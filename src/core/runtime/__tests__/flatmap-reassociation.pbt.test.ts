import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Async, asyncFlatMap, asyncSucceed, asyncFail } from "../../types/asyncEffect";
import { Exit } from "../../types/effect";
import { Runtime } from "../runtime";
import { Scheduler } from "../scheduler";

/**
 * **Validates: Requirements 12.8, 12.1**
 *
 * Propiedad 4: Confluencia de FlatMap Reassociation
 *
 * Para cadenas de FlatMap left-associated de profundidad N,
 * `reassociateFlatMap` (invoked internally by the fiber interpreter)
 * produce un resultado idéntico al de la cadena original sin reestructurar.
 *
 * This is a consequence of the associativity law of FlatMap from the Zionomicon:
 *   flatMap(flatMap(fa, f), g) === flatMap(fa, a => flatMap(f(a), g))
 *
 * We test this by building left-associated chains and verifying the runtime
 * (which applies reassociation internally) produces the expected result.
 *
 * Strategy:
 * - Generate a sequence of functions [f0, f1, ..., fN] where each fi: number -> Async<..., number>
 * - Build a left-associated chain: flatMap(flatMap(flatMap(succeed(seed), f0), f1), f2) ...
 * - Build a right-associated chain: flatMap(succeed(seed), a => flatMap(f0(a), b => flatMap(f1(b), f2)))
 * - Run both through the runtime and verify identical results
 *
 * Generador: Cadenas left-associated de profundidad 1-100 con funciones Succeed.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run an effect to completion and return the Exit. */
function runToExit<A>(effect: Async<unknown, unknown, A>): Promise<Exit<unknown, A>> {
  return new Promise<Exit<unknown, A>>((resolve) => {
    const scheduler = new Scheduler();
    const rt = new Runtime({ env: {}, scheduler });
    rt.unsafeRunAsync(effect, resolve);
  });
}

/**
 * Describes a step function for the chain.
 * - "add": adds a constant to the accumulator
 * - "mul": multiplies the accumulator by a constant
 * - "fail": produces a failure with a string error
 */
type StepOp =
  | { type: "add"; n: number }
  | { type: "mul"; n: number }
  | { type: "fail"; error: string };

/** Convert a StepOp into an actual effect-returning function. */
function stepToFn(op: StepOp): (a: number) => Async<unknown, string, number> {
  switch (op.type) {
    case "add":
      return (a: number) => asyncSucceed(a + op.n) as Async<unknown, string, number>;
    case "mul":
      return (a: number) => asyncSucceed(a * op.n) as Async<unknown, string, number>;
    case "fail":
      return (_a: number) => asyncFail(op.error) as Async<unknown, string, number>;
  }
}

/**
 * Build a LEFT-associated FlatMap chain from a seed and a list of step functions.
 *
 * Result: flatMap(flatMap(flatMap(succeed(seed), f0), f1), f2)
 *
 * This is the shape that triggers reassociateFlatMap in the fiber interpreter,
 * because the left child of each FlatMap is itself a FlatMap.
 */
function buildLeftAssociated(
  seed: number,
  steps: StepOp[]
): Async<unknown, string, number> {
  let chain: Async<unknown, string, number> = asyncSucceed(seed) as any;
  for (const step of steps) {
    const fn = stepToFn(step);
    chain = asyncFlatMap(chain, fn) as any;
  }
  return chain;
}

/**
 * Build a RIGHT-associated FlatMap chain from a seed and a list of step functions.
 *
 * Result: flatMap(succeed(seed), a => flatMap(f0(a), b => flatMap(f1(b), f2)))
 *
 * This shape does NOT trigger reassociation because the left child of each
 * FlatMap is never itself a FlatMap (it's a Succeed or the result of fi).
 */
function buildRightAssociated(
  seed: number,
  steps: StepOp[]
): Async<unknown, string, number> {
  if (steps.length === 0) {
    return asyncSucceed(seed) as any;
  }

  // Build from right to left: compose the functions in reverse
  // f_composed = a => flatMap(f0(a), b => flatMap(f1(b), ... fN))
  let composed: (a: number) => Async<unknown, string, number> = stepToFn(
    steps[steps.length - 1]
  );

  for (let i = steps.length - 2; i >= 0; i--) {
    const fi = stepToFn(steps[i]);
    const next = composed;
    composed = (a: number) => asyncFlatMap(fi(a), next) as any;
  }

  return asyncFlatMap(asyncSucceed(seed) as any, composed) as any;
}

/**
 * Compute the expected result of applying steps to a seed value purely
 * (no effects), returning either { ok: number } or { err: string }.
 */
function computeExpected(
  seed: number,
  steps: StepOp[]
): { ok: number } | { err: string } {
  let acc = seed;
  for (const step of steps) {
    switch (step.type) {
      case "add":
        acc = acc + step.n;
        break;
      case "mul":
        acc = acc * step.n;
        break;
      case "fail":
        return { err: step.error };
    }
  }
  return { ok: acc };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate a step operation (biased towards success to get longer chains). */
const stepOpArb: fc.Arbitrary<StepOp> = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: -100, max: 100 }).map((n) => ({ type: "add" as const, n })) },
  { weight: 3, arbitrary: fc.integer({ min: -10, max: 10 }).map((n) => ({ type: "mul" as const, n })) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 10 }).map((error) => ({ type: "fail" as const, error })) }
);

