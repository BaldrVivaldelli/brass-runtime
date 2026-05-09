import { afterEach, describe, expect, it, vi } from "vitest";

const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("scheduler coverage target edges", () => {
  it("infers lanes from dist/runtime stack frames and falls back for extensionless paths", async () => {
    const { inferCallerLaneFromStack, Scheduler } = await import("../scheduler");

    expect(inferCallerLaneFromStack([
      "Error",
      "    at run (/repo/dist/runtime.js:10:2)",
    ].join("\n"), "fallback lane")).toBe("fallback:lane");

    expect(inferCallerLaneFromStack([
      "Error",
      "    at job (/tmp/custom-script:1:1)",
    ].join("\n"), "fallback")).toBe("/tmp/custom-script");

    const scheduler = new Scheduler({
      laneMode: "single",
      initialCapacity: 4,
      maxCapacity: 4,
      flushBudget: 1,
    });
    const ran: number[] = [];
    expect(scheduler.scheduleBatch([
      { fn: () => ran.push(1), tag: "one" },
      { fn: "not a function" as any, tag: "bad" },
      { fn: () => ran.push(2), tag: "two" },
    ])).toEqual(["accepted", "dropped", "accepted"]);

    await wait();
    await wait();

    expect(ran).toEqual([1, 2]);
    expect(scheduler.stats().data.yieldedByBudget).toBeGreaterThan(0);
  });

  it("uses MessageChannel for macro flushes when setImmediate is unavailable", async () => {
    class FakeMessageChannel {
      port1: { onmessage: null | (() => void) } = { onmessage: null };
      port2 = {
        postMessage: () => {
          queueMicrotask(() => this.port1.onmessage?.());
        },
      };
    }

    vi.stubGlobal("setImmediate", undefined);
    vi.stubGlobal("MessageChannel", FakeMessageChannel as any);
    vi.resetModules();

    const { Scheduler } = await import("../scheduler");
    const scheduler = new Scheduler({ laneMode: "single", microThreshold: 0 });
    const ran: string[] = [];
    scheduler.schedule(() => ran.push("macro"));
    await Promise.resolve();

    expect(ran).toEqual(["macro"]);
  });

  it("falls back to setTimeout for macro flushes without setImmediate or MessageChannel", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("setImmediate", undefined);
    vi.stubGlobal("MessageChannel", undefined);
    vi.resetModules();

    const { Scheduler } = await import("../scheduler");
    const scheduler = new Scheduler({ laneMode: "single", microThreshold: 0 });
    const ran: string[] = [];
    scheduler.schedule(() => ran.push("timeout"));
    await vi.advanceTimersByTimeAsync(0);

    expect(ran).toEqual(["timeout"]);
    vi.useRealTimers();
  });
});
