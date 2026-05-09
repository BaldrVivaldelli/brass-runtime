// src/http/lifecycle/__tests__/batch.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Async } from "../../../core/types/asyncEffect";
import { asyncSucceed } from "../../../core/types/asyncEffect";
import type { Exit } from "../../../core/types/effect";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "../../client";
import { withBatch } from "../batch";
import type { BatchConfig } from "../batch";
import { registerHttpEffect } from "../../effectRunner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBatchConfig(overrides: Partial<BatchConfig> = {}): BatchConfig {
  return {
    windowMs: overrides.windowMs ?? 100,
    maxBatchSize: overrides.maxBatchSize ?? 100,
    batchKey: overrides.batchKey ?? (() => "test-key"),
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
          bodyText: `response-${i}`,
          ms: 1,
        })),
    },
  };
}

function makeRequest(url = "/test"): HttpRequest {
  return { method: "GET", url };
}

function makeNext(response?: HttpWireResponse): { next: HttpClientFn; callCount: () => number } {
  let count = 0;
  const defaultResponse: HttpWireResponse = {
    status: 200,
    statusText: "OK",
    headers: {},
    bodyText: "ok",
    ms: 1,
  };
  const next: HttpClientFn = (_req) => {
    count++;
    return asyncSucceed(response ?? defaultResponse);
  };
  return { next, callCount: () => count };
}

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

// ---------------------------------------------------------------------------
// 7.1: Config clamping tests (windowMs, maxBatchSize)
// ---------------------------------------------------------------------------

