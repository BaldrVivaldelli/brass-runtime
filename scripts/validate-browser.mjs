import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const browserExports = {
  ".": "./dist/browser/index.mjs",
  "./next": "./dist/browser/index.mjs",
  "./v1": "./dist/browser/v1/index.mjs",
  "./core": "./dist/browser/core/index.mjs",
  "./http": "./dist/browser/http/index.mjs",
  "./observability": "./dist/browser/observability/index.mjs",
};

for (const [subpath, expected] of Object.entries(browserExports)) {
  const actual = packageJson.exports?.[subpath]?.browser;
  if (actual !== expected) {
    throw new Error(
      `Invalid browser export for ${subpath}: expected ${expected}, received ${String(actual)}`,
    );
  }
}

const entries = [
  "dist/browser/index.mjs",
  "dist/browser/v1/index.mjs",
  "dist/browser/core/index.mjs",
  "dist/browser/http/index.mjs",
  "dist/browser/observability/index.mjs",
  "dist/schema/index.mjs",
];

for (const entry of entries) {
  const absolute = path.join(root, entry);
  if (!existsSync(absolute)) throw new Error(`Missing browser artifact: ${entry}`);

  await build({
    entryPoints: [absolute],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  console.log(`Browser compatible: ${entry}`);
}
