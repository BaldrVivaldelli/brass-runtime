import { defineConfig } from "vitest/config";

const coverageGate = process.env.COVERAGE_GATE ?? "baseline";

const coverageThresholds = (() => {
  if (coverageGate === "off") return undefined;
  if (coverageGate === "100") return { 100: true, perFile: true } as const;

  // Per-file gate for executable source. Branch coverage is reported but not
  // gated per-file yet because several branch-heavy modules still sit below 90%.
  return {
    statements: 90,
    functions: 90,
    lines: 90,
    perFile: true,
  };
})();

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
      reporter: ["text", "html", "json", "json-summary", "lcov"],
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
        "src/**/index.ts",
        "src/core/runtime/engine/types.ts",
        "src/http/lifecycle/types.ts",
        "src/http/prewarm/types.ts",
        "src/http/schema-type-tests.ts",
        "src/**/bench/**",
        "src/benchmarks/**",
        "src/examples/**",
        "src/agent/**",
        "dist/**",
        "coverage/**",
        "wasm/pkg/**"
      ],
      thresholds: coverageThresholds
    }
  }
});
