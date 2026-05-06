import { describe, it, expect, afterEach } from "vitest";
import { mapP, filterP, takeP, dropP, andThen, via } from "../pipeline";
import {
  PURE_PIPELINE_TAG,
  setFusionEnabled,
  isFusionEnabled,
  getStats,
} from "../fusion";
import { collectStream, fromArray } from "../stream";
import { Runtime } from "../../runtime/runtime";

const rt = Runtime.make({});
function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

// ---------------------------------------------------------------------------
// 1. Single operator no overhead (Req 7.4)
// ---------------------------------------------------------------------------
describe("Single operator no fusion overhead (Req 7.4)", () => {
  it("single mapP works correctly without fusion", async () => {
    const p = mapP((x: number) => x * 3);
    const stream = fromArray([1, 2, 3, 4]);
    const result = await run<number[]>(collectStream(via(stream, p)));
    expect(result).toEqual([3, 6, 9, 12]);
  });

  it("single filterP works correctly without fusion", async () => {
    const p = filterP((x: number) => x % 2 === 0);
    const stream = fromArray([1, 2, 3, 4, 5, 6]);
    const result = await run<number[]>(collectStream(via(stream, p)));
    expect(result).toEqual([2, 4, 6]);
  });

  it("single takeP works correctly without fusion", async () => {
    const p = takeP<number>(3);
    const stream = fromArray([10, 20, 30, 40, 50]);
    const result = await run<number[]>(collectStream(via(stream, p)));
    expect(result).toEqual([10, 20, 30]);
  });

  it("single dropP works correctly without fusion", async () => {
    const p = dropP<number>(2);
    const stream = fromArray([10, 20, 30, 40, 50]);
    const result = await run<number[]>(collectStream(via(stream, p)));
    expect(result).toEqual([30, 40, 50]);
  });

  it("single mapP does not have _fusedSteps (fusion only in andThen)", () => {
    const p = mapP((x: number) => x * 2);
    expect((p as any)._fusedSteps).toBeUndefined();
  });

  it("single filterP does not have _fusedSteps", () => {
    const p = filterP((x: number) => x > 0);
    expect((p as any)._fusedSteps).toBeUndefined();
  });

  it("single takeP does not have _fusedSteps", () => {
    const p = takeP<number>(5);
    expect((p as any)._fusedSteps).toBeUndefined();
  });

  it("single dropP does not have _fusedSteps", () => {
    const p = dropP<number>(3);
    expect((p as any)._fusedSteps).toBeUndefined();
  });

  it("getStats returns null for single operators (not fused)", () => {
    expect(getStats(mapP((x: number) => x) as any)).toBeNull();
    expect(getStats(filterP((x: number) => x > 0) as any)).toBeNull();
    expect(getStats(takeP(5) as any)).toBeNull();
    expect(getStats(dropP(2) as any)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. API backward compatibility (Req 7.1)
// ---------------------------------------------------------------------------
describe("API backward compatibility (Req 7.1)", () => {
  it("mapP accepts a transform function and returns a pipeline", () => {
    const p = mapP((x: number) => x + 1);
    expect(typeof p).toBe("function");
  });

  it("filterP accepts a predicate and returns a pipeline", () => {
    const p = filterP((x: number) => x > 0);
    expect(typeof p).toBe("function");
  });

  it("takeP accepts a number and returns a pipeline", () => {
    const p = takeP(5);
    expect(typeof p).toBe("function");
  });

  it("dropP accepts a number and returns a pipeline", () => {
    const p = dropP(3);
    expect(typeof p).toBe("function");
  });

  it("andThen accepts two pipelines and returns a pipeline", () => {
    const p = andThen(mapP((x: number) => x + 1), mapP((x: number) => x * 2));
    expect(typeof p).toBe("function");
  });

  it("via applies a pipeline to a stream and returns a stream", async () => {
    const p = mapP((x: number) => x * 10);
    const stream = fromArray([1, 2, 3]);
    const result = via(stream, p);
    // Result should be a stream (object with _tag)
    expect(result).toBeDefined();
    expect(typeof (result as any)._tag).toBe("string");
  });

  it("pipeline functions are callable directly on streams", async () => {
    const p = mapP((x: number) => x + 100);
    const stream = fromArray([1, 2]);
    // Calling pipeline directly (same as via)
    const resultStream = p(stream);
    const result = await run<number[]>(collectStream(resultStream));
    expect(result).toEqual([101, 102]);
  });

  it("andThen result is callable as a pipeline function", async () => {
    const p = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 5));
    const stream = fromArray([1, 2, 3, 4, 5]);
    const resultStream = p(stream);
    const result = await run<number[]>(collectStream(resultStream));
    expect(result).toEqual([6, 8, 10]);
  });
});

// ---------------------------------------------------------------------------
// 3. Fusion disable (Req 7.3)
// ---------------------------------------------------------------------------
describe("Fusion disable via setFusionEnabled(false) (Req 7.3)", () => {
  afterEach(() => {
    // Always restore fusion to enabled state
    setFusionEnabled(true);
  });

  it("setFusionEnabled(false) prevents andThen from producing _fusedSteps", () => {
    setFusionEnabled(false);
    const p = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    expect((p as any)._fusedSteps).toBeUndefined();
  });

  it("pipeline still works correctly with fusion disabled", async () => {
    setFusionEnabled(false);
    const p = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    const stream = fromArray([1, 2, 3, 4, 5]);
    const result = await run<number[]>(collectStream(via(stream, p)));
    // 1*2=2 (skip), 2*2=4 (skip), 3*2=6 (emit), 4*2=8 (emit), 5*2=10 (emit)
    expect(result).toEqual([6, 8, 10]);
  });

  it("multi-step pipeline works correctly with fusion disabled", async () => {
    setFusionEnabled(false);
    const p = andThen(
      andThen(mapP((x: number) => x + 1), filterP((x: number) => x % 2 === 0)),
      takeP(2)
    );
    const stream = fromArray([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await run<number[]>(collectStream(via(stream, p)));
    expect(result).toEqual([2, 4]);
  });

  it("setFusionEnabled(true) restores fusion behavior", () => {
    setFusionEnabled(false);
    expect(isFusionEnabled()).toBe(false);

    setFusionEnabled(true);
    expect(isFusionEnabled()).toBe(true);

    const p = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    expect((p as any)._fusedSteps).toBeDefined();
  });

  it("getStats returns null when fusion is disabled", () => {
    setFusionEnabled(false);
    const p = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    const stats = getStats(p as any);
    expect(stats).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Key functions exist (meta-test for Req 7.2)
// ---------------------------------------------------------------------------
describe("Key API exports exist (Req 7.2)", () => {
  it("mapP is exported and is a function", () => {
    expect(typeof mapP).toBe("function");
  });

  it("filterP is exported and is a function", () => {
    expect(typeof filterP).toBe("function");
  });

  it("takeP is exported and is a function", () => {
    expect(typeof takeP).toBe("function");
  });

  it("dropP is exported and is a function", () => {
    expect(typeof dropP).toBe("function");
  });

  it("andThen is exported and is a function", () => {
    expect(typeof andThen).toBe("function");
  });

  it("via is exported and is a function", () => {
    expect(typeof via).toBe("function");
  });

  it("setFusionEnabled is exported and is a function", () => {
    expect(typeof setFusionEnabled).toBe("function");
  });

  it("isFusionEnabled is exported and is a function", () => {
    expect(typeof isFusionEnabled).toBe("function");
  });

  it("getStats is exported and is a function", () => {
    expect(typeof getStats).toBe("function");
  });

  it("PURE_PIPELINE_TAG is exported and is a symbol", () => {
    expect(typeof PURE_PIPELINE_TAG).toBe("symbol");
  });

  it("fromArray is exported and is a function", () => {
    expect(typeof fromArray).toBe("function");
  });

  it("collectStream is exported and is a function", () => {
    expect(typeof collectStream).toBe("function");
  });
});
