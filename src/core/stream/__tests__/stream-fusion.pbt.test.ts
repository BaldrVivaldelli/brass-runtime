import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { mapP, filterP, takeP, dropP, andThen, via } from "../pipeline";
import { collectStream, fromArray } from "../stream";
import { Runtime } from "../../runtime/runtime";
import { fuse, getStats, PURE_PIPELINE_TAG, serializeFusedPipeline, deserializeFusedPipeline } from "../fusion";
import { Scheduler } from "../../runtime/scheduler";
import type { ZPipeline } from "../pipeline";

/**
 * Property-Based Tests for Stream Fusion Optimization
 *
 * Feature: stream-fusion-optimization
 *
 * These tests validate the correctness properties of the fusion engine
 * using fast-check to generate random inputs and operator compositions.
 */

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

type PureOp = {
  kind: "map" | "filter" | "take" | "drop";
  pipeline: ZPipeline<unknown, never, number, number>;
};

/**
 * Generator for random pure operators.
 * Uses fc.func for map/filter to generate arbitrary pure functions.
 */
const arbPureOp: fc.Arbitrary<PureOp> = fc.oneof(
  fc.func(fc.integer()).map(
    (f): PureOp => ({ kind: "map", pipeline: mapP(f) })
  ),
  fc.func(fc.boolean()).map(
    (p): PureOp => ({ kind: "filter", pipeline: filterP(p) })
  ),
  fc.nat({ max: 1000 }).map(
    (n): PureOp => ({ kind: "take", pipeline: takeP(n) })
  ),
  fc.nat({ max: 100 }).map(
    (n): PureOp => ({ kind: "drop", pipeline: dropP(n) })
  )
);

/** Generator for chains of pure operators (2-6 operators) */
const arbPureChain = fc.array(arbPureOp, { minLength: 2, maxLength: 6 });

/** Generator for input arrays of numbers (0-500 elements) */
const arbInputArray = fc.array(fc.integer(), { minLength: 0, maxLength: 500 });

// ---------------------------------------------------------------------------
// Property 1: Semantic equivalence (fused vs unfused)
// ---------------------------------------------------------------------------

describe("Feature: stream-fusion-optimization, Property 1: Semantic equivalence", () => {
  /**
   * **Validates: Requirements 1.3**
   *
   * For any input array and any composition of pure operators (map, filter,
   * take, drop), the fused pipeline SHALL produce the same output sequence
   * as the unfused pipeline when both are applied to the same input stream.
   *
   * The unfused path applies each operator sequentially (one at a time) to
   * the stream. The fused path composes all operators with andThen (which
   * triggers automatic fusion) and applies the composed pipeline.
   */
  it("fused pipeline produces same output as unfused pipeline for random operator chains", () => {
    return fc.assert(
      fc.asyncProperty(arbInputArray, arbPureChain, async (inputArr, ops) => {
        // --- Unfused path: apply each operator one by one ---
        let unfusedStream = fromArray(inputArr);
        for (const op of ops) {
          unfusedStream = op.pipeline(unfusedStream) as any;
        }
        const unfusedResult = await run<number[]>(collectStream(unfusedStream));

        // --- Fused path: compose with andThen (auto-fuses) then apply ---
        let fusedPipeline: ZPipeline<unknown, never, number, number> = ops[0]!.pipeline;
        for (let i = 1; i < ops.length; i++) {
          fusedPipeline = andThen(fusedPipeline, ops[i]!.pipeline);
        }
        const fusedStream = via(fromArray(inputArr), fusedPipeline);
        const fusedResult = await run<number[]>(collectStream(fusedStream));

        // Both paths must produce identical output
        expect(fusedResult).toEqual(unfusedResult);
      }),
      { numRuns: 100 }
    );
  });
});


// ---------------------------------------------------------------------------
// Property 2: Fusion structure correctness
// ---------------------------------------------------------------------------

