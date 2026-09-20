import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";
import path from "node:path";

const productExternals: ReadonlyArray<readonly [string, string]> = [
  [path.resolve("src/core"), "brass-runtime/core"],
  [path.resolve("src/http"), "brass-runtime/http"],
  [path.resolve("src/observability"), "brass-runtime/observability"],
];
const runtimeExternals: Plugin = {
  name: "perf-runtime-peers",
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      for (const [sourceRoot, packageName] of productExternals) {
        if (resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path.sep}`)) {
          return { path: packageName, external: true };
        }
      }
      return undefined;
    });
  },
};

const common = {
  entry: {
    index: "src/perf/index.ts",
    cli: "src/perf/cli.ts",
  },
  platform: "node" as const,
  target: "node18" as const,
  splitting: false,
  sourcemap: false,
  outDir: "packages/perf/dist",
  esbuildPlugins: [runtimeExternals],
};

export default defineConfig([
  {
    ...common,
    format: ["cjs"],
    clean: true,
    outExtension: () => ({ js: ".cjs" }),
  },
  {
    ...common,
    format: ["esm"],
    clean: false,
    outExtension: () => ({ js: ".mjs" }),
  },
  {
    entry: {
      index: "src/perf/index.ts",
    },
    platform: "node",
    target: "node18",
    format: ["esm"],
    splitting: false,
    sourcemap: false,
    outDir: "packages/perf/dist",
    clean: false,
    dts: { only: true },
    outExtension: () => ({ dts: ".d.ts" }),
  },
]);
