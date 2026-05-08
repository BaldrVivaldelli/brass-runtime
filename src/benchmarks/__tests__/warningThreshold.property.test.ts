import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { applyWarningThreshold } from "../lifecycle-baseline.bench";
import type { BenchmarkResult } from "../runner";

/**
 * Property-based tests for warning threshold correctness.
 * Feature: lifecycle-client-docs-benchmarks, Property 6: Warning threshold correctness
 *
 * **Validates: Requirements 3.7**
 */
describe("Property 6: Warning threshold correctness", () => {
  /**
   * Arbitrary for a positive float representing a p99 latency value.
   * Uses a range that covers realistic benchmark latencies (0.001ms to 1000ms).
   */
  const arbP99 = fc.double({ min: 0.001, max: 1000, noNaN: true });

  /**
   * Helper to construct a mock BenchmarkResult with a given p99 value.
   * Other percentile values are set to reasonable defaults since only p99
   * is relevant to the warning threshold logic.
   */
  function makeBenchmarkResult(p99: number, operation = "test operation"): BenchmarkResult {
    return {
      operation,
      iterations: 1000,
      totalMs: p99 * 1000,
      perOpMs: p99,
      percentiles: {
        p50: p99 * 0.5,
        p90: p99 * 0.8,
        p95: p99 * 0.9,
        p99,
      },
    };
  }

  it("sets warning=true and [WARN] prefix when lifecycle p99 > wire p99 * 1.05", () => {
    fc.assert(
      fc.property(arbP99, arbP99, (lifecycleP99, wireP99) => {
        const lifecycleResult = makeBenchmarkResult(lifecycleP99, "lifecycle client");
        const wireResult = makeBenchmarkResult(wireP99, "wire client");

        const result = applyWarningThreshold(lifecycleResult, wireResult);

        const threshold = wireP99 * 1.05;

        if (lifecycleP99 > threshold) {
          // When lifecycle p99 exceeds wire p99 by more than 5%:
          // - warning should be true
          // - operation should start with "[WARN]"
          expect(result.warning).toBe(true);
          expect(result.operation.startsWith("[WARN]")).toBe(true);
        } else {
          // When lifecycle p99 does NOT exceed wire p99 by more than 5%:
          // - warning should be undefined or false
          // - operation should NOT start with "[WARN]"
          expect(result.warning === undefined || result.warning === false).toBe(true);
          expect(result.operation.startsWith("[WARN]")).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("preserves original operation name (without prefix) when no warning", () => {
    fc.assert(
      fc.property(arbP99, (wireP99) => {
        // Generate a lifecycle p99 that is at most wire p99 * 1.05 (no warning case)
        const lifecycleP99 = wireP99 * 1.05 * 0.99; // safely below threshold
        const operationName = "lifecycle client (no layers)";

        const lifecycleResult = makeBenchmarkResult(lifecycleP99, operationName);
        const wireResult = makeBenchmarkResult(wireP99, "wire client");

        const result = applyWarningThreshold(lifecycleResult, wireResult);

        // Operation name should be unchanged
        expect(result.operation).toBe(operationName);
      }),
      { numRuns: 100 },
    );
  });

  it("prefixes operation name with [WARN] when warning is triggered", () => {
    fc.assert(
      fc.property(arbP99, (wireP99) => {
        // Generate a lifecycle p99 that exceeds wire p99 * 1.05 (warning case)
        const lifecycleP99 = wireP99 * 1.05 * 1.01 + 0.001; // safely above threshold
        const operationName = "lifecycle client (no layers)";

        const lifecycleResult = makeBenchmarkResult(lifecycleP99, operationName);
        const wireResult = makeBenchmarkResult(wireP99, "wire client");

        const result = applyWarningThreshold(lifecycleResult, wireResult);

        // Operation name should be prefixed with [WARN]
        expect(result.operation).toBe(`[WARN] ${operationName}`);
        expect(result.warning).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
