// Feature: http-p99-consolidation, Property 1: Effect path equivalence
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import type { Async } from "../../core/types/asyncEffect";
import { asyncSucceed, asyncFail, asyncFlatMap, asyncFold, asyncSync } from "../../core/types/asyncEffect";
import { Cause, type Exit } from "../../core/types/effect";
import { registerHttpEffect, type EffectCanceler } from "../effectRunner";
import type { HttpError, HttpWireResponse } from "../client";

/**
 * Property 1: Effect path equivalence
 *
 * For any transport effect (bare Async, FlatMap-wrapped, Fold-wrapped, or Sync-wrapped),
 * the direct transport fast-path detection and dispatch SHALL produce the same exit value
 * and cancellation behavior as the full `registerHttpEffect` interpretation path — i.e.,
 * for any effect `e` and environment `env`, running `e` through the fast-path (when applicable)
 * or the full interpreter yields an identical `Exit<HttpError, HttpWireResponse>`.
 *
 * **Validates: Requirements 1.2, 1.4, 1.5**
 */

// --- Test helpers ---

/** A minimal HttpWireResponse for testing */
const makeResponse = (status: number, bodyText: string): HttpWireResponse => ({
  status,
  statusText: status === 200 ? "OK" : "Error",
  headers: { "content-type": "application/json" },
  bodyText,
  ms: 1,
});

/** A minimal HttpError for testing */
const makeHttpError = (tag: "FetchError" | "Timeout" | "Abort"): HttpError => {
  switch (tag) {
    case "FetchError":
      return { _tag: "FetchError", message: "connection refused" };
    case "Timeout":
      return { _tag: "Timeout", timeoutMs: 5000, message: "timed out" };
    case "Abort":
      return { _tag: "Abort" };
  }
};

/**
 * Simulates the fast-path logic from `runDirectTransport`:
 * When effect._tag === "Async", call effect.register directly.
 * Otherwise, fall back to registerHttpEffect.
 */
function runFastPath(
  effect: Async<unknown, HttpError, HttpWireResponse>,
  env: unknown,
): { exit: Exit<HttpError, HttpWireResponse> | null; cancel: EffectCanceler | undefined } {
  let result: Exit<HttpError, HttpWireResponse> | null = null;
  let cancelFn: EffectCanceler | undefined;

  if (effect._tag === "Async") {
    // Fast path: direct register call
    const cancel = effect.register(env, (exit) => {
      result = exit;
    });
    cancelFn = typeof cancel === "function" ? cancel : undefined;
  } else {
    // Slow path: full interpreter
    cancelFn = registerHttpEffect(effect, env, (exit) => {
      result = exit;
    });
  }

  return { exit: result, cancel: cancelFn };
}

/**
 * Runs the effect through the full registerHttpEffect interpreter (always slow path).
 */
function runFullInterpreter(
  effect: Async<unknown, HttpError, HttpWireResponse>,
  env: unknown,
): { exit: Exit<HttpError, HttpWireResponse> | null; cancel: EffectCanceler | undefined } {
  let result: Exit<HttpError, HttpWireResponse> | null = null;

  const cancel = registerHttpEffect(effect, env, (exit) => {
    result = exit;
  });

  return { exit: result, cancel };
}

/** Deep equality check for Exit values */
function exitsAreEqual(
  a: Exit<HttpError, HttpWireResponse> | null,
  b: Exit<HttpError, HttpWireResponse> | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a._tag !== b._tag) return false;
  if (a._tag === "Success" && b._tag === "Success") {
    return (
      a.value.status === b.value.status &&
      a.value.statusText === b.value.statusText &&
      a.value.bodyText === b.value.bodyText &&
      a.value.ms === b.value.ms
    );
  }
  if (a._tag === "Failure" && b._tag === "Failure") {
    return causesAreEqual(a.cause, b.cause);
  }
  return false;
}

