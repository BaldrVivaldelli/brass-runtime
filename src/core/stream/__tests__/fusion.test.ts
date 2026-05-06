import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PURE_PIPELINE_TAG,
  FuseResult,
  FuseState,
  FusedPipelineRepr,
  fuse,
  applyFused,
  initState,
  PurePipelineMetadata,
  getStats,
  setFusionEnabled,
  isFusionEnabled,
  setFusionVerbose,
  isFusionVerbose,
  serializeFusedPipeline,
  deserializeFusedPipeline,
  SerializedFusedPipeline,
} from "../fusion";
import { collectStream, fromArray, emptyStream } from "../stream";
import { mapP, filterP, takeP, dropP, andThen, via } from "../pipeline";
import { Runtime } from "../../runtime/runtime";
import type { ZPipeline } from "../pipeline";

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

/**
 * Helper: attach PURE_PIPELINE_TAG to a pipeline for testing fuse() directly.
 * In the full implementation, pipeline.ts operators will do this automatically (Task 1.2).
 * For now, we manually tag pipelines to test the fusion engine in isolation.
 */
function tagPure<In, Out>(
  pipeline: ZPipeline<unknown, never, In, Out>,
  meta: PurePipelineMetadata<In, Out>
): ZPipeline<unknown, never, In, Out> {
  (pipeline as any)[PURE_PIPELINE_TAG] = meta;
  return pipeline;
}

/**
 * Helper: create a composed pipeline with _fusedSteps metadata for testing.
 */
function tagComposed<In, Out>(
  pipeline: ZPipeline<unknown, never, In, Out>,
  metas: PurePipelineMetadata<any, any>[]
): ZPipeline<unknown, never, In, Out> {
  (pipeline as any)._fusedSteps = metas;
  return pipeline;
}