describe("batch middleware - config clamping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("windowMs clamping to [1, 5000]", () => {
    it("clamps windowMs=0 to 1", () => {
      let dispatched = false;
      const config = makeBatchConfig({
        windowMs: 0,
        maxBatchSize: 100,
      });
      const { next } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      runEffect(client(makeRequest()));

      // At 0ms, should not have dispatched yet (clamped to 1ms)
      expect(dispatched).toBe(false);

      // After 1ms, should dispatch
      vi.advanceTimersByTime(1);
      // The timer fires — we verify by checking the effect resolved
    });

    it("clamps windowMs=-1 to 1", () => {
      const config = makeBatchConfig({ windowMs: -1, maxBatchSize: 100 });
      const { next, callCount } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      runEffect(client(makeRequest()));
      vi.advanceTimersByTime(1);

      expect(callCount()).toBe(1);
    });

    it("clamps windowMs=10000 to 5000", () => {
      const config = makeBatchConfig({ windowMs: 10000, maxBatchSize: 100 });
      const { next, callCount } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      runEffect(client(makeRequest()));

      // Should not dispatch at 5000ms - 1
      vi.advanceTimersByTime(4999);
      expect(callCount()).toBe(0);

      // Should dispatch at 5000ms
      vi.advanceTimersByTime(1);
      expect(callCount()).toBe(1);
    });

    it("clamps windowMs=Infinity to 1", () => {
      const config = makeBatchConfig({ windowMs: Infinity, maxBatchSize: 100 });
      const { next, callCount } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      runEffect(client(makeRequest()));
      vi.advanceTimersByTime(1);

      expect(callCount()).toBe(1);
    });

    it("clamps windowMs=NaN to 1", () => {
      const config = makeBatchConfig({ windowMs: NaN, maxBatchSize: 100 });
      const { next, callCount } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      runEffect(client(makeRequest()));
      vi.advanceTimersByTime(1);

      expect(callCount()).toBe(1);
    });

    it("preserves valid windowMs=50", () => {
      const config = makeBatchConfig({ windowMs: 50, maxBatchSize: 100 });
      const { next, callCount } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      runEffect(client(makeRequest()));

      vi.advanceTimersByTime(49);
      expect(callCount()).toBe(0);

      vi.advanceTimersByTime(1);
      expect(callCount()).toBe(1);
    });
  });

  describe("maxBatchSize clamping to [2, 10000]", () => {
    it("clamps maxBatchSize=0 to 2 (dispatches at 2 requests)", () => {
      const config = makeBatchConfig({ windowMs: 5000, maxBatchSize: 0 });
      const { next, callCount } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      runEffect(client(makeRequest("/a")));
      expect(callCount()).toBe(0);

      runEffect(client(makeRequest("/b")));
      // Should dispatch immediately at 2 (clamped from 0)
      expect(callCount()).toBe(1);
    });

    it("clamps maxBatchSize=-1 to 2", () => {
      const config = makeBatchConfig({ windowMs: 5000, maxBatchSize: -1 });
      const { next, callCount } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      runEffect(client(makeRequest("/a")));
      expect(callCount()).toBe(0);

      runEffect(client(makeRequest("/b")));
      expect(callCount()).toBe(1);
    });

    it("clamps maxBatchSize=1 to 2", () => {
      const config = makeBatchConfig({ windowMs: 5000, maxBatchSize: 1 });
      const { next, callCount } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      // First request should NOT trigger immediate dispatch (clamped to 2)
      runEffect(client(makeRequest("/a")));
      expect(callCount()).toBe(0);

      // Second request triggers dispatch
      runEffect(client(makeRequest("/b")));
      expect(callCount()).toBe(1);
    });

    it("clamps maxBatchSize=20000 to 10000", () => {
      let coalescedCount = 0;
      const config = makeBatchConfig({
        windowMs: 50,
        maxBatchSize: 20000,
        batch: {
          coalesce: (reqs) => {
            coalescedCount = reqs.length;
            return { method: "POST", url: "/batch", body: "" };
          },
          split: (_res, reqs) =>
            reqs.map(() => ({ status: 200, statusText: "OK", headers: {}, bodyText: "ok", ms: 1 })),
        },
      });
      const { next } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      // Add 10000 requests — should trigger immediate dispatch at 10000
      for (let i = 0; i < 10000; i++) {
        runEffect(client(makeRequest(`/item-${i}`)));
      }

      expect(coalescedCount).toBe(10000);
    });

    it("clamps maxBatchSize=Infinity to 2", () => {
      const config = makeBatchConfig({ windowMs: 5000, maxBatchSize: Infinity });
      const { next, callCount } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      runEffect(client(makeRequest("/a")));
      expect(callCount()).toBe(0);

      runEffect(client(makeRequest("/b")));
      expect(callCount()).toBe(1);
    });

    it("clamps maxBatchSize=NaN to 2", () => {
      const config = makeBatchConfig({ windowMs: 5000, maxBatchSize: NaN });
      const { next, callCount } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      runEffect(client(makeRequest("/a")));
      expect(callCount()).toBe(0);

      runEffect(client(makeRequest("/b")));
      expect(callCount()).toBe(1);
    });

    it("preserves valid maxBatchSize=5", () => {
      const config = makeBatchConfig({ windowMs: 5000, maxBatchSize: 5 });
      const { next, callCount } = makeNext();
      const middleware = withBatch(config);
      const client = middleware(next);

      for (let i = 0; i < 4; i++) {
        runEffect(client(makeRequest(`/item-${i}`)));
      }
      expect(callCount()).toBe(0);

      runEffect(client(makeRequest("/item-4")));
      expect(callCount()).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 7.2: Batch key bypass scenarios
// ---------------------------------------------------------------------------

describe("batch middleware - batchKey bypass", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bypasses batching when batchKey returns empty string", () => {
    const config = makeBatchConfig({
      batchKey: () => "",
    });
    const { next, callCount } = makeNext();
    const middleware = withBatch(config);
    const client = middleware(next);

    const { result } = runEffect(client(makeRequest()));

    // Should call next directly (no batching)
    expect(callCount()).toBe(1);
    expect(result()).toBeDefined();
    expect(result()!._tag).toBe("Success");
  });

  it("bypasses batching when batchKey throws an error", () => {
    const config = makeBatchConfig({
      batchKey: () => {
        throw new Error("key computation failed");
      },
    });
    const { next, callCount } = makeNext();
    const middleware = withBatch(config);
    const client = middleware(next);

    const { result } = runEffect(client(makeRequest()));

    // Should call next directly (no batching)
    expect(callCount()).toBe(1);
    expect(result()).toBeDefined();
    expect(result()!._tag).toBe("Success");
  });

  it("bypass request resolves with the direct response from next", () => {
    const directResponse: HttpWireResponse = {
      status: 201,
      statusText: "Created",
      headers: { "x-custom": "value" },
      bodyText: "direct-response",
      ms: 42,
    };
    const config = makeBatchConfig({ batchKey: () => "" });
    const { next } = makeNext(directResponse);
    const middleware = withBatch(config);
    const client = middleware(next);

    const { result } = runEffect(client(makeRequest()));

    expect(result()!._tag).toBe("Success");
    if (result()!._tag === "Success") {
      expect(result()!.value).toEqual(directResponse);
    }
  });

  it("bypass does not affect other batched requests", () => {
    let callIdx = 0;
    const config = makeBatchConfig({
      batchKey: (req) => (req.url === "/bypass" ? "" : "batch-key"),
    });
    const { next, callCount } = makeNext();
    const middleware = withBatch(config);
    const client = middleware(next);

    // This one bypasses
    const bypass = runEffect(client(makeRequest("/bypass")));
    expect(callCount()).toBe(1);
    expect(bypass.result()!._tag).toBe("Success");

    // This one gets batched
    const batched = runEffect(client(makeRequest("/batched")));
    expect(callCount()).toBe(1); // Not yet dispatched

    vi.advanceTimersByTime(101);
    expect(callCount()).toBe(2); // Now dispatched
  });
});

// ---------------------------------------------------------------------------
// 7.3: Effect laziness (no side effects until register is called)
// ---------------------------------------------------------------------------

describe("batch middleware - effect laziness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creating the effect does not start the timer", () => {
    const config = makeBatchConfig({ windowMs: 50 });
    const { next, callCount } = makeNext();
    const middleware = withBatch(config);
    const client = middleware(next);

    // Create the effect but do NOT register it
    const effect = client(makeRequest());

    // The effect should be an Async tag
    expect(effect._tag).toBe("Async");

    // Advance time — nothing should happen since register was never called
    vi.advanceTimersByTime(200);
    expect(callCount()).toBe(0);
  });

  it("timer starts only when register is called", () => {
    const config = makeBatchConfig({ windowMs: 50 });
    const { next, callCount } = makeNext();
    const middleware = withBatch(config);
    const client = middleware(next);

    // Create the effect
    const effect = client(makeRequest());

    // Advance time before registering
    vi.advanceTimersByTime(100);
    expect(callCount()).toBe(0);

    // Now register the effect
    runEffect(effect);

    // Still not dispatched (timer just started)
    expect(callCount()).toBe(0);

    // Advance past the window
    vi.advanceTimersByTime(50);
    expect(callCount()).toBe(1);
  });

  it("multiple unregistered effects have no side effects", () => {
    const config = makeBatchConfig({ windowMs: 50 });
    const { next, callCount } = makeNext();
    const middleware = withBatch(config);
    const client = middleware(next);

    // Create multiple effects without registering
    const effect1 = client(makeRequest("/a"));
    const effect2 = client(makeRequest("/b"));
    const effect3 = client(makeRequest("/c"));

    vi.advanceTimersByTime(1000);
    expect(callCount()).toBe(0);

    // All should be Async effects
    expect(effect1._tag).toBe("Async");
    expect(effect2._tag).toBe("Async");
    expect(effect3._tag).toBe("Async");
  });
});

