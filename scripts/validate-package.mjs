#!/usr/bin/env node
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(0, "utf8"));
const paths = new Set(report[0]?.files?.map((file) => file.path) ?? []);
const required = [
  "CONTRIBUTING.md",
  "GOVERNANCE.md",
  "dist/index.cjs",
  "dist/index.mjs",
  "dist/index.d.ts",
  "dist/next.cjs",
  "dist/next.mjs",
  "dist/next.d.ts",
  "dist/browser/index.mjs",
  "dist/browser/next.mjs",
  "dist/browser/core/index.mjs",
  "dist/browser/http/index.mjs",
  "dist/browser/observability/index.mjs",
  "wasm/pkg/brass_runtime_wasm_engine.js",
  "wasm/pkg/brass_runtime_wasm_engine_bg.wasm",
  "wasm/pkg/brass-runtime-build.json",
];
const missing = required.filter((entry) => !paths.has(entry));

if (missing.length > 0) {
  console.error(`Package is missing required artifacts: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Package contents validated (${paths.size} files).`);
