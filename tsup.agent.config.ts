import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";
import path from "node:path";

const runtimeRoot = path.resolve("src/core");
const runtimeExternal: Plugin = {
  name: "agent-runtime-peer",
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      if (resolved === runtimeRoot || resolved.startsWith(`${runtimeRoot}${path.sep}`)) {
        return { path: "brass-runtime", external: true };
      }
      return undefined;
    });
  },
};

const common = {
  entry: {
    index: "src/agent/index.ts",
    cli: "src/agent/cli/main.ts",
  },
  platform: "node" as const,
  target: "node18" as const,
  splitting: false,
  sourcemap: false,
  outDir: "packages/agent/dist",
  esbuildPlugins: [runtimeExternal],
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
]);