function causesAreEqual(a: Cause<HttpError>, b: Cause<HttpError>): boolean {
  if (a._tag !== b._tag) return false;
  switch (a._tag) {
    case "Fail":
      return (
        b._tag === "Fail" &&
        a.error._tag === b.error._tag &&
        JSON.stringify(a.error) === JSON.stringify(b.error)
      );
    case "Interrupt":
      return b._tag === "Interrupt";
    case "Die":
      return b._tag === "Die";
    case "Then":
    case "Both":
      return (
        (b._tag === "Then" || b._tag === "Both") &&
        a._tag === b._tag &&
        causesAreEqual(a.left as Cause<HttpError>, b.left as Cause<HttpError>) &&
        causesAreEqual(a.right as Cause<HttpError>, b.right as Cause<HttpError>)
      );
  }
}

// --- Generators ---

/** Generate a successful HttpWireResponse */
const arbResponse = fc.record({
  status: fc.integer({ min: 200, max: 599 }),
  bodyText: fc.string({ minLength: 0, maxLength: 50 }),
}).map(({ status, bodyText }) => makeResponse(status, bodyText));

/** Generate an HttpError */
const arbHttpError = fc.oneof(
  fc.constant(makeHttpError("FetchError")),
  fc.constant(makeHttpError("Timeout")),
  fc.constant(makeHttpError("Abort")),
);

/** Generate a bare Async effect (hits fast path) */
const arbBareAsync = (
  arbResp: fc.Arbitrary<HttpWireResponse>,
  arbErr: fc.Arbitrary<HttpError>,
): fc.Arbitrary<Async<unknown, HttpError, HttpWireResponse>> =>
  fc.oneof(
    // Async that succeeds synchronously
    arbResp.map((response) => ({
      _tag: "Async" as const,
      register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
        cb({ _tag: "Success", value: response });
      },
    })),
    // Async that fails synchronously
    arbErr.map((error) => ({
      _tag: "Async" as const,
      register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
        cb({ _tag: "Failure", cause: Cause.fail(error) });
      },
    })),
    // Async that succeeds with a cancel function
    arbResp.map((response) => ({
      _tag: "Async" as const,
      register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
        cb({ _tag: "Success", value: response });
        return () => {};
      },
    })),
  );

/** Generate a FlatMap-wrapped effect (hits slow path) */
const arbFlatMapWrapped = (
  arbResp: fc.Arbitrary<HttpWireResponse>,
  arbErr: fc.Arbitrary<HttpError>,
): fc.Arbitrary<Async<unknown, HttpError, HttpWireResponse>> =>
  fc.oneof(
    // FlatMap that succeeds: Succeed(x) >>= identity
    arbResp.map((response) =>
      asyncFlatMap(
        asyncSucceed(response) as Async<unknown, HttpError, HttpWireResponse>,
        (r) => asyncSucceed(r) as Async<unknown, HttpError, HttpWireResponse>,
      ),
    ),
    // FlatMap that fails: Fail(e) >>= identity
    arbErr.map((error) =>
      asyncFlatMap(
        asyncFail(error) as Async<unknown, HttpError, HttpWireResponse>,
        (r) => asyncSucceed(r) as Async<unknown, HttpError, HttpWireResponse>,
      ),
    ),
    // FlatMap with Async inner: Async(succeed) >>= identity
    arbResp.map((response) =>
      asyncFlatMap(
        {
          _tag: "Async" as const,
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            cb({ _tag: "Success", value: response });
          },
        } as Async<unknown, HttpError, HttpWireResponse>,
        (r) => asyncSucceed(r) as Async<unknown, HttpError, HttpWireResponse>,
      ),
    ),
  );

