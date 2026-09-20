import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptiveLimiter } from "../adaptiveLimiter";

describe("scheduled HTTP fault corpus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains a full bounded queue during a timeout storm", async () => {
    vi.useFakeTimers();
    const maxQueue = 256;
    const limiter = new AdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 1,
      maxQueue,
      queueTimeoutMs: 25,
      stateTtlMs: false,
    });
    const signal = new AbortController().signal;
    const held = await limiter.acquire("timeout-storm", signal);
    const queued = Array.from({ length: maxQueue }, () =>
      limiter.acquire("timeout-storm", signal).catch((error) => error),
    );

    await expect(limiter.acquire("timeout-storm", signal)).rejects.toMatchObject({
      _tag: "PoolRejected",
      key: "timeout-storm",
    });
    expect(limiter.stats("timeout-storm").queueDepth).toBe(maxQueue);

    await vi.advanceTimersByTimeAsync(26);
    const exits = await Promise.all(queued);

    expect(exits).toHaveLength(maxQueue);
    expect(exits.every((error) => error?._tag === "PoolTimeout")).toBe(true);
    expect(limiter.stats("timeout-storm")).toMatchObject({
      inFlight: 1,
      queueDepth: 0,
    });

    held.release(10);
    limiter.shutdown();
    expect(limiter.stats("timeout-storm")).toMatchObject({
      inFlight: 0,
      queueDepth: 0,
    });
  });

  it("removes a cancellation storm without dispatching queued work", async () => {
    const limiter = new AdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 1,
      maxQueue: 128,
      queueTimeoutMs: false,
      stateTtlMs: false,
    });
    const held = await limiter.acquire("cancel-storm", new AbortController().signal);
    const controllers = Array.from({ length: 128 }, () => new AbortController());
    const queued = controllers.map((controller) =>
      limiter.acquire("cancel-storm", controller.signal).catch((error) => error),
    );

    for (const controller of controllers) controller.abort("stability-fault");
    const exits = await Promise.all(queued);

    expect(exits.every((error) => error?._tag === "Abort")).toBe(true);
    expect(limiter.stats("cancel-storm")).toMatchObject({
      inFlight: 1,
      queueDepth: 0,
    });

    held.release(10);
    limiter.shutdown();
  });
});