describe("Feature: stream-fusion-optimization, Property 2: Fusion structure correctness", () => {
  /**
   * **Validates: Requirements 1.1, 3.1**
   *
   * For any sequence of pure operators composed with `andThen`, the FusionEngine
   * SHALL produce a `FusedPipelineRepr` whose internal structure contains:
   * - `stats.fusedSteps` equal to the number of operators composed
   * - `stats.steps` accurately describing each original operator's kind
   * - `stats.hasTake` true iff at least one take operator is present
   * - `stats.hasDrop` true iff at least one drop operator is present
   * - `initState()` creating a state with the correct number of counters (one per take/drop step)
   */
  it("fuse() produces correct metadata for random operator chains", () => {
    fc.assert(
      fc.property(arbPureChain, (ops) => {
        // Compose all operators with andThen (triggers auto-fusion)
        let composedPipeline: ZPipeline<unknown, never, number, number> = ops[0]!.pipeline;
        for (let i = 1; i < ops.length; i++) {
          composedPipeline = andThen(composedPipeline, ops[i]!.pipeline);
        }

        // The composed pipeline should have _fusedSteps from auto-fusion
        const fusedSteps = (composedPipeline as any)._fusedSteps;
        expect(fusedSteps).toBeDefined();
        expect(Array.isArray(fusedSteps)).toBe(true);

        // Call fuse() on the composed pipeline
        const fusedRepr = fuse(composedPipeline as any);
        expect(fusedRepr).not.toBeNull();

        if (!fusedRepr) return; // type guard

        // 1. fusedSteps count equals number of operators composed
        expect(fusedRepr.stats.fusedSteps).toBe(ops.length);

        // 2. steps array accurately describes each original operator's kind
        expect(fusedRepr.stats.steps.length).toBe(ops.length);
        for (let i = 0; i < ops.length; i++) {
          expect(fusedRepr.stats.steps[i]!.kind).toBe(ops[i]!.kind);
        }

        // 3. hasTake is true iff at least one take operator is present
        const expectedHasTake = ops.some((op) => op.kind === "take");
        expect(fusedRepr.stats.hasTake).toBe(expectedHasTake);

        // 4. hasDrop is true iff at least one drop operator is present
        const expectedHasDrop = ops.some((op) => op.kind === "drop");
        expect(fusedRepr.stats.hasDrop).toBe(expectedHasDrop);

        // 5. initState() creates a state with correct number of counters
        const expectedCounterCount = ops.filter(
          (op) => op.kind === "take" || op.kind === "drop"
        ).length;
        const state = fusedRepr.initState();
        expect(state.counters.length).toBe(expectedCounterCount);
        // All counters should be initialized to 0
        for (const counter of state.counters) {
          expect(counter).toBe(0);
        }
      }),
      { numRuns: 100 }
    );
  });
});


// ---------------------------------------------------------------------------
// Property 3: Fusion boundary detection
// ---------------------------------------------------------------------------

