// src/core/stream/fusion.ts
// FusionEngine — detects chains of pure operators and fuses them into a single pull loop.
//
// This module implements the core fusion logic for brass-runtime streams.
// It eliminates intermediate fibers by composing pure operators (map, filter, take, drop)
// into a single step function that processes each element through all transformations.

import { none, Option } from "../types/option";
import { asyncFail, asyncFold, asyncSucceed } from "../types/asyncEffect";
import { fail } from "../types/effect";
import { fromPull, uncons, ZStream } from "./stream";
import type { ZPipeline } from "./pipeline";

// ---------------------------------------------------------------------------
// Serialization types
// ---------------------------------------------------------------------------

/** Serialized representation of a single step in a fused pipeline */
export type SerializedStep =
  | { kind: "map"; fnSource: string }
  | { kind: "filter"; predSource: string }
  | { kind: "take"; n: number }
  | { kind: "drop"; n: number };

/** JSON-safe serialized representation of a fused pipeline */
export type SerializedFusedPipeline = {
  readonly version: 1;
  readonly steps: SerializedStep[];
};

// ---------------------------------------------------------------------------
// Global fusion configuration
// ---------------------------------------------------------------------------

let _fusionEnabled = true;
let _fusionVerbose = false;

/** Enable or disable fusion globally. When disabled, andThen will not attempt fusion. */
export function setFusionEnabled(enabled: boolean): void {
  _fusionEnabled = enabled;
}

/** Check if fusion is globally enabled. */
export function isFusionEnabled(): boolean {
  return _fusionEnabled;
}

/** Set verbose mode globally. When enabled, fusion decisions are logged to console. */
export function setFusionVerbose(verbose: boolean): void {
  _fusionVerbose = verbose;
}

/** Check if verbose mode is globally enabled. */
export function isFusionVerbose(): boolean {
  return _fusionVerbose;
}

// ---------------------------------------------------------------------------
// getStats() — extract stats from a fused pipeline
// ---------------------------------------------------------------------------

/**
 * Get stats from a fused pipeline, or null if the pipeline is not fused.
 * Works with pipelines that have been fused via `andThen` (have `_fusedSteps`)
 * or with `FusedPipelineRepr` objects directly.
 */
export function getStats<In, Out>(
  pipeline: ZPipeline<unknown, never, In, Out>
): FusedPipelineStats | null {
  const p = pipeline as any;

  // Check if it's a pipeline with _fusedSteps (created by andThen auto-fusion)
  if (p._fusedSteps && Array.isArray(p._fusedSteps)) {
    const metas: PurePipelineMetadata<any, any>[] = p._fusedSteps;
    return buildStats(metas);
  }

  // Check if it has a single PURE_PIPELINE_TAG (single pure operator, not fused)
  if (p[PURE_PIPELINE_TAG]) {
    return null; // Single operators are not "fused" — they're just pure
  }

  return null;
}

// ---------------------------------------------------------------------------
// Symbol for tagging pure pipelines (used by pipeline.ts operators)
// ---------------------------------------------------------------------------

export const PURE_PIPELINE_TAG = Symbol("brass:pure-pipeline");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a fused step for an element */
export type FuseResult<A> =
  | { readonly tag: "emit"; readonly value: A }
  | { readonly tag: "skip" }
  | { readonly tag: "halt" };

/** Metadata of a step in the original pipeline */
export type FusedStep =
  | { readonly kind: "map" }
  | { readonly kind: "filter" }
  | { readonly kind: "take"; readonly n: number }
  | { readonly kind: "drop"; readonly n: number };

/** Stats of a fused pipeline */
export type FusedPipelineStats = {
  readonly fusedSteps: number;
  readonly steps: readonly FusedStep[];
  readonly hasTake: boolean;
  readonly hasDrop: boolean;
};

/** Internal representation of a fused pipeline */
export type FusedPipelineRepr<In, Out> = {
  readonly _tag: "FusedPipeline";
  readonly step: (a: In, state: FuseState) => FuseResult<Out>;
  readonly initState: () => FuseState;
  readonly stats: FusedPipelineStats;
};

/** Mutable state during execution (per-step counters for take/drop) */
export type FuseState = {
  /** Per-step counters: each take/drop step gets its own independent counter */
  counters: number[];
};

/** Fusion options */
export type FusionOptions = {
  readonly enabled?: boolean;
  readonly verbose?: boolean;
};

