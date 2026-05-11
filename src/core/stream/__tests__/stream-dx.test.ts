import { describe, expect, it } from "vitest";

import { Runtime } from "../../runtime/runtime";
import { Pipeline, Stream } from "../dx";

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
});
