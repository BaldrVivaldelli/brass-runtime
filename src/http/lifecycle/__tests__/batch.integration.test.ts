// src/http/lifecycle/__tests__/batch.integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Async } from "../../../core/types/asyncEffect";
import type { Exit } from "../../../core/types/effect";
import type { HttpError, HttpRequest, HttpWireResponse } from "../../client";
import type { BatchConfig } from "../batch";
import type { LifecycleEvent } from "../types";
import { makeLifecycleClient } from "../lifecycleClient";
import { registerHttpEffect } from "../../effectRunner";
import { Runtime } from "../../../core/runtime/runtime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.example.com";
const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

function runEffect(effect: Async<unknown, HttpError, HttpWireResponse>): {
  result: () => Exit<HttpError, HttpWireResponse> | undefined;
  cancel: () => void;
} {
  let exitResult: Exit<HttpError, HttpWireResponse> | undefined;
  const cancel = registerHttpEffect(effect, undefined, (exit) => {
    exitResult = exit;
  });
  return { result: () => exitResult, cancel };
}

function makeRequest(url = "/test", method: "GET" | "POST" = "GET"): HttpRequest {
  return { method, url };
}

/**
 * Creates a standard BatchConfig for integration tests.
 */
function makeBatchConfig(overrides: Partial<BatchConfig> = {}): BatchConfig {
  return {
    windowMs: overrides.windowMs ?? 10,
    maxBatchSize: overrides.maxBatchSize ?? 100,
    batchKey: overrides.batchKey ?? (() => "integration-key"),
    batch: overrides.batch ?? {
      coalesce: (reqs) => ({
        method: "POST",
        url: "/batch",
        body: JSON.stringify(reqs.map((r) => r.url)),
      }),
      split: (_res, reqs) =>
        reqs.map((_, i) => ({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: `batch-response-${i}`,
          ms: 1,
        })),
    },
  };
}

// ---------------------------------------------------------------------------
// Mock fetch for integration tests
// ---------------------------------------------------------------------------

function setupMockFetch() {
  const mockFetch = vi.fn().mockImplementation(async () => {
    return new Response("mock-body", { status: 200, statusText: "OK" });
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

// ---------------------------------------------------------------------------
// 7.5: Lifecycle client integration setup
// ---------------------------------------------------------------------------

describe("batch integration - lifecycle client", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setupMockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("makeLifecycleClient accepts batch config", () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: makeBatchConfig(),
    });

    expect(client).toBeDefined();
    expect(typeof client).toBe("function");
    expect(typeof client.stats).toBe("function");
  });

  it("lifecycle client with batch returns Async effects", () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: makeBatchConfig(),
    });

    const effect = client(makeRequest());
    expect(effect).toHaveProperty("_tag");
    expect(effect._tag).toBe("Async");
  });

  it("lifecycle client batch stats start at zero", () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: makeBatchConfig(),
    });

    const stats = client.stats();
    expect(stats.batchDispatches).toBe(0);
    expect(stats.batchedRequests).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7.6: Batch layer composes correctly with dedup and cache
// ---------------------------------------------------------------------------

describe("batch integration - composition with dedup and cache", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setupMockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("batch composes with dedup layer enabled", async () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      dedup: {},
      batch: makeBatchConfig({ windowMs: 5 }),
    });

    const result = await run<HttpWireResponse>(client(makeRequest("/users")));
    expect(result).toBeDefined();
    expect(result.status).toBe(200);
  });

  it("batch composes with cache layer enabled", async () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: makeBatchConfig({ windowMs: 5 }),
      cache: { ttlSeconds: 60 },
    });

    const result = await run<HttpWireResponse>(client(makeRequest("/items")));
    expect(result).toBeDefined();
    expect(result.status).toBe(200);
  });

  it("batch composes with both dedup and cache layers", async () => {
    const events: LifecycleEvent[] = [];
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      dedup: {},
      batch: makeBatchConfig({ windowMs: 5 }),
      cache: { ttlSeconds: 60 },
      onEvent: (ev) => events.push(ev),
    });

    const result = await run<HttpWireResponse>(client(makeRequest("/data")));
    expect(result).toBeDefined();
    expect(result.status).toBe(200);
  });

  it("batch stats update after dispatch with other layers", async () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      dedup: {},
      batch: makeBatchConfig({ windowMs: 5 }),
      cache: { ttlSeconds: 60 },
    });

    // Send two requests concurrently that will be batched
    const [r1, r2] = await Promise.all([
      run<HttpWireResponse>(client(makeRequest("/a"))),
      run<HttpWireResponse>(client(makeRequest("/b"))),
    ]);

    expect(r1).toBeDefined();
    expect(r2).toBeDefined();

    const stats = client.stats();
    expect(stats.batchDispatches).toBe(1);
    expect(stats.batchedRequests).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 7.7: Disabled batch layer has zero overhead
// ---------------------------------------------------------------------------