// ---------------------------------------------------------------------------
// PurePipelineTag type (attached to pure operators)
// ---------------------------------------------------------------------------

export type PurePipelineMetadata<In, Out> = {
  readonly kind: "map" | "filter" | "take" | "drop";
  readonly fn?: (a: In) => Out;
  readonly pred?: (a: In) => boolean;
  readonly n?: number;
};

export type PurePipelineTag<In, Out> = {
  readonly [PURE_PIPELINE_TAG]: PurePipelineMetadata<In, Out>;
};

// ---------------------------------------------------------------------------
// Internal: step builders for each operator kind
// ---------------------------------------------------------------------------

function makeMapStep<In, Out>(fn: (a: In) => Out): (a: In, state: FuseState) => FuseResult<Out> {
  return (a, _state) => ({ tag: "emit", value: fn(a) });
}

function makeFilterStep<A>(pred: (a: A) => boolean): (a: A, state: FuseState) => FuseResult<A> {
  return (a, _state) => pred(a) ? { tag: "emit", value: a } : { tag: "skip" };
}

function makeTakeStep<A>(n: number, counterIndex: number): (a: A, state: FuseState) => FuseResult<A> {
  return (a, state) => {
    if (state.counters[counterIndex]! >= n) {
      return { tag: "halt" };
    }
    state.counters[counterIndex]!++;
    return { tag: "emit", value: a };
  };
}

function makeDropStep<A>(n: number, counterIndex: number): (a: A, state: FuseState) => FuseResult<A> {
  return (a, state) => {
    if (state.counters[counterIndex]! < n) {
      state.counters[counterIndex]!++;
      return { tag: "skip" };
    }
    return { tag: "emit", value: a };
  };
}

// ---------------------------------------------------------------------------
// initState factory
// ---------------------------------------------------------------------------

/** Creates a FuseState with per-step counters (one for each take/drop step) */
export function initState(counterCount: number): () => FuseState {
  return () => ({
    counters: new Array(counterCount).fill(0),
  });
}

// ---------------------------------------------------------------------------
// Internal: compose two step functions
// ---------------------------------------------------------------------------

function composeSteps<A, B, C>(
  step1: (a: A, state: FuseState) => FuseResult<B>,
  step2: (b: B, state: FuseState) => FuseResult<C>
): (a: A, state: FuseState) => FuseResult<C> {
  return (a, state) => {
    const r1 = step1(a, state);
    if (r1.tag !== "emit") return r1 as unknown as FuseResult<C>;
    return step2(r1.value, state);
  };
}

// ---------------------------------------------------------------------------
// Internal: extract metadata from a tagged pipeline
// ---------------------------------------------------------------------------

function getPureTag<In, Out>(
  pipeline: ZPipeline<unknown, never, In, Out>
): PurePipelineMetadata<In, Out> | null {
  const tagged = pipeline as unknown as Partial<PurePipelineTag<In, Out>>;
  return tagged[PURE_PIPELINE_TAG] ?? null;
}

