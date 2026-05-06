import { describe, it, expect } from "vitest";
import { mapP, filterP, takeP, dropP, andThen, via } from "../pipeline";
import { PURE_PIPELINE_TAG } from "../fusion";
import { collectStream, fromArray } from "../stream";
import { Runtime } from "../../runtime/runtime";

const rt = Runtime.make({});
function run<A>(effect: any): Promise<A> {
  return rt.toPromise(effect);
}

describe("andThen automatic fusion", () => {
  it("fuses two pure operators automatically", () => {
    const p = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    // Should have _fusedSteps attached
    expect((p as any)._fusedSteps).toBeDefined();
    expect((p as any)._fusedSteps.length).toBe(2);
    expect((p as any)._fusedSteps[0].kind).toBe("map");
    expect((p as any)._fusedSteps[1].kind).toBe("filter");
  });

  it("fuses three pure operators via nested andThen", () => {
    const p1 = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    const p2 = andThen(p1, takeP(3));
    expect((p2 as any)._fusedSteps).toBeDefined();
    expect((p2 as any)._fusedSteps.length).toBe(3);
    expect((p2 as any)._fusedSteps[0].kind).toBe("map");
    expect((p2 as any)._fusedSteps[1].kind).toBe("filter");
    expect((p2 as any)._fusedSteps[2].kind).toBe("take");
  });

  it("falls back to standard composition when one operand is not pure", () => {
    const effectful = ((input: any) => input) as any;
    const p = andThen(mapP((x: number) => x * 2), effectful);
    // Should NOT have _fusedSteps
    expect((p as any)._fusedSteps).toBeUndefined();
  });

  it("falls back when neither operand is pure", () => {
    const effectful1 = ((input: any) => input) as any;
    const effectful2 = ((input: any) => input) as any;
    const p = andThen(effectful1, effectful2);
    expect((p as any)._fusedSteps).toBeUndefined();
  });

  it("fused pipeline produces correct output (map + filter)", async () => {
    const p = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 4));
    const stream = fromArray([1, 2, 3, 4, 5]);
    const result = await run<number[]>(collectStream(via(stream, p)));
    // 1*2=2 (skip), 2*2=4 (skip), 3*2=6 (emit), 4*2=8 (emit), 5*2=10 (emit)
    expect(result).toEqual([6, 8, 10]);
  });

  it("fused pipeline produces correct output (map + filter + take)", async () => {
    const p = andThen(
      andThen(mapP((x: number) => x + 1), filterP((x: number) => x % 2 === 0)),
      takeP(2)
    );
    const stream = fromArray([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await run<number[]>(collectStream(via(stream, p)));
    // 1+1=2 (even, emit, taken=1), 2+1=3 (odd, skip), 3+1=4 (even, emit, taken=2) → halt
    expect(result).toEqual([2, 4]);
  });

  it("fused pipeline produces correct output (drop + map)", async () => {
    const p = andThen(dropP<number>(2), mapP((x: number) => x * 10));
    const stream = fromArray([1, 2, 3, 4, 5]);
    const result = await run<number[]>(collectStream(via(stream, p)));
    // drop 1, drop 2, then map: 3*10=30, 4*10=40, 5*10=50
    expect(result).toEqual([30, 40, 50]);
  });

  it("fused pipeline handles empty stream", async () => {
    const p = andThen(mapP((x: number) => x * 2), filterP((x: number) => x > 0));
    const stream = fromArray<number>([]);
    const result = await run<number[]>(collectStream(via(stream, p)));
    expect(result).toEqual([]);
  });

  it("preserves backward compatibility: API signature unchanged", () => {
    // andThen still accepts two pipelines and returns a pipeline
    const p = andThen(mapP((x: number) => x + 1), mapP((x: number) => x * 2));
    // It's still callable as a pipeline function
    expect(typeof p).toBe("function");
  });
});
