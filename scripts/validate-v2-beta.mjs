#!/usr/bin/env node

import {
  closeSync,
  cpSync,
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
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionFlag = process.argv.indexOf("--version");
const version = versionFlag >= 0 ? process.argv[versionFlag + 1] : "2.0.0-beta.0";

if (!/^2\.\d+\.\d+-beta\.\d+$/.test(version ?? "")) {
  throw new Error(`Expected a v2 beta version such as 2.0.0-beta.0; received ${String(version)}`);
}

const releaseRoot = path.join(root, "artifacts", "v2-beta");
const stage = path.join(releaseRoot, "package");
const dist = path.join(stage, "dist");
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "brass-v2-beta-"));
const productPacks = path.join(temporaryRoot, "products");
const consumer = path.join(temporaryRoot, "consumer");
const npmCache = path.join(temporaryRoot, "npm-cache");
let captureSequence = 0;

try {
  rmSync(releaseRoot, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(productPacks, { recursive: true });
  mkdirSync(consumer, { recursive: true });

  run(npmCommand(), ["run", "build:v2-beta"], root, {
    BRASS_V2_BETA_OUT_DIR: dist,
  });

  writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(betaManifest(version), null, 2)}\n`);
  writeFileSync(path.join(stage, "README.md"), betaReadme(version));
  cpSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
  copyDocumentation(stage);

  const betaPack = pack(stage, releaseRoot);
  assertBetaPackage(betaPack.report, version);

  run(npmCommand(), ["run", "build:products"], root);
  const perfPack = pack(path.join(root, "packages", "perf"), productPacks).tarball;
  const enginePack = pack(path.join(root, "packages", "engine-wasm"), productPacks).tarball;

  writeFileSync(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ name: "brass-v2-beta-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  install([betaPack.tarball, perfPack]);

  await validateBrowserConditions(consumer);
  validateTypes(consumer);
  validateEsmWithoutWasm(consumer);
  validateCjsWithoutWasm(consumer);

  install([enginePack]);
  validateOptionalWasm(consumer);

  const relativeTarball = path.relative(root, betaPack.tarball);
  console.log(
    `V2 beta candidate validated: ${relativeTarball} ` +
      `(${betaPack.report.entryCount} files, ${betaPack.report.size} compressed bytes, ` +
      `${betaPack.report.unpackedSize} unpacked bytes).`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function betaManifest(candidateVersion) {
  return {
    name: "brass-runtime",
    version: candidateVersion,
    description: "Brass Runtime v2 beta: small effect runtime facade with explicit v1 compatibility",
    license: "MIT",
    author: "Augusto Vivaldelli",
    type: "module",
    main: "./dist/index.cjs",
    module: "./dist/index.mjs",
    types: "./dist/index.d.ts",
    sideEffects: false,
    engines: { node: ">=20" },
    exports: {
      ".": conditional("index"),
      "./next": conditional("index"),
      "./v1": conditional("v1/index"),
      "./core": conditional("core/index"),
      "./http": conditional("http/index"),
      "./http/testing": nodeConditional("http/testing"),
      "./schema": nodeConditional("schema/index"),
      "./observability": conditional("observability/index"),
      "./package.json": "./package.json",
    },
    files: ["dist", "docs", "README.md", "LICENSE"],
    peerDependencies: {
      "@brass/engine-wasm": ">=0.1.0-alpha.0 <1",
    },
    peerDependenciesMeta: {
      "@brass/engine-wasm": { optional: true },
    },
    publishConfig: {
      access: "public",
      tag: "next",
      provenance: true,
    },
    repository: {
      type: "git",
      url: "git+https://github.com/BaldrVivaldelli/brass-runtime.git",
    },
    bugs: { url: "https://github.com/BaldrVivaldelli/brass-runtime/issues" },
    homepage: "https://github.com/BaldrVivaldelli/brass-runtime#readme",
    keywords: ["runtime", "effects", "typescript", "concurrency", "structured-concurrency"],
  };
}

function conditional(entry) {
  return {
    types: `./dist/${entry}.d.ts`,
    browser: `./dist/browser/${entry}.mjs`,
    import: `./dist/${entry}.mjs`,
    require: `./dist/${entry}.cjs`,
  };
}

function nodeConditional(entry) {
  return {
    types: `./dist/${entry}.d.ts`,
    import: `./dist/${entry}.mjs`,
    require: `./dist/${entry}.cjs`,
  };
}

function betaReadme(candidateVersion) {
  return `# Brass Runtime ${candidateVersion}\n\n` +
    "This is the installable v2 beta candidate. The package root is the small v2 API; " +
    "the same facade is available from `brass-runtime/next`.\n\n" +
    "Use `brass-runtime/v1` only as a temporary compatibility bridge. Agent, performance " +
    "tooling, and the WASM engine are independently versioned packages. The WASM engine " +
    "is optional and the runtime falls back to TypeScript in `auto` mode when it is absent.\n\n" +
    "See `docs/migration-v1-to-v2.md` for migration and rollback guidance. This candidate " +
    "must be published only with the npm `next` dist-tag; it must never replace `latest`.\n";
}

