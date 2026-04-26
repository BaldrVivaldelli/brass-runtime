import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/http/index.ts", "src/agent/index.ts", "src/agent/cli/main.ts"],
    format: ["esm", "cjs"],
    dts: true,                 // genera .d.ts
    sourcemap: false,          // no publicar maps (reduce tamaño)
    minify: true,              // reduce tamaño del JS publicado
    treeshake: true,
    splitting: true,           // solo aplica bien a ESM
    clean: true,               // borra dist
    outDir: "dist",
    target: "es2022",
    outExtension: ({ format }) => ({
        js: format === "cjs" ? ".cjs" : ".js"
    })
});
