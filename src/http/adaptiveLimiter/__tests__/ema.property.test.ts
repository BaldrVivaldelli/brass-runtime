import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { EmaComputer } from "../ema";

/**
 * Property-based tests for EMA computation.
 * Feature: http-adaptive-concurrency
 */
describe("EmaComputer property tests", () => {
  /**
   * Property 1: EMA formula correctness
   *
   * For any sequence of positive latency samples and any smoothing factor α in (0, 1],
   * the EMA after recording sample S with previous EMA value P shall equal
   * `α * S + (1 - α) * P`.
   *
   * **Validates: Requirements 2.2**
   */
  describe("Property 1: EMA formula correctness", () => {
    it("EMA follows the formula α * sample + (1 - α) * previous for all samples after the first", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0.01, max: 1.0, noNaN: true, noDefaultInfinity: true }),
          fc.array(fc.double({ min: 0.1, max: 10000, noNaN: true, noDefaultInfinity: true }), { minLength: 2, maxLength: 100 }),
          (alpha, samples) => {
            const ema = new EmaComputer(alpha);

            // First sample initializes the EMA
            let expected = samples[0];
            const result0 = ema.update(samples[0]);
            expect(result0).toBeCloseTo(expected, 10);

            // Subsequent samples follow the formula
            for (let i = 1; i < samples.length; i++) {
              expected = alpha * samples[i] + (1 - alpha) * expected;
              const result = ema.update(samples[i]);
              expect(result).toBeCloseTo(expected, 8);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("first sample initializes EMA to that sample value", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0.01, max: 1.0, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 0.1, max: 10000, noNaN: true, noDefaultInfinity: true }),
          (alpha, sample) => {
            const ema = new EmaComputer(alpha);
            expect(ema.value).toBeUndefined();
            const result = ema.update(sample);
            expect(result).toBe(sample);
            expect(ema.value).toBe(sample);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("alpha = 1.0 means EMA equals the latest sample (no smoothing)", () => {
      fc.assert(
        fc.property(
          fc.array(fc.double({ min: 0.1, max: 10000, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 50 }),
          (samples) => {
            const ema = new EmaComputer(1.0);
            for (const s of samples) {
              ema.update(s);
            }
            expect(ema.value).toBe(samples[samples.length - 1]);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("reset clears the EMA state", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0.01, max: 1.0, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 0.1, max: 10000, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 0.1, max: 10000, noNaN: true, noDefaultInfinity: true }),
          (alpha, sample1, sample2) => {
            const ema = new EmaComputer(alpha);
            ema.update(sample1);
            expect(ema.value).toBeDefined();
            ema.reset();
            expect(ema.value).toBeUndefined();
            // After reset, next sample initializes again
            const result = ema.update(sample2);
            expect(result).toBe(sample2);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
