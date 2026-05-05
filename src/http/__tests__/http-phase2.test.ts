import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHttp } from "../client";
import { Runtime, abortablePromiseStats, resetAbortablePromiseStats } from "../../core/runtime/runtime";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (predicate: () => boolean, timeoutMs = 500) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timeout");
    await wait(1);
  }
};

describe("HTTP phase 2 controls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAbortablePromiseStats();
  });

  it("enforces request timeout and exposes timeout diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    const http = makeHttp({ baseUrl: "https://example.com", timeoutMs: 5 });
    const rt = Runtime.make({});

    await expect(rt.toPromise(http({ method: "GET", url: "/slow" }))).rejects.toMatchObject({
      _tag: "Timeout",
      timeoutMs: 5,
    });

    expect(http.stats()).toMatchObject({
      inFlight: 0,
      started: 1,
      timedOut: 1,
    });
    expect(abortablePromiseStats()).toMatchObject({
      active: 0,
      started: 1,
      timedOut: 1,
    });
  });

  it("fails fast when the downstream pool queue is full", async () => {
    let releaseFirst!: () => void;
    let fetchCalls = 0;

    vi.stubGlobal("fetch", vi.fn(() => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return new Promise<Response>((resolve) => {
          releaseFirst = () => resolve(new Response("one", { status: 200 }));
        });
      }
      return Promise.resolve(new Response("two", { status: 200 }));
    }));

    const http = makeHttp({
      baseUrl: "https://example.com",
      pool: { concurrency: 1, maxQueue: 0, key: "origin" },
    });
    const rt = Runtime.make({});

    const first = rt.toPromise(http({ method: "GET", url: "/one" }));
    await waitUntil(() => fetchCalls === 1);

    await expect(rt.toPromise(http({ method: "GET", url: "/two" }))).rejects.toMatchObject({
      _tag: "PoolRejected",
      key: "https://example.com",
    });

    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: 200, bodyText: "one" });

    const stats = http.stats();
    expect(stats.poolRejected).toBe(1);
    expect(stats.pool?.keys[0]).toMatchObject({
      key: "https://example.com",
      acquired: 1,
      released: 1,
      rejected: 1,
    });
  });
});