describe("Feature: stream-fusion-optimization, Property 3: Fusion boundary detection", () => {
  /**
   * **Validates: Requirements 1.2**
   *
   * For any pipeline containing a mix of pure operators and effectful operators,
   * the FusionEngine SHALL fuse only contiguous segments of pure operators,
   * preserving effectful operators as unfused boundaries.
   *
   * Since `andThen` only fuses when BOTH operands are pure (have PURE_PIPELINE_TAG
   * or _fusedSteps), an effectful operator acts as a natural fusion boundary:
   * - pure + pure → result has `_fusedSteps` (fused)
   * - pure + effectful → result does NOT have `_fusedSteps` (not fused)
   * - effectful + pure → result does NOT have `_fusedSteps` (not fused)
   * - effectful + effectful → result does NOT have `_fusedSteps` (not fused)
   */

  // Generator for mixed operators (pure or effectful)
  type MixedOp = {
    kind: "map" | "filter" | "take" | "drop" | "effectful";
    pipeline: ZPipeline<unknown, never, number, number>;
    isPure: boolean;
  };

  const arbMixedOp: fc.Arbitrary<MixedOp> = fc.oneof(
    // Pure operators (4 kinds)
    arbPureOp.map((op): MixedOp => ({ ...op, isPure: true })),
    // Effectful operator (identity, no PURE_PIPELINE_TAG)
    fc.constant<MixedOp>({
      kind: "effectful",
      pipeline: ((s: any) => s) as ZPipeline<unknown, never, number, number>,
      isPure: false,
    })
  );

  const arbMixedChain = fc.array(arbMixedOp, { minLength: 2, maxLength: 6 });

  it("only contiguous pure operator pairs produce fused results via andThen", () => {
    fc.assert(
      fc.property(arbMixedChain, (ops) => {
        // For each adjacent pair of operators, compose with andThen and check fusion
        for (let i = 0; i < ops.length - 1; i++) {
          const left = ops[i]!;
          const right = ops[i + 1]!;
          const composed = andThen(left.pipeline, right.pipeline);

          if (left.isPure && right.isPure) {
            // Both pure → result should have _fusedSteps (fusion occurred)
            expect(
              (composed as any)._fusedSteps,
              `Expected fusion for pair [${i}] ${left.kind} + [${i + 1}] ${right.kind}`
            ).toBeDefined();
            expect(Array.isArray((composed as any)._fusedSteps)).toBe(true);
          } else {
            // At least one effectful → result should NOT have _fusedSteps
            expect(
              (composed as any)._fusedSteps,
              `Expected NO fusion for pair [${i}] ${left.kind} + [${i + 1}] ${right.kind}`
            ).toBeUndefined();
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it("effectful operators are never tagged as pure pipelines", () => {
    fc.assert(
      fc.property(arbMixedChain, (ops) => {
        for (const op of ops) {
          if (!op.isPure) {
            // Effectful operators must NOT have PURE_PIPELINE_TAG
            expect((op.pipeline as any)[PURE_PIPELINE_TAG]).toBeUndefined();
            // Effectful operators must NOT have _fusedSteps
            expect((op.pipeline as any)._fusedSteps).toBeUndefined();
          } else {
            // Pure operators must have PURE_PIPELINE_TAG or _fusedSteps
            expect((op.pipeline as any)[PURE_PIPELINE_TAG]).toBeDefined();
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it("mixed pipeline still produces correct output (semantic correctness across boundaries)", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 0, maxLength: 100 }),
        arbMixedChain,
        async (inputArr, ops) => {
          // Apply each operator sequentially (unfused reference)
          let referenceStream = fromArray(inputArr);
          for (const op of ops) {
            referenceStream = op.pipeline(referenceStream) as any;
          }
          const referenceResult = await run<number[]>(collectStream(referenceStream));

          // Compose all operators with andThen (may partially fuse pure segments)
          let composedPipeline: ZPipeline<unknown, never, number, number> = ops[0]!.pipeline;
          for (let i = 1; i < ops.length; i++) {
            composedPipeline = andThen(composedPipeline, ops[i]!.pipeline);
          }
          const composedStream = via(fromArray(inputArr), composedPipeline);
          const composedResult = await run<number[]>(collectStream(composedStream));

          // Both paths must produce identical output
          expect(composedResult).toEqual(referenceResult);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// ---------------------------------------------------------------------------
// Property 4: Pipeline inspection accuracy
// ---------------------------------------------------------------------------

describe("Feature: stream-fusion-optimization, Property 4: Pipeline inspection accuracy", () => {
  /**
   * **Validates: Requirements 8.1, 8.2**
   *
   * For any fused pipeline, the `getStats()` method SHALL return a
   * `FusedPipelineStats` object where:
   * - `fusedSteps` equals the number of original operators composed
   * - `steps` accurately describes each original operator's kind
   * - `hasTake` correctly reflects whether take operators are present
   * - `hasDrop` correctly reflects whether drop operators are present
   */
  it("getStats() returns accurate metadata for any fused pipeline", () => {
    fc.assert(
      fc.property(arbPureChain, (ops) => {
        // Compose all operators with andThen (triggers auto-fusion)
        let composedPipeline: ZPipeline<unknown, never, number, number> = ops[0]!.pipeline;
        for (let i = 1; i < ops.length; i++) {
          composedPipeline = andThen(composedPipeline, ops[i]!.pipeline);
        }

        // Call getStats() on the fused pipeline
        const stats = getStats(composedPipeline as any);
        expect(stats).not.toBeNull();

        if (!stats) return; // type guard

        // 1. fusedSteps equals the number of original operators composed
        expect(stats.fusedSteps).toBe(ops.length);

        // 2. steps accurately describes each original operator's kind
        expect(stats.steps.length).toBe(ops.length);
        for (let i = 0; i < ops.length; i++) {
          expect(stats.steps[i]!.kind).toBe(ops[i]!.kind);
        }

        // 3. hasTake correctly reflects whether take operators are present
        const expectedHasTake = ops.some((op) => op.kind === "take");
        expect(stats.hasTake).toBe(expectedHasTake);

        // 4. hasDrop correctly reflects whether drop operators are present
        const expectedHasDrop = ops.some((op) => op.kind === "drop");
        expect(stats.hasDrop).toBe(expectedHasDrop);
      }),
      { numRuns: 100 }
    );
  });
});


// ---------------------------------------------------------------------------
// Property 5: Serialization round-trip
// ---------------------------------------------------------------------------

describe("Feature: stream-fusion-optimization, Property 5: Serialization round-trip", () => {
  /**
   * **Validates: Requirements 3.2**
   *
   * For any fused pipeline applied to any input array, serializing and then
   * deserializing the pipeline SHALL produce a pipeline that generates the
   * same output sequence as the original when applied to the same input.
   *
   * NOTE: toString() serialization only works for non-closure functions.
   * This test uses a fixed set of serializable operators (inline arrow functions
   * without captured variables) to ensure round-trip correctness.
   */

  // Generator for serializable pure operators (no closures — only inline arrow functions)
  type SerializableOp = {
    kind: "map" | "filter" | "take" | "drop";
    pipeline: ZPipeline<unknown, never, number, number>;
  };

  const arbSerializableOp: fc.Arbitrary<SerializableOp> = fc.oneof(
    fc.constant<SerializableOp>({ kind: "map", pipeline: mapP((x: number) => x + 1) }),
    fc.constant<SerializableOp>({ kind: "map", pipeline: mapP((x: number) => x * 2) }),
    fc.constant<SerializableOp>({ kind: "map", pipeline: mapP((x: number) => x - 1) }),
    fc.constant<SerializableOp>({ kind: "filter", pipeline: filterP((x: number) => x > 0) }),
    fc.constant<SerializableOp>({ kind: "filter", pipeline: filterP((x: number) => x % 2 === 0) }),
    fc.nat({ max: 100 }).map((n): SerializableOp => ({ kind: "take", pipeline: takeP(n) })),
    fc.nat({ max: 50 }).map((n): SerializableOp => ({ kind: "drop", pipeline: dropP(n) }))
  );

  /** Generator for chains of serializable operators (2-5 operators) */
  const arbSerializableChain = fc.array(arbSerializableOp, { minLength: 2, maxLength: 5 });

  /** Generator for input arrays of numbers (0-200 elements) */
  const arbSerializableInput = fc.array(fc.integer({ min: -100, max: 100 }), {
    minLength: 0,
    maxLength: 200,
  });

  it("serializing and deserializing a fused pipeline produces same output as original", () => {
    return fc.assert(
      fc.asyncProperty(arbSerializableInput, arbSerializableChain, async (inputArr, ops) => {
        // --- Compose all operators with andThen (auto-fuses) ---
        let fusedPipeline: ZPipeline<unknown, never, number, number> = ops[0]!.pipeline;
        for (let i = 1; i < ops.length; i++) {
          fusedPipeline = andThen(fusedPipeline, ops[i]!.pipeline);
        }

        // --- Apply original fused pipeline to input ---
        const originalStream = via(fromArray(inputArr), fusedPipeline);
        const originalResult = await run<number[]>(collectStream(originalStream));

        // --- Serialize the fused pipeline ---
        const serialized = serializeFusedPipeline(fusedPipeline);
        expect(serialized).not.toBeNull();
        if (!serialized) return;

        // --- Deserialize the pipeline ---
        const deserialized = deserializeFusedPipeline<number, number>(serialized);
        expect(deserialized).not.toBeNull();
        if (!deserialized) return;

        // --- Apply deserialized pipeline to same input ---
        const deserializedStream = via(fromArray(inputArr), deserialized);
        const deserializedResult = await run<number[]>(collectStream(deserializedStream));

        // --- Both must produce identical output ---
        expect(deserializedResult).toEqual(originalResult);
      }),
      { numRuns: 100 }
    );
  });
});


// ---------------------------------------------------------------------------
// Property 6: Queue fast-path direct delivery
// ---------------------------------------------------------------------------

import { bounded, Queue } from "../queue";

describe("Feature: stream-fusion-optimization, Property 6: Queue fast-path direct delivery", () => {
  /**
   * **Validates: Requirements 5.1, 5.2**
   *
   * For any queue where a taker is suspended waiting, offering a value SHALL
   * deliver it directly to the taker (synchronous callback). Symmetrically,
   * for any queue where an offerer is suspended in backpressure, taking a value
   * SHALL admit the offerer's element directly.
   */

  // Property 6a: offer delivers directly to waiting taker
  it("offer delivers value directly to a suspended taker without scheduler round-trip", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.integer(),                        // value to offer
        fc.integer({ min: 1, max: 20 }),     // capacity (must be >= 1)
        async (value, capacity) => {
          const q = await run<Queue<number>>(bounded<number>(capacity, "backpressure"));

          // Suspend a taker (buffer is empty, no offerers waiting)
          let received: number | null = null;
          rt.unsafeRunAsync(q.take() as any, (exit: any) => {
            if (exit._tag === "Success") received = exit.value;
          });

          // Offer — should deliver directly to the waiting taker
          let offerResult: boolean | null = null;
          rt.unsafeRunAsync(q.offer(value) as any, (exit: any) => {
            if (exit._tag === "Success") offerResult = exit.value;
          });

          // Allow one microtask tick for the runtime to process
          await Promise.resolve();

          // Taker should have received the value directly
          expect(received).toBe(value);
          // Offer should have succeeded
          expect(offerResult).toBe(true);
          // Buffer should remain empty (direct delivery, not buffered)
          expect(q.size()).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 6b: take admits waiting offerer directly
  it("take admits a suspended offerer directly when buffer space is freed", () => {
    return fc.assert(
      fc.asyncProperty(
        fc.integer(),                        // value from the suspended offerer
        fc.integer({ min: 1, max: 10 }),     // capacity (must be >= 1)
        async (value, capacity) => {
          const q = await run<Queue<number>>(bounded<number>(capacity, "backpressure"));

          // Fill buffer to capacity
          for (let i = 0; i < capacity; i++) {
            await run(q.offer(i));
          }

          // Suspend an offerer (buffer is full, backpressure)
          let admitted = false;
          rt.unsafeRunAsync(q.offer(value) as any, (exit: any) => {
            if (exit._tag === "Success" && exit.value === true) admitted = true;
          });

          // Take — should free a slot and admit the offerer directly
          const taken = await run<number>(q.take());

          // Allow one microtask tick for the runtime to process
          await Promise.resolve();

          // The taken value should be the first element offered (FIFO)
          expect(taken).toBe(0);
          // The offerer should have been admitted directly
          expect(admitted).toBe(true);
          // Buffer should be full again (offerer's value was admitted into the freed slot)
          expect(q.size()).toBe(capacity);
        }
      ),
      { numRuns: 100 }
    );
  });
});



// ---------------------------------------------------------------------------
// Property 7: Queue FIFO invariant
// ---------------------------------------------------------------------------

describe("Feature: stream-fusion-optimization, Property 7: Queue FIFO invariant", () => {
  /**
   * **Validates: Requirements 5.3**
   *
   * For any sequence of offer and take operations on a bounded queue
   * (regardless of whether fast-path or standard path is used), elements
   * SHALL always be received in the same order they were offered.
   */

  // Generator for sequences of offer/take operations
  const arbQueueOps = fc.array(
    fc.oneof(
      fc.integer().map((n) => ({ op: "offer" as const, value: n })),
      fc.constant({ op: "take" as const })
    ),
    { minLength: 1, maxLength: 200 }
  );

  it("elements are always received in FIFO order regardless of offer/take interleaving", () => {
    return fc.assert(
      fc.asyncProperty(
        arbQueueOps,
        fc.integer({ min: 1, max: 20 }), // capacity
        async (ops, capacity) => {
          const q = await run<Queue<number>>(bounded<number>(capacity, "backpressure"));

          const offered: number[] = [];
          const taken: number[] = [];

          for (const op of ops) {
            if (op.op === "offer") {
              // Only offer when there's space to avoid deadlock in backpressure mode
              if (q.size() < capacity) {
                offered.push(op.value);
                await run(q.offer(op.value));
              }
            } else {
              // Only take when there's something to take
              if (offered.length > taken.length && q.size() > 0) {
                const value = await run<number>(q.take());
                taken.push(value);
              }
            }
          }

          // Drain remaining items from the queue
          while (taken.length < offered.length && q.size() > 0) {
            const value = await run<number>(q.take());
            taken.push(value);
          }

          // Verify FIFO: taken values should match the first N offered values in order
          expect(taken).toEqual(offered.slice(0, taken.length));
        }
      ),
      { numRuns: 100 }
    );
  });
});



// ---------------------------------------------------------------------------
// Property 8: Batch API semantic equivalence
// ---------------------------------------------------------------------------

describe("Feature: stream-fusion-optimization, Property 8: Batch API semantic equivalence", () => {
  /**
   * **Validates: Requirements 6.3**
   *
   * For any batch of tasks with associated tags, enqueueing them via
   * `scheduleBatch` SHALL produce the same lane assignments and drop
   * decisions as enqueueing them individually via `schedule` in the same order.
   */

  // Generator for batch of tasks with tags
  const arbTaskBatch = fc.array(
    fc.record({
      tag: fc.oneof(
        fc.constant("test:task"),
        fc.constant("lane:alpha|task"),
        fc.constant("lane:beta|task"),
        fc.constant("caller:gamma|task"),
        fc.string({ minLength: 1, maxLength: 20 })
      )
    }),
    { minLength: 1, maxLength: 100 }
  );

  it("scheduleBatch produces same results as N individual schedule calls", () => {
    fc.assert(
      fc.property(arbTaskBatch, (batch) => {
        const opts = { engine: "ts" as const, laneCapacity: 10, maxLanes: 5 };

        const schedulerA = new Scheduler(opts);
        const schedulerB = new Scheduler(opts);

        // Individual enqueue
        const individualResults = batch.map(({ tag }) =>
          schedulerA.schedule(() => {}, tag)
        );

        // Batch enqueue
        const batchResults = schedulerB.scheduleBatch(
          batch.map(({ tag }) => ({ fn: () => {}, tag }))
        );

        expect(batchResults).toEqual(individualResults);
      }),
      { numRuns: 100 }
    );
  });
});
