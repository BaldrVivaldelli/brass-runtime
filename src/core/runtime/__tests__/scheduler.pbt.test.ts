import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Scheduler } from "../scheduler";

/**
 * **Validates: Requirements 1.2**
 *
 * Propiedad 15: Scheduler drena hasta FLUSH_BUDGET tareas por flush
 * Cuando se encolan N tareas, un flush procesa min(N, FLUSH_BUDGET).
 *
 * Generador: Generar N (1-10000).
 *
 * Strategy: We create a fresh Scheduler with internal RingBuffers large enough
 * to hold up to 10000 tasks (the max N). We enqueue N tasks that increment a
 * counter, then wait for exactly one microtask tick to let the first flush run.
 * After one flush, the counter should equal min(N, FLUSH_BUDGET).
 *
 * FLUSH_BUDGET is 2048 as defined in scheduler.ts.
 *
 * Note: The default Scheduler uses RingBuffer(1024) with maxCap=1024, which
 * would drop tasks beyond 1024. To properly test the FLUSH_BUDGET property
 * across the full range of N (1-10000), we replace the internal buffers with
 * ones that have sufficient capacity.
 */

const FLUSH_BUDGET = 2048;

/**
 * Creates a Scheduler whose internal RingBuffers can hold up to `capacity` items,
 * allowing us to test FLUSH_BUDGET behavior without buffer-level drops.
 */
function createLargeCapacityScheduler(capacity: number): Scheduler {
  return new Scheduler({
    engine: "js",
    initialCapacity: capacity,
    maxCapacity: capacity,
    laneCapacity: capacity,
    maxLanes: 1,
    flushBudget: FLUSH_BUDGET,
  });
}

/**
 * Helper: waits for one microtask tick, which allows the scheduler's
 * first flush to execute (since it uses queueMicrotask for micro scheduling).
 */
function nextMicrotask(): Promise<void> {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("Scheduler drena hasta FLUSH_BUDGET tareas por flush (Property 15)", () => {
  it("for N enqueued tasks, a single flush processes exactly min(N, FLUSH_BUDGET) tasks", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10000 }),
        async (n) => {
          const scheduler = createLargeCapacityScheduler(16384);
          let executed = 0;

          // Enqueue all N tasks synchronously before any flush can run
          for (let i = 0; i < n; i++) {
            scheduler.schedule(() => { executed++; }, `lane:test|task-${i}`);
          }

          // At this point, no tasks have been executed yet because
          // the flush is scheduled via queueMicrotask (deferred).
          expect(executed).toBe(0);

          // Wait for exactly one microtask tick — this triggers the first flush.
          // The flush will drain up to FLUSH_BUDGET tasks and then yield.
          await nextMicrotask();

          const expected = Math.min(n, FLUSH_BUDGET);
          expect(executed).toBe(expected);
        }
      ),
      { numRuns: 200 }
    );
  });
});