function copyDocumentation(destination) {
  const selected = [
    "api-v2.md",
    "migration-v1-to-v2.md",
    "product-boundaries.md",
    "support-and-maintenance.md",
    "v1-to-v2-export-map.json",
  ];
  const docsDestination = path.join(destination, "docs");
  mkdirSync(docsDestination, { recursive: true });
  for (const relative of selected) {
    cpSync(path.join(root, "docs", relative), path.join(docsDestination, relative));
  }
}

function assertBetaPackage(report, candidateVersion) {
  const budget = JSON.parse(readFileSync(path.join(root, "scripts", "package-size-budget.json"), "utf8"));
  const target = budget.maximum;
  const failures = [];
  if (report.size > target.compressedBytes) failures.push(`compressed ${report.size} > ${target.compressedBytes}`);
  if (report.unpackedSize > target.unpackedBytes) failures.push(`unpacked ${report.unpackedSize} > ${target.unpackedBytes}`);
  if (report.entryCount > target.fileCount) failures.push(`files ${report.entryCount} > ${target.fileCount}`);

  const paths = new Set(report.files.map((file) => file.path));
  const required = [
    "dist/index.cjs",
    "dist/index.mjs",
    "dist/index.d.ts",
    "dist/v1/index.cjs",
    "dist/v1/index.mjs",
    "dist/v1/index.d.ts",
    "dist/browser/index.mjs",
    "dist/core/index.cjs",
    "dist/http/index.cjs",
    "dist/observability/index.cjs",
    "docs/v1-to-v2-export-map.json",
    "README.md",
    "LICENSE",
    "package.json",
  ];
  for (const requiredPath of required) {
    if (!paths.has(requiredPath)) failures.push(`missing ${requiredPath}`);
  }
  for (const forbidden of ["dist/agent/", "dist/perf/", "wasm/"]) {
    if ([...paths].some((entry) => entry.startsWith(forbidden))) failures.push(`forbidden ${forbidden}`);
  }

  const manifest = JSON.parse(readFileSync(path.join(stage, "package.json"), "utf8"));
  if (manifest.version !== candidateVersion) failures.push("candidate version mismatch");
  if (manifest.publishConfig?.tag !== "next") failures.push("publish tag must be next");
  if (manifest.exports?.["./agent"] || manifest.exports?.["./perf"]) {
    failures.push("Agent/Perf must not be beta runtime subpaths");
  }
  if (failures.length > 0) throw new Error(`V2 beta package validation failed:\n- ${failures.join("\n- ")}`);
}

async function validateBrowserConditions(consumerDirectory) {
  const source = path.join(consumerDirectory, "browser-smoke.ts");
  writeFileSync(
    source,
    [
      'import { Effect, runPromise } from "brass-runtime";',
      'import { Effect as NextEffect } from "brass-runtime/next";',
      'import { succeed } from "brass-runtime/v1";',
      'import { httpClient } from "brass-runtime/http";',
      'import * as observability from "brass-runtime/observability";',
      "void [Effect, NextEffect, runPromise, succeed, httpClient, observability];",
    ].join("\n"),
  );
  await build({
    absWorkingDir: consumerDirectory,
    entryPoints: [source],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "silent",
    conditions: ["browser", "import"],
  });
}

