// stream/pipeline.ts
// ZPipeline-style transformers for brass-runtime streams.
//
// Philosophy:
//   - A Pipeline is a reusable Stream transformer.
//   - It can add its own environment requirements (R) and failure type (E).
//   - It preserves Stream semantics: end-of-stream is represented by Failure(None).

import {
    Async,
    asyncFail,
    asyncFlatMap,
    asyncFold,
    asyncMapError,
    asyncSucceed,
} from "../types/asyncEffect";
import { none, Option, some } from "../types/option";
import {emptyStream, fromPull, uncons, widenOpt, ZStream} from "./stream";
import { buffer as bufferStream } from "./buffer";

/**
 * ZPipeline-style transformer.
 *
 * A pipeline that consumes `In` and produces `Out`, potentially requiring `Rp` and failing with `Ep`.
 * When applied to a stream `ZStream<R, E, In>`, the result is `ZStream<R & Rp, E | Ep, Out>`.
 */
export type ZPipeline<Rp, Ep, In, Out> = <R, E>(
    input: ZStream<R, E, In>
) => ZStream<R & Rp, E | Ep, Out>;



/** Apply a pipeline to a stream (alias of `pipeline(stream)`). */
export function via<R, E, A, Rp, Ep, B>(
    stream: ZStream<R, E, A>,
    pipeline: ZPipeline<Rp, Ep, A, B>
): ZStream<R & Rp, E | Ep, B> {
    return pipeline(stream);
}

/** Compose pipelines left-to-right (p1 >>> p2). */
export function andThen<R1, E1, In, Mid, R2, E2, Out>(
    p1: ZPipeline<R1, E1, In, Mid>,
    p2: ZPipeline<R2, E2, Mid, Out>
): ZPipeline<R1 & R2, E1 | E2, In, Out> {
    return (<R, E>(input: ZStream<R, E, In>) => p2(p1(input as any) as any)) as any;
}

/** Compose pipelines right-to-left (p2 <<< p1). */
export function compose<R1, E1, In, Mid, R2, E2, Out>(
    p2: ZPipeline<R2, E2, Mid, Out>,
    p1: ZPipeline<R1, E1, In, Mid>
): ZPipeline<R1 & R2, E1 | E2, In, Out> {
    return andThen(p1, p2);
}

/** Identity pipeline. */
export function identity<A>(): ZPipeline<unknown, never, A, A> {
    return (<R, E>(input: ZStream<R, E, A>) => input) as any;
}

/** Map elements. */
export function mapP<A, B>(f: (a: A) => B): ZPipeline<unknown, never, A, B> {
    return (<R, E>(input: ZStream<R, E, A>) => {
        const loop = (cur: ZStream<R, E, A>): ZStream<R, E, B> =>
            fromPull(
                asyncFold(
                    uncons(cur),
                    (opt: Option<E>) => asyncFail(opt),
                    ([a, tail]) => asyncSucceed([f(a), loop(tail)] as const)
                ) as any
            );

        return loop(input);
    }) as any;
}

/** Filter elements, preserving end/error. */
export function filterP<A>(pred: (a: A) => boolean): ZPipeline<unknown, never, A, A> {
    return (<R, E>(input: ZStream<R, E, A>) => {
        const next = (cur: ZStream<R, E, A>): Async<R, Option<E>, [A, ZStream<R, E, A>]> =>
            asyncFold(
                uncons(cur),
                (opt: Option<E>) => asyncFail(opt),
                ([a, tail]) => (pred(a) ? asyncSucceed([a, loop(tail)] as const) : next(tail))
            ) as any;

        const loop = (cur: ZStream<R, E, A>): ZStream<R, E, A> => fromPull(next(cur) as any);

        return loop(input);
    }) as any;
}

/**
 * Filter-map (aka collectSome).
 * If `f(a)` returns None, the element is dropped.
 */
export function filterMapP<A, B>(f: (a: A) => Option<B>): ZPipeline<unknown, never, A, B> {
    return (<R, E>(input: ZStream<R, E, A>) => {
        const next = (cur: ZStream<R, E, A>): Async<R, Option<E>, [B, ZStream<R, E, B>]> =>
            asyncFold(
                uncons(cur),
                (opt: Option<E>) => asyncFail(opt),
                ([a, tail]) => {
                    const ob = f(a);
                    return ob._tag === "Some"
                        ? asyncSucceed([ob.value, loop(tail)] as const)
                        : next(tail);
                }
            ) as any;

        const loop = (cur: ZStream<R, E, A>): ZStream<R, E, B> => fromPull(next(cur) as any);

        return loop(input);
    }) as any;
}

