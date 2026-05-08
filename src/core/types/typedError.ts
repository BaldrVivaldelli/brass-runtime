// src/core/types/typedError.ts
// Typed error utilities for discriminated union error handling.
//
// Enables pattern matching on error types with full TypeScript type narrowing.

import { Async, asyncFail, asyncFold, asyncSucceed } from "./asyncEffect";

// ---------------------------------------------------------------------------
// Tagged error base
// ---------------------------------------------------------------------------

/**
 * Base type for tagged errors. All errors should extend this pattern:
 *
 * ```ts
 * type NetworkError = { _tag: "NetworkError"; url: string; status: number };
 * type TimeoutError = { _tag: "TimeoutError"; ms: number };
 * type AppError = NetworkError | TimeoutError;
 * ```
 */
export type TaggedError = { readonly _tag: string };

// ---------------------------------------------------------------------------
// catchTag — catch a specific error by its _tag
// ---------------------------------------------------------------------------

/**
 * Catches a specific error by its `_tag` field and handles it.
 * Other errors pass through unchanged.
 *
 * ```ts
 * const result = catchTag(effect, "NetworkError", (e) => fallbackValue);
 * // e is narrowed to NetworkError
 * ```
 */
export function catchTag<R, E extends TaggedError, A, Tag extends E["_tag"], B>(
  effect: Async<R, E, A>,
  tag: Tag,
  handler: (error: Extract<E, { _tag: Tag }>) => Async<R, Exclude<E, { _tag: Tag }>, A | B>
): Async<R, Exclude<E, { _tag: Tag }>, A | B> {
  return asyncFold(
    effect as Async<R, E, A | B>,
    (error: E) => {
      if (typeof error === "object" && error !== null && "_tag" in error && error._tag === tag) {
        return handler(error as Extract<E, { _tag: Tag }>) as any;
      }
      return asyncFail(error) as any;
    },
    (value: A | B) => asyncSucceed(value) as any
  ) as any;
}

/**
 * Catches multiple error tags with a single handler map.
 *
 * ```ts
 * const result = catchTags(effect, {
 *   NetworkError: (e) => asyncSucceed(defaultValue),
 *   TimeoutError: (e) => retry(effect),
 * });
 * ```
 */
export function catchTags<
  R, E extends TaggedError, A,
  Handlers extends Partial<{ [K in E["_tag"]]: (error: Extract<E, { _tag: K }>) => Async<R, any, any> }>
>(
  effect: Async<R, E, A>,
  handlers: Handlers
): Async<R, Exclude<E, { _tag: keyof Handlers & string }>, A> {
  return asyncFold(
    effect,
    (error: E) => {
      if (typeof error === "object" && error !== null && "_tag" in error) {
        const handler = (handlers as any)[error._tag];
        if (handler) return handler(error) as any;
      }
      return asyncFail(error) as any;
    },
    (value: A) => asyncSucceed(value) as any
  ) as any;
}

// ---------------------------------------------------------------------------
// mapError — transform the error channel
// ---------------------------------------------------------------------------

/**
 * Maps the error channel of an effect.
 *
 * ```ts
 * const result = mapError(effect, (e) => ({ _tag: "Wrapped", cause: e }));
 * ```
 */
export function mapError<R, E, E2, A>(
  effect: Async<R, E, A>,
  f: (error: E) => E2
): Async<R, E2, A> {
  return asyncFold(effect, (error) => asyncFail(f(error)), asyncSucceed);
}

// ---------------------------------------------------------------------------
// tagError — wrap an untyped error with a tag
// ---------------------------------------------------------------------------

/**
 * Wraps any error with a tag, making it part of a discriminated union.
 *
 * ```ts
 * const typed = tagError(fetchData(), "NetworkError", (e) => ({ url, cause: e }));
 * // Error type becomes { _tag: "NetworkError"; url: string; cause: unknown }
 * ```
 */
export function tagError<R, E, A, Tag extends string, Fields extends Record<string, unknown>>(
  effect: Async<R, E, A>,
  tag: Tag,
  enrich?: (error: E) => Fields
): Async<R, { _tag: Tag } & Fields, A> {
  return asyncFold(
    effect,
    (error: E) => {
      const fields = enrich ? enrich(error) : ({} as Fields);
      return asyncFail({ _tag: tag, ...fields });
    },
    asyncSucceed
  );
}

// ---------------------------------------------------------------------------
// orElse — fallback on any error
// ---------------------------------------------------------------------------

/**
 * If the effect fails, run the fallback instead.
 *
 * ```ts
 * const result = orElse(primary(), () => fallback());
 * ```
 */
export function orElse<R, E, A, R2, E2, B>(
  effect: Async<R, E, A>,
  fallback: (error: E) => Async<R2, E2, B>
): Async<R & R2, E2, A | B> {
  return asyncFold(effect, fallback, asyncSucceed);
}