describe("batch integration - disabled batch (zero overhead)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setupMockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("batch=undefined means no batch layer", async () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      // batch is not set
    });

    const result = await run<HttpWireResponse>(client(makeRequest()));
    expect(result).toBeDefined();
    expect(result.status).toBe(200);
  });

  it("batch=false explicitly disables batch layer", async () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: false,
    });

    const result = await run<HttpWireResponse>(client(makeRequest()));
    expect(result).toBeDefined();
    expect(result.status).toBe(200);
  });

  it("disabled batch does not affect stats (batchDispatches stays 0)", async () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: false,
    });

    await Promise.all([
      run<HttpWireResponse>(client(makeRequest("/a"))),
      run<HttpWireResponse>(client(makeRequest("/b"))),
    ]);

    const stats = client.stats();
    expect(stats.batchDispatches).toBe(0);
    expect(stats.batchedRequests).toBe(0);
  });

  it("disabled batch sends requests directly without timer delay", async () => {
    const mockFetch = setupMockFetch();
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: undefined,
    });

    await run<HttpWireResponse>(client(makeRequest("/direct")));

    // fetch should have been called (no timer-based batching)
    expect(mockFetch).toHaveBeenCalled();
  });

  it("zero overhead: no batch events emitted when disabled", async () => {
    const events: LifecycleEvent[] = [];
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: false,
      onEvent: (ev) => events.push(ev),
    });

    await Promise.all([
      run<HttpWireResponse>(client(makeRequest("/a"))),
      run<HttpWireResponse>(client(makeRequest("/b"))),
    ]);

    const batchEvents = events.filter(
      (e) => e.type === "batch-hit" || e.type === "batch-dispatch",
    );
    expect(batchEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7.8: End-to-end batch dispatch through lifecycle client
// ---------------------------------------------------------------------------

describe("batch integration - end-to-end dispatch", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setupMockFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("batches multiple requests and distributes responses", async () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: makeBatchConfig({ windowMs: 10 }),
    });

    // Send requests concurrently — they should be batched together
    const [r1, r2, r3] = await Promise.all([
      run<HttpWireResponse>(client(makeRequest("/users/1"))),
      run<HttpWireResponse>(client(makeRequest("/users/2"))),
      run<HttpWireResponse>(client(makeRequest("/users/3"))),
    ]);

    expect(r1.bodyText).toBe("batch-response-0");
    expect(r2.bodyText).toBe("batch-response-1");
    expect(r3.bodyText).toBe("batch-response-2");
  });

  it("emits batch-dispatch event with correct batchSize", async () => {
    const events: LifecycleEvent[] = [];
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: makeBatchConfig({ windowMs: 10 }),
      onEvent: (ev) => events.push(ev),
    });

    await Promise.all([
      run<HttpWireResponse>(client(makeRequest("/a"))),
      run<HttpWireResponse>(client(makeRequest("/b"))),
    ]);

    const dispatchEvents = events.filter((e) => e.type === "batch-dispatch");
    expect(dispatchEvents.length).toBeGreaterThanOrEqual(1);
    expect(dispatchEvents[0].batchKey).toBe("integration-key");
    expect(dispatchEvents[0].batchSize).toBe(2);
  });

  it("emits batch-hit events for subsequent requests in same group", async () => {
    const events: LifecycleEvent[] = [];
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: makeBatchConfig({ windowMs: 10 }),
      onEvent: (ev) => events.push(ev),
    });

    await Promise.all([
      run<HttpWireResponse>(client(makeRequest("/first"))),
      run<HttpWireResponse>(client(makeRequest("/second"))),
      run<HttpWireResponse>(client(makeRequest("/third"))),
    ]);

    const hitEvents = events.filter((e) => e.type === "batch-hit");
    // 2 batch-hit events (second and third requests joining existing group)
    expect(hitEvents.length).toBe(2);
  });

  it("maxBatchSize triggers immediate dispatch through lifecycle client", async () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: makeBatchConfig({ windowMs: 5000, maxBatchSize: 3 }),
    });

    // Send exactly maxBatchSize requests — should dispatch immediately
    const [r1, r2, r3] = await Promise.all([
      run<HttpWireResponse>(client(makeRequest("/a"))),
      run<HttpWireResponse>(client(makeRequest("/b"))),
      run<HttpWireResponse>(client(makeRequest("/c"))),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
  });

  it("lifecycle stats reflect batch activity", async () => {
    const client = makeLifecycleClient({
      baseUrl: BASE_URL,
      batch: makeBatchConfig({ windowMs: 10 }),
    });

    await Promise.all([
      run<HttpWireResponse>(client(makeRequest("/x"))),
      run<HttpWireResponse>(client(makeRequest("/y"))),
    ]);

    const stats = client.stats();
    expect(stats.batchDispatches).toBe(1);
    expect(stats.batchedRequests).toBe(2);
    expect(stats.requestsStarted).toBeGreaterThanOrEqual(2);
  });

  it("cancellation works through lifecycle client", () => {
    vi.useFakeTimers();
    try {
      const client = makeLifecycleClient({
        baseUrl: BASE_URL,
        batch: makeBatchConfig({ windowMs: 100 }),
      });

      const r1 = runEffect(client(makeRequest("/cancel-me")));
      const r2 = runEffect(client(makeRequest("/keep-me")));

      // Cancel r1 before dispatch
      r1.cancel();

      expect(r1.result()).toBeDefined();
      expect(r1.result()!._tag).toBe("Failure");

      // r2 is still pending (batch not dispatched yet)
      expect(r2.result()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
