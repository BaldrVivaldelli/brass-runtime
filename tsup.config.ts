import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function copyWasmAssets() {
  const root = process.cwd();
  const src = path.join(root, "wasm", "pkg");

  if (!existsSync(src)) {
    throw new Error("Missing wasm/pkg. Run `npm run build:wasm` before `tsup`.");
  }

  const distDest = path.join(root, "dist", "wasm", "pkg");

  mkdirSync(distDest, { recursive: true });
  cpSync(src, distDest, {
    recursive: true,
    // Root wasm/pkg needs this override for npm packing. The dist copy keeps
    // wasm-pack's .gitignore so the tarball does not contain duplicate binaries.
    filter: (source) => path.basename(source) !== ".npmignore",
  });
  writeFileSync(path.join(distDest, ".npmignore"), "*\n", "utf8");
}

const entry = {
  index: "src/index.ts",
  "core/index": "src/core/index.ts",
  "http/index": "src/http/index.ts",
  "http/testing": "src/http/testing.ts",
  "schema/index": "src/schema/index.ts",
  "observability/index": "src/observability/index.ts",
  "perf/index": "src/perf/index.ts",
  "perf/cli": "src/perf/cli.ts",
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
  {
    entry: {
      "browser/index": "src/index.ts",
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
