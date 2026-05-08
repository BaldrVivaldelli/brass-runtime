import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { makeLifecycleClient } from "../lifecycle/lifecycleClient";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse, HttpMiddleware } from "../client";
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";
import type { LifecycleClient } from "../lifecycle/types";

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

const makeResponse = (body: string = "ok", status: number = 200): HttpWireResponse => ({
  status,
  statusText: "OK",
  headers: { "content-type": "text/plain" },
  bodyText: body,
  ms: 10,
});

describe("makeLifecycleClient", () => {
  describe("construction and globals validation", () => {
    it("throws if global fetch is missing", () => {
      const originalFetch = globalThis.fetch;
      try {
        // @ts-expect-error - intentionally removing fetch for testing
        delete globalThis.fetch;
        expect(() => makeLifecycleClient({})).toThrow(/global `fetch` is not available/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws if global AbortController is missing", () => {
      const originalAbortController = globalThis.AbortController;
      try {
        // @ts-expect-error - intentionally removing AbortController for testing
        delete globalThis.AbortController;
        expect(() => makeLifecycleClient({})).toThrow(/global `AbortController` is not available/);
      } finally {
        globalThis.AbortController = originalAbortController;
      }
    });

    it("creates a client successfully when globals are available", () => {
      const client = makeLifecycleClient({});
      expect(client).toBeDefined();
      expect(typeof client).toBe("function");
      expect(typeof client.with).toBe("function");
      expect(typeof client.stats).toBe("function");
      expect(typeof client.cancelAll).toBe("function");
      expect(typeof client.cache.invalidate).toBe("function");
      expect(typeof client.cache.clear).toBe("function");
    });
  });

  describe("zero-cost path (no layers)", () => {
    it("delegates directly to wire client when no layers configured", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("hello", { status: 200, statusText: "OK" })
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const client = makeLifecycleClient({ baseUrl: "https://example.com" });
        const result = await run<HttpWireResponse>(
          client({ method: "GET", url: "/test" })
        );

        expect(result.status).toBe(200);
        expect(result.bodyText).toBe("hello");
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("passes baseUrl and headers through to wire client", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("ok", { status: 200, statusText: "OK" })
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const client = makeLifecycleClient({
          baseUrl: "https://api.example.com",
          headers: { "x-custom": "value" },
        });

        await run<HttpWireResponse>(client({ method: "GET", url: "/path" }));

        // Verify the fetch was called with the resolved URL and default headers
        const [url, init] = mockFetch.mock.calls[0];
        expect(url.toString()).toBe("https://api.example.com/path");
        expect(init.headers["x-custom"]).toBe("value");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("passes timeoutMs through to wire client (request times out)", async () => {
      const mockFetch = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(new Response("late")), 5000))
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const client = makeLifecycleClient({
          baseUrl: "https://example.com",
          timeoutMs: 50,
        });

        await expect(
          run<HttpWireResponse>(client({ method: "GET", url: "/slow" }))
        ).rejects.toMatchObject({ _tag: "Timeout" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("passes pool config through to wire client", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("ok", { status: 200, statusText: "OK" })
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        // Pool with concurrency limit of 2
        const client = makeLifecycleClient({
          baseUrl: "https://example.com",
          pool: { concurrency: 2 },
        });

        const result = await run<HttpWireResponse>(
          client({ method: "GET", url: "/test" })
        );
        expect(result.status).toBe(200);

        // Verify pool stats are exposed through wire stats
        const stats = client.stats();
        expect(stats.wire.pool).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("passes pool: false to disable pool in wire client", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("ok", { status: 200, statusText: "OK" })
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const client = makeLifecycleClient({
          baseUrl: "https://example.com",
          pool: false,
        });

        const result = await run<HttpWireResponse>(
          client({ method: "GET", url: "/test" })
        );
        expect(result.status).toBe(200);

        // No pool stats when pool is disabled
        const stats = client.stats();
        expect(stats.wire.pool).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("layer enabling/disabling", () => {
    it("enables dedup layer when dedup config is provided", () => {
      const client = makeLifecycleClient({ dedup: {} });
      expect(client).toBeDefined();
    });

    it("enables cache layer when cache config is provided", () => {
      const client = makeLifecycleClient({ cache: {} });
      expect(client).toBeDefined();
    });

    it("enables priority layer when priority config is provided", () => {
      const client = makeLifecycleClient({ priority: {} });
      expect(client).toBeDefined();
    });

    it("enables all layers when all configs provided", () => {
      const client = makeLifecycleClient({
        dedup: {},
        cache: { ttlSeconds: 30 },
        priority: { queueTimeoutMs: 5000 },
      });
      expect(client).toBeDefined();
    });

    it("disables layers when set to false", () => {
      const client = makeLifecycleClient({
        dedup: false,
        cache: false,
        priority: false,
      });
      expect(client).toBeDefined();
    });
  });

  describe(".with() middleware", () => {
    it("returns a new LifecycleClient with middleware applied", () => {
      const client = makeLifecycleClient({});
      const mw = (next: HttpClientFn): HttpClientFn => next;
      const wrapped = client.with(mw);

      expect(wrapped).not.toBe(client);
      expect(typeof wrapped).toBe("function");
      expect(typeof wrapped.with).toBe("function");
      expect(typeof wrapped.stats).toBe("function");
      expect(typeof wrapped.cancelAll).toBe("function");
      expect(typeof wrapped.cache.invalidate).toBe("function");
      expect(typeof wrapped.cache.clear).toBe("function");
    });

    it("preserves cache layer configuration after .with()", () => {
      const client = makeLifecycleClient({ cache: { ttlSeconds: 30 } });
      const mw = (next: HttpClientFn): HttpClientFn => next;
      const wrapped = client.with(mw);

      // cache methods should still be available and functional
      expect(() => wrapped.cache.invalidate("test-key")).not.toThrow();
      expect(() => wrapped.cache.clear()).not.toThrow();
    });

    it("preserves cancelAll after .with()", async () => {
      const client = makeLifecycleClient({ dedup: {} });
      const mw = (next: HttpClientFn): HttpClientFn => next;
      const wrapped = client.with(mw);

      // cancelAll should still be available and resolve
      const result = await run<void>(wrapped.cancelAll());
      expect(result).toBeUndefined();
    });

    it("preserves stats after .with()", () => {
      const client = makeLifecycleClient({ priority: {} });
      const mw = (next: HttpClientFn): HttpClientFn => next;
      const wrapped = client.with(mw);

      const stats = wrapped.stats();
      expect(stats.queueDepth).toBe(0);
      expect(stats.wire).toBeDefined();
    });

    it("preserves dedup behavior after .with()", async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return new Response("deduped", { status: 200, statusText: "OK" });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const mw: HttpMiddleware = (next) => (req) => next(req);
        const client = makeLifecycleClient({
          baseUrl: "https://example.com",
          dedup: {},
        }).with(mw);

        const req: HttpRequest = { method: "GET", url: "/api/data" };
        const [r1, r2] = await Promise.all([
          run<HttpWireResponse>(client(req)),
          run<HttpWireResponse>(client(req)),
        ]);

        expect(r1.bodyText).toBe("deduped");
        expect(r2.bodyText).toBe("deduped");
        // Dedup still works — only one fetch call
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("applies middleware in correct order (outermost first on request path)", async () => {
      const order: string[] = [];
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("ok", { status: 200, statusText: "OK" })
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const mw1 = (next: HttpClientFn): HttpClientFn => (req) => {
          order.push("mw1-request");
          return next(req);
        };
        const mw2 = (next: HttpClientFn): HttpClientFn => (req) => {
          order.push("mw2-request");
          return next(req);
        };

        const client = makeLifecycleClient({ baseUrl: "https://example.com" }).with(mw1).with(mw2);
        await run<HttpWireResponse>(client({ method: "GET", url: "/test" }));

        // mw2 is outermost (applied last), mw1 is inner
        expect(order).toEqual(["mw2-request", "mw1-request"]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe(".stats()", () => {
    it("returns a stats snapshot with all expected fields", () => {
      const client = makeLifecycleClient({});
      const stats = client.stats();

      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(0);
      expect(stats.cacheEvictions).toBe(0);
      expect(stats.dedupHits).toBe(0);
      expect(stats.dedupActive).toBe(0);
      expect(stats.queueDepth).toBe(0);
      expect(stats.requestsStarted).toBe(0);
      expect(stats.requestsCompleted).toBe(0);
      expect(stats.requestsFailed).toBe(0);
      expect(stats.wire).toBeDefined();
    });

    it("exposes wire client stats", () => {
      const client = makeLifecycleClient({});
      const stats = client.stats();

      expect(stats.wire.inFlight).toBe(0);
      expect(stats.wire.started).toBe(0);
      expect(stats.wire.succeeded).toBe(0);
      expect(stats.wire.failed).toBe(0);
    });
  });

  describe(".cancelAll()", () => {
    it("returns an Async effect that resolves to void", async () => {
      const client = makeLifecycleClient({});
      const result = await run<void>(client.cancelAll());
      expect(result).toBeUndefined();
    });

    it("cancelAll resolves successfully with all layers enabled", async () => {
      const client = makeLifecycleClient({
        baseUrl: "https://example.com",
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: {},
      });

      // Should resolve cleanly
      const result = await run<void>(client.cancelAll());
      expect(result).toBeUndefined();
    });

    it("cancelAll resolves even when no requests are in-flight", async () => {
      const client = makeLifecycleClient({
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: {},
      });

      // Should resolve cleanly with no in-flight requests
      const result = await run<void>(client.cancelAll());
      expect(result).toBeUndefined();
    });

    it("cancelAll is available after .with() middleware", async () => {
      const client = makeLifecycleClient({
        dedup: {},
        priority: {},
      });
      const mw: HttpMiddleware = (next) => (req) => next(req);
      const wrapped = client.with(mw);

      const result = await run<void>(wrapped.cancelAll());
      expect(result).toBeUndefined();
    });
  });

  describe(".cache methods", () => {
    it("cache.invalidate does not throw when no cache layer", () => {
      const client = makeLifecycleClient({});
      expect(() => client.cache.invalidate("some-key")).not.toThrow();
    });

    it("cache.clear does not throw when no cache layer", () => {
      const client = makeLifecycleClient({});
      expect(() => client.cache.clear()).not.toThrow();
    });

    it("cache.invalidate delegates to cache layer when enabled", () => {
      const client = makeLifecycleClient({ cache: { ttlSeconds: 60 } });
      // Should not throw - delegates to the real cache layer
      expect(() => client.cache.invalidate("test-key")).not.toThrow();
    });

    it("cache.clear delegates to cache layer when enabled", () => {
      const client = makeLifecycleClient({ cache: { ttlSeconds: 60 } });
      // Should not throw - delegates to the real cache layer
      expect(() => client.cache.clear()).not.toThrow();
    });
  });

  describe("layer composition", () => {
    it("dedup layer deduplicates concurrent GET requests", async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        // Small delay to ensure both requests are in-flight
        await new Promise((r) => setTimeout(r, 10));
        return new Response("response", { status: 200, statusText: "OK" });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const client = makeLifecycleClient({
          baseUrl: "https://example.com",
          dedup: {},
        });

        const req: HttpRequest = { method: "GET", url: "/api/data" };

        // Fire two concurrent identical requests
        const [r1, r2] = await Promise.all([
          run<HttpWireResponse>(client(req)),
          run<HttpWireResponse>(client(req)),
        ]);

        // Both should get the same response
        expect(r1.bodyText).toBe("response");
        expect(r2.bodyText).toBe("response");
        // Only one fetch call should have been made
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("cache layer caches responses for subsequent requests", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("cached-response", { status: 200, statusText: "OK" })
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const client = makeLifecycleClient({
          baseUrl: "https://example.com",
          cache: { ttlSeconds: 60 },
        });

        const req: HttpRequest = { method: "GET", url: "/api/data" };

        // First request - cache miss
        const r1 = await run<HttpWireResponse>(client(req));
        expect(r1.bodyText).toBe("cached-response");
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Second request - cache hit
        const r2 = await run<HttpWireResponse>(client(req));
        expect(r2.bodyText).toBe("cached-response");
        // Should not have made another fetch call
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