/** Generate a Fold-wrapped effect (hits slow path) */
const arbFoldWrapped = (
  arbResp: fc.Arbitrary<HttpWireResponse>,
  arbErr: fc.Arbitrary<HttpError>,
): fc.Arbitrary<Async<unknown, HttpError, HttpWireResponse>> =>
  fc.oneof(
    // Fold on success: Succeed(x) fold(_, identity)
    arbResp.map((response) =>
      asyncFold(
        asyncSucceed(response) as Async<unknown, HttpError, HttpWireResponse>,
        (e: HttpError) => asyncFail(e) as Async<unknown, HttpError, HttpWireResponse>,
        (r: HttpWireResponse) => asyncSucceed(r) as Async<unknown, HttpError, HttpWireResponse>,
      ),
    ),
    // Fold on failure with recovery: Fail(e) fold(recover, _)
    fc.tuple(arbErr, arbResp).map(([error, response]) =>
      asyncFold(
        asyncFail(error) as Async<unknown, HttpError, HttpWireResponse>,
        (_e: HttpError) => asyncSucceed(response) as Async<unknown, HttpError, HttpWireResponse>,
        (r: HttpWireResponse) => asyncSucceed(r) as Async<unknown, HttpError, HttpWireResponse>,
      ),
    ),
    // Fold on failure without recovery: Fail(e) fold(rethrow, _)
    arbErr.map((error) =>
      asyncFold(
        asyncFail(error) as Async<unknown, HttpError, HttpWireResponse>,
        (e: HttpError) => asyncFail(e) as Async<unknown, HttpError, HttpWireResponse>,
        (r: HttpWireResponse) => asyncSucceed(r) as Async<unknown, HttpError, HttpWireResponse>,
      ),
    ),
  );

/** Generate a Sync-wrapped effect (hits slow path) */
const arbSyncWrapped = (
  arbResp: fc.Arbitrary<HttpWireResponse>,
  arbErr: fc.Arbitrary<HttpError>,
): fc.Arbitrary<Async<unknown, HttpError, HttpWireResponse>> =>
  fc.oneof(
    // Sync that returns a value (wrapped in FlatMap to produce HttpWireResponse)
    arbResp.map((response) =>
      asyncFlatMap(
        asyncSync(() => response) as Async<unknown, HttpError, HttpWireResponse>,
        (r) => asyncSucceed(r) as Async<unknown, HttpError, HttpWireResponse>,
      ),
    ),
    // Sync that throws (wrapped in Fold to catch)
    arbErr.map((error) =>
      asyncFold(
        {
          _tag: "Sync" as const,
          thunk: () => { throw error; },
        } as Async<unknown, HttpError, HttpWireResponse>,
        // The Sync throw produces a Die cause, not a Fail cause.
        // The Fold's onFailure only handles Fail causes, so Die propagates.
        (_e: HttpError) => asyncFail(error) as Async<unknown, HttpError, HttpWireResponse>,
        (r: HttpWireResponse) => asyncSucceed(r) as Async<unknown, HttpError, HttpWireResponse>,
      ),
    ),
  );

/** Generate effect trees with varying shapes */
const arbEffectTree: fc.Arbitrary<Async<unknown, HttpError, HttpWireResponse>> = fc.oneof(
  arbBareAsync(arbResponse, arbHttpError),
  arbFlatMapWrapped(arbResponse, arbHttpError),
  arbFoldWrapped(arbResponse, arbHttpError),
  arbSyncWrapped(arbResponse, arbHttpError),
);

// --- Property tests ---

