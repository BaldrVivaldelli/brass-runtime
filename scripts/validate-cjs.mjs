import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const require = createRequire(import.meta.url);

const requiredFiles = [
  "dist/index.cjs",
  "dist/v1/index.cjs",
  "dist/core/index.cjs",
  "dist/http/index.cjs",
  "dist/http/testing.cjs",
  "dist/schema/index.cjs",
  "dist/observability/index.cjs",
];

for (const file of requiredFiles) {
  const fullPath = path.join(root, file);

  if (!existsSync(fullPath)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

const cjsFiles = [
  "dist/index.cjs",
  "dist/v1/index.cjs",
  "dist/core/index.cjs",
  "dist/http/index.cjs",
  "dist/http/testing.cjs",
  "dist/schema/index.cjs",
  "dist/observability/index.cjs",
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
  // The root is the small v2 facade; `/next` is kept as an alias of it.
  const root2 = require(path.join(root, "dist/index.cjs"));

  if (!root2.Effect || typeof root2.pipe !== "function" || Object.keys(root2).length > 40) {
    throw new Error("Invalid brass-runtime root surface");
  }
  if (typeof root2.Effect.gen !== "function") {
    throw new Error("Effect.gen missing from the root surface");
  }

  console.log("✅ Small v2 root surface loads correctly from CJS");
} catch (error) {
  console.error("❌ v2 root CJS validation failed");
  console.error(error);
  process.exitCode = 1;
}

try {
  const brass = require(path.join(root, "dist/v1/index.cjs"));

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
