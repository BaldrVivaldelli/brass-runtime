import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { BenchmarkResult } from "../runner";

/**
 * Computes the layer overhead as the difference in p50 latency between
 * a layer-enabled measurement and the baseline measurement.
 *
 * @param layerResult - The benchmark result with the layer enabled
 * @param baselineResult - The benchmark result without any layer (baseline)
 * @returns The overhead in milliseconds (layerResult.p50 - baselineResult.p50)
 */
export function computeOverhead(
  layerResult: BenchmarkResult,
  baselineResult: BenchmarkResult,
): number {
  return layerResult.percentiles.p50 - baselineResult.percentiles.p50;
}

/**
 * Property-based tests for layer overhead computation.
 * Feature: lifecycle-client-docs-benchmarks, Property 7: Layer overhead computation correctness
 */
describe("Layer overhead computation property tests", () => {
  /**
   * Property 7: Layer overhead computation correctness
   *
   * For any layer benchmark result and its corresponding baseline result,
   * the reported overheadMs value SHALL equal
   * `layerResult.percentiles.p50 - baselineResult.percentiles.p50`
   * within floating-point tolerance of ±0.001ms.
   *
   * **Validates: Requirements 4.4, 5.5, 6.4, 7.4**
   */
  describe("Property 7: Layer overhead computation correctness", () => {
    it("overheadMs equals layerResult.p50 - baselineResult.p50 within ±0.001ms tolerance", () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 1000, noNaN: true }),
          fc.float({ min: 0, max: 1000, noNaN: true }),
          (layerP50, baselineP50) => {
            const layerResult: BenchmarkResult = {
              operation: "layer-test",
              iterations: 1000,
              totalMs: layerP50 * 1000,
              perOpMs: layerP50,
              percentiles: {
                p50: layerP50,
                p90: layerP50 * 1.2,
                p95: layerP50 * 1.4,
                p99: layerP50 * 1.8,
              },
            };

            const baselineResult: BenchmarkResult = {
              operation: "baseline-test",
              iterations: 1000,
              totalMs: baselineP50 * 1000,
              perOpMs: baselineP50,
              percentiles: {
                p50: baselineP50,
                p90: baselineP50 * 1.2,
                p95: baselineP50 * 1.4,
                p99: baselineP50 * 1.8,
              },
            };

            const result = computeOverhead(layerResult, baselineResult);
            const expected = layerP50 - baselineP50;

            expect(Math.abs(result - expected)).toBeLessThanOrEqual(0.001);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
