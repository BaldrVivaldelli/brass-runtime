import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { makeBudgetSemaphore } from "../budgetSemaphore";

/**
 * Property-based tests for the budget semaphore.
 * Feature: http-connection-prewarm, Property 3: Budget Concurrency Invariant
 *
 * **Validates: Requirements 1.5, 2.6, 8.1, 8.4**
 */
describe("Budget Semaphore Property Tests", () => {
  /**
   * Property 3 (partial): For any capacity N and M concurrent acquires where M > N,
   * at most N are granted simultaneously.
   *
   * **Validates: Requirements 1.5, 2.6, 8.1, 8.4**
   */
  it("at most N slots are granted simultaneously for any capacity N and M > N acquires", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 16 }),
        fc.integer({ min: 2, max: 32 }),
        async (capacity, extraAcquires) => {
          const totalAcquires = capacity + extraAcquires;
          const sem = makeBudgetSemaphore(capacity);

          let maxConcurrent = 0;
          let currentConcurrent = 0;
          const releases: Array<() => void> = [];

          // Launch all acquires concurrently
          const promises = Array.from({ length: totalAcquires }, () =>
            sem.acquire().then(({ release }) => {
              currentConcurrent++;
              maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
              releases.push(() => {
                currentConcurrent--;
                release();
              });
            }),
          );

          // Wait a tick to let the first N resolve
          await new Promise((r) => setTimeout(r, 0));

          // Release all acquired slots one by one to let queued waiters proceed
          while (releases.length > 0) {
            const rel = releases.shift()!;
            rel();
            await new Promise((r) => setTimeout(r, 0));
          }

          // Wait for all promises to settle
          await Promise.all(promises);

          // Release any remaining
          while (releases.length > 0) {
            releases.shift()!();
            await new Promise((r) => setTimeout(r, 0));
          }

          // The maximum concurrent should never exceed capacity
          expect(maxConcurrent).toBeLessThanOrEqual(capacity);
        },
      ),
      { numRuns: 100 },
    );
  });
});
