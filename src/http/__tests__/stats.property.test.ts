import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { LifecycleStatsTracker } from "../lifecycle/stats";
import type { HttpClientStats } from "../client";

const emptyWireStats = (): HttpClientStats => ({
  inFlight: 0,
  started: 0,
  succeeded: 0,
  failed: 0,
  aborted: 0,
  timedOut: 0,
  poolRejected: 0,
  poolTimeouts: 0,
});

/**
 * Property-based tests for lifecycle stats counter accuracy.
 * Feature: http-lifecycle-client
 */
describe("LifecycleStatsTracker property tests", () => {
  /**
   * Property 20: Stats counter accuracy
   *
   * For any sequence of N requests where K succeed and N-K fail,
   * `stats().requestsCompleted` SHALL equal K and `stats().requestsFailed`
   * SHALL equal N-K, and `stats().requestsStarted` SHALL equal N.
   *
   * **Validates: Requirements 8.2, 8.3**
   */
  describe("Property 20: Stats counter accuracy", () => {
    it("requestsStarted === N, requestsCompleted === K, requestsFailed === N-K for any sequence of N requests", () => {
      fc.assert(
        fc.property(
          fc.array(fc.boolean(), { minLength: 0, maxLength: 200 }),
          (outcomes) => {
            const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });

            const N = outcomes.length;
            let K = 0;

            for (const succeeded of outcomes) {
              tracker.requestStarted();
              if (succeeded) {
                tracker.requestCompleted();
                K++;
              } else {
                tracker.requestFailed();
              }
            }

            const stats = tracker.snapshot();
            expect(stats.requestsStarted).toBe(N);
            expect(stats.requestsCompleted).toBe(K);
            expect(stats.requestsFailed).toBe(N - K);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("requestsStarted === requestsCompleted + requestsFailed for any interleaved sequence", () => {
      /**
       * Generate an interleaved sequence of operations where starts happen
       * before their corresponding completions/failures, simulating realistic
       * concurrent request patterns.
       */
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 100 }),
          (totalRequests, outcomePool) => {
            const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });

            // Start all requests first, then resolve them
            for (let i = 0; i < totalRequests; i++) {
              tracker.requestStarted();
            }

            let completed = 0;
            let failed = 0;

            // Resolve each request using the outcome pool (cycling if needed)
            for (let i = 0; i < totalRequests; i++) {
              const succeeded = outcomePool[i % outcomePool.length]!;
              if (succeeded) {
                tracker.requestCompleted();
                completed++;
              } else {
                tracker.requestFailed();
                failed++;
              }
            }

            const stats = tracker.snapshot();
            expect(stats.requestsStarted).toBe(totalRequests);
            expect(stats.requestsCompleted).toBe(completed);
            expect(stats.requestsFailed).toBe(failed);
            expect(stats.requestsStarted).toBe(stats.requestsCompleted + stats.requestsFailed);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("counters increase monotonically as requests are processed", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              fc.constant("start" as const),
              fc.constant("complete" as const),
              fc.constant("fail" as const),
            ),
            { minLength: 1, maxLength: 150 },
          ),
          (operations) => {
            const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });

            let prevStarted = 0;
            let prevCompleted = 0;
            let prevFailed = 0;

            for (const op of operations) {
              switch (op) {
                case "start":
                  tracker.requestStarted();
                  break;
                case "complete":
                  tracker.requestCompleted();
                  break;
                case "fail":
                  tracker.requestFailed();
                  break;
              }

              const stats = tracker.snapshot();

              // Monotonically increasing
              expect(stats.requestsStarted).toBeGreaterThanOrEqual(prevStarted);
              expect(stats.requestsCompleted).toBeGreaterThanOrEqual(prevCompleted);
              expect(stats.requestsFailed).toBeGreaterThanOrEqual(prevFailed);

              prevStarted = stats.requestsStarted;
              prevCompleted = stats.requestsCompleted;
              prevFailed = stats.requestsFailed;
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("each increment changes exactly one counter by exactly 1", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              fc.constant("start" as const),
              fc.constant("complete" as const),
              fc.constant("fail" as const),
            ),
            { minLength: 1, maxLength: 100 },
          ),
          (operations) => {
            const tracker = new LifecycleStatsTracker({ wireStats: emptyWireStats });

            let prevStarted = 0;
            let prevCompleted = 0;
            let prevFailed = 0;

            for (const op of operations) {
              switch (op) {
                case "start":
                  tracker.requestStarted();
                  break;
                case "complete":
                  tracker.requestCompleted();
                  break;
                case "fail":
                  tracker.requestFailed();
                  break;
              }

              const stats = tracker.snapshot();

              const startedDelta = stats.requestsStarted - prevStarted;
              const completedDelta = stats.requestsCompleted - prevCompleted;
              const failedDelta = stats.requestsFailed - prevFailed;

              // Exactly one counter changed by exactly 1
              const totalDelta = startedDelta + completedDelta + failedDelta;
              expect(totalDelta).toBe(1);

              // The changed counter corresponds to the operation
              switch (op) {
                case "start":
                  expect(startedDelta).toBe(1);
                  expect(completedDelta).toBe(0);
                  expect(failedDelta).toBe(0);
                  break;
                case "complete":
                  expect(startedDelta).toBe(0);
                  expect(completedDelta).toBe(1);
                  expect(failedDelta).toBe(0);
                  break;
                case "fail":
                  expect(startedDelta).toBe(0);
                  expect(completedDelta).toBe(0);
                  expect(failedDelta).toBe(1);
                  break;
              }

              prevStarted = stats.requestsStarted;
              prevCompleted = stats.requestsCompleted;
              prevFailed = stats.requestsFailed;
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("multiple tracker instances maintain independent counters", () => {
      fc.assert(
        fc.property(
          fc.array(fc.boolean(), { minLength: 0, maxLength: 50 }),
          fc.array(fc.boolean(), { minLength: 0, maxLength: 50 }),
          (outcomes1, outcomes2) => {
            const tracker1 = new LifecycleStatsTracker({ wireStats: emptyWireStats });
            const tracker2 = new LifecycleStatsTracker({ wireStats: emptyWireStats });

            // Process outcomes on tracker1
            for (const succeeded of outcomes1) {
              tracker1.requestStarted();
              if (succeeded) tracker1.requestCompleted();
              else tracker1.requestFailed();
            }

            // Process outcomes on tracker2
            for (const succeeded of outcomes2) {
              tracker2.requestStarted();
              if (succeeded) tracker2.requestCompleted();
              else tracker2.requestFailed();
            }

            const stats1 = tracker1.snapshot();
            const stats2 = tracker2.snapshot();

            // Each tracker has its own independent counts
            expect(stats1.requestsStarted).toBe(outcomes1.length);
            expect(stats2.requestsStarted).toBe(outcomes2.length);

            const k1 = outcomes1.filter(Boolean).length;
            const k2 = outcomes2.filter(Boolean).length;

            expect(stats1.requestsCompleted).toBe(k1);
            expect(stats1.requestsFailed).toBe(outcomes1.length - k1);
            expect(stats2.requestsCompleted).toBe(k2);
            expect(stats2.requestsFailed).toBe(outcomes2.length - k2);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
