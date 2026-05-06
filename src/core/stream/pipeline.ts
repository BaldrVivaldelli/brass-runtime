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
import { chunks as chunksStream, mapChunksEffect, StreamChunkOptions } from "./chunks";
import { PURE_PIPELINE_TAG, PurePipelineMetadata, fuse, applyFused, FusedPipelineRepr, isFusionEnabled, isFusionVerbose } from "./fusion";

/**
 * ZPipeline-style transformer.
 *
 * A pipeline that consumes `In` and produces `Out`, potentially requiring `Rp` and failing with `Ep`.
 * When applied to a stream `ZStream<R, E, In>`, the result is `ZStream<R & Rp, E | Ep, Out>`.
 */
export type ZPipeline<Rp, Ep, In, Out> = <R, E>(
    input: ZStream<R, E, In>
) => ZStream<R & Rp, E | Ep, Out>;



/** Apply a pipeline to a stream (alias of `pipeline(stream)`).
 *
 * OPTIMIZATION: When the pipeline is a single pure operator (has PURE_PIPELINE_TAG)
 * and the stream can be drained synchronously, uses the fast fused path.
 * The FusedPipelineRepr is cached on the pipeline to avoid recalculation.
 */
export function via<R, E, A, Rp, Ep, B>(
    stream: ZStream<R, E, A>,
    pipeline: ZPipeline<Rp, Ep, A, B>
): ZStream<R & Rp, E | Ep, B> {
    // Fast path: if pipeline is pure (single or fused) and fusion is enabled,
    // try to use applyFused which will attempt synchronous drain
    if (isFusionEnabled()) {
        const p = pipeline as any;
        if (p._fusedSteps || p[PURE_PIPELINE_TAG]) {
            // Cache the FusedPipelineRepr on the pipeline to avoid recalculating
            let fusedRepr = p._cachedFusedRepr;
            if (!fusedRepr) {
                fusedRepr = fuse(pipeline as any);
                if (fusedRepr) p._cachedFusedRepr = fusedRepr;
            }
            if (fusedRepr) {
                return applyFused(stream as any, fusedRepr) as any;
            }
        }
    }
    return pipeline(stream);
}

/** Compose pipelines left-to-right (p1 >>> p2). */
export function andThen<R1, E1, In, Mid, R2, E2, Out>(
    p1: ZPipeline<R1, E1, In, Mid>,
    p2: ZPipeline<R2, E2, Mid, Out>
): ZPipeline<R1 & R2, E1 | E2, In, Out> {
    // Attempt automatic fusion when both operands are pure
    const fused = tryFuse<In, Mid, Out>(p1 as any, p2 as any);
    if (fused) return fused as any;

    // Fallback: standard composition
    return (<R, E>(input: ZStream<R, E, In>) => p2(p1(input as any) as any)) as any;
}

// ---------------------------------------------------------------------------
// Internal: automatic fusion for andThen
// ---------------------------------------------------------------------------

/**
 * Collects metadata from a pipeline that is either:
 * - A single pure operator (has PURE_PIPELINE_TAG)
 * - An already-fused pipeline (has _fusedSteps array)
 * Returns null if the pipeline is not pure/fused.
 */
function collectPureMetas<In, Out>(
    pipeline: ZPipeline<unknown, never, In, Out>
): PurePipelineMetadata<any, any>[] | null {
    const p = pipeline as any;

    // Check if it's an already-fused pipeline with _fusedSteps
    if (p._fusedSteps && Array.isArray(p._fusedSteps)) {
        return p._fusedSteps;
    }

    // Check if it's a single pure operator with PURE_PIPELINE_TAG
    const tag = p[PURE_PIPELINE_TAG] as PurePipelineMetadata<In, Out> | undefined;
    if (tag) {
        return [tag];
    }

    return null;
}

/**
 * Attempts to fuse two pipelines. Returns a fused pipeline if both are pure,
 * or null if fusion doesn't apply.
 */
function tryFuse<In, Mid, Out>(
    p1: ZPipeline<unknown, never, In, Mid>,
    p2: ZPipeline<unknown, never, Mid, Out>
): ZPipeline<unknown, never, In, Out> | null {
    // Check global fusion flag
    if (!isFusionEnabled()) {
        if (isFusionVerbose()) {
            console.log("[FusionEngine] andThen: fusion globally disabled, skipping");
        }
        return null;
    }

    const metas1 = collectPureMetas(p1);
    const metas2 = collectPureMetas(p2);

    // Both must be pure for fusion to apply
    if (!metas1 || !metas2) {
        if (isFusionVerbose()) {
            const reason = !metas1 && !metas2
                ? "neither operand is pure"
                : !metas1
                ? "left operand is not pure"
                : "right operand is not pure";
            console.log(`[FusionEngine] andThen: cannot fuse — ${reason}`);
        }
        return null;
    }

    // Combine metadata from both pipelines
    const combinedMetas: PurePipelineMetadata<any, any>[] = [...metas1, ...metas2];

    // Build the fused representation from combined metadata
    const fusedRepr = fuse(
        createMetadataCarrier(combinedMetas) as any
    );

    if (!fusedRepr) {
        return null;
    }

    if (isFusionVerbose()) {
        console.log(
            `[FusionEngine] andThen: fused ${combinedMetas.length} steps: ${combinedMetas.map((m) => m.kind).join(" → ")}`
        );
    }

    // Create the fused pipeline function
    const fusedPipeline = (<R, E>(input: ZStream<R, E, In>) => {
        return applyFused(input, fusedRepr as FusedPipelineRepr<In, Out>);
    }) as ZPipeline<unknown, never, In, Out>;

    // Attach _fusedSteps for further composition
    (fusedPipeline as any)._fusedSteps = combinedMetas;

    return fusedPipeline;
}

