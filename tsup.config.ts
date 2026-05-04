import { defineConfig } from "tsup";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

function copyWasmAssets() {
  const root = process.cwd();

  const src = path.join(root, "wasm", "pkg");

  if (!existsSync(src)) {
    throw new Error(
      "Missing wasm/pkg. Run `npm run build:wasm` before `tsup`."
    );
  }

  /**
   * Copia dentro de dist para que el artefacto compilado tenga los assets cerca.
   *
   * Queda:
   * dist/wasm/pkg/brass_runtime_wasm_engine.js
   * dist/wasm/pkg/brass_runtime_wasm_engine_bg.wasm
   */
  const distDest = path.join(root, "dist", "wasm", "pkg");

  mkdirSync(distDest, { recursive: true });
  cpSync(src, distDest, { recursive: true });
}

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "http/index": "src/http/index.ts",
    "agent/index": "src/agent/index.ts",
    "agent/cli/main": "src/agent/cli/main.ts",
  },

  format: ["esm", "cjs"],
  platform: "node",
  target: "node18",
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: false,
  outDir: "dist",

  onSuccess: async () => {
    copyWasmAssets();
  },
});