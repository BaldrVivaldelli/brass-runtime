import { afterEach, describe, expect, it, vi } from "vitest";

describe("HTTP lifecycle timing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses performance.now when the Performance API is available", async () => {
    const nowFn = vi.fn(() => 12.5);
    vi.stubGlobal("performance", { now: nowFn });
    vi.resetModules();

    const timing = await import("../lifecycle/timing");
    const callsBefore = nowFn.mock.calls.length;
    const value = timing.now();
    const callsAfter = nowFn.mock.calls.length;

    expect(value).toBe(12.5);
    expect(callsAfter - callsBefore).toBe(1);
  });

  it("falls back to Date.now when performance.now is unavailable", async () => {
    vi.stubGlobal("performance", undefined);
    vi.spyOn(Date, "now").mockReturnValue(123);
    vi.resetModules();

    const timing = await import("../lifecycle/timing");

    expect(timing.now()).toBe(123);
  });
});
