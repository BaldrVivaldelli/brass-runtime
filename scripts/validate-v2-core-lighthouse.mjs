#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const betaTarball = path.resolve(root, argumentValue("--beta-tarball")
  ?? "artifacts/v2-beta/brass-runtime-2.0.0-beta.0.tgz");
const stableVersionRequested = argumentValue("--stable-version")
  ?? JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const reportPath = argumentValue("--report");

if (!existsSync(betaTarball)) {
  throw new Error(`Missing beta tarball ${betaTarball}. Run npm run validate:v2-beta first.`);
}

const temporaryRoot = mkdtempSync(path.join(tmpdir(), "brass-v2-core-lighthouse-"));
const staged = path.join(temporaryRoot, "consumer");
const packs = path.join(temporaryRoot, "packs");
const npmCache = path.join(temporaryRoot, "npm-cache");
const startedAt = new Date();

try {
  mkdirSync(packs, { recursive: true });
  cpSync(path.join(root, "examples", "v2-preview"), staged, { recursive: true });

  const manifestPath = path.join(staged, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.name = "brass-v2-core-lighthouse";
  manifest.dependencies = { "brass-runtime": `file:${betaTarball}` };
  delete manifest.devDependencies;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const tsconfigPath = path.join(staged, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
  tsconfig.compilerOptions.module = "NodeNext";
  tsconfig.compilerOptions.moduleResolution = "NodeNext";
  delete tsconfig.compilerOptions.baseUrl;
  delete tsconfig.compilerOptions.paths;
  writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);

  const appPath = path.join(staged, "src", "app.ts");
  const previewSource = readFileSync(appPath, "utf8");
  const betaSource = previewSource.replace('from "brass-runtime/next"', 'from "brass-runtime"');
  if (betaSource === previewSource) throw new Error("Expected the preview import in the core lighthouse");
  writeFileSync(appPath, betaSource);

  install(betaTarball);
  const betaVersion = installedVersion();
  typecheckAndExecute("v2 root");
  const betaFinishedAt = new Date();

  writeFileSync(appPath, previewSource);
  typecheckAndExecute("beta /next rollback");
  const bridgeFinishedAt = new Date();

  const stableTarball = packPublishedRuntime(packs, stableVersionRequested);
  install(stableTarball);
  const stableVersion = installedVersion();
  if (stableVersion !== stableVersionRequested) {
    throw new Error(`Expected published stable ${stableVersionRequested}, installed ${stableVersion}`);
  }
  typecheckAndExecute("published stable v1 rollback");
  const finishedAt = new Date();

  const report = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    betaFinishedAt: betaFinishedAt.toISOString(),
    bridgeFinishedAt: bridgeFinishedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    betaVersion,
    stableVersion,
    stableSource: `npm:brass-runtime@${stableVersionRequested}`,
    checks: [
      "strict TypeScript against v2 package root",
      "Effect result equals 42",
      "Stream result equals [6, 8, 10]",
      "beta /next facade rollback",
      "published stable v1 tarball rollback",
    ],
  };
  if (reportPath) {
    const absoluteReportPath = path.resolve(root, reportPath);
    mkdirSync(path.dirname(absoluteReportPath), { recursive: true });
    writeFileSync(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(
    `V2 core lighthouse passed (${betaVersion} root -> /next -> stable ${stableVersion}, ` +
    `${report.durationMs}ms).`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function argumentValue(name) {
  const inline = process.argv.slice(2).find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function install(tarball) {
  run(npmCommand(), [
    "install",
    "--offline",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--no-save",
    tarball,
  ], staged, { npm_config_cache: npmCache });
}

function installedVersion() {
  return JSON.parse(readFileSync(path.join(staged, "node_modules", "brass-runtime", "package.json"), "utf8")).version;
}

function typecheckAndExecute(label) {
  run(process.execPath, [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    path.join(staged, "tsconfig.json"),
    "--noEmit",
  ], staged);
  const output = run(process.execPath, [
    path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(staged, "src", "app.ts"),
  ], staged, {}, true);
  if (!/^effect 42$/m.test(output) || !/^stream \[ 6, 8, 10 \]$/m.test(output)) {
    throw new Error(`${label} behavior mismatch:\n${output}`);
  }
}

function packPublishedRuntime(destination, version) {
  const output = run(
    npmCommand(),
    ["pack", `brass-runtime@${version}`, "--json", "--ignore-scripts", "--pack-destination", destination],
    root,
    { npm_config_cache: npmCache },
    true,
  );
  const report = JSON.parse(output)[0];
  if (!report?.filename) throw new Error("npm pack did not report the published stable runtime tarball");
  return path.join(destination, report.filename);
}

function run(command, args, cwd, extraEnv = {}, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})` +
      `${capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : ""}`,
    );
  }
  return capture ? result.stdout : "";
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
