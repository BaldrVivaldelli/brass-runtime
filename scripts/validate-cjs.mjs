import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);

const requiredFiles = [
  "dist/index.cjs",
  "dist/http/index.cjs",
  "dist/agent/index.cjs",
  "wasm/pkg/brass_runtime_wasm_engine.js",
  "wasm/pkg/brass_runtime_wasm_engine_bg.wasm",
];

for (const file of requiredFiles) {
  const fullPath = path.join(root, file);

  if (!existsSync(fullPath)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

const cjsFiles = [
  "dist/index.cjs",
  "dist/http/index.cjs",
  "dist/agent/index.cjs",
];

for (const file of cjsFiles) {
  const fullPath = path.join(root, file);

  try {
    require(fullPath);
    console.log(`✅ CJS compatible: ${file}`);
  } catch (error) {
    console.error(`❌ CJS failed: ${file}`);
    console.error(error);
    process.exitCode = 1;
  }
}

try {
  const brass = require(path.join(root, "dist/index.cjs"));

  if (!brass.Runtime) {
    throw new Error("Runtime export not found");
  }

  const runtime = new brass.Runtime({ env: {}, engine: "wasm" });

  if (!runtime) {
    throw new Error("Runtime could not be instantiated");
  }

  console.log("✅ Runtime({ engine: 'wasm' }) loads correctly from CJS");
} catch (error) {
  console.error("❌ WASM runtime CJS validation failed");
  console.error(error);
  process.exitCode = 1;
}

if (process.exitCode) {
  process.exit(process.exitCode);
}