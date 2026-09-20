import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";
import path from "node:path";

const outDir = path.resolve(process.env.BRASS_V2_BETA_OUT_DIR ?? "artifacts/v2-beta/package/dist");

const nodeEntry = {
  index: "src/next.ts",
  "v1/index": "src/index.ts",
  "core/index": "src/core/index.ts",
  "http/index": "src/http/index.ts",
  "http/testing": "src/http/testing.ts",
  "schema/index": "src/schema/index.ts",
  "observability/index": "src/observability/index.ts",
};

const browserAliases: Plugin = {
  name: "brass-v2-beta-browser-aliases",
  setup(build) {
    const aliases = new Map([
      [
        path.resolve("src/core/runtime/wasmModule"),
        path.resolve("src/core/runtime/wasmModule.browser.ts"),
      ],
      [
        path.resolve("src/http/compression/decompressor"),
        path.resolve("src/http/compression/decompressor.browser.ts"),
      ],
    ]);

    build.onResolve({ filter: /(?:wasmModule|decompressor)$/ }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      const replacement = aliases.get(resolved);
      return replacement ? { path: replacement } : undefined;
    });
  },
};

const base = {
  entry: nodeEntry,
  platform: "node" as const,
  target: "node20" as const,
  splitting: true,
  sourcemap: false,
  outDir,
};

export default defineConfig([
  {
    ...base,
    format: ["cjs"],
    dts: true,
    clean: true,
    outExtension: () => ({ js: ".cjs" }),
  },
  {
    ...base,
    format: ["esm"],
    dts: false,
    clean: false,
    outExtension: () => ({ js: ".mjs" }),
  },
  {
    entry: {
      "browser/index": "src/next.ts",
      "browser/v1/index": "src/index.ts",
      "browser/core/index": "src/core/index.ts",
      "browser/http/index": "src/http/browser.ts",
      "browser/observability/index": "src/observability/index.ts",
    },
    platform: "browser",
    target: "es2022",
    splitting: true,
    sourcemap: false,
    outDir,
    format: ["esm"],
    dts: false,
    clean: false,
    esbuildPlugins: [browserAliases],
    outExtension: () => ({ js: ".mjs" }),
  },
]);