/**
 * Creates a minimal pipeline carrier that holds _fusedSteps metadata,
 * allowing fuse() to detect it as a composed pipeline.
 */
function createMetadataCarrier(
    metas: PurePipelineMetadata<any, any>[]
): ZPipeline<unknown, never, any, any> {
    const carrier = (() => {}) as any;
    carrier._fusedSteps = metas;
    return carrier;
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
    const pipeline = (<R, E>(input: ZStream<R, E, A>) => {
        // Hoist both handlers outside the loop — reused across all pulls
        // instead of creating new closures per element.
        const onError = (opt: Option<E>) => asyncFail(opt);
        const onSuccess = ([a, tail]: [A, ZStream<R, E, A>]) =>
            asyncSucceed([f(a), loop(tail)] as const);

        const loop = (cur: ZStream<R, E, A>): ZStream<R, E, B> =>
            fromPull(
                asyncFold(uncons(cur), onError, onSuccess) as any
            );

        return loop(input);
    }) as ZPipeline<unknown, never, A, B>;
    (pipeline as any)[PURE_PIPELINE_TAG] = { kind: "map", fn: f } as PurePipelineMetadata<A, B>;
    return pipeline;
}

/** Filter elements, preserving end/error. */
export function filterP<A>(pred: (a: A) => boolean): ZPipeline<unknown, never, A, A> {
    const pipeline = (<R, E>(input: ZStream<R, E, A>) => {
        // Hoist both handlers outside the loop — reused across all pulls
        // instead of creating new closures per element.
        const onError = (opt: Option<E>) => asyncFail(opt);
        const onSuccess = ([a, tail]: [A, ZStream<R, E, A>]) =>
            pred(a) ? asyncSucceed([a, loop(tail)] as const) : next(tail);

        const next = (cur: ZStream<R, E, A>): Async<R, Option<E>, [A, ZStream<R, E, A>]> =>
            asyncFold(uncons(cur), onError, onSuccess) as any;

        const loop = (cur: ZStream<R, E, A>): ZStream<R, E, A> => fromPull(next(cur) as any);

        return loop(input);
    }) as ZPipeline<unknown, never, A, A>;
    (pipeline as any)[PURE_PIPELINE_TAG] = { kind: "filter", pred } as PurePipelineMetadata<A, A>;
    return pipeline;
}

/**
 * Filter-map (aka collectSome).
 * If `f(a)` returns None, the element is dropped.
 */
export function filterMapP<A, B>(f: (a: A) => Option<B>): ZPipeline<unknown, never, A, B> {
    return (<R, E>(input: ZStream<R, E, A>) => {
        // Hoist error handler outside the loop — reused across all pulls
        // instead of creating a new closure per element.
        const onError = (opt: Option<E>) => asyncFail(opt);

        const next = (cur: ZStream<R, E, A>): Async<R, Option<E>, [B, ZStream<R, E, B>]> =>
            asyncFold(
                uncons(cur),
                onError,
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

    const pipeline = (<R, E>(input: ZStream<R, E, A>) => {
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
    }) as ZPipeline<unknown, never, A, A>;
    (pipeline as any)[PURE_PIPELINE_TAG] = { kind: "take", n: m } as PurePipelineMetadata<A, A>;
    return pipeline;
}

/** Drop the first N elements. */
export function dropP<A>(n: number): ZPipeline<unknown, never, A, A> {
    const m = Math.max(0, n | 0);

    const pipeline = (<R, E>(input: ZStream<R, E, A>) => {
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
    }) as ZPipeline<unknown, never, A, A>;
    (pipeline as any)[PURE_PIPELINE_TAG] = { kind: "drop", n: m } as PurePipelineMetadata<A, A>;
    return pipeline;
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



/** Re-chunk a stream into arrays of up to `chunkSize` elements. */
export function chunksP<A>(
    chunkSize: number,
    options: StreamChunkOptions = {}
): ZPipeline<unknown, never, A, readonly A[]> {
    return (<R, E>(input: ZStream<R, E, A>) => chunksStream(input, chunkSize, options)) as any;
}

/** Apply one effect per chunk and flatten the returned chunk back to elements. */
export function mapChunksEffectP<Rp, Ep, A, B>(
    chunkSize: number,
    f: (chunk: readonly A[]) => Async<Rp, Ep, readonly B[]>,
    options: StreamChunkOptions = {}
): ZPipeline<Rp, Ep, A, B> {
    return mapChunksEffect(chunkSize, f, options) as any;
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
