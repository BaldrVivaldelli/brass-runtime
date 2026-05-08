import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { makeLifecycleClient } from "../lifecycle/lifecycleClient";
import type { HttpRequest, HttpWireResponse } from "../client";
import type { Exit } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

/** Flush microtask queue to allow fibers to start executing */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("Lifecycle Client Integration Tests", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("full request flow through dedup → cache → priority → wire", () => {
    it("a GET request flows through all layers and returns a response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("integration-response", { status: 200, statusText: "OK" })
      );
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: { concurrency: 4 },
      });

      const req: HttpRequest = { method: "GET", url: "/users" };
      const result = await run<HttpWireResponse>(client(req));

      expect(result.status).toBe(200);
      expect(result.bodyText).toBe("integration-response");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("concurrent identical GET requests are deduplicated (single network call)", async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return new Response("shared", { status: 200, statusText: "OK" });
      });
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: { concurrency: 4 },
      });

      const req: HttpRequest = { method: "GET", url: "/users/1" };

      const [r1, r2, r3] = await Promise.all([
        run<HttpWireResponse>(client(req)),
        run<HttpWireResponse>(client(req)),
        run<HttpWireResponse>(client(req)),
      ]);

      // All callers get the same response
      expect(r1.bodyText).toBe("shared");
      expect(r2.bodyText).toBe("shared");
      expect(r3.bodyText).toBe("shared");
      // Only one network call was made (dedup collapsed them)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("second request is served from cache (no network call)", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return new Response(`response-${callCount}`, { status: 200, statusText: "OK" });
      });
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: { concurrency: 4 },
      });

      const req: HttpRequest = { method: "GET", url: "/users/1" };

      // First request — cache miss, hits network
      const r1 = await run<HttpWireResponse>(client(req));
      expect(r1.bodyText).toBe("response-1");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second request — cache hit, no network call
      const r2 = await run<HttpWireResponse>(client(req));
      expect(r2.bodyText).toBe("response-1"); // Same cached response
      expect(mockFetch).toHaveBeenCalledTimes(1); // No additional fetch
    });

    it("priority layer dispatches requests in priority order when at capacity", async () => {
      const dispatchOrder: string[] = [];
      let resolvers: Array<() => void> = [];

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        // Block until manually resolved
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
        dispatchOrder.push(url.toString());
        return new Response("ok", { status: 200, statusText: "OK" });
      });
      globalThis.fetch = mockFetch;

      // Concurrency of 1 forces queuing
      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: false,
        priority: { concurrency: 1 },
      });

      // First request occupies the single slot
      const p1 = run<HttpWireResponse>(client({ method: "GET", url: "/first" }));
      await flush();

      // Queue a low-priority and high-priority request
      const p2 = run<HttpWireResponse>(
        client({ method: "GET", url: "/low-priority", init: { priority: 8 } as any })
      );
      const p3 = run<HttpWireResponse>(
        client({ method: "GET", url: "/high-priority", init: { priority: 1 } as any })
      );
      await flush();

      // Resolve the first request to free the slot
      resolvers[0]!();
      await flush();
      await p1;

      // The high-priority request should be dispatched next
      resolvers[1]!();
      await flush();

      // Then the low-priority request
      resolvers[2]!();
      await flush();

      await Promise.all([p2, p3]);

      // Verify dispatch order: first, then high-priority, then low-priority
      expect(dispatchOrder[0]).toContain("/first");
      expect(dispatchOrder[1]).toContain("/high-priority");
      expect(dispatchOrder[2]).toContain("/low-priority");
    });

    it("POST requests bypass dedup but still go through priority", async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return new Response("post-result", { status: 201, statusText: "Created" });
      });
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: { concurrency: 4 },
      });

      const req: HttpRequest = { method: "POST", url: "/users", body: '{"name":"test"}' };

      // Two identical POST requests should NOT be deduplicated
      const [r1, r2] = await Promise.all([
        run<HttpWireResponse>(client(req)),
        run<HttpWireResponse>(client(req)),
      ]);

      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      // Both should have made separate network calls
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("cancellation propagation through all layers", () => {
    it("cancelling an effect before it completes produces an Interrupt exit", async () => {
      const mockFetch = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(new Response("late")), 5000))
      );
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: { concurrency: 4 },
      });

      const req: HttpRequest = { method: "GET", url: "/slow" };
      const effect = client(req);

      // Register the effect and capture the cancel function
      let exit: Exit<any, any> | undefined;
      let cancel: (() => void) | undefined;

      if (effect._tag === "Async") {
        cancel = effect.register({}, (e) => { exit = e; }) as (() => void) | undefined;
      }

      await flush();

      // Cancel the request
      cancel?.();

      // Should produce an Interrupt exit
      expect(exit).toBeDefined();
      expect(exit!._tag).toBe("Failure");
      if (exit!._tag === "Failure") {
        expect(exit!.cause._tag).toBe("Interrupt");
      }
    });

    it("partial cancellation of deduplicated requests preserves remaining callers", async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return new Response("shared-result", { status: 200, statusText: "OK" });
      });
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: { concurrency: 4 },
      });

      const req: HttpRequest = { method: "GET", url: "/data" };

      // Register two effects manually to control cancellation
      let exit1: Exit<any, any> | undefined;
      let exit2: Exit<any, any> | undefined;
      let cancel1: (() => void) | undefined;

      const effect1 = client(req);
      const effect2 = client(req);

      if (effect1._tag === "Async") {
        cancel1 = effect1.register({}, (e) => { exit1 = e; }) as (() => void) | undefined;
      }
      if (effect2._tag === "Async") {
        effect2.register({}, (e) => { exit2 = e; });
      }

      await flush();

      // Cancel the first caller
      cancel1?.();

      // First caller gets interrupt
      expect(exit1).toBeDefined();
      expect(exit1!._tag).toBe("Failure");
      if (exit1!._tag === "Failure") {
        expect(exit1!.cause._tag).toBe("Interrupt");
      }

      // Wait for the network call to complete
      await new Promise((r) => setTimeout(r, 100));

      // Second caller should still get the response
      expect(exit2).toBeDefined();
      expect(exit2!._tag).toBe("Success");
      if (exit2!._tag === "Success") {
        expect(exit2!.value.bodyText).toBe("shared-result");
      }

      // Only one network call was made
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("cancelling all callers of a deduplicated request results in interrupt for all", async () => {
      const mockFetch = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(new Response("never")), 5000))
      );
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: { concurrency: 4 },
      });

      const req: HttpRequest = { method: "GET", url: "/data" };

      let exit1: Exit<any, any> | undefined;
      let exit2: Exit<any, any> | undefined;
      let cancel1: (() => void) | undefined;
      let cancel2: (() => void) | undefined;

      const effect1 = client(req);
      const effect2 = client(req);

      if (effect1._tag === "Async") {
        cancel1 = effect1.register({}, (e) => { exit1 = e; }) as (() => void) | undefined;
      }
      if (effect2._tag === "Async") {
        cancel2 = effect2.register({}, (e) => { exit2 = e; }) as (() => void) | undefined;
      }

      await flush();

      // Cancel both callers — all should get interrupt
      cancel1?.();
      cancel2?.();

      await flush();

      // Both callers should receive interrupt exits
      expect(exit1).toBeDefined();
      expect(exit1!._tag).toBe("Failure");
      if (exit1!._tag === "Failure") {
        expect(exit1!.cause._tag).toBe("Interrupt");
      }

      expect(exit2).toBeDefined();
      expect(exit2!._tag).toBe("Failure");
      if (exit2!._tag === "Failure") {
        expect(exit2!.cause._tag).toBe("Interrupt");
      }
    });
  });

  describe("SWR background revalidation with failing network", () => {
    it("returns stale response and triggers background revalidation on expired entry", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return new Response(`response-${callCount}`, { status: 200, statusText: "OK" });
      });
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 1, staleWhileRevalidate: true },
        priority: { concurrency: 4 },
      });

      const req: HttpRequest = { method: "GET", url: "/data" };

      // First request — cache miss, fetches from network
      const r1 = await run<HttpWireResponse>(client(req));
      expect(r1.bodyText).toBe("response-1");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 1100));

      // Second request — stale entry returned immediately, background revalidation triggered
      const r2 = await run<HttpWireResponse>(client(req));
      expect(r2.bodyText).toBe("response-1"); // Stale response returned immediately

      // Wait for background revalidation to complete
      await new Promise((r) => setTimeout(r, 50));

      // Background revalidation should have made a second fetch
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Third request — should get the fresh response from cache
      const r3 = await run<HttpWireResponse>(client(req));
      expect(r3.bodyText).toBe("response-2"); // Fresh response from revalidation
    });

    it("retains stale entry when background revalidation fails", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("original", { status: 200, statusText: "OK" });
        }
        // Subsequent calls fail
        throw new Error("Network error");
      });
      globalThis.fetch = mockFetch;

      const onEvent = vi.fn();

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 1, staleWhileRevalidate: true, onEvent } as any,
        priority: { concurrency: 4 },
      });

      const req: HttpRequest = { method: "GET", url: "/data" };

      // First request — populates cache
      const r1 = await run<HttpWireResponse>(client(req));
      expect(r1.bodyText).toBe("original");

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 1100));

      // Second request — returns stale, triggers failing revalidation
      const r2 = await run<HttpWireResponse>(client(req));
      expect(r2.bodyText).toBe("original"); // Stale response

      // Wait for background revalidation to fail
      await new Promise((r) => setTimeout(r, 100));

      // The stale entry should still be available
      const r3 = await run<HttpWireResponse>(client(req));
      expect(r3.bodyText).toBe("original"); // Still stale (revalidation failed)
    });

    it("does not initiate duplicate SWR revalidation for the same key", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("original", { status: 200, statusText: "OK" });
        }
        // Slow revalidation
        await new Promise((r) => setTimeout(r, 200));
        return new Response("revalidated", { status: 200, statusText: "OK" });
      });
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 1, staleWhileRevalidate: true },
        priority: { concurrency: 4 },
      });

      const req: HttpRequest = { method: "GET", url: "/data" };

      // Populate cache
      await run<HttpWireResponse>(client(req));
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 1100));

      // Fire multiple requests that would all trigger revalidation
      const [r2, r3] = await Promise.all([
        run<HttpWireResponse>(client(req)),
        run<HttpWireResponse>(client(req)),
      ]);

      // Both should get the stale response
      expect(r2.bodyText).toBe("original");
      expect(r3.bodyText).toBe("original");

      // Wait for revalidation to complete
      await new Promise((r) => setTimeout(r, 300));

      // Only one revalidation request should have been made (not two)
      // Total: 1 initial + 1 revalidation = 2
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("cancelAll() aborts everything", () => {
    it("cancelAll resolves successfully", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("ok", { status: 200, statusText: "OK" })
      );
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: { concurrency: 4 },
      });

      const result = await run<void>(client.cancelAll());
      expect(result).toBeUndefined();
    });

    it("cancelAll resolves even with all layers enabled and no in-flight requests", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("ok", { status: 200, statusText: "OK" })
      );
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: { concurrency: 4, queueTimeoutMs: 5000 },
      });

      // cancelAll with no in-flight requests should resolve cleanly
      const result = await run<void>(client.cancelAll());
      expect(result).toBeUndefined();
    });

    it("cancelAll is available after applying middleware via .with()", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("ok", { status: 200, statusText: "OK" })
      );
      globalThis.fetch = mockFetch;

      const client = makeLifecycleClient({
        baseUrl: "https://api.example.com",
        dedup: {},
        cache: { ttlSeconds: 60 },
        priority: { concurrency: 4 },
      }).with((next) => (req) => next(req));

      const result = await run<void>(client.cancelAll());
      expect(result).toBeUndefined();
    });
  });
});
