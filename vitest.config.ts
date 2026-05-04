import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.pbt.test.ts"],
    exclude: ["node_modules/**", "dist/**", "coverage/**", "wasm/pkg/**"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "html", "json", "lcov"],
      include: [
        "src/core/**/*.ts",
        "src/http/**/*.ts",
        "src/index.ts"
      ],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.pbt.test.ts",
        "src/**/__tests__/**",
        "src/**/*.d.ts",
        "src/**/bench/**",
        "src/benchmarks/**",
        "src/examples/**",
        "src/agent/**",
        "dist/**",
        "coverage/**",
        "wasm/pkg/**"
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80
      }
    }
  }
});
