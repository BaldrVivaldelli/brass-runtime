import { defineConfig } from "vitest/config";

const coverageGate = process.env.COVERAGE_GATE ?? "baseline";

const coverageThresholds = (() => {
  if (coverageGate === "off") return undefined;
  if (coverageGate === "100") return { 100: true, perFile: true } as const;

  // Current honest baseline from the first full V8 coverage report.
  // Raise these only when tests have actually increased coverage.
  return {
    statements: 92,
    branches: 83,
    functions: 94,
    lines: 94,
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
