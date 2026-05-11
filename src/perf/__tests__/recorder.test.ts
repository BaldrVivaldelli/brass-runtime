import { describe, expect, it } from "vitest";
import { makePerfRecorder, summarizePerfEvents } from "../recorder";

describe("makePerfRecorder", () => {
  it("keeps a bounded ring buffer and reports dropped events", () => {
    let now = 0;
    const recorder = makePerfRecorder({ maxEvents: 2, clock: () => ++now });

    recorder.mark("first");
    recorder.counter("requests", 1, "count");
    recorder.gauge("heap", 10, "MB");

    expect(recorder.snapshot().map((event) => event.name)).toEqual(["requests", "heap"]);
    expect(recorder.stats()).toEqual({ capacity: 2, size: 2, recorded: 3, dropped: 1 });
  });

  it("measures sync and async work", async () => {
    let now = 0;
    const recorder = makePerfRecorder({ clock: () => ++now });

    const value = recorder.measure("sync", () => 42);
    const asyncValue = await recorder.measureAsync("async", async () => "ok");

    expect(value).toBe(42);
    expect(asyncValue).toBe("ok");
    expect(recorder.explain().map((summary) => summary.name)).toEqual(["async", "sync"]);
    expect(recorder.explain().every((summary) => summary.totalDurationMs > 0)).toBe(true);
  });
});

describe("summarizePerfEvents", () => {
  it("groups events by name and type", () => {
    const summaries = summarizePerfEvents([
      { type: "measure", name: "http", timestamp: 1, durationMs: 10 },
      { type: "measure", name: "http", timestamp: 2, durationMs: 15 },
      { type: "counter", name: "http", timestamp: 3, value: 2 },
    ]);

    expect(summaries).toHaveLength(2);
    expect(summaries.find((summary) => summary.type === "measure")).toMatchObject({
      name: "http",
      count: 2,
      totalDurationMs: 25,
      maxDurationMs: 15,
    });
    expect(summaries.find((summary) => summary.type === "counter")).toMatchObject({
      lastValue: 2,
    });
  });
});
