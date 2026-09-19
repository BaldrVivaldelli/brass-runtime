#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const required = process.argv.includes("--required");
const writeManifest = process.argv.includes("--write-manifest");
const root = process.cwd();
const artifact = path.join(root, "wasm/pkg/brass_runtime_wasm_engine.js");
const binaryArtifact = path.join(root, "wasm/pkg/brass_runtime_wasm_engine_bg.wasm");
const manifestPath = path.join(root, "wasm/pkg/brass-runtime-build.json");
const hasJavaScriptArtifact = existsSync(artifact);
const hasBinaryArtifact = existsSync(binaryArtifact);

if (!hasJavaScriptArtifact && !hasBinaryArtifact) {
  if (required) {
    console.error("Missing JavaScript or binary wasm/pkg artifact. Run `npm run build:wasm`.");
    process.exit(1);
  }
  console.log("WASM artifact absent; TypeScript tests will run without real-WASM suites.");
  process.exit(0);
}

if (!hasJavaScriptArtifact || !hasBinaryArtifact) {
  console.error("Partial WASM artifact: JavaScript and binary outputs must both exist.");
  console.error("Run `npm run build:wasm`.");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const module = require(artifact);
const Vm = module.BrassWasmVm;
const requiredExports = [
  "abi_version",
  "min_compatible_abi_version",
  "engine_version",
  "capabilities",
  "max_program_words",
  "max_patch_words",
  "max_event_batch",
  "memory",
  "prepare_program_words",
  "prepare_patch_words",
  "create_fiber_from_program_words",
  "drive_batch_ptr",
  "event_batch_len",
  "provide_value_ptr",
  "provide_error_ptr",
  "provide_effect_from_words",
  "interrupt_ptr",
  "metrics_snapshot_ptr",
  "metrics_snapshot_len",
];

if (typeof Vm !== "function") {
  console.error("Stale WASM artifact: missing BrassWasmVm. Run `npm run build:wasm`.");
  process.exit(1);
}

let vm;
try {
  vm = new Vm();
} catch (error) {
  console.error(`Invalid WASM artifact: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const missing = requiredExports.filter((name) => typeof vm[name] !== "function");
if (typeof vm.free === "function") {
  try {
    vm.free();
  } catch {
    // The strict ABI check below is authoritative; disposal is best-effort here.
  }
}
if (missing.length > 0) {
  console.error("Stale WASM artifact. Run `npm run build:wasm`.");
  console.error(`Missing strict exports: ${missing.join(", ")}`);
  process.exit(1);
}

const expectedManifest = {
  formatVersion: 1,
  target: "nodejs",
  sourceSha256: sourceFingerprint(),
};

if (writeManifest) {
  writeFileSync(manifestPath, `${JSON.stringify(expectedManifest, null, 2)}\n`, "utf8");
} else if (!existsSync(manifestPath)) {
  console.error("Missing WASM source manifest. Run `npm run build:wasm`.");
  process.exit(1);
} else {
  let actualManifest;
  try {
    actualManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`Invalid WASM source manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (
    actualManifest.formatVersion !== expectedManifest.formatVersion
    || actualManifest.target !== expectedManifest.target
    || actualManifest.sourceSha256 !== expectedManifest.sourceSha256
  ) {
    console.error("Stale WASM artifact: its source fingerprint does not match the Rust workspace.");
    console.error("Run `npm run build:wasm`.");
    process.exit(1);
  }
}

console.log("WASM artifact matches the strict runtime ABI and Rust source fingerprint.");

function sourceFingerprint() {
  const files = [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates/brass-engine-core/Cargo.toml",
    ...walkFiles("crates/brass-engine-core/src", ".rs"),
    "crates/brass-runtime-wasm-engine/Cargo.toml",
    ...walkFiles("crates/brass-runtime-wasm-engine/src", ".rs"),
  ].sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walkFiles(relativeDirectory, extension) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return walkFiles(relative, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [relative] : [];
  });
}