// ---------------------------------------------------------------------------
// Types and initState
// ---------------------------------------------------------------------------
describe("FusionEngine types and initState", () => {
  it("initState creates correct initial state with no counters", () => {
    const factory = initState(0);
    const state = factory();
    expect(state).toEqual({
      counters: [],
    });
  });

  it("initState creates correct initial state with one counter", () => {
    const factory = initState(1);
    const state = factory();
    expect(state.counters).toEqual([0]);
  });

  it("initState creates correct initial state with multiple counters", () => {
    const factory = initState(3);
    const state = factory();
    expect(state.counters).toEqual([0, 0, 0]);
  });

  it("initState creates fresh state on each call", () => {
    const factory = initState(2);
    const state1 = factory();
    state1.counters[0] = 5;
    const state2 = factory();
    expect(state2.counters).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------
// fuse() — single operators
// ---------------------------------------------------------------------------
describe("fuse() with single operators", () => {
  it("fuses a single mapP operator", () => {
    const p = tagPure(mapP((x: number) => x * 2), {
      kind: "map",
      fn: (x: number) => x * 2,
    });

    const result = fuse(p);
    expect(result).not.toBeNull();
    expect(result!._tag).toBe("FusedPipeline");
    expect(result!.stats.fusedSteps).toBe(1);
    expect(result!.stats.steps).toEqual([{ kind: "map" }]);
    expect(result!.stats.hasTake).toBe(false);
    expect(result!.stats.hasDrop).toBe(false);
  });

  it("fuses a single filterP operator", () => {
    const pred = (x: number) => x > 0;
    const p = tagPure(filterP(pred), { kind: "filter", pred });

    const result = fuse(p);
    expect(result).not.toBeNull();
    expect(result!.stats.fusedSteps).toBe(1);
    expect(result!.stats.steps).toEqual([{ kind: "filter" }]);
  });

  it("fuses a single takeP operator", () => {
    const p = tagPure(takeP(5), { kind: "take", n: 5 });

    const result = fuse(p);
    expect(result).not.toBeNull();
    expect(result!.stats.fusedSteps).toBe(1);
    expect(result!.stats.steps).toEqual([{ kind: "take", n: 5 }]);
    expect(result!.stats.hasTake).toBe(true);
    expect(result!.stats.hasDrop).toBe(false);
  });

  it("fuses a single dropP operator", () => {
    const p = tagPure(dropP(3), { kind: "drop", n: 3 });

    const result = fuse(p);
    expect(result).not.toBeNull();
    expect(result!.stats.fusedSteps).toBe(1);
    expect(result!.stats.steps).toEqual([{ kind: "drop", n: 3 }]);
    expect(result!.stats.hasTake).toBe(false);
    expect(result!.stats.hasDrop).toBe(true);
  });

  it("returns null for untagged pipeline", () => {
    // A custom pipeline function without PURE_PIPELINE_TAG is not fusable
    const p: ZPipeline<unknown, never, number, number> = ((input: any) => input) as any;
    const result = fuse(p);
    expect(result).toBeNull();
  });

  it("returns null when fusion is disabled", () => {
    const p = tagPure(mapP((x: number) => x * 2), {
      kind: "map",
      fn: (x: number) => x * 2,
    });

    const result = fuse(p, { enabled: false });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fuse() — composed operators
// ---------------------------------------------------------------------------
describe("fuse() with composed operators", () => {
  it("fuses a composed map+filter pipeline", () => {
    const metas: PurePipelineMetadata<any, any>[] = [
      { kind: "map", fn: (x: number) => x * 2 },
      { kind: "filter", pred: (x: number) => x > 4 },
    ];
    const p = tagComposed(
      andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4)),
      metas
    );

    const result = fuse(p);
    expect(result).not.toBeNull();
    expect(result!.stats.fusedSteps).toBe(2);
    expect(result!.stats.steps).toEqual([{ kind: "map" }, { kind: "filter" }]);
  });

  it("fuses a composed map+filter+take pipeline", () => {
    const metas: PurePipelineMetadata<any, any>[] = [
      { kind: "map", fn: (x: number) => x + 1 },
      { kind: "filter", pred: (x: number) => x % 2 === 0 },
      { kind: "take", n: 3 },
    ];
    const composed = andThen(
      andThen(mapP((x: number) => x + 1), filterP((x: number) => x % 2 === 0)),
      takeP(3)
    );
    const p = tagComposed(composed, metas);

    const result = fuse(p);
    expect(result).not.toBeNull();
    expect(result!.stats.fusedSteps).toBe(3);
    expect(result!.stats.hasTake).toBe(true);
    expect(result!.stats.hasDrop).toBe(false);
  });

  it("correctly creates per-step counters for multiple takes", () => {
    const metas: PurePipelineMetadata<any, any>[] = [
      { kind: "take", n: 10 },
      { kind: "take", n: 5 },
    ];
    const p = tagComposed(andThen(takeP(10), takeP(5)), metas);

    const result = fuse(p);
    expect(result).not.toBeNull();
    const state = result!.initState();
    // Two take steps → two counters
    expect(state.counters.length).toBe(2);
    expect(state.counters).toEqual([0, 0]);
  });

  it("correctly creates per-step counters for multiple drops", () => {
    const metas: PurePipelineMetadata<any, any>[] = [
      { kind: "drop", n: 2 },
      { kind: "drop", n: 3 },
    ];
    const p = tagComposed(andThen(dropP(2), dropP(3)), metas);

    const result = fuse(p);
    expect(result).not.toBeNull();
    const state = result!.initState();
    // Two drop steps → two counters
    expect(state.counters.length).toBe(2);
    expect(state.counters).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Step function behavior
// ---------------------------------------------------------------------------
describe("fused step function", () => {
  it("map step emits transformed value", () => {
    const p = tagPure(mapP((x: number) => x * 3), {
      kind: "map",
      fn: (x: number) => x * 3,
    });
    const fused = fuse(p)!;
    const state = fused.initState();

    expect(fused.step(5, state)).toEqual({ tag: "emit", value: 15 });
  });

  it("filter step emits matching value", () => {
    const pred = (x: number) => x > 3;
    const p = tagPure(filterP(pred), { kind: "filter", pred });
    const fused = fuse(p)!;
    const state = fused.initState();

    expect(fused.step(5, state)).toEqual({ tag: "emit", value: 5 });
  });

  it("filter step skips non-matching value", () => {
    const pred = (x: number) => x > 3;
    const p = tagPure(filterP(pred), { kind: "filter", pred });
    const fused = fuse(p)!;
    const state = fused.initState();

    expect(fused.step(2, state)).toEqual({ tag: "skip" });
  });

  it("take step halts after limit", () => {
    const p = tagPure(takeP(2), { kind: "take", n: 2 });
    const fused = fuse(p)!;
    const state = fused.initState();

    expect(fused.step(1, state)).toEqual({ tag: "emit", value: 1 });
    expect(fused.step(2, state)).toEqual({ tag: "emit", value: 2 });
    expect(fused.step(3, state)).toEqual({ tag: "halt" });
  });

  it("drop step skips first N elements", () => {
    const p = tagPure(dropP(2), { kind: "drop", n: 2 });
    const fused = fuse(p)!;
    const state = fused.initState();

    expect(fused.step(1, state)).toEqual({ tag: "skip" });
    expect(fused.step(2, state)).toEqual({ tag: "skip" });
    expect(fused.step(3, state)).toEqual({ tag: "emit", value: 3 });
  });

  it("composed map+filter step works correctly", () => {
    const metas: PurePipelineMetadata<any, any>[] = [
      { kind: "map", fn: (x: number) => x * 2 },
      { kind: "filter", pred: (x: number) => x > 5 },
    ];
    const p = tagComposed(
      andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 5)),
      metas
    );
    const fused = fuse(p)!;
    const state = fused.initState();

    // 1 * 2 = 2, not > 5 → skip
    expect(fused.step(1, state)).toEqual({ tag: "skip" });
    // 3 * 2 = 6, > 5 → emit
    expect(fused.step(3, state)).toEqual({ tag: "emit", value: 6 });
    // 4 * 2 = 8, > 5 → emit
    expect(fused.step(4, state)).toEqual({ tag: "emit", value: 8 });
  });
});

// ---------------------------------------------------------------------------
// applyFused() — integration with streams
// ---------------------------------------------------------------------------
describe("applyFused()", () => {
  it("applies fused map to a stream", async () => {
    const p = tagPure(mapP((x: number) => x * 2), {
      kind: "map",
      fn: (x: number) => x * 2,
    });
    const fused = fuse(p)!;
    const stream = fromArray([1, 2, 3, 4, 5]);
    const fusedStream = applyFused(stream, fused);

    const result = await run<number[]>(collectStream(fusedStream));
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it("applies fused filter to a stream", async () => {
    const pred = (x: number) => x % 2 === 0;
    const p = tagPure(filterP(pred), { kind: "filter", pred });
    const fused = fuse(p)!;
    const stream = fromArray([1, 2, 3, 4, 5, 6]);
    const fusedStream = applyFused(stream, fused);

    const result = await run<number[]>(collectStream(fusedStream));
    expect(result).toEqual([2, 4, 6]);
  });

  it("applies fused take to a stream", async () => {
    const p = tagPure(takeP(3), { kind: "take", n: 3 });
    const fused = fuse(p)!;
    const stream = fromArray([10, 20, 30, 40, 50]);
    const fusedStream = applyFused(stream, fused);

    const result = await run<number[]>(collectStream(fusedStream));
    expect(result).toEqual([10, 20, 30]);
  });

  it("applies fused drop to a stream", async () => {
    const p = tagPure(dropP(2), { kind: "drop", n: 2 });
    const fused = fuse(p)!;
    const stream = fromArray([10, 20, 30, 40, 50]);
    const fusedStream = applyFused(stream, fused);

    const result = await run<number[]>(collectStream(fusedStream));
    expect(result).toEqual([30, 40, 50]);
  });

  it("applies fused map+filter to a stream", async () => {
    const metas: PurePipelineMetadata<any, any>[] = [
      { kind: "map", fn: (x: number) => x * 2 },
      { kind: "filter", pred: (x: number) => x > 4 },
    ];
    const p = tagComposed(
      andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4)),
      metas
    );
    const fused = fuse(p)!;
    const stream = fromArray([1, 2, 3, 4, 5]);
    const fusedStream = applyFused(stream, fused);

    const result = await run<number[]>(collectStream(fusedStream));
    // 1*2=2 (skip), 2*2=4 (skip), 3*2=6 (emit), 4*2=8 (emit), 5*2=10 (emit)
    expect(result).toEqual([6, 8, 10]);
  });

  it("applies fused map+filter+take to a stream", async () => {
    const metas: PurePipelineMetadata<any, any>[] = [
      { kind: "map", fn: (x: number) => x + 1 },
      { kind: "filter", pred: (x: number) => x % 2 === 0 },
      { kind: "take", n: 2 },
    ];
    const composed = andThen(
      andThen(mapP((x: number) => x + 1), filterP((x: number) => x % 2 === 0)),
      takeP(2)
    );
    const p = tagComposed(composed, metas);
    const fused = fuse(p)!;
    const stream = fromArray([1, 2, 3, 4, 5, 6, 7, 8]);
    const fusedStream = applyFused(stream, fused);

    const result = await run<number[]>(collectStream(fusedStream));
    // 1+1=2 (even, emit, taken=1), 2+1=3 (odd, skip), 3+1=4 (even, emit, taken=2), 4+1=5 (odd, skip) → halt
    expect(result).toEqual([2, 4]);
  });

  it("applies fused drop+map to a stream", async () => {
    const metas: PurePipelineMetadata<any, any>[] = [
      { kind: "drop", n: 2 },
      { kind: "map", fn: (x: number) => x * 10 },
    ];
    const composed = andThen(dropP(2), mapP((x: number) => x * 10));
    const p = tagComposed(composed, metas);
    const fused = fuse(p)!;
    const stream = fromArray([1, 2, 3, 4, 5]);
    const fusedStream = applyFused(stream, fused);

    const result = await run<number[]>(collectStream(fusedStream));
    // drop 1, drop 2, then map: 3*10=30, 4*10=40, 5*10=50
    expect(result).toEqual([30, 40, 50]);
  });

  it("handles empty stream", async () => {
    const p = tagPure(mapP((x: number) => x * 2), {
      kind: "map",
      fn: (x: number) => x * 2,
    });
    const fused = fuse(p)!;
    const stream = emptyStream<unknown, never, number>();
    const fusedStream = applyFused(stream, fused);

    const result = await run<number[]>(collectStream(fusedStream));
    expect(result).toEqual([]);
  });

  it("handles take(0) — immediately halts", async () => {
    const p = tagPure(takeP(0), { kind: "take", n: 0 });
    const fused = fuse(p)!;
    const stream = fromArray([1, 2, 3]);
    const fusedStream = applyFused(stream, fused);

    const result = await run<number[]>(collectStream(fusedStream));
    expect(result).toEqual([]);
  });

  it("handles filter that rejects everything", async () => {
    const pred = (_x: number) => false;
    const p = tagPure(filterP(pred), { kind: "filter", pred });
    const fused = fuse(p)!;
    const stream = fromArray([1, 2, 3]);
    const fusedStream = applyFused(stream, fused);

    const result = await run<number[]>(collectStream(fusedStream));
    expect(result).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// getStats() — pipeline inspection
// ---------------------------------------------------------------------------
describe("getStats()", () => {
  it("returns stats for a fused pipeline (map + filter)", () => {
    const p = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    const stats = getStats(p as any);
    expect(stats).not.toBeNull();
    expect(stats!.fusedSteps).toBe(2);
    expect(stats!.steps).toEqual([{ kind: "map" }, { kind: "filter" }]);
    expect(stats!.hasTake).toBe(false);
    expect(stats!.hasDrop).toBe(false);
  });

  it("returns stats for a fused pipeline with take and drop", () => {
    const p = andThen(
      andThen(dropP<number>(3), mapP((x: number) => x + 1)),
      takeP(5)
    );
    const stats = getStats(p as any);
    expect(stats).not.toBeNull();
    expect(stats!.fusedSteps).toBe(3);
    expect(stats!.steps).toEqual([
      { kind: "drop", n: 3 },
      { kind: "map" },
      { kind: "take", n: 5 },
    ]);
    expect(stats!.hasTake).toBe(true);
    expect(stats!.hasDrop).toBe(true);
  });

  it("returns null for a non-fused pipeline (single pure operator)", () => {
    const p = mapP((x: number) => x * 2);
    const stats = getStats(p as any);
    expect(stats).toBeNull();
  });

  it("returns null for a non-pure pipeline", () => {
    const p = ((input: any) => input) as ZPipeline<unknown, never, number, number>;
    const stats = getStats(p);
    expect(stats).toBeNull();
  });

  it("returns correct stats for a 4-step fused pipeline", () => {
    const p = andThen(
      andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 0)),
      andThen(dropP<number>(1), takeP(10))
    );
    const stats = getStats(p as any);
    expect(stats).not.toBeNull();
    expect(stats!.fusedSteps).toBe(4);
    expect(stats!.steps).toEqual([
      { kind: "map" },
      { kind: "filter" },
      { kind: "drop", n: 1 },
      { kind: "take", n: 10 },
    ]);
    expect(stats!.hasTake).toBe(true);
    expect(stats!.hasDrop).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Global fusion enable/disable
// ---------------------------------------------------------------------------
describe("setFusionEnabled / isFusionEnabled", () => {
  afterEach(() => {
    // Reset to default state
    setFusionEnabled(true);
    setFusionVerbose(false);
  });

  it("fusion is enabled by default", () => {
    expect(isFusionEnabled()).toBe(true);
  });

  it("setFusionEnabled(false) disables fusion globally", () => {
    setFusionEnabled(false);
    expect(isFusionEnabled()).toBe(false);
  });

  it("setFusionEnabled(true) re-enables fusion", () => {
    setFusionEnabled(false);
    setFusionEnabled(true);
    expect(isFusionEnabled()).toBe(true);
  });

  it("when fusion is disabled, andThen does not fuse pure operators", () => {
    setFusionEnabled(false);
    const p = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    // Should NOT have _fusedSteps
    expect((p as any)._fusedSteps).toBeUndefined();
  });

  it("when fusion is disabled, andThen still produces correct output", async () => {
    setFusionEnabled(false);
    const p = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    const stream = fromArray([1, 2, 3, 4, 5]);
    const result = await run<number[]>(collectStream(via(stream, p)));
    expect(result).toEqual([6, 8, 10]);
  });

  it("when fusion is re-enabled, andThen fuses again", () => {
    setFusionEnabled(false);
    const p1 = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    expect((p1 as any)._fusedSteps).toBeUndefined();

    setFusionEnabled(true);
    const p2 = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    expect((p2 as any)._fusedSteps).toBeDefined();
  });

  it("fuse() respects global disable", () => {
    setFusionEnabled(false);
    const p = tagPure(mapP((x: number) => x * 2), {
      kind: "map",
      fn: (x: number) => x * 2,
    });
    const result = fuse(p);
    expect(result).toBeNull();
  });

  it("fuse() with explicit enabled: true overrides global disable", () => {
    setFusionEnabled(false);
    const p = tagPure(mapP((x: number) => x * 2), {
      kind: "map",
      fn: (x: number) => x * 2,
    });
    const result = fuse(p, { enabled: true });
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Verbose mode
// ---------------------------------------------------------------------------
describe("setFusionVerbose / isFusionVerbose", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    setFusionVerbose(false);
    setFusionEnabled(true);
  });

  it("verbose is disabled by default", () => {
    expect(isFusionVerbose()).toBe(false);
  });

  it("setFusionVerbose(true) enables verbose mode", () => {
    setFusionVerbose(true);
    expect(isFusionVerbose()).toBe(true);
  });

  it("verbose mode logs fusion decisions in fuse()", () => {
    setFusionVerbose(true);
    const p = tagPure(mapP((x: number) => x * 2), {
      kind: "map",
      fn: (x: number) => x * 2,
    });
    fuse(p);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[FusionEngine] Fusing 1 steps: map")
    );
  });

  it("verbose mode logs when pipeline is not fusable", () => {
    setFusionVerbose(true);
    const p = ((input: any) => input) as ZPipeline<unknown, never, number, number>;
    fuse(p);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[FusionEngine] Pipeline is not fusable")
    );
  });

  it("verbose mode logs when fusion is disabled", () => {
    setFusionVerbose(true);
    setFusionEnabled(false);
    const p = tagPure(mapP((x: number) => x * 2), {
      kind: "map",
      fn: (x: number) => x * 2,
    });
    fuse(p);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[FusionEngine] Fusion disabled by options")
    );
  });

  it("verbose mode logs andThen fusion decisions", () => {
    setFusionVerbose(true);
    andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[FusionEngine] andThen: fused 2 steps: map → filter")
    );
  });

  it("verbose mode logs andThen when fusion cannot apply", () => {
    setFusionVerbose(true);
    const effectful = ((input: any) => input) as any;
    andThen(mapP((x: number) => x * 2), effectful);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[FusionEngine] andThen: cannot fuse")
    );
  });

  it("verbose mode logs andThen when fusion is globally disabled", () => {
    setFusionVerbose(true);
    setFusionEnabled(false);
    andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[FusionEngine] andThen: fusion globally disabled")
    );
  });

  it("per-call verbose option works without global verbose", () => {
    const p = tagPure(mapP((x: number) => x * 2), {
      kind: "map",
      fn: (x: number) => x * 2,
    });
    fuse(p, { verbose: true });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[FusionEngine] Fusing 1 steps: map")
    );
  });
});


// ---------------------------------------------------------------------------
// Serialization / Deserialization
// ---------------------------------------------------------------------------
describe("serializeFusedPipeline()", () => {
  it("serializes a fused map pipeline", () => {
    const p = andThen(mapP((x: number) => x * 2), mapP((x: number) => x + 1));
    const serialized = serializeFusedPipeline(p as any);

    expect(serialized).not.toBeNull();
    expect(serialized!.version).toBe(1);
    expect(serialized!.steps.length).toBe(2);
    expect(serialized!.steps[0]!.kind).toBe("map");
    expect((serialized!.steps[0] as any).fnSource).toContain("x");
    expect(serialized!.steps[1]!.kind).toBe("map");
    expect((serialized!.steps[1] as any).fnSource).toContain("x");
  });

  it("serializes a composed map+filter+take pipeline", () => {
    const p = andThen(
      andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4)),
      takeP(5)
    );
    const serialized = serializeFusedPipeline(p as any);

    expect(serialized).not.toBeNull();
    expect(serialized!.version).toBe(1);
    expect(serialized!.steps.length).toBe(3);
    expect(serialized!.steps[0]!.kind).toBe("map");
    expect(serialized!.steps[1]!.kind).toBe("filter");
    expect(serialized!.steps[2]!.kind).toBe("take");
    expect((serialized!.steps[2] as any).n).toBe(5);
  });

  it("serializes a pipeline with drop", () => {
    const p = andThen(dropP<number>(3), mapP((x: number) => x + 10));
    const serialized = serializeFusedPipeline(p as any);

    expect(serialized).not.toBeNull();
    expect(serialized!.steps.length).toBe(2);
    expect(serialized!.steps[0]!.kind).toBe("drop");
    expect((serialized!.steps[0] as any).n).toBe(3);
    expect(serialized!.steps[1]!.kind).toBe("map");
  });

  it("returns null for a non-fused pipeline (single operator)", () => {
    const p = mapP((x: number) => x * 2);
    const serialized = serializeFusedPipeline(p as any);
    expect(serialized).toBeNull();
  });

  it("returns null for a non-pure pipeline", () => {
    const p = ((input: any) => input) as ZPipeline<unknown, never, number, number>;
    const serialized = serializeFusedPipeline(p);
    expect(serialized).toBeNull();
  });
});

describe("deserializeFusedPipeline()", () => {
  it("deserializes a map pipeline and produces correct output", async () => {
    const serialized: SerializedFusedPipeline = {
      version: 1,
      steps: [{ kind: "map", fnSource: "(x) => x * 3" }],
    };
    const pipeline = deserializeFusedPipeline<number, number>(serialized);

    expect(pipeline).not.toBeNull();
    const stream = fromArray([1, 2, 3, 4]);
    const result = await run<number[]>(collectStream(pipeline!(stream)));
    expect(result).toEqual([3, 6, 9, 12]);
  });

  it("deserializes a filter pipeline and produces correct output", async () => {
    const serialized: SerializedFusedPipeline = {
      version: 1,
      steps: [{ kind: "filter", predSource: "(x) => x > 2" }],
    };
    const pipeline = deserializeFusedPipeline<number, number>(serialized);

    expect(pipeline).not.toBeNull();
    const stream = fromArray([1, 2, 3, 4, 5]);
    const result = await run<number[]>(collectStream(pipeline!(stream)));
    expect(result).toEqual([3, 4, 5]);
  });

  it("deserializes a take pipeline and produces correct output", async () => {
    const serialized: SerializedFusedPipeline = {
      version: 1,
      steps: [{ kind: "take", n: 3 }],
    };
    const pipeline = deserializeFusedPipeline<number, number>(serialized);

    expect(pipeline).not.toBeNull();
    const stream = fromArray([10, 20, 30, 40, 50]);
    const result = await run<number[]>(collectStream(pipeline!(stream)));
    expect(result).toEqual([10, 20, 30]);
  });

  it("deserializes a drop pipeline and produces correct output", async () => {
    const serialized: SerializedFusedPipeline = {
      version: 1,
      steps: [{ kind: "drop", n: 2 }],
    };
    const pipeline = deserializeFusedPipeline<number, number>(serialized);

    expect(pipeline).not.toBeNull();
    const stream = fromArray([10, 20, 30, 40, 50]);
    const result = await run<number[]>(collectStream(pipeline!(stream)));
    expect(result).toEqual([30, 40, 50]);
  });

  it("deserializes a composed map+filter+take pipeline", async () => {
    const serialized: SerializedFusedPipeline = {
      version: 1,
      steps: [
        { kind: "map", fnSource: "(x) => x * 2" },
        { kind: "filter", predSource: "(x) => x > 4" },
        { kind: "take", n: 2 },
      ],
    };
    const pipeline = deserializeFusedPipeline<number, number>(serialized);

    expect(pipeline).not.toBeNull();
    const stream = fromArray([1, 2, 3, 4, 5]);
    const result = await run<number[]>(collectStream(pipeline!(stream)));
    // 1*2=2 (skip), 2*2=4 (skip), 3*2=6 (emit, taken=1), 4*2=8 (emit, taken=2) → halt
    expect(result).toEqual([6, 8]);
  });

  it("returns null for invalid version", () => {
    const serialized = { version: 2, steps: [{ kind: "map", fnSource: "(x) => x" }] } as any;
    const pipeline = deserializeFusedPipeline(serialized);
    expect(pipeline).toBeNull();
  });

  it("returns null for empty steps", () => {
    const serialized: SerializedFusedPipeline = { version: 1, steps: [] };
    const pipeline = deserializeFusedPipeline(serialized);
    expect(pipeline).toBeNull();
  });

  it("returns null for invalid fnSource (syntax error)", () => {
    const serialized: SerializedFusedPipeline = {
      version: 1,
      steps: [{ kind: "map", fnSource: "not a valid function {{{{" }],
    };
    const pipeline = deserializeFusedPipeline(serialized);
    expect(pipeline).toBeNull();
  });

  it("returns null for negative take n", () => {
    const serialized: SerializedFusedPipeline = {
      version: 1,
      steps: [{ kind: "take", n: -1 }],
    };
    const pipeline = deserializeFusedPipeline(serialized);
    expect(pipeline).toBeNull();
  });
});

describe("serialization round-trip", () => {
  it("round-trip produces functionally equivalent pipeline for map", async () => {
    const original = andThen(mapP((x: number) => x * 2), mapP((x: number) => x + 1));
    const serialized = serializeFusedPipeline(original as any);
    expect(serialized).not.toBeNull();

    const deserialized = deserializeFusedPipeline<number, number>(serialized!);
    expect(deserialized).not.toBeNull();

    const input = [1, 2, 3, 4, 5];
    const stream1 = fromArray(input);
    const stream2 = fromArray(input);

    const result1 = await run<number[]>(collectStream(via(stream1, original)));
    const result2 = await run<number[]>(collectStream(deserialized!(stream2)));

    expect(result2).toEqual(result1);
  });

  it("round-trip produces functionally equivalent pipeline for map+filter+take", async () => {
    const original = andThen(
      andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4)),
      takeP(3)
    );
    const serialized = serializeFusedPipeline(original as any);
    expect(serialized).not.toBeNull();

    const deserialized = deserializeFusedPipeline<number, number>(serialized!);
    expect(deserialized).not.toBeNull();

    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const stream1 = fromArray(input);
    const stream2 = fromArray(input);

    const result1 = await run<number[]>(collectStream(via(stream1, original)));
    const result2 = await run<number[]>(collectStream(deserialized!(stream2)));

    expect(result2).toEqual(result1);
  });

  it("round-trip produces functionally equivalent pipeline for drop+map+filter", async () => {
    const original = andThen(
      andThen(dropP<number>(3), mapP((x: number) => x * 10)),
      filterP((x: number) => x > 50)
    );
    const serialized = serializeFusedPipeline(original as any);
    expect(serialized).not.toBeNull();

    const deserialized = deserializeFusedPipeline<number, number>(serialized!);
    expect(deserialized).not.toBeNull();

    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const stream1 = fromArray(input);
    const stream2 = fromArray(input);

    const result1 = await run<number[]>(collectStream(via(stream1, original)));
    const result2 = await run<number[]>(collectStream(deserialized!(stream2)));

    expect(result2).toEqual(result1);
  });

  it("deserialized pipeline has _fusedSteps for further composition", () => {
    const serialized: SerializedFusedPipeline = {
      version: 1,
      steps: [
        { kind: "map", fnSource: "(x) => x * 2" },
        { kind: "filter", predSource: "(x) => x > 4" },
      ],
    };
    const pipeline = deserializeFusedPipeline<number, number>(serialized);
    expect(pipeline).not.toBeNull();
    expect((pipeline as any)._fusedSteps).toBeDefined();
    expect((pipeline as any)._fusedSteps.length).toBe(2);
  });

  it("deserialized pipeline can be inspected with getStats", () => {
    const serialized: SerializedFusedPipeline = {
      version: 1,
      steps: [
        { kind: "map", fnSource: "(x) => x * 2" },
        { kind: "filter", predSource: "(x) => x > 4" },
        { kind: "take", n: 10 },
      ],
    };
    const pipeline = deserializeFusedPipeline<number, number>(serialized);
    expect(pipeline).not.toBeNull();

    const stats = getStats(pipeline!);
    expect(stats).not.toBeNull();
    expect(stats!.fusedSteps).toBe(3);
    expect(stats!.steps).toEqual([
      { kind: "map" },
      { kind: "filter" },
      { kind: "take", n: 10 },
    ]);
    expect(stats!.hasTake).toBe(true);
    expect(stats!.hasDrop).toBe(false);
  });
});
