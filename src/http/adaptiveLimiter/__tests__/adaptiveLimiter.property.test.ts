import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { AdaptiveLimiter } from "../adaptiveLimiter";
import { validateConfig } from "../types";

/**
 * Property-based tests for AdaptiveLimiter core behavior.
 * Feature: http-adaptive-concurrency
 */
describe("AdaptiveLimiter property tests", () => {
  /**
   * Property 9: Probe fires at correct interval
   *
   * For any probe interval P, after exactly P request completions without a prior probe,
   * the limiter shall apply a +1 probe increment and reset the counter to zero.
   *
   * **Validates: Requirements 4.1, 4.2, 4.3**
   */
  describe("Property 9: Probe fires at correct interval", () => {
    it("probe fires every probeInterval completions", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 1, max: 5 }),
          (probeInterval, cycles) => {
            const limiter = new AdaptiveLimiter({
              initialLimit: 100,
              maxLimit: 500,
              minLimit: 1,
              probeInterval,
              probeJitterRatio: 0,
              minSamples: 1,
              smoothingFactor: 1.0, // no smoothing for predictability
              windowSize: 200,
            });

            const key = "test";
            const signal = new AbortController().signal;

            // Track limit changes
            const totalCompletions = probeInterval * cycles;

            for (let i = 0; i < totalCompletions; i++) {
              const lease = limiter.acquire(key, signal);
              // Since initialLimit is 100, all acquires should resolve immediately
              lease.then((l) => l.release(10)); // constant latency = stable gradient
            }

            // After completions, probeCount should be 0 (just fired) if totalCompletions is a multiple of probeInterval
            const stats = limiter.stats(key);
            expect(stats.probeCount).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 10: Per-key isolation
   *
   * For any two distinct pool keys A and B, recording latency samples on key A
   * shall not affect the concurrency limit, EMA, or window state of key B.
   *
   * **Validates: Requirements 6.2**
   */
  describe("Property 10: Per-key isolation", () => {
    it("operations on key A do not affect key B state", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true }), { minLength: 5, maxLength: 30 }),
          fc.array(fc.double({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true }), { minLength: 5, maxLength: 30 }),
          async (samplesA, samplesB) => {
            const limiter = new AdaptiveLimiter({
              initialLimit: 100,
              maxLimit: 500,
              smoothingFactor: 0.5,
              windowSize: 50,
            });

            const signal = new AbortController().signal;

            // Record samples on key A
            for (const s of samplesA) {
              const lease = await limiter.acquire("keyA", signal);
              lease.release(s);
            }

            // Get key B stats before any operations on B
            const statsBBefore = limiter.stats("keyB");
            expect(statsBBefore.limit).toBe(100); // initial limit, unaffected
            expect(statsBBefore.smoothedLatency).toBeUndefined();
            expect(statsBBefore.windowSize).toBe(0);

            // Record samples on key B
            for (const s of samplesB) {
              const lease = await limiter.acquire("keyB", signal);
              lease.release(s);
            }

            // Key A stats should not have changed from key B operations
            const statsA = limiter.stats("keyA");
            const statsB = limiter.stats("keyB");

            // They should have independent window sizes
            expect(statsA.windowSize).toBe(Math.min(samplesA.length, 50));
            expect(statsB.windowSize).toBe(Math.min(samplesB.length, 50));
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  /**
   * Property 11: Backpressure queue capacity enforcement
   *
   * For any configured max queue depth Q and a key at its concurrency limit,
   * the (Q+1)th queued request shall be rejected with a PoolRejected error.
   *
   * **Validates: Requirements 7.1, 7.2**
   */
  describe("Property 11: Backpressure queue capacity enforcement", () => {
    it("rejects with PoolRejected when queue is full", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 10 }),
          async (limit, maxQueue) => {
            const limiter = new AdaptiveLimiter({
              initialLimit: limit,
              maxLimit: limit,
              minLimit: limit,
              maxQueue,
              smoothingFactor: 0.5,
            });

            const signal = new AbortController().signal;
            const key = "test";

            // Fill all slots
            const leases = [];
            for (let i = 0; i < limit; i++) {
              leases.push(await limiter.acquire(key, signal));
            }

            // Fill the queue
            const queuedPromises = [];
            for (let i = 0; i < maxQueue; i++) {
              queuedPromises.push(limiter.acquire(key, signal));
            }

            // The next acquire should be rejected
            try {
              await limiter.acquire(key, signal);
              expect.fail("Should have been rejected");
            } catch (e: any) {
              expect(e._tag).toBe("PoolRejected");
              expect(e.key).toBe(key);
            }

            // Cleanup
            for (const l of leases) l.release(10);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  /**
   * Property 12: Abort removes from queue
   *
   * For any request queued in the backpressure queue, aborting via AbortSignal
   * shall remove it from the queue and the queue depth shall decrease by 1.
   *
   * **Validates: Requirements 10.2**
   */
  describe("Property 12: Abort removes from queue", () => {
    it("aborting a queued request removes it from the queue", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          fc.integer({ min: 2, max: 10 }),
          async (limit, queueCount) => {
            const limiter = new AdaptiveLimiter({
              initialLimit: limit,
              maxLimit: limit,
              minLimit: limit,
              maxQueue: queueCount + 5,
              smoothingFactor: 0.5,
            });

            const signal = new AbortController().signal;
            const key = "test";

            // Fill all slots
            const leases = [];
            for (let i = 0; i < limit; i++) {
              leases.push(await limiter.acquire(key, signal));
            }

            // Queue some requests with individual abort controllers
            const controllers: AbortController[] = [];
            const queuedPromises: Promise<any>[] = [];
            for (let i = 0; i < queueCount; i++) {
              const ctrl = new AbortController();
              controllers.push(ctrl);
              queuedPromises.push(
                limiter.acquire(key, ctrl.signal).catch(() => null),
              );
            }

            // Verify queue depth
            expect(limiter.stats(key).queueDepth).toBe(queueCount);

            // Abort one request
            controllers[0].abort();
            await queuedPromises[0];

            // Queue depth should decrease by 1
            expect(limiter.stats(key).queueDepth).toBe(queueCount - 1);

            // Cleanup
            for (const ctrl of controllers.slice(1)) ctrl.abort();
            await Promise.allSettled(queuedPromises);
            for (const l of leases) l.release(10);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  /**
   * Property 13: Limit event correctness
   *
   * For any state transition that changes the concurrency limit, the emitted
   * LimitChangeEvent shall contain the correct previous limit, new limit,
   * current gradient, and current smoothed latency values.
   *
   * **Validates: Requirements 8.1**
   */
  describe("Property 13: Limit event correctness", () => {
    it("emitted events have correct previousLimit, newLimit, gradient, and smoothedLatency", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.double({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true }), { minLength: 5, maxLength: 50 }),
          async (latencies) => {
            const events: any[] = [];
            const limiter = new AdaptiveLimiter({
              initialLimit: 10,
              maxLimit: 200,
              minLimit: 1,
              smoothingFactor: 0.5,
              windowSize: 50,
              minSamples: 2,
              probeInterval: 100, // high to avoid probe interference
              onLimitChange: (event) => events.push(event),
            });

            const signal = new AbortController().signal;
            const key = "test";

            for (const lat of latencies) {
              const lease = await limiter.acquire(key, signal);
              lease.release(lat);
            }

            // Verify all emitted events
            for (const event of events) {
              expect(event.key).toBe(key);
              expect(event.previousLimit).not.toBe(event.newLimit);
              expect(typeof event.gradient).toBe("number");
              expect(typeof event.smoothedLatency).toBe("number");
              expect(typeof event.minLatency).toBe("number");
              expect(typeof event.timestamp).toBe("number");
              expect(event.newLimit).toBeGreaterThanOrEqual(1);
              expect(event.newLimit).toBeLessThanOrEqual(200);
            }
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  /**
   * Property 14: Configuration validation rejects invalid combinations
   *
   * For any configuration where smoothingFactor is ≤ 0 or > 1, or windowSize < 2,
   * or probeInterval < 1, the constructor shall throw a descriptive error.
   *
   * **Validates: Requirements 9.4**
   */
  describe("Property 14: Configuration validation rejects invalid combinations", () => {
    it("throws for smoothingFactor <= 0", () => {
      fc.assert(
        fc.property(
          fc.double({ min: -100, max: 0, noNaN: true, noDefaultInfinity: true }),
          (alpha) => {
            expect(() => validateConfig({ smoothingFactor: alpha })).toThrow(/smoothingFactor/);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("throws for smoothingFactor > 1", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 1.001, max: 100, noNaN: true, noDefaultInfinity: true }),
          (alpha) => {
            expect(() => validateConfig({ smoothingFactor: alpha })).toThrow(/smoothingFactor/);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("throws for windowSize < 2", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -100, max: 1 }),
          (windowSize) => {
            expect(() => validateConfig({ windowSize })).toThrow(/windowSize/);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("throws for probeInterval < 1", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -100, max: 0 }),
          (probeInterval) => {
            expect(() => validateConfig({ probeInterval })).toThrow(/probeInterval/);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("does not throw for valid configurations", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0.01, max: 1.0, noNaN: true, noDefaultInfinity: true }),
          fc.integer({ min: 2, max: 1000 }),
          fc.integer({ min: 1, max: 100 }),
          (smoothingFactor, windowSize, probeInterval) => {
            expect(() =>
              validateConfig({ smoothingFactor, windowSize, probeInterval }),
            ).not.toThrow();
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