/** Take at most N elements. */
export function takeP<A>(n: number): ZPipeline<unknown, never, A, A> {
    const m = Math.max(0, n | 0);

    return (<R, E>(input: ZStream<R, E, A>) => {
        const loop = (cur: ZStream<R, E, A>, remaining: number): ZStream<R, E, A> => {
            if (remaining <= 0) return emptyStream<R, E, A>();

            return fromPull(
                asyncFold(
                    uncons(cur),
                    (opt: Option<E>) => asyncFail(opt),
                    ([a, tail]) => asyncSucceed([a, loop(tail, remaining - 1)] as const)
                ) as any
            );
        };

        return loop(input, m);
    }) as any;
}

/** Drop the first N elements. */
export function dropP<A>(n: number): ZPipeline<unknown, never, A, A> {
    const m = Math.max(0, n | 0);

    return (<R, E>(input: ZStream<R, E, A>) => {
        const skip = (cur: ZStream<R, E, A>, remaining: number): ZStream<R, E, A> => {
            if (remaining <= 0) return cur;

            return fromPull(
                asyncFold(
                    uncons(cur),
                    (opt: Option<E>) => asyncFail(opt),
                    ([_a, tail]) => uncons(skip(tail, remaining - 1)) as any
                ) as any
            );
        };

        return skip(input, m);
    }) as any;
}

/**
 * Map elements with an effect (sequential).
 *
 * - Upstream end => end
 * - Upstream error E => fail(E)
 * - f(a) fails with Ep => fail(Ep)
 */
const raiseToOpt =
  <E, Ep, R, B>(fa: Async<R, Ep, B>): Async<R, Option<E | Ep>, B> =>
    asyncMapError(fa, (e: Ep) => some(e as unknown as E | Ep));

export function mapEffectP<Rp, Ep, A, B>(
  f: (a: A) => Async<Rp, Ep, B>
): ZPipeline<Rp, Ep, A, B> {
  return (<R, E>(input: ZStream<R, E, A>) => {
    const raiseToOpt =
      <E0>(fa: Async<Rp, Ep, B>): Async<Rp, Option<E0 | Ep>, B> =>
        asyncMapError(fa, (e: Ep) => some(e as unknown as E0 | Ep));

    const loop = (cur: ZStream<R & Rp, E, A>): ZStream<R & Rp, E | Ep, B> =>
      fromPull(
        asyncFold(
          asyncMapError(
            uncons(cur),
            (opt: Option<E>) => widenOpt<E, Ep>(opt)
          ),
          (opt: Option<E | Ep>) => asyncFail(opt),
          ([a, tail]) =>
            asyncFold(
              raiseToOpt<E>(f(a)),                     // Async<Rp, ...>
              (opt2: Option<E | Ep>) => asyncFail(opt2),
              (b: B) => asyncSucceed([b, loop(tail as any)] as const)
            )
        )
      );

    return loop(input as any) as any;
  }) as any;
}



/** Tap each element with an effect, preserving the element. */
export function tapEffectP<Rp, Ep, A>(
    f: (a: A) => Async<Rp, Ep, any>
): ZPipeline<Rp, Ep, A, A> {
    return mapEffectP<Rp, Ep, A, A>((a) => asyncFlatMap(f(a) as any, () => asyncSucceed(a)) as any);
}

/** Buffer upstream using your existing queue-based buffer implementation. */
export function bufferP<A>(
    capacity: number,
    strategy: "backpressure" | "dropping" | "sliding" = "backpressure"
): ZPipeline<unknown, never, A, A> {
    return (<R, E>(input: ZStream<R, E, A>) => bufferStream(input as any, capacity, strategy) as any) as any;
}

/**
 * Group elements into arrays of size `n` (last chunk may be smaller).
 * Example: [1,2,3,4,5].grouped(2) => [1,2],[3,4],[5]
 */
export function groupedP<A>(n: number): ZPipeline<unknown, never, A, A[]> {
    const size = Math.max(1, n | 0);

    return (<R, E>(input: ZStream<R, E, A>) => {
        const gather = (
            cur: ZStream<R, E, A>,
            remaining: number,
            acc: A[]
        ): Async<R, Option<E>, { chunk: A[]; rest: ZStream<R, E, A> }> => {
            if (remaining <= 0) return asyncSucceed({ chunk: acc, rest: cur });

            return asyncFold(
                uncons(cur),
                (opt: Option<E>) => {
                    // End => emit partial (if any) and terminate afterwards.
                    if (opt._tag === "None") return asyncSucceed({ chunk: acc, rest: emptyStream<R, E, A>() });
                    // Real error.
                    return asyncFail(opt);
                },
                ([a, tail]) => gather(tail, remaining - 1, [...acc, a])
            ) as any;
        };

        const loop = (cur: ZStream<R, E, A>): ZStream<R, E, A[]> =>
            fromPull(
                asyncFold(
                    uncons(cur),
                    (opt: Option<E>) => asyncFail(opt),
                    ([a, tail]) =>
                        asyncFlatMap(gather(tail, size - 1, [a]), ({ chunk, rest }) =>
                            asyncSucceed([chunk, loop(rest)] as const)
                        )
                ) as any
            );

        return loop(input);
    }) as any;
}
