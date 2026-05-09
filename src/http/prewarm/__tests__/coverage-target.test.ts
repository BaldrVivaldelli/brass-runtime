import { afterEach, describe, expect, it, vi } from "vitest";
import { async } from "../../../core/types/asyncEffect";
import { makeMockHttpClient } from "../../testing";
import { makeConnectionStateMap } from "../connectionState";

afterEach(() => {
  vi.doUnmock("../probe");
  vi.resetModules();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("prewarm coverage target edges", () => {
  it("covers connection state no-op branches and auto-refresh timer clearing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const state = makeConnectionStateMap(["https://api.example.com"], 10);

    state.markWarm("https://missing.example.com");
    state.markExpired("https://missing.example.com");
    state.markIdle("https://missing.example.com");
    state.markProbing("https://missing.example.com");
    expect(state.isWarm("https://missing.example.com")).toBe(false);
    expect(state.getState("https://missing.example.com")).toBeUndefined();

    state.markWarm("https://api.example.com", 100);
    expect(state.isWarm("https://api.example.com", 105)).toBe(true);
    state.markExpired("https://api.example.com");
    expect(state.isWarm("https://api.example.com", 106)).toBe(false);
    state.markIdle("https://api.example.com");
    expect(state.snapshot().origins).toEqual([
      { origin: "https://api.example.com", status: "idle", lastProbeAt: undefined, warmUntil: undefined },
    ]);

    const { makePrewarmManager } = await import("../prewarmManager");
    const manager = makePrewarmManager({
      origins: ["https://api.example.com"],
      autoRefresh: true,
      keepAliveDurationMs: 100,
    });
    await expect(manager.warm("https://api.example.com")).resolves.toMatchObject({ status: "warmed" });
    manager.cancel("https://api.example.com");
    manager.dispose();
  });

  it("treats unexpected probe throws as failed prewarm results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    vi.doMock("../probe", () => ({
      executeProbe: async () => {
        throw new Error("probe exploded");
      },
    }));
    vi.resetModules();

    const { makePrewarmManager } = await import("../prewarmManager");
    const events: unknown[] = [];
    const manager = makePrewarmManager({
      origins: ["https://api.example.com"],
      onEvent: (event) => events.push(event),
    });

    await expect(manager.warm("https://api.example.com")).resolves.toMatchObject({
      status: "failed",
      error: "probe exploded",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "connection-failed",
      error: "probe exploded",
    }));
    manager.dispose();
  });

  it("returns cancelled when disposed while waiting for a prewarm budget slot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => undefined)));
    const { makePrewarmManager } = await import("../prewarmManager");
    const manager = makePrewarmManager({
      origins: ["https://api.example.com", "https://cdn.example.com"],
      budget: 1,
      client: makeMockHttpClient(() => async(() => () => undefined)),
      useClientPool: true,
    });

    void manager.warm("https://api.example.com");
    const queued = manager.warm("https://cdn.example.com");
    await Promise.resolve();
    manager.dispose();

    await expect(queued).resolves.toMatchObject({ status: "cancelled" });
  });
});
