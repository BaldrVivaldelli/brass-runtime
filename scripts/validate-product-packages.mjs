#!/usr/bin/env node

import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productSizeBudgets = JSON.parse(
  readFileSync(path.join(root, "scripts", "package-size-budget.json"), "utf8"),
).productTargets;
const requested = process.argv[2];
const products = requested ? [requested] : ["perf", "engine-wasm"];
const supported = new Set(["perf", "engine-wasm"]);

for (const product of products) {
  if (!supported.has(product)) {
    throw new Error(`Unknown product '${product}'. Expected perf or engine-wasm.`);
  }
}

const requiredRuntimeFiles = ["dist/index.cjs"];
for (const required of requiredRuntimeFiles) {
  try {
    readFileSync(path.join(root, required));
  } catch {
    throw new Error(`Missing ${required}. Run npm run build before validating product packages.`);
  }
}

const temporaryRoot = mkdtempSync(path.join(tmpdir(), "brass-products-"));
const packDirectory = path.join(temporaryRoot, "packs");
const consumerDirectory = path.join(temporaryRoot, "consumer");
const npmCache = path.join(temporaryRoot, "npm-cache");
let captureSequence = 0;

try {
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });

  for (const product of products) {
    run(npmCommand(), ["run", `build:product:${product}`], root, {}, true);
  }

  const runtimeTarball = pack(root, packDirectory);
  const productTarballs = products.map((product) => pack(path.join(root, "packages", product), packDirectory));

  writeFileSync(
    path.join(consumerDirectory, "package.json"),
    JSON.stringify({ name: "brass-product-smoke", private: true, type: "module" }, null, 2),
  );

  run(
    npmCommand(),
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      runtimeTarball,
      ...productTarballs,
    ],
    consumerDirectory,
    { npm_config_cache: npmCache },
  );

  const esmChecks = products.map((product) => {
    if (product === "engine-wasm") {
      return [
        'const engineWasmPackage = await import("@brass/engine-wasm");',
        "const EngineVm = engineWasmPackage.BrassWasmVm ?? engineWasmPackage.default?.BrassWasmVm;",
        'if (typeof EngineVm !== "function") throw new Error("Missing BrassWasmVm ESM export");',
        "const engineVm = new EngineVm();",
        'if (engineVm.abi_version() !== 1) throw new Error("Unexpected WASM ABI version");',
        "engineVm.free();",
      ].join("\n");
    }
    const symbol = "runBrassPerformanceProfile";
    const behavior = `if (${product}Package.makePerfRecorder().mark("smoke").name !== "smoke") throw new Error("Perf ESM behavior smoke failed");`;
    return [
      `const ${product}Package = await import("@brass/${product}");`,
      `if (typeof ${product}Package.${symbol} !== "function") throw new Error("Missing ${symbol}");`,
      behavior,
    ].join("\n");
  });
  const esmSmoke = path.join(consumerDirectory, "smoke.mjs");
  writeFileSync(
    esmSmoke,
    [
      'const next = await import("brass-runtime/next");',
      "const answer = await next.runPromise(next.Effect.map(next.Effect.succeed(41), (value) => value + 1));",
      'if (answer !== 42) throw new Error("v2 ESM execution smoke failed");',
      ...esmChecks,
      "",
    ].join("\n"),
  );
  run(process.execPath, [esmSmoke], consumerDirectory);

  const cjsChecks = products.map((product) => {
    if (product === "engine-wasm") {
      return [
        'const engineWasmPackage = require("@brass/engine-wasm");',
        'if (typeof engineWasmPackage.BrassWasmVm !== "function") throw new Error("Missing BrassWasmVm CJS export");',
        "const engineVm = new engineWasmPackage.BrassWasmVm();",
        'if (engineVm.abi_version() !== 1) throw new Error("Unexpected WASM ABI version");',
        "engineVm.free();",
        'const strictWasmRuntime = new (require("brass-runtime/core").Runtime)({ env: {}, engine: "wasm" });',
        'if (strictWasmRuntime.diagnostics().engine !== "wasm") throw new Error("Runtime did not load @brass/engine-wasm");',
      ].join("\n");
    }
    const symbol = "runBrassPerformanceProfile";
    const behavior = `if (${product}Package.makePerfRecorder().mark("smoke").name !== "smoke") throw new Error("Perf CJS behavior smoke failed");`;
    return [
      `const ${product}Package = require("@brass/${product}");`,
      `if (typeof ${product}Package.${symbol} !== "function") throw new Error("Missing ${symbol}");`,
      behavior,
    ].join("\n");
  });
  const cjsSmoke = path.join(consumerDirectory, "smoke.cjs");
  writeFileSync(
    cjsSmoke,
    [
      'const next = require("brass-runtime/next");',
      ...cjsChecks,
      "async function main() {",
      "  const answer = await next.runPromise(next.Effect.map(next.Effect.succeed(41), (value) => value + 1));",
      '  if (answer !== 42) throw new Error("v2 CJS execution smoke failed");',
      "}",
      "main().catch((error) => { console.error(error); process.exitCode = 1; });",
      "",
    ].join("\n"),
  );
  run(process.execPath, [cjsSmoke], consumerDirectory);

  const typeImports = products.map((product) => {
    if (product === "engine-wasm") {
      return 'import { BrassWasmVm } from "@brass/engine-wasm"; void BrassWasmVm;';
    }
    const symbol = "runBrassPerformanceProfile";
    return `import { ${symbol} } from "@brass/${product}"; void ${symbol};`;
  });
  const typeSmoke = path.join(consumerDirectory, "smoke.ts");
  writeFileSync(typeSmoke, `${typeImports.join("\n")}\n`);
  writeFileSync(
    path.join(consumerDirectory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: ["smoke.ts"],
      },
      null,
      2,
    ),
  );
  run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc")], consumerDirectory);

  if (products.includes("perf")) {
    const report = run(
      process.execPath,
      [
        path.join(consumerDirectory, "node_modules", "@brass", "perf", "dist", "cli.cjs"),
        "--profile",
        "runtime",
        "--runtime-iterations",
        "1",
        "--runtime-chain-depth",
        "1",
        "--json",
      ],
      consumerDirectory,
      {},
      true,
    );
    if (!JSON.parse(report).runtime) throw new Error("@brass/perf CLI JSON smoke failed");
  }

  console.log(`Product package validation passed: ${products.join(", ")}.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function pack(directory, destination) {
  const output = run(
    npmCommand(),
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination, directory],
    root,
    { npm_config_cache: npmCache },
    true,
  );
  const report = JSON.parse(output);
  const result = report[0];
  if (!result?.filename || !Array.isArray(result.files)) {
    throw new Error(`Invalid npm pack report for ${directory}`);
  }
  const tarball = path.join(destination, result.filename);

  if (directory !== root) {
    const paths = new Set(result.files.map((file) => file.path));
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    const productId = manifest.name.replace("@brass/", "");
    const sizeBudget = productSizeBudgets?.[productId];
    if (!sizeBudget) throw new Error(`${manifest.name} is missing a product package size budget`);
    const actualSize = {
      compressedBytes: Number(result.size ?? 0),
      unpackedBytes: Number(result.unpackedSize ?? 0),
      fileCount: result.files.length,
    };
    for (const [metric, maximum] of Object.entries(sizeBudget)) {
      if (actualSize[metric] > maximum) {
        throw new Error(`${manifest.name} ${metric} ${actualSize[metric]} exceeds ${maximum}`);
      }
    }
    const requiredFiles = manifest.name === "@brass/engine-wasm"
      ? [
          "dist/brass_runtime_wasm_engine.js",
          "dist/brass_runtime_wasm_engine.d.ts",
          "dist/brass_runtime_wasm_engine_bg.wasm",
          "dist/brass-runtime-build.json",
          "README.md",
          "LICENSE",
          "package.json",
        ]
      : [
          "dist/index.cjs",
          "dist/index.mjs",
          "dist/index.d.mts",
          "dist/cli.cjs",
          "README.md",
          "LICENSE",
          "package.json",
        ];
    for (const required of requiredFiles) {
      if (!paths.has(required)) throw new Error(`${manifest.name} tarball is missing ${required}`);
    }

    if (manifest.name === "@brass/perf") {
      const declaration = readFileSync(path.join(directory, "dist", "index.d.mts"), "utf8");
      if (/from\s+["']brass-runtime\/perf["']/.test(declaration)) {
        throw new Error(`${manifest.name} declarations depend on a legacy monolith subpath`);
      }
    }
  }

  return tarball;
}

function run(command, args, cwd = root, extraEnv = {}, capture = false) {
  const captureId = capture ? captureSequence++ : undefined;
  const stdoutPath = capture ? path.join(temporaryRoot, `stdout-${captureId}.log`) : undefined;
  const stderrPath = capture ? path.join(temporaryRoot, `stderr-${captureId}.log`) : undefined;
  const stdoutFd = stdoutPath ? openSync(stdoutPath, "w") : undefined;
  const stderrFd = stderrPath ? openSync(stderrPath, "w") : undefined;
  let result;

  try {
    result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
      stdio: capture ? ["ignore", stdoutFd, stderrFd] : "inherit",
    });
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }

  const stdout = stdoutPath ? readFileSync(stdoutPath, "utf8") : "";
  const stderr = stderrPath ? readFileSync(stderrPath, "utf8") : "";
  if (stdoutPath) rmSync(stdoutPath, { force: true });
  if (stderrPath) rmSync(stderrPath, { force: true });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(stdout);
      process.stderr.write(stderr);
    }
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }

  return stdout;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
