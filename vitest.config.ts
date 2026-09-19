import { defineConfig } from "vitest/config";

const coverageGate = process.env.COVERAGE_GATE ?? "baseline";

const coverageThresholds = (() => {
  if (coverageGate === "off") return undefined;
  if (coverageGate === "100") return { 100: true, perFile: true } as const;

  // Repository-wide gate across every shipped subsystem. Focused per-file
  // regressions are handled by module tests and exact public API checks.
  return {
    statements: 80,
    branches: 65,
    functions: 80,
    lines: 80,
  };
})();

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.pbt.test.ts", "scripts/**/*.test.mjs"],
    exclude: ["node_modules/**", "dist/**", "coverage/**", "wasm/pkg/**"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "html", "json", "json-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.pbt.test.ts",
        "src/**/__tests__/**",
        "src/**/*.d.ts",
        "src/index.ts",
        "src/core/**/index.ts",
        "src/http/**/index.ts",
        "src/observability/**/index.ts",
        "src/perf/**/index.ts",
        "src/agent/**/index.ts",
        "src/core/runtime/engine/types.ts",
        "src/http/lifecycle/types.ts",
        "src/http/prewarm/types.ts",
        "src/core/runtime/dx-type-tests.ts",
        "src/http/schema-type-tests.ts",
        "src/schema/type-tests.ts",
        "src/http/browser.ts",
        "src/**/bench/**",
        "src/benchmarks/**",
        "src/examples/**",
        "dist/**",
        "coverage/**",
        "wasm/pkg/**"
      ],
      thresholds: coverageThresholds
    }
  }
});