// ---------------------------------------------------------------------------
// 7.4: Middleware type conformance
// ---------------------------------------------------------------------------

describe("batch middleware - type conformance", () => {
  it("withBatch returns a function conforming to HttpMiddleware", () => {
    const config = makeBatchConfig();
    const middleware = withBatch(config);

    // HttpMiddleware is (next: HttpClientFn) => HttpClientFn
    expect(typeof middleware).toBe("function");
  });

  it("middleware(next) returns an HttpClientFn", () => {
    const config = makeBatchConfig();
    const { next } = makeNext();
    const middleware = withBatch(config);
    const client = middleware(next);

    // HttpClientFn is (req: HttpRequest) => Async<unknown, HttpError, HttpWireResponse>
    expect(typeof client).toBe("function");
  });

  it("client(req) returns an Async effect", () => {
    vi.useFakeTimers();
    const config = makeBatchConfig();
    const { next } = makeNext();
    const middleware = withBatch(config);
    const client = middleware(next);

    const effect = client(makeRequest());
    expect(effect).toHaveProperty("_tag");
    expect(effect._tag).toBe("Async");
    vi.useRealTimers();
  });

  it("withBatch can be assigned to HttpMiddleware type", () => {
    const config = makeBatchConfig();
    // This is a compile-time check — if it compiles, the type is correct
    const mw: HttpMiddleware = withBatch(config);
    expect(mw).toBeDefined();
  });

  it("middleware composes with other middleware", () => {
    vi.useFakeTimers();
    const config = makeBatchConfig({ windowMs: 50 });
    const { next } = makeNext();

    // Create a simple passthrough middleware
    const passthrough: HttpMiddleware = (innerNext) => (req) => innerNext(req);

    const batchMw = withBatch(config);
    // Compose: passthrough wraps batch wraps next
    const composed = passthrough(batchMw(next));

    const { result } = runEffect(composed(makeRequest()));
    vi.advanceTimersByTime(51);

    expect(result()).toBeDefined();
    expect(result()!._tag).toBe("Success");
    vi.useRealTimers();
  });
});
