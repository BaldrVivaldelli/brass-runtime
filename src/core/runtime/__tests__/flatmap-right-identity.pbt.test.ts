import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Async, asyncFlatMap, asyncSucceed, asyncFail, asyncSync } from "../../types/asyncEffect";
import { Exit } from "../../types/effect";
import { Runtime } from "../runtime";
import { Scheduler } from "../scheduler";

/**
 * **Validates: Requirements 12.3**
 *
 * Propiedad 3: Identidad derecha de FlatMap (Ley del Zionomicon)
 *
 * Para todo efecto `fa`, `flatMap(fa, succeed)` produce el mismo resultado que `fa`.
 *
 * This is the monad right identity law:
 *   flatMap(fa, succeed) === fa
 *
 * Strategy:
 * - Generate random effects `fa` of various kinds (Succeed, Fail, Sync, FlatMap chains)
 * - Build both sides: flatMap(fa, succeed) and fa
 * - Run both through the runtime and compare Exit results
 * - Verify that wrapping any effect with flatMap(_, succeed) is a no-op
 *
 * Generador: Efectos Succeed y Fail con valores aleatorios.
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
// Effect generators
// ---------------------------------------------------------------------------

/**
 * Describes a base effect that can be generated randomly.
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
 * Describes a function number -> Async<..., number> for building FlatMap chains.
 */
type FnDesc =
  | { type: "addSucceed"; n: number }
  | { type: "mulSucceed"; n: number }
  | { type: "addSync"; n: number };

/** Arbitrary for a success-only function description. */
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
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlatMap right identity law (Property 3)", () => {
  it("flatMap(fa, succeed) === fa — success path with Succeed effects", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        async (value) => {
          const fa = asyncSucceed(value) as Async<unknown, string, number>;

          // Left side: flatMap(fa, succeed)
          const left = asyncFlatMap(fa, (a: number) =>
            asyncSucceed(a) as Async<unknown, string, number>
          );

          // Right side: fa
          const right = fa;

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          expect(leftExit._tag).toBe("Success");
          expect(rightExit._tag).toBe("Success");
          expect(exitsEqual(leftExit, rightExit)).toBe(true);

          if (leftExit._tag === "Success") {
            expect(leftExit.value).toBe(value);
          }
        }
      ),
      { numRuns: 500 }
    );
  });

  it("flatMap(fa, succeed) === fa — with Sync effects", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        async (value) => {
          const fa = asyncSync(() => value) as Async<unknown, string, number>;

          // Left side: flatMap(fa, succeed)
          const left = asyncFlatMap(fa, (a: number) =>
            asyncSucceed(a) as Async<unknown, string, number>
          );

          // Right side: fa
          const right = fa;

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          expect(leftExit._tag).toBe("Success");
          expect(rightExit._tag).toBe("Success");
          expect(exitsEqual(leftExit, rightExit)).toBe(true);

          if (leftExit._tag === "Success") {
            expect(leftExit.value).toBe(value);
          }
        }
      ),
      { numRuns: 500 }
    );
  });

  it("flatMap(fa, succeed) === fa — with Fail effects", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 10 }),
        async (error) => {
          const fa = asyncFail(error) as Async<unknown, string, number>;

          // Left side: flatMap(fa, succeed)
          const left = asyncFlatMap(fa, (a: number) =>
            asyncSucceed(a) as Async<unknown, string, number>
          );

          // Right side: fa
          const right = fa;

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
      { numRuns: 300 }
    );
  });

  it("flatMap(fa, succeed) === fa — with mixed effect types", async () => {
    await fc.assert(
      fc.asyncProperty(
        effectDescArb,
        async (faDesc) => {
          const fa = descToEffect(faDesc);

          // Left side: flatMap(fa, succeed)
          const left = asyncFlatMap(fa, (a: number) =>
            asyncSucceed(a) as Async<unknown, string, number>
          );

          // Right side: fa
          const right = fa;

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

  it("flatMap(fa, succeed) === fa — with singleton values (undefined, true, false, null)", async () => {
    // Test that the singleton optimization in asyncSucceed doesn't break right identity
    const singletonValues: Array<{ value: any; label: string }> = [
      { value: undefined, label: "undefined" },
      { value: true, label: "true" },
      { value: false, label: "false" },
      { value: null, label: "null" },
    ];

    for (const { value } of singletonValues) {
      const fa = asyncSucceed(value) as Async<unknown, string, any>;

      // Left side: flatMap(fa, succeed)
      const left = asyncFlatMap(fa, (a: any) =>
        asyncSucceed(a) as Async<unknown, string, any>
      );

      // Right side: fa
      const right = fa;

      const [leftExit, rightExit] = await Promise.all([
        runToExit(left),
        runToExit(right),
      ]);

      expect(leftExit._tag).toBe("Success");
      expect(rightExit._tag).toBe("Success");
      expect(exitsEqual(leftExit, rightExit)).toBe(true);
    }
  });

  it("flatMap(fa, succeed) === fa — when fa is a FlatMap chain", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        successFnDescArb,
        async (seed, fDesc) => {
          const f = descToFn(fDesc);

          // fa = flatMap(succeed(seed), f) — fa is itself a FlatMap node
          const fa = asyncFlatMap(
            asyncSucceed(seed) as Async<unknown, string, number>,
            f
          );

          // Left side: flatMap(fa, succeed)
          const left = asyncFlatMap(fa, (a: number) =>
            asyncSucceed(a) as Async<unknown, string, number>
          );

          // Right side: fa
          const right = fa;

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

  it("flatMap(fa, succeed) === fa — when fa is a deep FlatMap chain (depth 10-50)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: 1000 }),
        fc.array(successFnDescArb, { minLength: 10, maxLength: 50 }),
        async (seed, fnDescs) => {
          // Build a left-associated FlatMap chain as fa
          let fa: Async<unknown, string, number> = asyncSucceed(seed) as any;
          for (const desc of fnDescs) {
            const fn = descToFn(desc);
            fa = asyncFlatMap(fa, fn);
          }

          // Left side: flatMap(fa, succeed)
          const left = asyncFlatMap(fa, (a: number) =>
            asyncSucceed(a) as Async<unknown, string, number>
          );

          // Right side: fa
          const right = fa;

          const [leftExit, rightExit] = await Promise.all([
            runToExit(left),
            runToExit(right),
          ]);

          expect(leftExit._tag).toBe("Success");
          expect(rightExit._tag).toBe("Success");
          expect(exitsEqual(leftExit, rightExit)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("flatMap(fa, succeed) === fa — applying right identity multiple times is idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        successEffectDescArb,
        fc.integer({ min: 1, max: 5 }),
        async (faDesc, wraps) => {
          const baseEffect = descToEffect(faDesc);

          // Wrap fa with flatMap(_, succeed) N times
          let wrapped: Async<unknown, string, number> = baseEffect;
          for (let i = 0; i < wraps; i++) {
            wrapped = asyncFlatMap(wrapped, (a: number) =>
              asyncSucceed(a) as Async<unknown, string, number>
            );
          }

          const [wrappedExit, baseExit] = await Promise.all([
            runToExit(wrapped),
            runToExit(baseEffect),
          ]);

          expect(wrappedExit._tag).toBe("Success");
          expect(baseExit._tag).toBe("Success");
          expect(exitsEqual(wrappedExit, baseExit)).toBe(true);
        }
      ),
      { numRuns: 300 }
    );
  });
});
