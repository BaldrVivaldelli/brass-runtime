import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { LRUCache } from "../lifecycle/lruCache";

/**
 * Property-based tests for LRU cache eviction behavior.
 * Feature: http-lifecycle-client
 */
describe("LRUCache property tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Property 10: LRU eviction at capacity
   *
   * For any cache with maxEntries = M that currently holds M entries,
   * inserting a new entry SHALL evict exactly the least-recently-used entry
   * (the entry with the oldest last-access time).
   *
   * **Validates: Requirements 3.4**
   */
  describe("Property 10: LRU eviction at capacity", () => {
    /** Arbitrary for cache capacity (small to keep tests fast) */
    const arbMaxEntries = fc.integer({ min: 1, max: 20 });

    /** Arbitrary for a unique key */
    const arbKey = fc.stringMatching(/^[a-z][a-z0-9]{0,9}$/).filter((s) => s.length >= 1);

    /** Arbitrary for a cache value */
    const arbValue = fc.string({ minLength: 1, maxLength: 20 });

    /** TTL large enough to never expire during tests */
    const LONG_TTL = 60_000;

    /**
     * Operation type for generating sequences of get/set operations.
     * - "set": insert a new key-value pair
     * - "get": access an existing key (making it MRU)
     */
    type CacheOp =
      | { type: "set"; key: string; value: string }
      | { type: "get"; key: string };

    it("evicts the least-recently-used entry when inserting beyond capacity", () => {
      fc.assert(
        fc.property(
          arbMaxEntries,
          fc.array(arbKey, { minLength: 2, maxLength: 30 }).chain((keys) => {
            // Ensure we have at least M+1 unique keys
            const uniqueKeys = [...new Set(keys)];
            return fc.constant(uniqueKeys).filter((ks) => ks.length >= 2);
          }),
          arbValue,
          (maxEntries, uniqueKeys, value) => {
            // Ensure we have enough unique keys to fill the cache + 1
            if (uniqueKeys.length <= maxEntries) return; // skip if not enough keys

            const cache = new LRUCache<string>({ maxEntries });

            // Fill the cache to capacity with the first M keys
            const fillKeys = uniqueKeys.slice(0, maxEntries);
            for (const key of fillKeys) {
              cache.set(key, value, LONG_TTL);
            }

            expect(cache.size).toBe(maxEntries);

            // The LRU entry is the first one inserted (fillKeys[0])
            // since no get operations have been performed
            const lruKey = fillKeys[0];

            // Insert one more entry (the M+1th key)
            const newKey = uniqueKeys[maxEntries];
            cache.set(newKey, value, LONG_TTL);

            // Size should still be maxEntries (one was evicted)
            expect(cache.size).toBe(maxEntries);

            // The LRU entry should have been evicted
            expect(cache.get(lruKey)).toBeUndefined();

            // The new entry should be present
            expect(cache.get(newKey)).toBe(value);

            // All other entries (except the evicted one) should still be present
            for (let i = 1; i < maxEntries; i++) {
              expect(cache.get(fillKeys[i])).toBe(value);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("get operations update recency, changing which entry is evicted", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 15 }),
          fc.array(arbKey, { minLength: 5, maxLength: 30 }).chain((keys) => {
            const uniqueKeys = [...new Set(keys)];
            return fc.constant(uniqueKeys).filter((ks) => ks.length >= 5);
          }),
          arbValue,
          (maxEntries, uniqueKeys, value) => {
            if (uniqueKeys.length <= maxEntries) return;

            const cache = new LRUCache<string>({ maxEntries });

            // Fill the cache to capacity
            const fillKeys = uniqueKeys.slice(0, maxEntries);
            for (const key of fillKeys) {
              cache.set(key, value, LONG_TTL);
            }

            // Access the first entry (originally LRU) to make it MRU
            cache.get(fillKeys[0]);

            // Now the LRU entry is fillKeys[1] (second inserted, never accessed since)
            const expectedLruKey = fillKeys[1];

            // Insert a new entry to trigger eviction
            const newKey = uniqueKeys[maxEntries];
            cache.set(newKey, value, LONG_TTL);

            // The entry that was second-oldest (now LRU) should be evicted
            expect(cache.get(expectedLruKey)).toBeUndefined();

            // The first entry (which was accessed) should still be present
            expect(cache.get(fillKeys[0])).toBe(value);

            // The new entry should be present
            expect(cache.get(newKey)).toBe(value);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("sequences of get/set operations maintain correct LRU ordering for eviction", () => {
      /**
       * Generate a sequence of operations on a cache, then verify that
       * eviction targets the correct LRU entry.
       */
      const arbOpsScenario = fc
        .integer({ min: 2, max: 10 })
        .chain((maxEntries) => {
          // Generate M+1 unique keys
          const numKeys = maxEntries + 1;
          return fc
            .uniqueArray(arbKey, { minLength: numKeys, maxLength: numKeys + 5 })
            .filter((ks) => ks.length >= numKeys)
            .chain((uniqueKeys) => {
              const fillKeys = uniqueKeys.slice(0, maxEntries);
              const extraKey = uniqueKeys[maxEntries];

              // Generate a sequence of get operations on existing keys
              // (0 to maxEntries-1 operations to shuffle recency)
              const arbGetOps = fc.array(
                fc.integer({ min: 0, max: maxEntries - 1 }),
                { minLength: 0, maxLength: maxEntries * 2 },
              );

              return arbGetOps.map((getIndices) => ({
                maxEntries,
                fillKeys,
                extraKey,
                getIndices,
              }));
            });
        });

      fc.assert(
        fc.property(arbOpsScenario, ({ maxEntries, fillKeys, extraKey, getIndices }) => {
          const cache = new LRUCache<string>({ maxEntries });

          // Fill the cache to capacity
          for (const key of fillKeys) {
            cache.set(key, "v", LONG_TTL);
          }

          // Track recency: maintain a list ordered from MRU to LRU
          // Initially, the last inserted is MRU, first inserted is LRU
          const recencyOrder = [...fillKeys]; // index 0 = oldest (LRU), last = newest (MRU)

          // Apply get operations — each get moves the accessed key to MRU position
          for (const idx of getIndices) {
            if (idx < fillKeys.length) {
              const key = fillKeys[idx];
              cache.get(key);

              // Update recency tracking: move to end (MRU)
              const pos = recencyOrder.indexOf(key);
              if (pos !== -1) {
                recencyOrder.splice(pos, 1);
                recencyOrder.push(key);
              }
            }
          }

          // The LRU entry is at index 0 of recencyOrder
          const expectedLruKey = recencyOrder[0];

          // Insert a new entry to trigger eviction
          cache.set(extraKey, "new", LONG_TTL);

          // Verify the LRU entry was evicted
          expect(cache.get(expectedLruKey)).toBeUndefined();

          // Verify the new entry exists
          expect(cache.get(extraKey)).toBe("new");

          // Verify size is still maxEntries
          // (size may be maxEntries because we just did gets which could
          // have moved things around, but the cache should not exceed capacity)
          expect(cache.size).toBeLessThanOrEqual(maxEntries);
        }),
        { numRuns: 100 },
      );
    });

    it("eviction callback is invoked exactly once per eviction at capacity", () => {
      fc.assert(
        fc.property(
          arbMaxEntries,
          fc.integer({ min: 1, max: 10 }),
          arbValue,
          (maxEntries, extraInserts, value) => {
            const onEvict = vi.fn();
            const cache = new LRUCache<string>({ maxEntries, onEvict });

            // Fill to capacity with unique keys
            for (let i = 0; i < maxEntries; i++) {
              cache.set(`fill-${i}`, value, LONG_TTL);
            }

            expect(onEvict).not.toHaveBeenCalled();

            // Insert extra entries beyond capacity
            for (let i = 0; i < extraInserts; i++) {
              cache.set(`extra-${i}`, value, LONG_TTL);
            }

            // onEvict should have been called once per extra insert
            expect(onEvict).toHaveBeenCalledTimes(extraInserts);

            // Each call should have been invoked with count=1
            for (let i = 0; i < extraInserts; i++) {
              expect(onEvict).toHaveBeenNthCalledWith(i + 1, 1);
            }

            // Size should remain at maxEntries
            expect(cache.size).toBe(maxEntries);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("size never exceeds maxEntries regardless of operation sequence", () => {
      const arbOps = (keys: string[]) =>
        fc.array(
          fc.oneof(
            fc.record({
              type: fc.constant("set" as const),
              key: fc.constantFrom(...keys),
              value: arbValue,
            }),
            fc.record({
              type: fc.constant("get" as const),
              key: fc.constantFrom(...keys),
            }),
          ),
          { minLength: 1, maxLength: 50 },
        );

      fc.assert(
        fc.property(
          arbMaxEntries,
          fc.uniqueArray(arbKey, { minLength: 3, maxLength: 30 }).filter((ks) => ks.length >= 3),
          (maxEntries, keys) => {
            return fc.assert(
              fc.property(arbOps(keys), (ops) => {
                const cache = new LRUCache<string>({ maxEntries });

                for (const op of ops) {
                  if (op.type === "set") {
                    cache.set(op.key, op.value, LONG_TTL);
                  } else {
                    cache.get(op.key);
                  }

                  // Invariant: size never exceeds maxEntries
                  expect(cache.size).toBeLessThanOrEqual(maxEntries);
                }
              }),
              { numRuns: 20 },
            );
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
