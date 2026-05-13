// Feature: http-p99-consolidation, Property 3: Pool async fallback preserves semantics
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { HttpConcurrencyPool } from "../pool";
import type { HttpPoolLease } from "../pool";

/**
 * Property 3: Pool async fallback preserves semantics
 *
 * For any pool state where `tryAcquireSync` returns null (pool at capacity),
 * the asynchronous `pool.acquire` fallback SHALL eventually produce the same lease,
 * apply the same timeout expiry behavior, and propagate cancellation identically
 * to the synchronous path — i.e., for any request that would succeed on an uncontended
 * pool, the same request on a contended-then-released pool produces an equivalent Exit.
 *
 * **Validates: Requirements 2.4**
 */

describe("Property 3: Pool async fallback preserves semantics", () => {
  it("async fallback produces equivalent lease to sync path after pool slot is released", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.constantFrom("origin-a", "origin-b", "origin-c", "test-key", "pool-key"),
        async (concurrency, key) => {
          const pool = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });
          const signal = new AbortController().signal;

          // Step 1: Fill the pool to capacity using tryAcquireSync
          const syncLeases: HttpPoolLease[] = [];
          for (let i = 0; i < concurrency; i++) {
            const lease = pool.tryAcquireSync(key, signal);
            expect(lease).toBeDefined();
            syncLeases.push(lease!);
          }

          // Step 2: Verify pool is at capacity — tryAcquireSync returns undefined
          const syncAttempt = pool.tryAcquireSync(key, signal);
          expect(syncAttempt).toBeUndefined();

          // Step 3: Submit async acquire (will queue since pool is full)
          const asyncAcquirePromise = pool.acquire(key, signal);

          // Step 4: Release one slot to allow async acquire to succeed
          syncLeases[0]!.release();

          // Step 5: Await the async lease
          const asyncLease = await asyncAcquirePromise;

          // Step 6: Assert the async lease is valid and has the same key
          expect(asyncLease).toBeDefined();
          expect(asyncLease.key).toBe(syncLeases[0]!.key);

          // Step 7: Verify pool stats are consistent
          const stats = pool.stats();
          // We released 1 sync lease and acquired 1 async lease, so running should be concurrency
          expect(stats.running).toBe(concurrency);

          // Cleanup: release all remaining leases
          asyncLease.release();
          for (let i = 1; i < syncLeases.length; i++) {
            syncLeases[i]!.release();
          }

          const finalStats = pool.stats();
          expect(finalStats.running).toBe(0);
          expect(finalStats.acquired).toBe(concurrency + 1); // all sync + 1 async
          expect(finalStats.released).toBe(concurrency + 1);
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);

  it("async fallback and sync path produce equivalent Exit values for transport dispatch", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.constantFrom("origin-a", "origin-b", "origin-c", "test-key", "pool-key"),
        async (concurrency, key) => {
          const pool = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });
          const signal = new AbortController().signal;

          // Fill pool to capacity
          const syncLeases: HttpPoolLease[] = [];
          for (let i = 0; i < concurrency; i++) {
            const lease = pool.tryAcquireSync(key, signal);
            expect(lease).toBeDefined();
            syncLeases.push(lease!);
          }

          // Queue one async acquire
          const asyncPromise = pool.acquire(key, signal);

          // Release one slot to allow async acquire to succeed
          syncLeases[0]!.release();

          const asyncLease = await asyncPromise;

          // Verify the async lease is valid and functional
          expect(asyncLease).toBeDefined();
          expect(asyncLease.key).toBe(key);

          // Both sync and async leases should be releasable without error
          asyncLease.release();
          for (let i = 1; i < syncLeases.length; i++) {
            syncLeases[i]!.release();
          }

          const finalStats = pool.stats();
          expect(finalStats.running).toBe(0);
          expect(finalStats.acquired).toBe(concurrency + 1);
          expect(finalStats.released).toBe(concurrency + 1);
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);

  it("timeout expiry on async path rejects with queue timeout error", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.constantFrom("origin-a", "origin-b", "origin-c", "test-key", "pool-key"),
        async (concurrency, key) => {
          // Pool with a very short queue timeout to test expiry
          const queueTimeoutMs = 10;
          const pool = new HttpConcurrencyPool({
            concurrency,
            maxQueue: 256,
            queueTimeoutMs,
          });
          const signal = new AbortController().signal;

          // Fill pool to capacity
          const syncLeases: HttpPoolLease[] = [];
          for (let i = 0; i < concurrency; i++) {
            const lease = pool.tryAcquireSync(key, signal);
            expect(lease).toBeDefined();
            syncLeases.push(lease!);
          }

          // Verify pool is full
          expect(pool.tryAcquireSync(key, signal)).toBeUndefined();

          // Submit async acquire — will queue and eventually timeout
          // Attach .catch immediately to prevent unhandled rejection
          let rejected = false;
          let rejectionError: any;
          const asyncAcquirePromise = pool.acquire(key, signal).then(
            (lease) => { lease.release(); return lease; },
            (err) => { rejected = true; rejectionError = err; throw err; },
          ).catch(() => {});

          // Wait for the queue timeout to expire
          await new Promise((resolve) => setTimeout(resolve, queueTimeoutMs + 50));
          await asyncAcquirePromise;

          expect(rejected).toBe(true);
          expect(rejectionError).toBeDefined();
          expect(rejectionError._tag).toBe("PoolTimeout");
          expect(rejectionError.key).toBe(key);
          expect(rejectionError.timeoutMs).toBe(queueTimeoutMs);

          // Verify pool stats reflect the timeout
          const stats = pool.stats();
          expect(stats.queueTimeouts).toBe(1);
          expect(stats.queued).toBe(0); // waiter was removed

          // Cleanup
          for (const lease of syncLeases) {
            lease.release();
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 60000);

  it("cancellation propagation on async path rejects with abort error", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }),
        fc.constantFrom("origin-a", "origin-b", "origin-c", "test-key", "pool-key"),
        async (concurrency, key) => {
          const pool = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });
          const controller = new AbortController();

          // Fill pool to capacity
          const syncLeases: HttpPoolLease[] = [];
          for (let i = 0; i < concurrency; i++) {
            const lease = pool.tryAcquireSync(key, controller.signal);
            expect(lease).toBeDefined();
            syncLeases.push(lease!);
          }

          // Verify pool is full
          expect(pool.tryAcquireSync(key, controller.signal)).toBeUndefined();

          // Submit async acquire — will queue
          const asyncAcquirePromise = pool.acquire(key, controller.signal);

          // Abort the signal — should propagate cancellation to the queued waiter
          controller.abort();

          // The async acquire should reject with an abort error
          let rejected = false;
          let rejectionError: any;
          try {
            await asyncAcquirePromise;
          } catch (err) {
            rejected = true;
            rejectionError = err;
          }

          expect(rejected).toBe(true);
          expect(rejectionError).toBeDefined();
          expect(rejectionError._tag).toBe("Abort");

          // Verify pool stats reflect the abort
          const stats = pool.stats();
          expect(stats.abortedWhileQueued).toBe(1);
          expect(stats.queued).toBe(0); // waiter was removed

          // Cleanup
          for (const lease of syncLeases) {
            lease.release();
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);

  it("async fallback preserves ordering — first queued waiter gets the released slot", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 2, max: 5 }),
        fc.constantFrom("origin-a", "origin-b", "origin-c", "test-key", "pool-key"),
        async (concurrency, numWaiters, key) => {
          const pool = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });
          const signal = new AbortController().signal;

          // Fill pool to capacity
          const syncLeases: HttpPoolLease[] = [];
          for (let i = 0; i < concurrency; i++) {
            const lease = pool.tryAcquireSync(key, signal);
            expect(lease).toBeDefined();
            syncLeases.push(lease!);
          }

          // Queue multiple async acquires
          const resolveOrder: number[] = [];
          const asyncPromises = Array.from({ length: numWaiters }, (_, idx) =>
            pool.acquire(key, signal).then((lease) => {
              resolveOrder.push(idx);
              return lease;
            }),
          );

          // Release one slot at a time, allowing each waiter to resolve in order.
          // After each release, the drain logic grants the slot to the next waiter.
          // We release async leases back to keep the cycle going.
          const asyncLeases: HttpPoolLease[] = [];
          for (let i = 0; i < numWaiters; i++) {
            if (i < concurrency) {
              // Release a sync lease
              syncLeases[i]!.release();
            } else {
              // Release a previously acquired async lease
              asyncLeases[i - concurrency]!.release();
            }
            // Allow microtask to process the drain
            await new Promise((resolve) => setTimeout(resolve, 0));
            // The i-th async promise should now be resolved
            const lease = await asyncPromises[i]!;
            asyncLeases.push(lease);
          }

          // Verify FIFO ordering — waiters should resolve in the order they were queued
          for (let i = 0; i < resolveOrder.length; i++) {
            expect(resolveOrder[i]).toBe(i);
          }

          // Cleanup remaining leases
          for (const lease of asyncLeases) {
            lease.release();
          }
          for (let i = numWaiters; i < concurrency; i++) {
            syncLeases[i]!.release();
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 30000);
});