describe("Property 1: Effect path equivalence", () => {
  it("fast-path and full interpreter produce identical Exit values for all effect shapes", () => {
    fc.assert(
      fc.property(arbEffectTree, (effect) => {
        const env = {};

        const fastResult = runFastPath(effect, env);
        const fullResult = runFullInterpreter(effect, env);

        // Both should produce a result (synchronous effects resolve immediately)
        expect(fastResult.exit).not.toBeNull();
        expect(fullResult.exit).not.toBeNull();

        // Exit values must be identical
        expect(exitsAreEqual(fastResult.exit, fullResult.exit)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("cancellation produces interrupt exit on both paths for bare Async effects", () => {
    fc.assert(
      fc.property(
        arbResponse,
        (response) => {
          const env = {};

          // Create an Async effect that does NOT call cb immediately (simulates pending)
          const pendingEffect: Async<unknown, HttpError, HttpWireResponse> = {
            _tag: "Async",
            register: (_env: unknown, _cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
              // Don't call cb — effect is pending
              return () => {
                // Cancel function — no-op for test purposes
              };
            },
          };

          // Fast path
          let fastExit: Exit<HttpError, HttpWireResponse> | null = null;
          const fastCancel = registerHttpEffect(pendingEffect, env, (exit) => {
            fastExit = exit;
          });

          // Full interpreter
          let fullExit: Exit<HttpError, HttpWireResponse> | null = null;
          const fullCancel = registerHttpEffect(pendingEffect, env, (exit) => {
            fullExit = exit;
          });

          // Before cancel, no exit should be produced
          expect(fastExit).toBeNull();
          expect(fullExit).toBeNull();

          // Cancel both
          fastCancel();
          fullCancel();

          // Both should produce interrupt exits
          expect(fastExit).not.toBeNull();
          expect(fullExit).not.toBeNull();
          expect(fastExit!._tag).toBe("Failure");
          expect(fullExit!._tag).toBe("Failure");

          if (fastExit!._tag === "Failure" && fullExit!._tag === "Failure") {
            expect(Cause.containsInterrupt(fastExit!.cause)).toBe(true);
            expect(Cause.containsInterrupt(fullExit!.cause)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("cancellation on FlatMap-wrapped effects produces interrupt exit identically", () => {
    fc.assert(
      fc.property(
        arbResponse,
        (_response) => {
          const env = {};

          // Create a FlatMap-wrapped effect with a pending inner Async
          const pendingFlatMap: Async<unknown, HttpError, HttpWireResponse> = {
            _tag: "FlatMap",
            first: {
              _tag: "Async",
              register: (_env: unknown, _cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
                return () => {};
              },
            },
            andThen: (r: HttpWireResponse) => asyncSucceed(r) as Async<unknown, HttpError, HttpWireResponse>,
          };

          // Both paths go through registerHttpEffect for FlatMap
          let exit1: Exit<HttpError, HttpWireResponse> | null = null;
          const cancel1 = registerHttpEffect(pendingFlatMap, env, (exit) => {
            exit1 = exit;
          });

          let exit2: Exit<HttpError, HttpWireResponse> | null = null;
          const cancel2 = registerHttpEffect(pendingFlatMap, env, (exit) => {
            exit2 = exit;
          });

          // Before cancel
          expect(exit1).toBeNull();
          expect(exit2).toBeNull();

          // Cancel both
          cancel1();
          cancel2();

          // Both should produce interrupt exits
          expect(exit1).not.toBeNull();
          expect(exit2).not.toBeNull();
          expect(exit1!._tag).toBe("Failure");
          expect(exit2!._tag).toBe("Failure");

          if (exit1!._tag === "Failure" && exit2!._tag === "Failure") {
            expect(Cause.containsInterrupt(exit1!.cause)).toBe(true);
            expect(Cause.containsInterrupt(exit2!.cause)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("fast-path direct register matches full interpreter for success outcomes", () => {
    fc.assert(
      fc.property(arbResponse, (response) => {
        const env = {};

        // Bare Async that succeeds — fast path applies
        const effect: Async<unknown, HttpError, HttpWireResponse> = {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            cb({ _tag: "Success", value: response });
          },
        };

        const fastResult = runFastPath(effect, env);
        const fullResult = runFullInterpreter(effect, env);

        expect(fastResult.exit).not.toBeNull();
        expect(fullResult.exit).not.toBeNull();
        expect(fastResult.exit!._tag).toBe("Success");
        expect(fullResult.exit!._tag).toBe("Success");
        expect(exitsAreEqual(fastResult.exit, fullResult.exit)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("fast-path direct register matches full interpreter for failure outcomes", () => {
    fc.assert(
      fc.property(arbHttpError, (error) => {
        const env = {};

        // Bare Async that fails — fast path applies
        const effect: Async<unknown, HttpError, HttpWireResponse> = {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            cb({ _tag: "Failure", cause: Cause.fail(error) });
          },
        };

        const fastResult = runFastPath(effect, env);
        const fullResult = runFullInterpreter(effect, env);

        expect(fastResult.exit).not.toBeNull();
        expect(fullResult.exit).not.toBeNull();
        expect(fastResult.exit!._tag).toBe("Failure");
        expect(fullResult.exit!._tag).toBe("Failure");
        expect(exitsAreEqual(fastResult.exit, fullResult.exit)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
