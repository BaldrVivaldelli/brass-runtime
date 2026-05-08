import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { clampPriority, PriorityQueue } from "../lifecycle/priorityQueue";

/**
 * Property-based tests for priority queue ordering behavior.
 * Feature: http-lifecycle-client
 */
describe("PriorityQueue property tests", () => {
  /**
   * Property 13: Priority ordering with FIFO tiebreak
   *
   * For any set of N queued requests with priorities P₁..Pₙ and arrival orders A₁..Aₙ,
   * the dispatch order SHALL satisfy: request X is dispatched before request Y
   * if and only if (Pₓ < Pᵧ) OR (Pₓ = Pᵧ AND Aₓ < Aᵧ).
   *
   * **Validates: Requirements 4.1, 4.2, 4.3, 4.5**
   */
  describe("Property 13: Priority ordering with FIFO tiebreak", () => {
    /** Arbitrary for a valid priority value (0-9) */
    const arbPriority = fc.integer({ min: 0, max: 9 });

    /** Arbitrary for a queue entry with a label and priority */
    const arbEntry = fc.record({
      label: fc.string({ minLength: 1, maxLength: 10 }),
      priority: arbPriority,
    });

    it("dequeue order satisfies priority ascending then arrival order ascending", () => {
      fc.assert(
        fc.property(
          fc.array(arbEntry, { minLength: 2, maxLength: 50 }),
          (entries) => {
            const queue = new PriorityQueue<string>();

            // Enqueue all entries in order — arrivalOrder is assigned sequentially
            for (const entry of entries) {
              queue.enqueue(entry.label, entry.priority);
            }

            // Dequeue all entries and collect the results
            const dequeued: Array<{ priority: number; arrivalOrder: number }> = [];
            let item = queue.dequeue();
            while (item !== undefined) {
              dequeued.push({ priority: item.priority, arrivalOrder: item.arrivalOrder });
              item = queue.dequeue();
            }

            // Verify all entries were dequeued
            expect(dequeued.length).toBe(entries.length);

            // Verify ordering: for every consecutive pair, X before Y means
            // (Px < Py) OR (Px === Py AND Ax < Ay)
            for (let i = 0; i < dequeued.length - 1; i++) {
              const x = dequeued[i]!;
              const y = dequeued[i + 1]!;

              const correctOrder =
                x.priority < y.priority ||
                (x.priority === y.priority && x.arrivalOrder < y.arrivalOrder);

              expect(correctOrder).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("higher-priority entries (lower numeric value) are always dispatched before lower-priority entries", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 8 }),
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 1, max: 20 }),
          (highPriority, numHigh, numLow) => {
            const lowPriority = highPriority + 1; // guaranteed higher numeric = lower priority
            const queue = new PriorityQueue<string>();

            // Enqueue low-priority entries first
            for (let i = 0; i < numLow; i++) {
              queue.enqueue(`low-${i}`, lowPriority);
            }

            // Enqueue high-priority entries after (later arrival)
            for (let i = 0; i < numHigh; i++) {
              queue.enqueue(`high-${i}`, highPriority);
            }

            // All high-priority entries should be dequeued before any low-priority entry
            for (let i = 0; i < numHigh; i++) {
              const item = queue.dequeue();
              expect(item).toBeDefined();
              expect(item!.priority).toBe(highPriority);
            }

            for (let i = 0; i < numLow; i++) {
              const item = queue.dequeue();
              expect(item).toBeDefined();
              expect(item!.priority).toBe(lowPriority);
            }

            // Queue should be empty
            expect(queue.dequeue()).toBeUndefined();
          },
        ),
        { numRuns: 100 },
      );
    });

    it("entries with the same priority are dispatched in FIFO (arrival) order", () => {
      fc.assert(
        fc.property(
          arbPriority,
          fc.integer({ min: 2, max: 30 }),
          (priority, count) => {
            const queue = new PriorityQueue<number>();

            // Enqueue entries with the same priority
            for (let i = 0; i < count; i++) {
              queue.enqueue(i, priority);
            }

            // Dequeue and verify FIFO order
            for (let i = 0; i < count; i++) {
              const item = queue.dequeue();
              expect(item).toBeDefined();
              expect(item!.value).toBe(i);
              expect(item!.arrivalOrder).toBe(i);
            }

            expect(queue.dequeue()).toBeUndefined();
          },
        ),
        { numRuns: 100 },
      );
    });

    it("inserting a higher-priority entry after lower-priority entries places it ahead in dispatch order", () => {
      fc.assert(
        fc.property(
          fc.array(arbEntry, { minLength: 1, maxLength: 30 }),
          fc.integer({ min: 0, max: 9 }),
          (existingEntries, insertPriority) => {
            const queue = new PriorityQueue<string>();

            // Enqueue existing entries
            for (const entry of existingEntries) {
              queue.enqueue(entry.label, entry.priority);
            }

            // Insert a new entry
            const inserted = queue.enqueue("inserted", insertPriority);

            // Dequeue all and find the position of the inserted entry
            const dequeued: Array<{ priority: number; arrivalOrder: number }> = [];
            let item = queue.dequeue();
            while (item !== undefined) {
              dequeued.push({ priority: item.priority, arrivalOrder: item.arrivalOrder });
              item = queue.dequeue();
            }

            // Find the inserted entry's position
            const insertedIdx = dequeued.findIndex(
              (d) => d.arrivalOrder === inserted.arrivalOrder,
            );
            expect(insertedIdx).toBeGreaterThanOrEqual(0);

            // Verify all entries before the inserted one have higher or equal priority
            for (let i = 0; i < insertedIdx; i++) {
              const before = dequeued[i]!;
              const correctlyBefore =
                before.priority < inserted.priority ||
                (before.priority === inserted.priority &&
                  before.arrivalOrder < inserted.arrivalOrder);
              expect(correctlyBefore).toBe(true);
            }

            // Verify all entries after the inserted one have lower or equal priority
            for (let i = insertedIdx + 1; i < dequeued.length; i++) {
              const after = dequeued[i]!;
              const correctlyAfter =
                after.priority > inserted.priority ||
                (after.priority === inserted.priority &&
                  after.arrivalOrder > inserted.arrivalOrder);
              expect(correctlyAfter).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("the full dequeue sequence is a total order consistent with (priority, arrivalOrder)", () => {
      fc.assert(
        fc.property(
          fc.array(arbPriority, { minLength: 1, maxLength: 50 }),
          (priorities) => {
            const queue = new PriorityQueue<number>();

            // Enqueue entries with the given priorities
            for (let i = 0; i < priorities.length; i++) {
              queue.enqueue(i, priorities[i]);
            }

            // Dequeue all and verify total ordering
            const dequeued: Array<{ priority: number; arrivalOrder: number }> = [];
            let item = queue.dequeue();
            while (item !== undefined) {
              dequeued.push({ priority: item.priority, arrivalOrder: item.arrivalOrder });
              item = queue.dequeue();
            }

            expect(dequeued.length).toBe(priorities.length);

            // Verify the sequence is sorted by (priority, arrivalOrder)
            for (let i = 0; i < dequeued.length - 1; i++) {
              const a = dequeued[i]!;
              const b = dequeued[i + 1]!;

              if (a.priority === b.priority) {
                // Same priority: must be in arrival order
                expect(a.arrivalOrder).toBeLessThan(b.arrivalOrder);
              } else {
                // Different priority: lower priority value comes first
                expect(a.priority).toBeLessThan(b.priority);
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 14: Priority clamping
   *
   * For any numeric priority value V, the effective priority SHALL equal
   * `clamp(Math.trunc(V), 0, 9)`.
   *
   * **Validates: Requirements 4.6**
   */
  describe("Property 14: Priority clamping", () => {
    /** Reference implementation of the expected clamping behavior */
    function expectedClamp(value: number): number {
      return Math.max(0, Math.min(9, Math.trunc(value)));
    }

    it("clampPriority equals clamp(Math.trunc(V), 0, 9) for all finite numbers", () => {
      fc.assert(
        fc.property(
          fc.double({ min: -1e10, max: 1e10, noNaN: true, noDefaultInfinity: true }),
          (value) => {
            const result = clampPriority(value);
            const expected = expectedClamp(value);
            expect(result).toBe(expected);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("clampPriority clamps large positive values to 9", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 9.01, max: 1e15, noNaN: true, noDefaultInfinity: true }),
          (value) => {
            const result = clampPriority(value);
            expect(result).toBe(9);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("clampPriority clamps negative values to 0", () => {
      fc.assert(
        fc.property(
          fc.double({ min: -1e15, max: -0.01, noNaN: true, noDefaultInfinity: true }),
          (value) => {
            const result = clampPriority(value);
            expect(result).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("clampPriority truncates fractional values toward zero before clamping", () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 9.999, noNaN: true, noDefaultInfinity: true }),
          (value) => {
            const result = clampPriority(value);
            const expected = expectedClamp(value);
            expect(result).toBe(expected);
            // Result should always be an integer
            expect(Number.isInteger(result)).toBe(true);
            // Result should be in [0, 9]
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(9);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("clampPriority returns default 5 for NaN and Infinity", () => {
      expect(clampPriority(NaN)).toBe(5);
      expect(clampPriority(Infinity)).toBe(5);
      expect(clampPriority(-Infinity)).toBe(5);
      expect(clampPriority(undefined)).toBe(5);
    });

    it("clampPriority always produces an integer in [0, 9] for any numeric input", () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.double({ noNaN: true, noDefaultInfinity: true }),
            fc.integer({ min: -1000, max: 1000 }),
          ),
          (value) => {
            const result = clampPriority(value);
            expect(Number.isInteger(result)).toBe(true);
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(9);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("enqueue applies clamping so effective priority is always in [0, 9]", () => {
      fc.assert(
        fc.property(
          fc.double({ min: -1e10, max: 1e10, noNaN: true, noDefaultInfinity: true }),
          (value) => {
            const queue = new PriorityQueue<string>();
            const entry = queue.enqueue("test", value);
            const expected = expectedClamp(value);
            expect(entry.priority).toBe(expected);
          },
        ),
        { numRuns: 200 },
      );
    });

    it("enqueue with integer priorities in [0, 9] preserves the value unchanged", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 9 }),
          (value) => {
            const queue = new PriorityQueue<string>();
            const entry = queue.enqueue("test", value);
            expect(entry.priority).toBe(value);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
