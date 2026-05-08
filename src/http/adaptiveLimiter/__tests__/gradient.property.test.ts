import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeGradient, computeNewLimit } from "../gradient";

/**
 * Property-based tests for gradient computation and limit adjustment.
 * Feature: http-adaptive-concurrency
 */
describe("Gradient property tests", () => {
  /**
   * Property 2: Gradient computation correctness
   *
   * For any latency window containing at least one sample, the computed gradient
   * shall equal min(window_samples) / ema_value where ema_value is the current smoothed latency.
   *
   * **Validates: Requirements 1.2, 2.3**
   */
  describe("Property 2: Gradient computation correctness", () => {
    it("gradient equals minLatency / currentLatency for positive values", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0.1, max: 10000, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 0.1, max: 10000, noNaN: true, noDefaultInfinity: true }),
          (minLatency, currentLatency) => {
            const gradient = computeGradient(minLatency, currentLatency);
            const expected = minLatency / currentLatency;
            expect(gradient).toBeCloseTo(expected, 10);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("gradient is 1.0 when currentLatency <= 0", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0.1, max: 10000, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: -1000, max: 0, noNaN: true, noDefaultInfinity: true }),
          (minLatency, currentLatency) => {
            const gradient = computeGradient(minLatency, currentLatency);
            expect(gradient).toBe(1.0);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("gradient <= 1.0 when minLatency <= currentLatency", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0.1, max: 5000, noNaN: true, noDefaultInfinity: true }),
          (minLatency) => {
            const currentLatency = minLatency + Math.random() * 5000;
            const gradient = computeGradient(minLatency, currentLatency);
            expect(gradient).toBeLessThanOrEqual(1.0 + 1e-10);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 3: Limit decrease on high latency
   *
   * For any current limit and gradient value less than 1.0, the new limit
   * (before probe and clamping) shall equal floor(currentLimit * gradient).
   *
   * **Validates: Requirements 1.3**
   */
  describe("Property 3: Limit decrease on high latency", () => {
    it("when gradient < 1.0, newLimit = floor(currentLimit * gradient) (clamped)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 200 }),
          fc.double({ min: 0.01, max: 0.99, noNaN: true, noDefaultInfinity: true }),
          fc.integer({ min: 1, max: 10 }),
          (currentLimit, gradient, headroom) => {
            const rawExpected = Math.floor(currentLimit * gradient);
            const result = computeNewLimit(currentLimit, gradient, headroom, 1, 200);
            const expected = Math.max(1, Math.min(200, rawExpected));
            expect(result).toBe(expected);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("limit decreases when gradient < 1.0 and currentLimit > minBound", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 5, max: 200 }),
          fc.double({ min: 0.1, max: 0.9, noNaN: true, noDefaultInfinity: true }),
          (currentLimit, gradient) => {
            const result = computeNewLimit(currentLimit, gradient, 1, 1, 200);
            expect(result).toBeLessThanOrEqual(currentLimit);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 4: Limit increase on stable latency
   *
   * For any current limit and gradient value >= 1.0, the new limit
   * (before probe and clamping) shall equal currentLimit + headroom.
   *
   * **Validates: Requirements 1.4**
   */
  describe("Property 4: Limit increase on stable latency", () => {
    it("when gradient >= 1.0, newLimit = currentLimit + headroom (clamped)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 190 }),
          fc.double({ min: 1.0, max: 5.0, noNaN: true, noDefaultInfinity: true }),
          fc.integer({ min: 1, max: 10 }),
          (currentLimit, gradient, headroom) => {
            const rawExpected = currentLimit + headroom;
            const result = computeNewLimit(currentLimit, gradient, headroom, 1, 200);
            const expected = Math.max(1, Math.min(200, rawExpected));
            expect(result).toBe(expected);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("limit increases when gradient >= 1.0 and currentLimit < maxBound", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 195 }),
          fc.double({ min: 1.0, max: 3.0, noNaN: true, noDefaultInfinity: true }),
          (currentLimit, gradient) => {
            const result = computeNewLimit(currentLimit, gradient, 1, 1, 200);
            expect(result).toBeGreaterThanOrEqual(currentLimit);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 5: Bounds invariant
   *
   * For any sequence of latency recordings and any valid configuration,
   * the concurrency limit shall always satisfy minLimit ≤ limit ≤ maxLimit
   * after every state transition.
   *
   * **Validates: Requirements 1.5, 3.4, 4.4**
   */
  describe("Property 5: Bounds invariant", () => {
    it("computeNewLimit always returns a value within [minBound, maxBound]", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 500 }),
          fc.double({ min: 0.01, max: 5.0, noNaN: true, noDefaultInfinity: true }),
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 500 }),
          (currentLimit, gradient, headroom, minBound, maxBoundRaw) => {
            const maxBound = Math.max(minBound, maxBoundRaw);
            const result = computeNewLimit(currentLimit, gradient, headroom, minBound, maxBound);
            expect(result).toBeGreaterThanOrEqual(minBound);
            expect(result).toBeLessThanOrEqual(maxBound);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
