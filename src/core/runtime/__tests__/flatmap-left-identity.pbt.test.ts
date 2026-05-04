import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Async, asyncFlatMap, asyncSucceed, asyncFail, asyncSync } from "../../types/asyncEffect";
import { Exit } from "../../types/effect";
import { Runtime } from "../runtime";
import { Scheduler } from "../scheduler";

/**
 * **Validates: Requirements 12.2**
 *
 * Propiedad 2: Identidad izquierda de FlatMap (Ley del Zionomicon)
 *
 * Para todo valor `a` y función `f`, `flatMap(succeed(a), f)` produce
 * el mismo resultado que `f(a)`.
 *
 * This is the monad left identity law:
 *   flatMap(succeed(a), f) === f(a)
 *
 * Strategy:
 * - Generate random values `a` of various types (numbers, strings, booleans, null, undefined)
 * - Generate random functions `f` that return effects (Succeed, Fail, Sync)
 * - Build both sides: flatMap(succeed(a), f) and f(a)
 * - Run both through the runtime and compare Exit results
 *
 * Generador: Valores primitivos y funciones que retornan Succeed o Fail.
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
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

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

/** Arbitrary for a function description (includes failures). */
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

/** Compute the expected result of applying f to a value purely. */
function computeExpected(a: number, desc: FnDesc): { ok: number } | { err: string } {
  switch (desc.type) {
    case "addSucceed":
      return { ok: a + desc.n };
    case "mulSucceed":
      return { ok: a * desc.n };
    case "addSync":
      return { ok: a + desc.n };
    case "constFail":
      return { err: desc.error };
  }
}

const seedArb = fc.integer({ min: -1000, max: 1000 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlatMap left identity law (Property 2)", () => {
  it("flatMap(succeed(a), f) === f(a) — success path with numeric values", async () => {
    await fc.assert(
      fc.asyncProperty(
        seedArb,
        successFnDescArb,
        async (a, fDesc) => {
          const f = descToFn(fDesc);

          // Left side: flatMap(succeed(a), f)
          const left = asyncFlatMap(
            asyncSucceed(a) as Async<unknown, string, number>,
            f
          );

          // Right side: f(a)
          const right = f(a);

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          expect(leftExit._tag).toBe("Success");
          expect(rightExit._tag).toBe("Success");
          expect(exitsEqual(leftExit, rightExit)).toBe(true);

          // Also verify against pure computation
          const expected = computeExpected(a, fDesc);
          expect("ok" in expected).toBe(true);
          if (leftExit._tag === "Success" && "ok" in expected) {
            expect(leftExit.value).toBe(expected.ok);
          }
        }
      ),
      { numRuns: 500 }
    );
  });

  it("flatMap(succeed(a), f) === f(a) — with failures", async () => {
    await fc.assert(
      fc.asyncProperty(
        seedArb,
        fnDescArb,
        async (a, fDesc) => {
          const f = descToFn(fDesc);

          // Left side: flatMap(succeed(a), f)
          const left = asyncFlatMap(
            asyncSucceed(a) as Async<unknown, string, number>,
            f
          );

          // Right side: f(a)
          const right = f(a);

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          expect(exitsEqual(leftExit, rightExit)).toBe(true);

          // Verify against pure computation
          const expected = computeExpected(a, fDesc);
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

  it("flatMap(succeed(a), f) === f(a) — with singleton values (undefined, true, false, null)", async () => {
    // Test that the singleton optimization in asyncSucceed doesn't break left identity
    const singletonValues: Array<{ value: any; label: string }> = [
      { value: undefined, label: "undefined" },
      { value: true, label: "true" },
      { value: false, label: "false" },
      { value: null, label: "null" },
    ];

    for (const { value, label } of singletonValues) {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: -100, max: 100 }),
          async (n) => {
            // f maps any value to asyncSucceed(n)
            const f = (_a: any) => asyncSucceed(n) as Async<unknown, string, number>;

            // Left side: flatMap(succeed(value), f)
            const left = asyncFlatMap(asyncSucceed(value) as any, f);

            // Right side: f(value)
            const right = f(value);

            const [leftExit, rightExit] = await Promise.all([
              runToExit(left),
              runToExit(right),
            ]);

            expect(leftExit._tag).toBe("Success");
            expect(rightExit._tag).toBe("Success");
            expect(exitsEqual(leftExit, rightExit)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    }
  });

  it("flatMap(succeed(a), f) === f(a) — f returns a FlatMap chain", async () => {
    await fc.assert(
      fc.asyncProperty(
        seedArb,
        successFnDescArb,
        successFnDescArb,
        async (a, fDesc, gDesc) => {
          const fInner = descToFn(fDesc);
          const g = descToFn(gDesc);

          // f returns a FlatMap chain: a => flatMap(fInner(a), g)
          const f = (x: number) => asyncFlatMap(fInner(x), g) as Async<unknown, string, number>;

          // Left side: flatMap(succeed(a), f)
          const left = asyncFlatMap(
            asyncSucceed(a) as Async<unknown, string, number>,
            f
          );

          // Right side: f(a)
          const right = f(a);

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          expect(leftExit._tag).toBe("Success");
          expect(rightExit._tag).toBe("Success");
          expect(exitsEqual(leftExit, rightExit)).toBe(true);
        }
      ),
      { numRuns: 300 }
    );
  });

  it("flatMap(succeed(a), f) === f(a) — f returns asyncSync", async () => {
    await fc.assert(
      fc.asyncProperty(
        seedArb,
        fc.integer({ min: -100, max: 100 }),
        async (a, n) => {
          // f uses asyncSync to compute the result
          const f = (x: number) => asyncSync(() => x + n) as Async<unknown, string, number>;

          // Left side: flatMap(succeed(a), f)
          const left = asyncFlatMap(
            asyncSucceed(a) as Async<unknown, string, number>,
            f
          );

          // Right side: f(a)
          const right = f(a);

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          expect(leftExit._tag).toBe("Success");
          expect(rightExit._tag).toBe("Success");
          if (leftExit._tag === "Success" && rightExit._tag === "Success") {
            expect(leftExit.value).toBe(a + n);
            expect(rightExit.value).toBe(a + n);
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  it("flatMap(succeed(a), f) === f(a) — f always fails", async () => {
    await fc.assert(
      fc.asyncProperty(
        seedArb,
        fc.string({ minLength: 1, maxLength: 10 }),
        async (a, error) => {
          // f always returns a failure regardless of input
          const f = (_x: number) => asyncFail(error) as Async<unknown, string, number>;

          // Left side: flatMap(succeed(a), f)
          const left = asyncFlatMap(
            asyncSucceed(a) as Async<unknown, string, number>,
            f
          );

          // Right side: f(a)
          const right = f(a);

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          // Both must fail with the same error
          expect(leftExit._tag).toBe("Failure");
          expect(rightExit._tag).toBe("Failure");
          expect(exitsEqual(leftExit, rightExit)).toBe(true);

          if (leftExit._tag === "Failure" && leftExit.cause._tag === "Fail") {
            expect(leftExit.cause.error).toBe(error);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
