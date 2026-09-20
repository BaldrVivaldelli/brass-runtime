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
const requested = process.argv[2];
const products = requested ? [requested] : ["agent", "perf"];
const supported = new Set(["agent", "perf"]);

for (const product of products) {
  if (!supported.has(product)) {
    throw new Error(`Unknown product '${product}'. Expected agent or perf.`);
  }
}

for (const required of ["dist/index.cjs", "dist/agent/index.cjs", "dist/perf/index.cjs"]) {
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
    const symbol = product === "agent" ? "runAgent" : "runBrassPerformanceProfile";
    const behavior = product === "agent"
      ? `if (${product}Package.goalForAgentPreset("inspect").length === 0) throw new Error("Agent ESM behavior smoke failed");`
      : `if (${product}Package.makePerfRecorder().mark("smoke").name !== "smoke") throw new Error("Perf ESM behavior smoke failed");`;
    return [
      `const ${product}Package = await import("@brass/${product}");`,
      `const ${product}Legacy = await import("brass-runtime/${product}");`,
      `if (typeof ${product}Package.${symbol} !== "function") throw new Error("Missing ${symbol}");`,
      `if (JSON.stringify(Object.keys(${product}Package).sort()) !== JSON.stringify(Object.keys(${product}Legacy).sort())) throw new Error("ESM export parity mismatch for ${product}");`,
      `if (${product}Package.${symbol} === ${product}Legacy.${symbol}) throw new Error("ESM ${product} package unexpectedly forwards its implementation");`,
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
    const symbol = product === "agent" ? "runAgent" : "runBrassPerformanceProfile";
    const behavior = product === "agent"
      ? `if (${product}Package.goalForAgentPreset("inspect").length === 0) throw new Error("Agent CJS behavior smoke failed");`
      : `if (${product}Package.makePerfRecorder().mark("smoke").name !== "smoke") throw new Error("Perf CJS behavior smoke failed");`;
    return [
      `const ${product}Package = require("@brass/${product}");`,
      `const ${product}Legacy = require("brass-runtime/${product}");`,
      `if (typeof ${product}Package.${symbol} !== "function") throw new Error("Missing ${symbol}");`,
      `if (JSON.stringify(Object.keys(${product}Package).sort()) !== JSON.stringify(Object.keys(${product}Legacy).sort())) throw new Error("CJS export parity mismatch for ${product}");`,
      `if (${product}Package.${symbol} === ${product}Legacy.${symbol}) throw new Error("CJS ${product} package unexpectedly forwards its implementation");`,
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
    const symbol = product === "agent" ? "runAgent" : "runBrassPerformanceProfile";
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

  if (products.includes("agent")) {
    const help = run(
      process.execPath,
      [path.join(consumerDirectory, "node_modules", "@brass", "agent", "dist", "cli.cjs"), "--help"],
      consumerDirectory,
      {},
      true,
    );
    if (!help.includes("Usage: brass-agent")) throw new Error("@brass/agent CLI help smoke failed");
  }
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
    for (const required of [
      "dist/index.cjs",
      "dist/index.mjs",
      "dist/cli.cjs",
      "index.d.ts",
      "README.md",
      "LICENSE",
      "package.json",
    ]) {
      if (!paths.has(required)) throw new Error(`${manifest.name} tarball is missing ${required}`);
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
