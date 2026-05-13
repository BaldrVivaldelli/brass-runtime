import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { HttpConcurrencyPool } from "../pool";

/**
 * Property-based tests for Pool Concurrency Fast-Path.
 * Feature: http-p99-optimization
 */
describe("Pool fast-path property tests", () => {
  /**
   * Property P5: Pool fast-path + abort signal
   *
   * When the abort signal is already aborted, `tryAcquireSync` returns
   * `undefined` without granting a permit or modifying any pool state
   * (running count, acquired count remain unchanged).
   *
   * This must hold for any valid pool configuration (various concurrency
   * limits, various keys).
   *
   * **Validates: Requirement 2.5**
   */
  describe("Property P5: Pool fast-path + abort signal", () => {
    it("tryAcquireSync returns undefined with no state mutation when signal is aborted", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 256 }),
          fc.integer({ min: 0, max: 512 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          (concurrency, maxQueue, key) => {
            const pool = new HttpConcurrencyPool({ concurrency, maxQueue });

            // Capture stats before the aborted acquire attempt
            const statsBefore = pool.stats();

            // Create an already-aborted signal
            const controller = new AbortController();
            controller.abort();

            const result = pool.tryAcquireSync(key, controller.signal);

            // Must return undefined
            expect(result).toBeUndefined();

            // Stats must be unchanged — no state mutation
            const statsAfter = pool.stats();
            expect(statsAfter.running).toBe(statsBefore.running);
            expect(statsAfter.acquired).toBe(statsBefore.acquired);
            expect(statsAfter.released).toBe(statsBefore.released);
            expect(statsAfter.rejected).toBe(statsBefore.rejected);
            expect(statsAfter.queued).toBe(statsBefore.queued);
            expect(statsAfter.queueTimeouts).toBe(statsBefore.queueTimeouts);
            expect(statsAfter.abortedWhileQueued).toBe(statsBefore.abortedWhileQueued);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("tryAcquireSync returns undefined even when pool has available capacity", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 256 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          (concurrency, key) => {
            // Pool with plenty of capacity — fast-path would normally succeed
            const pool = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });

            const controller = new AbortController();
            controller.abort();

            const result = pool.tryAcquireSync(key, controller.signal);

            // Even with available capacity, aborted signal means no lease
            expect(result).toBeUndefined();

            // Running count must remain 0 — no permit was granted
            const stats = pool.stats();
            expect(stats.running).toBe(0);
            expect(stats.acquired).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("tryAcquireSync with aborted signal does not affect subsequent non-aborted acquires", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 64 }),
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.integer({ min: 1, max: 10 }),
          (concurrency, key, abortedAttempts) => {
            const pool = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });

            // Perform multiple aborted acquire attempts
            for (let i = 0; i < abortedAttempts; i++) {
              const abortedController = new AbortController();
              abortedController.abort();
              const result = pool.tryAcquireSync(key, abortedController.signal);
              expect(result).toBeUndefined();
            }

            // A non-aborted acquire should still succeed (pool has capacity)
            const liveController = new AbortController();
            const lease = pool.tryAcquireSync(key, liveController.signal);

            expect(lease).toBeDefined();
            expect(lease!.key).toBe(key.trim().slice(0, 160) || "global");

            const stats = pool.stats();
            expect(stats.running).toBe(1);
            expect(stats.acquired).toBe(1);

            // Clean up
            lease!.release();
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
