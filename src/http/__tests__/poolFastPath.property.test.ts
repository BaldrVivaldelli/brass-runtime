import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { HttpConcurrencyPool } from "../pool";

/**
 * Property-based tests for Pool Concurrency Fast-Path stats equivalence.
 * Feature: http-p99-optimization
 */
describe("Pool fast-path property tests", () => {
  /**
   * Property P4: Pool fast-path stats equivalence
   *
   * For any sequence of acquire/release operations on a pool with a given
   * concurrency limit, using tryAcquireSync (with fallback to acquire when it
   * returns undefined) produces identical stats as using acquire alone.
   *
   * Stats fields compared: acquired, released, running, rejected,
   * queueTimeouts, abortedWhileQueued
   *
   * **Validates: Requirement 2.6**
   */
  describe("Property P4: Pool fast-path stats equivalence", () => {
    /**
     * Generate a valid operation sequence that won't deadlock.
     * We track how many leases are held and only generate "release" when
     * there's something to release. We only generate "acquire" when the pool
     * has capacity (running < concurrency) to avoid queuing that would block.
     */
    function validOperationSequence(concurrency: number, length: number) {
      return fc.array(
        fc.double({ min: 0, max: 1, noNaN: true }),
        { minLength: length, maxLength: length },
      ).map((randoms) => {
        const ops: Array<"acquire" | "release"> = [];
        let held = 0;
        for (const r of randoms) {
          if (held === 0) {
            // Must acquire — nothing to release
            ops.push("acquire");
            if (held < concurrency) held++;
          } else if (held >= concurrency) {
            // Must release — pool is full
            ops.push("release");
            held--;
          } else {
            // Can do either
            if (r < 0.6) {
              ops.push("acquire");
              held++;
            } else {
              ops.push("release");
              held--;
            }
          }
        }
        return ops;
      });
    }

    it("tryAcquireSync + acquire fallback produces identical stats as pure acquire for uncontended sequences", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 5, max: 40 }),
          async (concurrency, seqLength) => {
            // Generate a valid sequence that stays within concurrency limits
            const ops = await fc.sample(validOperationSequence(concurrency, seqLength), 1)[0]!;
            const signal = new AbortController().signal;

            // Pool A: uses tryAcquireSync with fallback to acquire
            const poolA = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });
            // Pool B: uses only acquire (reference implementation)
            const poolB = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });

            const leasesA: Array<{ release: () => void }> = [];
            const leasesB: Array<{ release: () => void }> = [];

            for (const op of ops) {
              if (op === "acquire") {
                // Pool A: try sync first, fallback to async
                const syncLease = poolA.tryAcquireSync("test", signal);
                if (syncLease !== undefined) {
                  leasesA.push(syncLease);
                } else {
                  const asyncLease = await poolA.acquire("test", signal);
                  leasesA.push(asyncLease);
                }

                // Pool B: pure acquire
                const lease = await poolB.acquire("test", signal);
                leasesB.push(lease);
              } else {
                // Release the oldest lease
                if (leasesA.length > 0) leasesA.shift()!.release();
                if (leasesB.length > 0) leasesB.shift()!.release();
              }
            }

            const statsA = poolA.stats();
            const statsB = poolB.stats();

            expect(statsA.acquired).toBe(statsB.acquired);
            expect(statsA.released).toBe(statsB.released);
            expect(statsA.running).toBe(statsB.running);
            expect(statsA.rejected).toBe(statsB.rejected);
            expect(statsA.queueTimeouts).toBe(statsB.queueTimeouts);
            expect(statsA.abortedWhileQueued).toBe(statsB.abortedWhileQueued);
          },
        ),
        { numRuns: 100 },
      );
    }, 30000);

    it("tryAcquireSync + acquire fallback produces identical per-key stats for multiple keys", async () => {
      const keys = ["origin-a", "origin-b", "origin-c"] as const;

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 8 }),
          fc.array(
            fc.record({
              action: fc.double({ min: 0, max: 1, noNaN: true }),
              keyIdx: fc.integer({ min: 0, max: 2 }),
            }),
            { minLength: 5, maxLength: 40 },
          ),
          async (concurrency, rawOps) => {
            const signal = new AbortController().signal;

            const poolA = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });
            const poolB = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });

            const leasesA = new Map<string, Array<{ release: () => void }>>();
            const leasesB = new Map<string, Array<{ release: () => void }>>();

            // Track per-key held counts to avoid deadlock
            const heldPerKey = new Map<string, number>();

            for (const { action, keyIdx } of rawOps) {
              const key = keys[keyIdx]!;
              const held = heldPerKey.get(key) ?? 0;

              let doAcquire: boolean;
              if (held === 0) {
                doAcquire = true;
              } else if (held >= concurrency) {
                doAcquire = false;
              } else {
                doAcquire = action < 0.6;
              }

              if (doAcquire) {
                // Pool A: try sync first, fallback to async
                const syncLease = poolA.tryAcquireSync(key, signal);
                if (syncLease !== undefined) {
                  const arr = leasesA.get(key) ?? [];
                  arr.push(syncLease);
                  leasesA.set(key, arr);
                } else {
                  const asyncLease = await poolA.acquire(key, signal);
                  const arr = leasesA.get(key) ?? [];
                  arr.push(asyncLease);
                  leasesA.set(key, arr);
                }

                // Pool B: pure acquire
                const lease = await poolB.acquire(key, signal);
                const arr = leasesB.get(key) ?? [];
                arr.push(lease);
                leasesB.set(key, arr);

                heldPerKey.set(key, held + 1);
              } else {
                // Release oldest lease for this key
                const arrA = leasesA.get(key);
                if (arrA && arrA.length > 0) arrA.shift()!.release();
                const arrB = leasesB.get(key);
                if (arrB && arrB.length > 0) arrB.shift()!.release();
                heldPerKey.set(key, Math.max(0, held - 1));
              }
            }

            const statsA = poolA.stats();
            const statsB = poolB.stats();

            expect(statsA.acquired).toBe(statsB.acquired);
            expect(statsA.released).toBe(statsB.released);
            expect(statsA.running).toBe(statsB.running);
            expect(statsA.rejected).toBe(statsB.rejected);
            expect(statsA.queueTimeouts).toBe(statsB.queueTimeouts);
            expect(statsA.abortedWhileQueued).toBe(statsB.abortedWhileQueued);

            // Also compare per-key stats
            for (const keyStatA of statsA.keys) {
              const keyStatB = statsB.keys.find((k) => k.key === keyStatA.key);
              if (keyStatB) {
                expect(keyStatA.acquired).toBe(keyStatB.acquired);
                expect(keyStatA.released).toBe(keyStatB.released);
                expect(keyStatA.running).toBe(keyStatB.running);
                expect(keyStatA.rejected).toBe(keyStatB.rejected);
                expect(keyStatA.queueTimeouts).toBe(keyStatB.queueTimeouts);
                expect(keyStatA.abortedWhileQueued).toBe(keyStatB.abortedWhileQueued);
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    }, 30000);

    it("fast-path acquire followed by release matches async acquire followed by release for varying concurrency", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 1, max: 30 }),
          async (concurrency, numOps) => {
            const signal = new AbortController().signal;

            const poolA = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });
            const poolB = new HttpConcurrencyPool({ concurrency, maxQueue: 256 });

            const leasesA: Array<{ release: () => void }> = [];
            const leasesB: Array<{ release: () => void }> = [];

            // Acquire up to concurrency leases, then release them all.
            // This ensures we never exceed concurrency and never deadlock.
            const acquireCount = Math.min(numOps, concurrency);

            for (let i = 0; i < acquireCount; i++) {
              // Pool A: tryAcquireSync + fallback
              const syncLease = poolA.tryAcquireSync("key", signal);
              if (syncLease !== undefined) {
                leasesA.push(syncLease);
              } else {
                const asyncLease = await poolA.acquire("key", signal);
                leasesA.push(asyncLease);
              }

              // Pool B: pure acquire
              const lease = await poolB.acquire("key", signal);
              leasesB.push(lease);
            }

            // Release all
            for (const lease of leasesA) lease.release();
            for (const lease of leasesB) lease.release();

            const statsA = poolA.stats();
            const statsB = poolB.stats();

            expect(statsA.acquired).toBe(statsB.acquired);
            expect(statsA.released).toBe(statsB.released);
            expect(statsA.running).toBe(statsB.running);
            expect(statsA.rejected).toBe(statsB.rejected);
            expect(statsA.queueTimeouts).toBe(statsB.queueTimeouts);
            expect(statsA.abortedWhileQueued).toBe(statsB.abortedWhileQueued);
          },
        ),
        { numRuns: 100 },
      );
    }, 30000);
  });
});
