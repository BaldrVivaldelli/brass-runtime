#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "wasm", "pkg");
const destination = path.join(root, "packages", "engine-wasm", "dist");
const required = [
  "brass_runtime_wasm_engine.js",
  "brass_runtime_wasm_engine.d.ts",
  "brass_runtime_wasm_engine_bg.wasm",
  "brass_runtime_wasm_engine_bg.wasm.d.ts",
  "brass-runtime-build.json",
];

for (const file of required) {
  if (!existsSync(path.join(source, file))) {
    throw new Error(`Missing wasm/pkg/${file}. Run npm run build:wasm first.`);
  }
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const file of required) cpSync(path.join(source, file), path.join(destination, file));

console.log(`Built @brass/engine-wasm candidate (${required.length} files).`);
