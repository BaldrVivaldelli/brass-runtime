#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const crate = path.join(root, "crates/brass-runtime-wasm-engine");
const wasmPack = process.platform === "win32" ? "wasm-pack.cmd" : "wasm-pack";

const build = spawnSync(
  wasmPack,
  ["build", "--target", "nodejs", "--out-dir", "../../wasm/pkg"],
  { cwd: crate, stdio: "inherit" },
);

if (build.error) {
  console.error(`Unable to start wasm-pack: ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

// wasm-pack writes a catch-all .gitignore into the output directory. An empty
// .npmignore keeps the generated files out of Git while allowing package.json's
// explicit `files` allowlist to include them in npm tarballs.
writeFileSync(path.join(root, "wasm/pkg/.npmignore"), "", "utf8");

const validate = spawnSync(
  process.execPath,
  [path.join(root, "scripts/check-wasm-artifact.mjs"), "--required", "--write-manifest"],
  { cwd: root, stdio: "inherit" },
);

if (validate.error) {
  console.error(`Unable to validate the WASM build: ${validate.error.message}`);
  process.exit(1);
}
process.exit(validate.status ?? 1);