/** Generate only success steps (no failures) for pure success-path testing. */
const successStepArb: fc.Arbitrary<StepOp> = fc.oneof(
  fc.integer({ min: -100, max: 100 }).map((n) => ({ type: "add" as const, n })),
  fc.integer({ min: -10, max: 10 }).map((n) => ({ type: "mul" as const, n }))
);

const seedArb = fc.integer({ min: -1000, max: 1000 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlatMap reassociation confluence (Property 4)", () => {
  it("left-associated chains produce the same result as right-associated chains (success path)", async () => {
    await fc.assert(
      fc.asyncProperty(
        seedArb,
        fc.array(successStepArb, { minLength: 1, maxLength: 100 }),
        async (seed, steps) => {
          const leftEffect = buildLeftAssociated(seed, steps);
          const rightEffect = buildRightAssociated(seed, steps);

          const [leftExit, rightExit] = await Promise.all([
            runToExit(leftEffect),
            runToExit(rightEffect),
          ]);

          // Both must succeed
          expect(leftExit._tag).toBe("Success");
          expect(rightExit._tag).toBe("Success");

          if (leftExit._tag === "Success" && rightExit._tag === "Success") {
            expect(leftExit.value).toBe(rightExit.value);
          }

          // Also verify against the pure computation
          const expected = computeExpected(seed, steps);
          expect("ok" in expected).toBe(true);
          if ("ok" in expected && leftExit._tag === "Success") {
            expect(leftExit.value).toBe(expected.ok);
          }
        }
      ),
      { numRuns: 500 }
    );
  });

  it("left-associated chains produce the same result as right-associated chains (with failures)", async () => {
    await fc.assert(
      fc.asyncProperty(
        seedArb,
        fc.array(stepOpArb, { minLength: 1, maxLength: 50 }),
        async (seed, steps) => {
          const leftEffect = buildLeftAssociated(seed, steps);
          const rightEffect = buildRightAssociated(seed, steps);

          const [leftExit, rightExit] = await Promise.all([
            runToExit(leftEffect),
            runToExit(rightEffect),
          ]);

          // Both must have the same tag
          expect(leftExit._tag).toBe(rightExit._tag);

          if (leftExit._tag === "Success" && rightExit._tag === "Success") {
            expect(leftExit.value).toBe(rightExit.value);
          } else if (
            leftExit._tag === "Failure" &&
            rightExit._tag === "Failure"
          ) {
            // Both should fail with the same cause
            expect(leftExit.cause._tag).toBe(rightExit.cause._tag);
            if (
              leftExit.cause._tag === "Fail" &&
              rightExit.cause._tag === "Fail"
            ) {
              expect(leftExit.cause.error).toBe(rightExit.cause.error);
            }
          }

          // Verify against pure computation
          const expected = computeExpected(seed, steps);
          if ("ok" in expected) {
            expect(leftExit._tag).toBe("Success");
            if (leftExit._tag === "Success") {
              expect(leftExit.value).toBe(expected.ok);
            }
          } else {
            expect(leftExit._tag).toBe("Failure");
            if (leftExit._tag === "Failure" && leftExit.cause._tag === "Fail") {
              expect(leftExit.cause.error).toBe(expected.err);
            }
          }
        }
      ),
      { numRuns: 500 }
    );
  });

  it("deeply left-associated chains (depth 50-100) produce correct results", async () => {
    await fc.assert(
      fc.asyncProperty(
        seedArb,
        fc.array(successStepArb, { minLength: 50, maxLength: 100 }),
        async (seed, steps) => {
          const leftEffect = buildLeftAssociated(seed, steps);
          const exit = await runToExit(leftEffect);

          expect(exit._tag).toBe("Success");

          const expected = computeExpected(seed, steps);
          expect("ok" in expected).toBe(true);
          if (exit._tag === "Success" && "ok" in expected) {
            expect(exit.value).toBe(expected.ok);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it("single-step chains are unaffected by reassociation", async () => {
    await fc.assert(
      fc.asyncProperty(
        seedArb,
        stepOpArb,
        async (seed, step) => {
          const effect = buildLeftAssociated(seed, [step]);
          const exit = await runToExit(effect);

          const expected = computeExpected(seed, [step]);
          if ("ok" in expected) {
            expect(exit._tag).toBe("Success");
            if (exit._tag === "Success") {
              expect(exit.value).toBe(expected.ok);
            }
          } else {
            expect(exit._tag).toBe("Failure");
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it("empty step list returns the seed unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, async (seed) => {
        const leftEffect = buildLeftAssociated(seed, []);
        const rightEffect = buildRightAssociated(seed, []);

        const [leftExit, rightExit] = await Promise.all([
          runToExit(leftEffect),
          runToExit(rightEffect),
        ]);

        expect(leftExit._tag).toBe("Success");
        expect(rightExit._tag).toBe("Success");

        if (leftExit._tag === "Success" && rightExit._tag === "Success") {
          expect(leftExit.value).toBe(seed);
          expect(rightExit.value).toBe(seed);
        }
      }),
      { numRuns: 100 }
    );
  });
});
