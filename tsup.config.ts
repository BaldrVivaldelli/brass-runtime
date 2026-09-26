import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";
import path from "node:path";

// The package root is the small v2 facade. `/v1` is the explicit compatibility
// bridge, and the WASM engine installs separately as @brass/engine-wasm rather
// than shipping inside this tarball.
const entry = {
  index: "src/next.ts",
  "v1/index": "src/index.ts",
  "core/index": "src/core/index.ts",
  "http/index": "src/http/index.ts",
  "http/testing": "src/http/testing.ts",
  "schema/index": "src/schema/index.ts",
  "observability/index": "src/observability/index.ts",
};

const base = {
  entry,
  platform: "node" as const,
  target: "node20" as const,
  splitting: true,
  sourcemap: false,
  outDir: "dist",
};

const browserAliases: Plugin = {
  name: "brass-browser-aliases",
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
    outDir: "dist",
    format: ["esm"],
    dts: false,
    clean: false,
    esbuildPlugins: [browserAliases],
    outExtension() {
      return { js: ".mjs" };
    },
  },
]);
