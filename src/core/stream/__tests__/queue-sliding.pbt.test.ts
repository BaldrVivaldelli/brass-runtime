import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { bounded, Queue } from "../queue";
import { asyncFlatMap, asyncSucceed } from "../../types/asyncEffect";
import { Runtime } from "../../runtime/runtime";

/**
 * **Validates: Requirements 5.5, Design Property 10**
 *
 * Propiedad: Queue sliding strategy mantiene los más recientes
 *
 * Para una cola sliding de capacidad C, después de ofrecer N > C elementos,
 * la cola contiene los últimos C elementos en orden FIFO.
 *
 * Esto verifica que la estrategia sliding descarta correctamente los elementos
 * más antiguos y preserva los más recientes, manteniendo el orden FIFO.
 *
 * Generador: Capacidades 1-100 y secuencias de 1-1000 elementos.
 */

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

/**
 * Helper: offer all elements to a sliding queue, then take all remaining.
 * Returns the array of taken elements.
 */
async function offerAllThenDrain(
  capacity: number,
  elements: number[]
): Promise<number[]> {
  const q = await run<Queue<number>>(bounded<number>(capacity, "sliding"));

  // Offer all elements sequentially
  for (const el of elements) {
    await run<boolean>(q.offer(el));
  }

  // Drain all elements from the queue
  const result: number[] = [];
  const currentSize = q.size();
  for (let i = 0; i < currentSize; i++) {
    const val = await run<number>(q.take());
    result.push(val);
  }

  return result;
}

describe("Queue sliding strategy keeps most recent elements (Property 10)", () => {
  it("after offering N > C elements to a sliding queue of capacity C, the queue contains the last C elements in FIFO order", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }),
        fc.array(fc.integer(), { minLength: 1, maxLength: 1000 }),
        async (capacity, elements) => {
          const result = await offerAllThenDrain(capacity, elements);

          // The queue should contain at most `capacity` elements
          const expectedCount = Math.min(capacity, elements.length);
          expect(result).toHaveLength(expectedCount);

          // The elements should be the last `expectedCount` from the input, in order
          const expected = elements.slice(elements.length - expectedCount);
          expect(result).toEqual(expected);
        }
      ),
      { numRuns: 500 }
    );
  });

  it("a sliding queue of capacity C with exactly C elements preserves all of them in order", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }).chain((cap) =>
          fc.tuple(
            fc.constant(cap),
            fc.array(fc.integer(), { minLength: cap, maxLength: cap })
          )
        ),
        async ([capacity, elements]) => {
          const result = await offerAllThenDrain(capacity, elements);
          expect(result).toEqual(elements);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("a sliding queue of capacity C with fewer than C elements preserves all of them in order", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 100 }).chain((cap) =>
          fc.tuple(
            fc.constant(cap),
            fc.array(fc.integer(), {
              minLength: 1,
              maxLength: cap - 1,
            })
          )
        ),
        async ([capacity, elements]) => {
          const result = await offerAllThenDrain(capacity, elements);
          expect(result).toEqual(elements);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("offer always returns true for sliding strategy regardless of buffer state", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.integer(), { minLength: 1, maxLength: 500 }),
        async (capacity, elements) => {
          const q = await run<Queue<number>>(
            bounded<number>(capacity, "sliding")
          );

          for (const el of elements) {
            const accepted = await run<boolean>(q.offer(el));
            expect(accepted).toBe(true);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it("size never exceeds capacity for sliding strategy", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.integer(), { minLength: 1, maxLength: 500 }),
        async (capacity, elements) => {
          const q = await run<Queue<number>>(
            bounded<number>(capacity, "sliding")
          );

          for (const el of elements) {
            await run<boolean>(q.offer(el));
            expect(q.size()).toBeLessThanOrEqual(capacity);
          }
        }
      ),
      { numRuns: 300 }
    );
  });
});
