/**
 * Dual (data-first / data-last) combinators for the v2 `Effect` namespace.
 *
 * Every function here accepts both `Effect.map(self, f)` and the `pipe`-able
 * `Effect.map(f)`. The v1 data-first exports in `effect.ts` are untouched, so
 * this adds a calling convention without changing any existing signature.
 */
import type { Async } from "./asyncEffect";
import { as as baseAs, catchAll as baseCatchAll, catchAllWith as baseCatchAllWith, flatMap as baseFlatMap, map as baseMap, mapError as baseMapError, tap as baseTap } from "./effect";
import {
  retry as baseRetry,
  retryN as baseRetryN,
  retryWithBackoff as baseRetryWithBackoff,
  timeout as baseTimeout,
  type RetryPolicy,
  type TimeoutError,
} from "../runtime/combinators";
import { dual } from "./pipe";

const isEffectFirst = (args: ReadonlyArray<unknown>): boolean =>
  typeof args[0] === "object" && args[0] !== null && "_tag" in (args[0] as object);

export interface MapSignature {
  <R, E, A, B>(self: Async<R, E, A>, f: (a: A) => B): Async<R, E, B>;
  <A, B>(f: (a: A) => B): <R, E>(self: Async<R, E, A>) => Async<R, E, B>;
}

export interface FlatMapSignature {
  <R, E, A, R2, E2, B>(self: Async<R, E, A>, f: (a: A) => Async<R2, E2, B>): Async<R & R2, E | E2, B>;
  <A, R2, E2, B>(
    f: (a: A) => Async<R2, E2, B>,
  ): <R, E>(self: Async<R, E, A>) => Async<R & R2, E | E2, B>;
}

export interface TapSignature {
  <R, E, A, R2, E2>(self: Async<R, E, A>, f: (a: A) => Async<R2, E2, unknown>): Async<R & R2, E | E2, A>;
  <A, R2, E2>(
    f: (a: A) => Async<R2, E2, unknown>,
  ): <R, E>(self: Async<R, E, A>) => Async<R & R2, E | E2, A>;
}

export interface CatchAllSignature {
  <R, E, A, R2, E2, B>(self: Async<R, E, A>, f: (e: E) => Async<R2, E2, B>): Async<R & R2, E2, A | B>;
  <E, R2, E2, B>(
    f: (e: E) => Async<R2, E2, B>,
  ): <R, A>(self: Async<R, E, A>) => Async<R & R2, E2, A | B>;
}

export interface CatchAllWithSignature {
  <R, E, A, B>(self: Async<R, E, A>, f: (e: E) => B): Async<R, never, A | B>;
  <E, B>(f: (e: E) => B): <R, A>(self: Async<R, E, A>) => Async<R, never, A | B>;
}

export interface MapErrorSignature {
  <R, E, E2, A>(self: Async<R, E, A>, f: (e: E) => E2): Async<R, E2, A>;
  <E, E2>(f: (e: E) => E2): <R, A>(self: Async<R, E, A>) => Async<R, E2, A>;
}

export interface AsSignature {
  <R, E, A, B>(self: Async<R, E, A>, value: B): Async<R, E, B>;
  <B>(value: B): <R, E, A>(self: Async<R, E, A>) => Async<R, E, B>;
}

export interface TimeoutSignature {
  <R, E, A>(self: Async<R, E, A>, ms: number): Async<R, E | TimeoutError, A>;
  (ms: number): <R, E, A>(self: Async<R, E, A>) => Async<R, E | TimeoutError, A>;
}

export interface RetrySignature {
  <R, E, A>(self: Async<R, E, A>, policy: RetryPolicy): Async<R, E, A>;
  (policy: RetryPolicy): <R, E, A>(self: Async<R, E, A>) => Async<R, E, A>;
}

export interface RetryNSignature {
  <R, E, A>(self: Async<R, E, A>, times: number): Async<R, E, A>;
  (times: number): <R, E, A>(self: Async<R, E, A>) => Async<R, E, A>;
}

type BackoffOptions = Parameters<typeof baseRetryWithBackoff>[1];

export interface RetryWithBackoffSignature {
  <R, E, A>(self: Async<R, E, A>, options?: BackoffOptions): Async<R, E, A>;
  (options?: BackoffOptions): <R, E, A>(self: Async<R, E, A>) => Async<R, E, A>;
}

export const map = dual(2, baseMap) as MapSignature;
export const flatMap = dual(2, baseFlatMap) as FlatMapSignature;
export const tap = dual(2, baseTap) as TapSignature;
export const catchAll = dual(2, baseCatchAll) as CatchAllSignature;
export const catchAllWith = dual(2, baseCatchAllWith) as CatchAllWithSignature;
export const mapError = dual(2, baseMapError) as MapErrorSignature;
export const as = dual(2, baseAs) as AsSignature;
export const timeout = dual(2, baseTimeout) as TimeoutSignature;
export const retry = dual(2, baseRetry) as RetrySignature;
export const retryN = dual(2, baseRetryN) as RetryNSignature;

/**
 * `retryWithBackoff` has an optional second parameter, so argument counting
 * cannot tell `retryWithBackoff(self)` from `retryWithBackoff(options)`.
 * The guard checks for an effect node instead.
 */
export const retryWithBackoff = dual(
  isEffectFirst,
  baseRetryWithBackoff,
) as RetryWithBackoffSignature;
