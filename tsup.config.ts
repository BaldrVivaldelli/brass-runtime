import { defineConfig } from "tsup";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

function copyWasmAssets() {
  const root = process.cwd();
  const src = path.join(root, "wasm", "pkg");

  if (!existsSync(src)) {
    throw new Error("Missing wasm/pkg. Run `npm run build:wasm` before `tsup`.");
  }

  const distDest = path.join(root, "dist", "wasm", "pkg");

  mkdirSync(distDest, { recursive: true });
  cpSync(src, distDest, { recursive: true });
}

const entry = {
  index: "src/index.ts",
  "core/index": "src/core/index.ts",
  "http/index": "src/http/index.ts",
  "http/testing": "src/http/testing.ts",
  "schema/index": "src/schema/index.ts",
  "observability/index": "src/observability/index.ts",
  "agent/index": "src/agent/index.ts",
  "agent/cli/main": "src/agent/cli/main.ts",
};

const base = {
  entry,
  platform: "node" as const,
  target: "node18" as const,
  splitting: true,
  sourcemap: false,
  outDir: "dist",
};

export default defineConfig([
  {
    ...base,
    format: ["cjs"],
    dts: true,
    clean: true,
    outExtension() {
      return { js: ".cjs" };
    },
  },
  {
    ...base,
    format: ["esm"],
    dts: false,
    clean: false,
    outExtension() {
      return { js: ".mjs" };
    },
  },
  {
    ...base,
    format: ["esm"],
    dts: false,
    clean: false,
    outExtension() {
      return { js: ".js" };
    },
    onSuccess: async () => {
      copyWasmAssets();
    },
  },
]);
