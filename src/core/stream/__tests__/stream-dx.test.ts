import { describe, expect, it } from "vitest";

import { Runtime } from "../../runtime/runtime";
import { Pipeline, Stream, asStream } from "../dx";
import { fromArray } from "../stream";

describe("Stream DX facade", () => {
  it("collects mapped and filtered streams through a runtime", async () => {
    const runtime = Runtime.make({});

    const result = await Stream
      .from([1, 2, 3, 4, 5])
      .map((value) => value * 2)
      .filter((value) => value > 5)
      .collect(runtime);

    expect(result).toEqual([6, 8, 10]);
  });

  it("supports explicit pipeline composition", async () => {
    const runtime = Runtime.make({});
    const result = await Stream
      .range(1, 3)
      .pipe(Pipeline.map((value: number) => String(value)))
      .collect(runtime);

    expect(result).toEqual(["1", "2", "3"]);
    await expect(Stream.empty<number>().collect(runtime)).resolves.toEqual([]);
  });

  it("adds fluent operations without mutating the source stream AST", async () => {
    const runtime = Runtime.make({});
    const source = fromArray([1, 2, 3]);
    const fluent = asStream(source);

    expect(fluent).not.toBe(source);
    expect("pipe" in source).toBe(false);
    expect(Object.keys(fluent)).toEqual(Object.keys(source));
    await expect(fluent.collect(runtime)).resolves.toEqual([1, 2, 3]);
  });
});
