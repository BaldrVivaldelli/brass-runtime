import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { LinkedQueue, Node } from "../linkedQueue";

/**
 * **Validates: Requirements 5.3**
 *
 * Propiedad 9: LinkedQueue push/shift/remove correctitud
 * Para cualquier secuencia de operaciones push, shift y remove,
 * la LinkedQueue mantiene el estado correcto.
 *
 * Generador: Secuencias de operaciones (push value, shift, remove node) aleatorias.
 */

type PushOp = { type: "push"; value: number };
type ShiftOp = { type: "shift" };
type RemoveOp = { type: "remove"; index: number };
type QueueOp = PushOp | ShiftOp | RemoveOp;

const pushOp: fc.Arbitrary<PushOp> = fc.integer().map((value) => ({
  type: "push" as const,
  value,
}));

const shiftOp: fc.Arbitrary<ShiftOp> = fc.constant({ type: "shift" as const });

const removeOp: fc.Arbitrary<RemoveOp> = fc
  .nat({ max: 999 })
  .map((index) => ({ type: "remove" as const, index }));

const queueOp: fc.Arbitrary<QueueOp> = fc.oneof(
  { weight: 3, arbitrary: pushOp },
  { weight: 2, arbitrary: shiftOp },
  { weight: 2, arbitrary: removeOp }
);

const opsArb: fc.Arbitrary<QueueOp[]> = fc.array(queueOp, {
  minLength: 1,
  maxLength: 200,
});

/**
 * Helper: execute a sequence of operations on a LinkedQueue and a reference model,
 * returning the shifted values from both.
 */
function executeOps(ops: QueueOp[]) {
  const queue = new LinkedQueue<number>();
  const nodes: Node<number>[] = [];
  // Reference model: array of { value, removed } tracking logical queue state
  const model: { value: number; removed: boolean }[] = [];
  const shiftedQueue: (number | undefined)[] = [];
  const shiftedModel: (number | undefined)[] = [];

  for (const op of ops) {
    switch (op.type) {
      case "push": {
        const node = queue.push(op.value);
        nodes.push(node);
        model.push({ value: op.value, removed: false });
        break;
      }
      case "shift": {
        const val = queue.shift();
        shiftedQueue.push(val);
        // Model: find first non-removed entry
        const idx = model.findIndex((e) => !e.removed);
        if (idx >= 0) {
          shiftedModel.push(model[idx].value);
          model[idx].removed = true;
        } else {
          shiftedModel.push(undefined);
        }
        break;
      }
      case "remove": {
        if (nodes.length > 0) {
          const nodeIdx = op.index % nodes.length;
          const node = nodes[nodeIdx];
          queue.remove(node);
          // Model: mark the corresponding entry as removed (if not already)
          const modelIdx = model.findIndex(
            (e) => e.value === node.value && !e.removed
          );
          if (modelIdx >= 0) {
            model[modelIdx].removed = true;
          }
        }
        break;
      }
    }
  }

  // Count remaining (non-removed) entries in model
  const modelLength = model.filter((e) => !e.removed).length;

  return { queue, nodes, model, shiftedQueue, shiftedModel, modelLength };
}

describe("LinkedQueue push/shift/remove correctitud (Property 9)", () => {
  it("FIFO ordering: elements shifted come out in push order, excluding removed elements", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const { shiftedQueue, shiftedModel } = executeOps(ops);
        expect(shiftedQueue).toEqual(shiftedModel);
      }),
      { numRuns: 500 }
    );
  });

  it("length consistency: length always equals the number of elements logically in the queue", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const queue = new LinkedQueue<number>();
        const nodes: Node<number>[] = [];
        let expectedLength = 0;

        for (const op of ops) {
          switch (op.type) {
            case "push": {
              const node = queue.push(op.value);
              nodes.push(node);
              expectedLength++;
              break;
            }
            case "shift": {
              const val = queue.shift();
              if (val !== undefined) {
                expectedLength--;
              }
              break;
            }
            case "remove": {
              if (nodes.length > 0) {
                const nodeIdx = op.index % nodes.length;
                const node = nodes[nodeIdx];
                if (!node.removed) {
                  expectedLength--;
                }
                queue.remove(node);
              }
              break;
            }
          }
          expect(queue.length).toBe(expectedLength);
        }
      }),
      { numRuns: 500 }
    );
  });

  it("remove correctness: after removing a node, its value is never shifted out and remaining elements maintain FIFO order", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const queue = new LinkedQueue<number>();
        const nodes: Node<number>[] = [];
        const removedNodes = new Set<Node<number>>();
        const pushed: number[] = [];

        // Execute only push and remove ops
        for (const op of ops) {
          if (op.type === "push") {
            const node = queue.push(op.value);
            nodes.push(node);
            pushed.push(op.value);
          } else if (op.type === "remove" && nodes.length > 0) {
            const nodeIdx = op.index % nodes.length;
            const node = nodes[nodeIdx];
            queue.remove(node);
            removedNodes.add(node);
          }
        }

        // Build expected BEFORE draining (since shift marks nodes as removed)
        const expected: number[] = [];
        for (let i = 0; i < nodes.length; i++) {
          if (!removedNodes.has(nodes[i])) {
            expected.push(pushed[i]);
          }
        }

        // Drain the queue
        const drained: number[] = [];
        let val = queue.shift();
        while (val !== undefined) {
          drained.push(val);
          val = queue.shift();
        }

        expect(drained).toEqual(expected);
      }),
      { numRuns: 500 }
    );
  });

  it("remove idempotency: removing an already-removed node is a no-op", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 1, maxLength: 50 }),
        fc.nat({ max: 49 }),
        (values, removeIdx) => {
          const queue = new LinkedQueue<number>();
          const nodes: Node<number>[] = [];

          for (const v of values) {
            nodes.push(queue.push(v));
          }

          const idx = removeIdx % nodes.length;
          const node = nodes[idx];

          // Remove once
          queue.remove(node);
          const lengthAfterFirst = queue.length;
          const isRemovedAfterFirst = node.removed;

          // Remove again (should be no-op)
          queue.remove(node);
          const lengthAfterSecond = queue.length;
          const isRemovedAfterSecond = node.removed;

          expect(lengthAfterSecond).toBe(lengthAfterFirst);
          expect(isRemovedAfterFirst).toBe(true);
          expect(isRemovedAfterSecond).toBe(true);

          // Drain and verify the queue is still consistent
          const drained: number[] = [];
          let val = queue.shift();
          while (val !== undefined) {
            drained.push(val);
            val = queue.shift();
          }

          expect(drained.length).toBe(lengthAfterFirst);
          expect(queue.length).toBe(0);
        }
      ),
      { numRuns: 500 }
    );
  });

  it("isEmpty consistency: isEmpty() is true iff length === 0", () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        const queue = new LinkedQueue<number>();
        const nodes: Node<number>[] = [];

        for (const op of ops) {
          switch (op.type) {
            case "push": {
              const node = queue.push(op.value);
              nodes.push(node);
              break;
            }
            case "shift": {
              queue.shift();
              break;
            }
            case "remove": {
              if (nodes.length > 0) {
                const nodeIdx = op.index % nodes.length;
                queue.remove(nodes[nodeIdx]);
              }
              break;
            }
          }
          // After every operation, isEmpty must agree with length
          expect(queue.isEmpty()).toBe(queue.length === 0);
        }
      }),
      { numRuns: 500 }
    );
  });
});
