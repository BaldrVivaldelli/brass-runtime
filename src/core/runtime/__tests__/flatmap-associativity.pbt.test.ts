import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Async, asyncFlatMap, asyncSucceed, asyncFail, asyncSync } from "../../types/asyncEffect";
import { Exit } from "../../types/effect";
import { Runtime } from "../runtime";
import { Scheduler } from "../scheduler";

/**
 * **Validates: Requirements 12.1**
 *
 * Propiedad 1: Asociatividad de FlatMap (Ley del Zionomicon)
 *
 * Para efectos generados aleatoriamente, `flatMap(flatMap(fa, f), g)` produce
 * el mismo resultado que `flatMap(fa, a => flatMap(f(a), g))`.
 *
 * This is the monad associativity law:
 *   flatMap(flatMap(fa, f), g) === flatMap(fa, a => flatMap(f(a), g))
 *
 * Strategy:
 * - Generate random base effects (Succeed, Fail, Sync) with random values
 * - Generate random functions f and g that transform values into effects
 * - Build both sides of the associativity equation
 * - Run both through the runtime and compare Exit results
 *
 * Generador: Árboles de efectos con Succeed, Fail, Sync de profundidad acotada.
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

/** Compare two Exit values for structural equality. */
function exitsEqual(a: Exit<unknown, unknown>, b: Exit<unknown, unknown>): boolean {
  if (a._tag !== b._tag) return false;
  if (a._tag === "Success" && b._tag === "Success") {
    return Object.is(a.value, b.value);
  }
  if (a._tag === "Failure" && b._tag === "Failure") {
    if (a.cause._tag !== b.cause._tag) return false;
    if (a.cause._tag === "Fail" && b.cause._tag === "Fail") {
      return Object.is(a.cause.error, b.cause.error);
    }
    // Interrupt and Die — same tag is enough
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Effect generators
// ---------------------------------------------------------------------------

/**
 * Describes a base effect that can be generated randomly.
 * We keep the description as data so we can build effects from it deterministically.
 */
type EffectDesc =
  | { type: "succeed"; value: number }
  | { type: "fail"; error: string }
  | { type: "sync"; value: number };

/** Arbitrary for a base effect description. */
const effectDescArb: fc.Arbitrary<EffectDesc> = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: -1000, max: 1000 }).map((v) => ({ type: "succeed" as const, value: v })) },
  { weight: 2, arbitrary: fc.string({ minLength: 1, maxLength: 10 }).map((e) => ({ type: "fail" as const, error: e })) },
  { weight: 3, arbitrary: fc.integer({ min: -1000, max: 1000 }).map((v) => ({ type: "sync" as const, value: v })) }
);

/** Only-success effect descriptions (no failures). */
const successEffectDescArb: fc.Arbitrary<EffectDesc> = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }).map((v) => ({ type: "succeed" as const, value: v })),
  fc.integer({ min: -1000, max: 1000 }).map((v) => ({ type: "sync" as const, value: v }))
);

/** Convert an EffectDesc into an actual Async effect. */
function descToEffect(desc: EffectDesc): Async<unknown, string, number> {
  switch (desc.type) {
    case "succeed":
      return asyncSucceed(desc.value) as Async<unknown, string, number>;
    case "fail":
      return asyncFail(desc.error) as Async<unknown, string, number>;
    case "sync":
      return asyncSync(() => desc.value) as Async<unknown, string, number>;
  }
}

/**
 * Describes a function number -> Async<..., number> that can be generated randomly.
 * - "addSucceed": returns asyncSucceed(a + n)
 * - "mulSucceed": returns asyncSucceed(a * n)
 * - "addSync": returns asyncSync(() => a + n)
 * - "constFail": returns asyncFail(error) regardless of input
 */
type FnDesc =
  | { type: "addSucceed"; n: number }
  | { type: "mulSucceed"; n: number }
  | { type: "addSync"; n: number }
  | { type: "constFail"; error: string };

/** Arbitrary for a function description (biased towards success). */
const fnDescArb: fc.Arbitrary<FnDesc> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -100, max: 100 }).map((n) => ({ type: "addSucceed" as const, n })) },
  { weight: 3, arbitrary: fc.integer({ min: -10, max: 10 }).map((n) => ({ type: "mulSucceed" as const, n })) },
  { weight: 2, arbitrary: fc.integer({ min: -100, max: 100 }).map((n) => ({ type: "addSync" as const, n })) },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 10 }).map((error) => ({ type: "constFail" as const, error })) }
);

/** Only-success function descriptions (no failures). */
const successFnDescArb: fc.Arbitrary<FnDesc> = fc.oneof(
  fc.integer({ min: -100, max: 100 }).map((n) => ({ type: "addSucceed" as const, n })),
  fc.integer({ min: -10, max: 10 }).map((n) => ({ type: "mulSucceed" as const, n })),
  fc.integer({ min: -100, max: 100 }).map((n) => ({ type: "addSync" as const, n }))
);