function validateTypes(consumerDirectory) {
  writeFileSync(
    path.join(consumerDirectory, "types-smoke.ts"),
    [
      'import { Effect, Runtime, runPromise } from "brass-runtime";',
      'import { succeed } from "brass-runtime/v1";',
      'import { Scope } from "brass-runtime/core";',
      'import { httpClient } from "brass-runtime/http";',
      'import { runBrassPerformanceProfile } from "@brass/perf";',
      "const effect = Effect.succeed(42);",
      "void [Runtime, runPromise, succeed, Scope, httpClient, runBrassPerformanceProfile, effect];",
    ].join("\n"),
  );
  writeFileSync(
    path.join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      files: ["types-smoke.ts"],
    }, null, 2)}\n`,
  );
  run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc")], consumerDirectory);
}

function validateEsmWithoutWasm(consumerDirectory) {
  const smoke = path.join(consumerDirectory, "esm-smoke.mjs");
  writeFileSync(
    smoke,
    [
      'import * as brass from "brass-runtime";',
      'import * as next from "brass-runtime/next";',
      'import * as v1 from "brass-runtime/v1";',
      'import * as core from "brass-runtime/core";',
      'import { httpClient } from "brass-runtime/http";',
      'import * as observability from "brass-runtime/observability";',
      'import { makePerfRecorder } from "@brass/perf";',
      "const answer = await brass.runPromise(brass.Effect.map(brass.Effect.succeed(41), (value) => value + 1));",
      'if (answer !== 42) throw new Error("v2 root execution failed");',
      'if (JSON.stringify(Object.keys(brass).sort()) !== JSON.stringify(Object.keys(next).sort())) throw new Error("root/next drift");',
      'if (typeof v1.succeed !== "function" || typeof core.Runtime !== "function") throw new Error("v1 compatibility failed");',
      'if (typeof httpClient !== "function" || Object.keys(observability).length === 0) throw new Error("product surface failed");',
      'if (makePerfRecorder().mark("beta").name !== "beta") throw new Error("companion product failed");',
      'const auto = new brass.Runtime({ env: {}, engine: "auto" });',
      'if (auto.diagnostics().engine !== "ts" || !auto.diagnostics().fallbackUsed) throw new Error("missing-WASM fallback failed");',
      "let strictFailed = false;",
      'try { new brass.Runtime({ env: {}, engine: "wasm" }); } catch { strictFailed = true; }',
      'if (!strictFailed) throw new Error("strict WASM unexpectedly loaded without optional package");',
    ].join("\n"),
  );
  run(process.execPath, [smoke], consumerDirectory);
}

function validateCjsWithoutWasm(consumerDirectory) {
  const smoke = path.join(consumerDirectory, "cjs-smoke.cjs");
  writeFileSync(
    smoke,
    [
      'const brass = require("brass-runtime");',
      'const next = require("brass-runtime/next");',
      'const v1 = require("brass-runtime/v1");',
      'const core = require("brass-runtime/core");',
      'const perf = require("@brass/perf");',
      "async function main() {",
      "  const answer = await brass.runPromise(brass.Effect.succeed(42));",
      '  if (answer !== 42) throw new Error("v2 CJS execution failed");',
      '  if (JSON.stringify(Object.keys(brass).sort()) !== JSON.stringify(Object.keys(next).sort())) throw new Error("CJS root/next drift");',
      '  if (typeof v1.succeed !== "function" || typeof core.Runtime !== "function") throw new Error("CJS v1 compatibility failed");',
      '  if (perf.makePerfRecorder().mark("beta").name !== "beta") throw new Error("CJS companion product failed");',
      "}",
      "main().catch((error) => { console.error(error); process.exitCode = 1; });",
    ].join("\n"),
  );
  run(process.execPath, [smoke], consumerDirectory);
}

function validateOptionalWasm(consumerDirectory) {
  const smoke = path.join(consumerDirectory, "wasm-smoke.cjs");
  writeFileSync(
    smoke,
    [
      'const { Runtime } = require("brass-runtime");',
      'const engine = require("@brass/engine-wasm");',
      'const runtime = new Runtime({ env: {}, engine: "wasm" });',
      'if (runtime.diagnostics().engine !== "wasm") throw new Error("optional WASM engine was not selected");',
      "const vm = new engine.BrassWasmVm();",
      'if (vm.abi_version() !== 1) throw new Error("unexpected WASM ABI");',
      "vm.free();",
    ].join("\n"),
  );
  run(process.execPath, [smoke], consumerDirectory);
}

function install(tarballs) {
  run(
    npmCommand(),
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      ...tarballs,
    ],
    consumer,
    { npm_config_cache: npmCache },
  );
}

function pack(directory, destination) {
  const output = run(
    npmCommand(),
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination, directory],
    root,
    { npm_config_cache: npmCache },
    true,
  );
  const report = JSON.parse(output)[0];
  if (!report?.filename || !Array.isArray(report.files)) {
    throw new Error(`Invalid npm pack report for ${directory}`);
  }
  return { report, tarball: path.join(destination, report.filename) };
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
      env: { ...process.env, ...extraEnv },
      stdio: capture ? ["ignore", stdoutFd, stderrFd] : "inherit",
    });
  } finally {
    if (stdoutFd !== undefined) closeDescriptor(stdoutFd);
    if (stderrFd !== undefined) closeDescriptor(stderrFd);
  }

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stdout = stdoutPath ? readFileSync(stdoutPath, "utf8") : "";
    const stderr = stderrPath ? readFileSync(stderrPath, "utf8") : "";
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${stdout}${stderr}`);
  }
  return stdoutPath ? readFileSync(stdoutPath, "utf8") : "";
}

function closeDescriptor(descriptor) {
  try {
    closeSync(descriptor);
  } catch {
    // The process has already completed, so a close failure is non-actionable here.
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
