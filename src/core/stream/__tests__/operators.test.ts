import { describe, it, expect } from "vitest";
import { zip, zipWith, scan, interleave, take, drop } from "../operators";
import { fromArray, collectStream } from "../stream";
import { Runtime } from "../../runtime/runtime";

const rt = Runtime.make({});
function run<A>(effect: any): Promise<A> { return rt.toPromise(effect); }

describe("zip", () => {
  it("pairs elements from two streams", async () => {
    const left = fromArray([1, 2, 3]);
    const right = fromArray(["a", "b", "c"]);
    const result = await run<[number, string][]>(collectStream(zip(left, right)));
    expect(result).toEqual([[1, "a"], [2, "b"], [3, "c"]]);
  });

  it("stops when left stream is shorter", async () => {
    const left = fromArray([1, 2]);
    const right = fromArray(["a", "b", "c", "d"]);
    const result = await run<[number, string][]>(collectStream(zip(left, right)));
    expect(result).toEqual([[1, "a"], [2, "b"]]);
  });

  it("stops when right stream is shorter", async () => {
    const left = fromArray([1, 2, 3, 4]);
    const right = fromArray(["x"]);
    const result = await run<[number, string][]>(collectStream(zip(left, right)));
    expect(result).toEqual([[1, "x"]]);
  });

  it("handles empty streams", async () => {
    const left = fromArray<number>([]);
    const right = fromArray(["a", "b"]);
    const result = await run<[number, string][]>(collectStream(zip(left, right)));
    expect(result).toEqual([]);
  });
});

describe("zipWith", () => {
  it("combines elements with a custom function", async () => {
    const left = fromArray([1, 2, 3]);
    const right = fromArray([10, 20, 30]);
    const result = await run<number[]>(collectStream(zipWith(left, right, (a, b) => a + b)));
    expect(result).toEqual([11, 22, 33]);
  });
});

describe("scan", () => {
  it("produces running accumulation", async () => {
    const stream = fromArray([1, 2, 3, 4]);
    const result = await run<number[]>(collectStream(scan(stream, 0, (acc, n) => acc + n)));
    expect(result).toEqual([0, 1, 3, 6, 10]); // initial + running sum
  });

  it("emits initial value for empty stream", async () => {
    const stream = fromArray<number>([]);
    const result = await run<number[]>(collectStream(scan(stream, 42, (acc, n) => acc + n)));
    expect(result).toEqual([42]);
  });

  it("works with string accumulation", async () => {
    const stream = fromArray(["a", "b", "c"]);
    const result = await run<string[]>(collectStream(scan(stream, "", (acc, s) => acc + s)));
    expect(result).toEqual(["", "a", "ab", "abc"]);
  });
});

describe("interleave", () => {
  it("alternates elements from two streams", async () => {
    const left = fromArray([1, 3, 5]);
    const right = fromArray([2, 4, 6]);
    const result = await run<number[]>(collectStream(interleave(left, right)));
    expect(result).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("drains remaining when one stream is shorter", async () => {
    const left = fromArray([1, 3]);
    const right = fromArray([2, 4, 6, 8]);
    const result = await run<number[]>(collectStream(interleave(left, right)));
    // left: 1, right: 2, left: 3, right: 4, left empty → drain right: 6, 8
    expect(result).toEqual([1, 2, 3, 4, 6, 8]);
  });

  it("handles empty left stream", async () => {
    const left = fromArray<number>([]);
    const right = fromArray([1, 2, 3]);
    const result = await run<number[]>(collectStream(interleave(left, right)));
    expect(result).toEqual([1, 2, 3]);
  });
});

describe("take (standalone)", () => {
  it("takes first N elements", async () => {
    const stream = fromArray([10, 20, 30, 40, 50]);
    const result = await run<number[]>(collectStream(take(stream, 3)));
    expect(result).toEqual([10, 20, 30]);
  });

  it("returns all if N > length", async () => {
    const stream = fromArray([1, 2]);
    const result = await run<number[]>(collectStream(take(stream, 10)));
    expect(result).toEqual([1, 2]);
  });

  it("returns empty for take(0)", async () => {
    const stream = fromArray([1, 2, 3]);
    const result = await run<number[]>(collectStream(take(stream, 0)));
    expect(result).toEqual([]);
  });
});

describe("drop (standalone)", () => {
  it("drops first N elements", async () => {
    const stream = fromArray([10, 20, 30, 40, 50]);
    const result = await run<number[]>(collectStream(drop(stream, 2)));
    expect(result).toEqual([30, 40, 50]);
  });

  it("returns empty if N >= length", async () => {
    const stream = fromArray([1, 2]);
    const result = await run<number[]>(collectStream(drop(stream, 5)));
    expect(result).toEqual([]);
  });

  it("returns all for drop(0)", async () => {
    const stream = fromArray([1, 2, 3]);
    const result = await run<number[]>(collectStream(drop(stream, 0)));
    expect(result).toEqual([1, 2, 3]);
  });
});