/** Convert a FnDesc into an actual effect-returning function. */
function descToFn(desc: FnDesc): (a: number) => Async<unknown, string, number> {
  switch (desc.type) {
    case "addSucceed":
      return (a: number) => asyncSucceed(a + desc.n) as Async<unknown, string, number>;
    case "mulSucceed":
      return (a: number) => asyncSucceed(a * desc.n) as Async<unknown, string, number>;
    case "addSync":
      return (a: number) => asyncSync(() => a + desc.n) as Async<unknown, string, number>;
    case "constFail":
      return (_a: number) => asyncFail(desc.error) as Async<unknown, string, number>;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlatMap associativity law (Property 1)", () => {
  it("flatMap(flatMap(fa, f), g) === flatMap(fa, a => flatMap(f(a), g)) — success path", async () => {
    await fc.assert(
      fc.asyncProperty(
        successEffectDescArb,
        successFnDescArb,
        successFnDescArb,
        async (faDesc, fDesc, gDesc) => {
          const fa = descToEffect(faDesc);
          const f = descToFn(fDesc);
          const g = descToFn(gDesc);

          // Left side: flatMap(flatMap(fa, f), g)
          const left = asyncFlatMap(asyncFlatMap(fa, f), g);

          // Right side: flatMap(fa, a => flatMap(f(a), g))
          const right = asyncFlatMap(fa, (a: number) => asyncFlatMap(f(a), g));

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          expect(leftExit._tag).toBe("Success");
          expect(rightExit._tag).toBe("Success");
          expect(exitsEqual(leftExit, rightExit)).toBe(true);
        }
      ),
      { numRuns: 500 }
    );
  });

  it("flatMap(flatMap(fa, f), g) === flatMap(fa, a => flatMap(f(a), g)) — with failures", async () => {
    await fc.assert(
      fc.asyncProperty(
        effectDescArb,
        fnDescArb,
        fnDescArb,
        async (faDesc, fDesc, gDesc) => {
          const fa = descToEffect(faDesc);
          const f = descToFn(fDesc);
          const g = descToFn(gDesc);

          // Left side: flatMap(flatMap(fa, f), g)
          const left = asyncFlatMap(asyncFlatMap(fa, f), g);

          // Right side: flatMap(fa, a => flatMap(f(a), g))
          const right = asyncFlatMap(fa, (a: number) => asyncFlatMap(f(a), g));

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          expect(exitsEqual(leftExit, rightExit)).toBe(true);
        }
      ),
      { numRuns: 500 }
    );
  });

  it("associativity holds when fa is a FlatMap chain itself", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        successFnDescArb,
        successFnDescArb,
        successFnDescArb,
        async (seed, hDesc, fDesc, gDesc) => {
          const h = descToFn(hDesc);
          const f = descToFn(fDesc);
          const g = descToFn(gDesc);

          // fa = flatMap(succeed(seed), h) — so fa is itself a FlatMap node
          const fa = asyncFlatMap(
            asyncSucceed(seed) as Async<unknown, string, number>,
            h
          );

          // Left side: flatMap(flatMap(fa, f), g)
          const left = asyncFlatMap(asyncFlatMap(fa, f), g);

          // Right side: flatMap(fa, a => flatMap(f(a), g))
          const right = asyncFlatMap(fa, (a: number) => asyncFlatMap(f(a), g));

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          expect(exitsEqual(leftExit, rightExit)).toBe(true);
        }
      ),
      { numRuns: 300 }
    );
  });

  it("associativity holds with Sync effects in the chain", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        async (seed, addF, addG) => {
          // fa = asyncSync(() => seed)
          const fa = asyncSync(() => seed) as Async<unknown, string, number>;

          // f = a => asyncSync(() => a + addF)
          const f = (a: number) => asyncSync(() => a + addF) as Async<unknown, string, number>;

          // g = b => asyncSync(() => b + addG)
          const g = (b: number) => asyncSync(() => b + addG) as Async<unknown, string, number>;

          // Left side: flatMap(flatMap(fa, f), g)
          const left = asyncFlatMap(asyncFlatMap(fa, f), g);

          // Right side: flatMap(fa, a => flatMap(f(a), g))
          const right = asyncFlatMap(fa, (a: number) => asyncFlatMap(f(a), g));

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          expect(leftExit._tag).toBe("Success");
          expect(rightExit._tag).toBe("Success");
          if (leftExit._tag === "Success" && rightExit._tag === "Success") {
            expect(leftExit.value).toBe(seed + addF + addG);
            expect(rightExit.value).toBe(seed + addF + addG);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it("associativity holds when fa fails (both sides short-circuit identically)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 10 }),
        successFnDescArb,
        successFnDescArb,
        async (error, fDesc, gDesc) => {
          const fa = asyncFail(error) as Async<unknown, string, number>;
          const f = descToFn(fDesc);
          const g = descToFn(gDesc);

          // Left side: flatMap(flatMap(fa, f), g)
          const left = asyncFlatMap(asyncFlatMap(fa, f), g);

          // Right side: flatMap(fa, a => flatMap(f(a), g))
          const right = asyncFlatMap(fa, (a: number) => asyncFlatMap(f(a), g));

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          // Both must fail with the same error
          expect(leftExit._tag).toBe("Failure");
          expect(rightExit._tag).toBe("Failure");
          expect(exitsEqual(leftExit, rightExit)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });
});
