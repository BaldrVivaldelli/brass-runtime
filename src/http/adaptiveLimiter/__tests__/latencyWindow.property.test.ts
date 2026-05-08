import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { LatencyWindow } from "../latencyWindow";

/**
 * Property-based tests for LatencyWindow.
 * Feature: http-adaptive-concurrency
 */
describe("LatencyWindow property tests", () => {
  /**
   * Property 6: Sliding window size invariant
   *
   * For any window of configured size N and any number of recorded samples M,
   * the window shall contain exactly min(M, N) samples.
   *
   * **Validates: Requirements 5.1, 5.2**
   */
  describe("Property 6: Sliding window size invariant", () => {
    it("window length equals min(validSamples, capacity) after recording", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 200 }),
          fc.array(fc.double({ min: 0.001, max: 10000, noNaN: true, noDefaultInfinity: true }), { minLength: 0, maxLength: 500 }),
          (windowSize, samples) => {
            const window = new LatencyWindow(windowSize);
            let validCount = 0;
            for (const s of samples) {
              window.record(s);
              if (Number.isFinite(s) && s > 0) validCount++;
            }
            expect(window.length).toBe(Math.min(validCount, windowSize));
            expect(window.capacity).toBe(Math.max(2, windowSize));
          },
        ),
        { numRuns: 100 },
      );
    });

    it("window never exceeds capacity", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 50 }),
          fc.array(fc.double({ min: 0.1, max: 1000, noNaN: true, noDefaultInfinity: true }), { minLength: 0, maxLength: 200 }),
          (windowSize, samples) => {
            const window = new LatencyWindow(windowSize);
            for (const s of samples) {
              window.record(s);
              expect(window.length).toBeLessThanOrEqual(window.capacity);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("invalid samples (non-positive, NaN, Infinity) are discarded", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 50 }),
          fc.array(
            fc.oneof(
              fc.constant(0),
              fc.constant(-1),
              fc.constant(NaN),
              fc.constant(Infinity),
              fc.constant(-Infinity),
              fc.double({ min: -1000, max: 0, noNaN: true, noDefaultInfinity: true }),
            ),
            { minLength: 1, maxLength: 50 },
          ),
          (windowSize, invalidSamples) => {
            const window = new LatencyWindow(windowSize);
            for (const s of invalidSamples) {
              window.record(s);
            }
            expect(window.length).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 7: Window minimum correctness
   *
   * For any set of samples currently in the latency window, the computed minimum
   * shall equal the mathematical minimum of those samples.
   *
   * **Validates: Requirements 5.3**
   */
  describe("Property 7: Window minimum correctness", () => {
    it("min() returns the mathematical minimum of samples in the window", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 100 }),
          fc.array(fc.double({ min: 0.001, max: 10000, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 300 }),
          (windowSize, samples) => {
            const window = new LatencyWindow(windowSize);
            for (const s of samples) {
              window.record(s);
            }

            // The window contains the last min(samples.length, windowSize) valid samples
            const validSamples = samples.filter((s) => Number.isFinite(s) && s > 0);
            if (validSamples.length === 0) {
              expect(window.min()).toBeUndefined();
              return;
            }

            const inWindow = validSamples.slice(-windowSize);
            const expectedMin = Math.min(...inWindow);
            expect(window.min()).toBe(expectedMin);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("min() returns undefined for empty window", () => {
      const window = new LatencyWindow(10);
      expect(window.min()).toBeUndefined();
    });
  });

  /**
   * Property 8: Percentile computation correctness
   *
   * For any array of at least 2 latency samples, the computed P50 shall equal
   * the sample at rank ceil(0.5 * N) in the sorted array, and P99 shall equal
   * the sample at rank ceil(0.99 * N).
   *
   * **Validates: Requirements 11.1**
   */
  describe("Property 8: Percentile computation correctness", () => {
    it("percentile(50) equals nearest-rank P50 of samples in window", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 200 }),
          fc.array(fc.double({ min: 0.001, max: 10000, noNaN: true, noDefaultInfinity: true }), { minLength: 2, maxLength: 300 }),
          (windowSize, samples) => {
            const window = new LatencyWindow(windowSize);
            for (const s of samples) {
              window.record(s);
            }

            const validSamples = samples.filter((s) => Number.isFinite(s) && s > 0);
            if (validSamples.length < 2) return;

            const inWindow = validSamples.slice(-windowSize);
            const sorted = [...inWindow].sort((a, b) => a - b);
            const rank = Math.ceil(0.5 * sorted.length);
            const expectedP50 = sorted[Math.min(rank, sorted.length) - 1];

            expect(window.percentile(50)).toBe(expectedP50);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("percentile(99) equals nearest-rank P99 of samples in window", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 200 }),
          fc.array(fc.double({ min: 0.001, max: 10000, noNaN: true, noDefaultInfinity: true }), { minLength: 2, maxLength: 300 }),
          (windowSize, samples) => {
            const window = new LatencyWindow(windowSize);
            for (const s of samples) {
              window.record(s);
            }

            const validSamples = samples.filter((s) => Number.isFinite(s) && s > 0);
            if (validSamples.length < 2) return;

            const inWindow = validSamples.slice(-windowSize);
            const sorted = [...inWindow].sort((a, b) => a - b);
            const rank = Math.ceil(0.99 * sorted.length);
            const expectedP99 = sorted[Math.min(rank, sorted.length) - 1];

            expect(window.percentile(99)).toBe(expectedP99);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("percentile returns undefined when fewer than 2 samples", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 100 }),
          fc.double({ min: 0.001, max: 10000, noNaN: true, noDefaultInfinity: true }),
          (windowSize, sample) => {
            const window = new LatencyWindow(windowSize);
            expect(window.percentile(50)).toBeUndefined();
            window.record(sample);
            expect(window.percentile(50)).toBeUndefined();
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