/** Get the list of fused steps from a pipeline (if it's already fused) */
function getFusedSteps<In, Out>(
  pipeline: ZPipeline<unknown, never, In, Out>
): PurePipelineMetadata<any, any>[] | null {
  const p = pipeline as any;
  if (p._fusedSteps && Array.isArray(p._fusedSteps)) {
    return p._fusedSteps;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal: build step from metadata (with counter index for take/drop)
// ---------------------------------------------------------------------------

function buildStepFromMetadata<In, Out>(
  meta: PurePipelineMetadata<In, Out>,
  counterIndex: number
): (a: In, state: FuseState) => FuseResult<Out> {
  switch (meta.kind) {
    case "map":
      return makeMapStep(meta.fn!) as any;
    case "filter":
      return makeFilterStep(meta.pred!) as any;
    case "take":
      return makeTakeStep(meta.n!, counterIndex) as any;
    case "drop":
      return makeDropStep(meta.n!, counterIndex) as any;
  }
}

// ---------------------------------------------------------------------------
// Internal: build stats from metadata array
// ---------------------------------------------------------------------------

function buildStats(metas: PurePipelineMetadata<any, any>[]): FusedPipelineStats {
  const steps: FusedStep[] = metas.map((m) => {
    switch (m.kind) {
      case "map":
        return { kind: "map" } as FusedStep;
      case "filter":
        return { kind: "filter" } as FusedStep;
      case "take":
        return { kind: "take", n: m.n! } as FusedStep;
      case "drop":
        return { kind: "drop", n: m.n! } as FusedStep;
    }
  });

  return {
    fusedSteps: steps.length,
    steps,
    hasTake: metas.some((m) => m.kind === "take"),
    hasDrop: metas.some((m) => m.kind === "drop"),
  };
}

// ---------------------------------------------------------------------------
// Internal: count how many per-step counters are needed (one per take/drop)
// ---------------------------------------------------------------------------

function countCounters(metas: PurePipelineMetadata<any, any>[]): number {
  let count = 0;
  for (const m of metas) {
    if (m.kind === "take" || m.kind === "drop") {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// fuse() — main entry point
// ---------------------------------------------------------------------------

/**
 * Detects if a pipeline is fusable and returns the fused representation.
 * Returns null if the pipeline is not fusable (not pure or fusion disabled).
 */
export function fuse<In, Out>(
  pipeline: ZPipeline<unknown, never, In, Out>,
  options?: FusionOptions
): FusedPipelineRepr<In, Out> | null {
  const verbose = options?.verbose ?? _fusionVerbose;

  // Check if fusion is disabled (per-call option takes precedence over global)
  if (options?.enabled === false || (!_fusionEnabled && options?.enabled !== true)) {
    if (verbose) {
      console.log("[FusionEngine] Fusion disabled by options");
    }
    return null;
  }

  // Collect all metadata from the pipeline
  const metas = collectMetadata(pipeline);
  if (!metas || metas.length === 0) {
    if (verbose) {
      console.log("[FusionEngine] Pipeline is not fusable (no pure tags detected)");
    }
    return null;
  }

  if (verbose) {
    console.log(
      `[FusionEngine] Fusing ${metas.length} steps: ${metas.map((m) => m.kind).join(" → ")}`
    );
  }

  // Build the composed step function, assigning counter indices to take/drop steps
  let counterIndex = 0;
  let composedStep: (a: any, state: FuseState) => FuseResult<any> = buildStepFromMetadata(
    metas[0]!,
    (metas[0]!.kind === "take" || metas[0]!.kind === "drop") ? counterIndex++ : -1
  );
  for (let i = 1; i < metas.length; i++) {
    const meta = metas[i]!;
    const idx = (meta.kind === "take" || meta.kind === "drop") ? counterIndex++ : -1;
    composedStep = composeSteps(composedStep, buildStepFromMetadata(meta, idx));
  }

  // Count how many per-step counters are needed
  const counterCount = countCounters(metas);

  // Build stats
  const stats = buildStats(metas);

  return {
    _tag: "FusedPipeline",
    step: composedStep as (a: In, state: FuseState) => FuseResult<Out>,
    initState: initState(counterCount),
    stats,
  };
}

// ---------------------------------------------------------------------------
// Internal: collect metadata from a pipeline (single or composed)
// ---------------------------------------------------------------------------

function collectMetadata<In, Out>(
  pipeline: ZPipeline<unknown, never, In, Out>
): PurePipelineMetadata<any, any>[] | null {
  // Check if it's a composed pipeline with _fusedSteps
  const fusedSteps = getFusedSteps(pipeline);
  if (fusedSteps) {
    return fusedSteps;
  }

  // Check if it's a single pure operator
  const tag = getPureTag(pipeline);
  if (tag) {
    return [tag];
  }

  // Not fusable
  return null;
}

// ---------------------------------------------------------------------------
// runFusedArray() — pure synchronous execution of a fused pipeline on an array
// ---------------------------------------------------------------------------

/**
 * Applies a fused pipeline to an array of inputs synchronously.
 * This is the fastest execution path — a pure `for` loop with no effects,
 * no fibers, no scheduling overhead. O(n) with minimal constant factor.
 */
export function runFusedArray<In, Out>(
  input: readonly In[],
  fused: FusedPipelineRepr<In, Out>
): Out[] {
  const state = fused.initState();
  const output: Out[] = [];

  for (let i = 0; i < input.length; i++) {
    const result = fused.step(input[i]!, state);
    switch (result.tag) {
      case "emit":
        output.push(result.value);
        break;
      case "skip":
        break;
      case "halt":
        return output;
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Internal: drain a stream ADT into an array synchronously (best-effort)
// ---------------------------------------------------------------------------

/**
 * Attempts to extract all elements from a stream synchronously.
 * Works for streams built from fromArray (Concat chains of Emit nodes).
 * Returns null if the stream contains async/effectful nodes.
 */
function drainStreamSync<R, E, A>(stream: ZStream<R, E, A>): A[] | null {
  const result: A[] = [];
  let cur: ZStream<R, E, A> = stream;

  while (true) {
    switch (cur._tag) {
      case "Empty":
        return result;

      case "FromArray": {
        // O(1) drain — just copy the array
        const arr = cur.values;
        for (let i = 0; i < arr.length; i++) {
          result.push(arr[i]!);
        }
        return result;
      }

      case "Emit": {
        // Emit wraps a ZIO — only Succeed is synchronous
        const zio = cur.value as any;
        if (zio._tag === "Succeed") {
          result.push(zio.value);
          return result;
        }
        // Non-synchronous emit — can't drain
        return null;
      }

      case "Concat": {
        // Drain left, then continue with right
        const leftItems = drainStreamSync(cur.left);
        if (leftItems === null) return null;
        for (let i = 0; i < leftItems.length; i++) {
          result.push(leftItems[i]!);
        }
        cur = cur.right;
        break;
      }

      default:
        // FromPull, Flatten, Merge, Scoped, Managed — can't drain synchronously
        return null;
    }
  }
}

// ---------------------------------------------------------------------------
// applyFused() — applies a fused pipeline to a stream with a single pull loop
// ---------------------------------------------------------------------------

/**
 * Applies a fused pipeline to a stream using a single pull loop.
 * No intermediate fibers are created between fused operators.
 *
 * OPTIMIZATION: If the input stream can be drained synchronously (e.g., fromArray),
 * the entire pipeline is executed as a pure synchronous loop — no effects at all.
 */
export function applyFused<R, E, In, Out>(
  stream: ZStream<R, E, In>,
  fused: FusedPipelineRepr<In, Out>
): ZStream<R, E, Out> {
  // Fast path: try to drain the input stream synchronously
  const inputArray = drainStreamSync(stream);
  if (inputArray !== null) {
    // Execute the entire pipeline as a pure synchronous loop
    const outputArray = runFusedArray(inputArray as In[], fused);
    // Wrap the result back as a stream (fromArray pattern)
    return arrayToStream(outputArray);
  }

  // Slow path: effectful stream — use pull-based execution
  const state = fused.initState();

  const loop = (cur: ZStream<R, E, In>): ZStream<R, E, Out> =>
    fromPull(
      asyncFold(
        uncons(cur),
        // End-of-stream or error: propagate
        (opt: Option<E>) => asyncFail(opt),
        ([a, tail]) => {
          const result = fused.step(a, state);
          switch (result.tag) {
            case "emit":
              return asyncSucceed([result.value, loop(tail)] as [Out, ZStream<R, E, Out>]);
            case "skip":
              // Element filtered out — pull next element (loop internally)
              return uncons(loop(tail)) as any;
            case "halt":
              // Take limit reached — signal end-of-stream
              return asyncFail(none);
          }
        }
      ) as any
    );

  return loop(stream);
}

// ---------------------------------------------------------------------------
// Internal: convert an array back to a stream (efficient Concat chain)
// ---------------------------------------------------------------------------

function arrayToStream<A>(values: A[]): ZStream<any, never, A> {
  if (values.length === 0) return { _tag: "Empty" } as ZStream<any, never, A>;
  return { _tag: "FromArray", values } as ZStream<any, never, A>;
}

// ---------------------------------------------------------------------------
// serializeFusedPipeline() — serialize a fused pipeline to JSON-safe form
// ---------------------------------------------------------------------------

/**
 * Serialize a fused pipeline to a JSON-safe representation.
 * Returns null if the pipeline is not fused (no _fusedSteps metadata).
 *
 * For map/filter steps, the function/predicate source is captured via `.toString()`.
 * Note: toString() has limitations with closures and minification, but is sufficient
 * for debugging/observability use cases.
 */
export function serializeFusedPipeline<In, Out>(
  pipeline: ZPipeline<unknown, never, In, Out>
): SerializedFusedPipeline | null {
  const p = pipeline as any;

  // Extract _fusedSteps metadata from the pipeline
  let metas: PurePipelineMetadata<any, any>[] | null = null;

  if (p._fusedSteps && Array.isArray(p._fusedSteps)) {
    metas = p._fusedSteps;
  } else if (p[PURE_PIPELINE_TAG]) {
    // Single pure operator — not a fused pipeline
    return null;
  }

  if (!metas || metas.length === 0) {
    return null;
  }

  const steps: SerializedStep[] = metas.map((meta) => {
    switch (meta.kind) {
      case "map":
        return { kind: "map" as const, fnSource: meta.fn!.toString() };
      case "filter":
        return { kind: "filter" as const, predSource: meta.pred!.toString() };
      case "take":
        return { kind: "take" as const, n: meta.n! };
      case "drop":
        return { kind: "drop" as const, n: meta.n! };
    }
  });

  return { version: 1, steps };
}

// ---------------------------------------------------------------------------
// deserializeFusedPipeline() — reconstruct a pipeline from serialized form
// ---------------------------------------------------------------------------

/**
 * Deserialize a serialized pipeline back to a functional pipeline.
 * Returns null if deserialization fails (e.g., invalid version, malformed fnSource).
 *
 * Reconstructs functions using `new Function(...)` with appropriate wrapping.
 * The resulting pipeline is functionally equivalent to the original for pure
 * (non-closure) functions.
 *
 * WARNING: Uses `new Function()` which has security implications similar to `eval`.
 * Only deserialize trusted serialized pipelines.
 */
export function deserializeFusedPipeline<In, Out>(
  serialized: SerializedFusedPipeline
): ZPipeline<unknown, never, In, Out> | null {
  try {
    // Validate version
    if (serialized.version !== 1) {
      return null;
    }

    if (!serialized.steps || serialized.steps.length === 0) {
      return null;
    }

    // Reconstruct metadata from serialized steps
    const metas: PurePipelineMetadata<any, any>[] = [];

    for (const step of serialized.steps) {
      switch (step.kind) {
        case "map": {
          // Reconstruct function from source: wrap in 'return' to handle arrow functions
          const fn = new Function("return " + step.fnSource)();
          if (typeof fn !== "function") return null;
          metas.push({ kind: "map", fn });
          break;
        }
        case "filter": {
          // Reconstruct predicate from source
          const pred = new Function("return " + step.predSource)();
          if (typeof pred !== "function") return null;
          metas.push({ kind: "filter", pred });
          break;
        }
        case "take": {
          if (typeof step.n !== "number" || step.n < 0) return null;
          metas.push({ kind: "take", n: step.n });
          break;
        }
        case "drop": {
          if (typeof step.n !== "number" || step.n < 0) return null;
          metas.push({ kind: "drop", n: step.n });
          break;
        }
        default:
          return null;
      }
    }

    // Build the fused representation from reconstructed metadata
    const carrier = createDeserializedCarrier<In, Out>(metas);
    return carrier;
  } catch {
    // Any error during deserialization (e.g., syntax error in fnSource) → return null
    return null;
  }
}

/**
 * Creates a pipeline function from deserialized metadata.
 * The pipeline carries _fusedSteps and applies via applyFused internally.
 */
function createDeserializedCarrier<In, Out>(
  metas: PurePipelineMetadata<any, any>[]
): ZPipeline<unknown, never, In, Out> | null {
  // Build the fused representation
  let counterIndex = 0;
  let composedStep: (a: any, state: FuseState) => FuseResult<any> = buildStepFromMetadata(
    metas[0]!,
    (metas[0]!.kind === "take" || metas[0]!.kind === "drop") ? counterIndex++ : -1
  );
  for (let i = 1; i < metas.length; i++) {
    const meta = metas[i]!;
    const idx = (meta.kind === "take" || meta.kind === "drop") ? counterIndex++ : -1;
    composedStep = composeSteps(composedStep, buildStepFromMetadata(meta, idx));
  }

  const counterCount = countCounters(metas);
  const stats = buildStats(metas);

  const fusedRepr: FusedPipelineRepr<In, Out> = {
    _tag: "FusedPipeline",
    step: composedStep as (a: In, state: FuseState) => FuseResult<Out>,
    initState: initState(counterCount),
    stats,
  };

  // Create the pipeline function that applies the fused repr
  const pipeline = (<R, E>(input: ZStream<R, E, In>) => {
    return applyFused(input, fusedRepr);
  }) as ZPipeline<unknown, never, In, Out>;

  // Attach _fusedSteps for further composition and inspection
  (pipeline as any)._fusedSteps = metas;

  return pipeline;
}
