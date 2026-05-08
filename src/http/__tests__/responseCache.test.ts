import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withCache } from "../lifecycle/responseCache";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";

const makeResponse = (body: string = "ok", status: number = 200): HttpWireResponse => ({
  status,
  statusText: "OK",
  headers: { "content-type": "text/plain" },
  bodyText: body,
  ms: 10,
});

/**
 * Creates a mock HttpClientFn that resolves immediately with a given response.
 */
function makeImmediateClient(response: HttpWireResponse): {
  client: HttpClientFn;
  calls: HttpRequest[];
} {
  const calls: HttpRequest[] = [];
  const client: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
    calls.push(req);
    return { _tag: "Succeed", value: response } as any;
  };
  return { client, calls };
}

/**
 * Creates a mock HttpClientFn that resolves only when manually triggered.
 */
function makeDelayedClient(): {
  client: HttpClientFn;
  calls: HttpRequest[];
  resolveAll: (res: HttpWireResponse) => void;
  rejectAll: (err: HttpError) => void;
  pending: Array<{
    resolve: (res: HttpWireResponse) => void;
    reject: (err: HttpError) => void;
  }>;
} {
  const calls: HttpRequest[] = [];
  const pending: Array<{
    resolve: (res: HttpWireResponse) => void;
    reject: (err: HttpError) => void;
  }> = [];

  const client: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => ({
    _tag: "Async",
    register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
      calls.push(req);
      const entry = {
        resolve: (res: HttpWireResponse) => cb({ _tag: "Success", value: res }),
        reject: (err: HttpError) => cb({ _tag: "Failure", cause: Cause.fail(err) }),
      };
      pending.push(entry);
      return () => {
        cb({ _tag: "Failure", cause: Cause.interrupt() });
      };
    },
  });

  return {
    client,
    calls,
    pending,
    resolveAll: (res) => {
      for (const p of pending.splice(0)) {
        p.resolve(res);
      }
    },
    rejectAll: (err) => {
      for (const p of pending.splice(0)) {
        p.reject(err);
      }
    },
  };
}

/**
 * Creates a mock HttpClientFn that fails immediately.
 */
function makeFailingClient(error: HttpError): {
  client: HttpClientFn;
  calls: HttpRequest[];
} {
  const calls: HttpRequest[] = [];
  const client: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
    calls.push(req);
    return { _tag: "Fail", error } as any;
  };
  return { client, calls };
}

/**
 * Runs an Async effect and returns the Exit.
 */
function runEffect(effect: Async<unknown, HttpError, HttpWireResponse>): Promise<Exit<HttpError, HttpWireResponse>> {
  return new Promise((resolve) => {
    if (effect._tag === "Succeed") {
      resolve({ _tag: "Success", value: (effect as any).value });
    } else if (effect._tag === "Fail") {
      resolve({ _tag: "Failure", cause: Cause.fail((effect as any).error) });
    } else if (effect._tag === "Async") {
      (effect as any).register(undefined, resolve);
    } else {
      // For other effect types, try register
      (effect as any).register?.(undefined, resolve);
    }
  });
}

describe("withCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("stale-while-revalidate (Property 11)", () => {
    it("returns stale response immediately and triggers background revalidation", async () => {
      let callCount = 0;
      const revalidationCallbacks: Array<(exit: Exit<HttpError, HttpWireResponse>) => void> = [];

      const trackingClient: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
        callCount++;

        if (callCount === 1) {
          // First call resolves immediately to populate cache
          return { _tag: "Succeed", value: makeResponse("stale-data") } as any;
        }

        // Subsequent calls are async (background revalidation)
        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            revalidationCallbacks.push(cb);
            return undefined;
          },
        };
      };

      const { middleware } = withCache({
        ttlSeconds: 1,
        staleWhileRevalidate: true,
        baseUrl: "https://example.com",
      });

      const cachedClient = middleware(trackingClient);
      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };

      // Populate cache
      const exit1 = await runEffect(cachedClient(req));
      expect(exit1._tag).toBe("Success");
      if (exit1._tag === "Success") {
        expect(exit1.value.bodyText).toBe("stale-data");
      }
      expect(callCount).toBe(1);

      // Advance past TTL to make entry stale
      vi.advanceTimersByTime(1001);

      // Request with stale entry — should return stale immediately
      const exit2 = await runEffect(cachedClient(req));
      expect(exit2._tag).toBe("Success");
      if (exit2._tag === "Success") {
        // Caller gets the stale response immediately
        expect(exit2.value.bodyText).toBe("stale-data");
      }

      // Background revalidation should have been triggered
      expect(callCount).toBe(2);
      expect(revalidationCallbacks.length).toBe(1);

      // Resolve the background revalidation with fresh data
      revalidationCallbacks[0]!({ _tag: "Success", value: makeResponse("fresh-data") });

      // Next request should get the fresh response (cache updated)
      const exit3 = await runEffect(cachedClient(req));
      expect(exit3._tag).toBe("Success");
      if (exit3._tag === "Success") {
        expect(exit3.value.bodyText).toBe("fresh-data");
      }
    });

    it("returns stale response and triggers exactly one revalidation", async () => {
      // Use a two-phase approach: first populate cache, then expire and verify SWR
      let callCount = 0;
      const responses: HttpWireResponse[] = [];
      const pendingCallbacks: Array<(exit: Exit<HttpError, HttpWireResponse>) => void> = [];

      const trackingClient: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
        callCount++;
        const currentCall = callCount;

        if (currentCall === 1) {
          // First call resolves immediately to populate cache
          return { _tag: "Succeed", value: makeResponse("original") } as any;
        }

        // Subsequent calls are async (for revalidation)
        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            pendingCallbacks.push(cb);
            return undefined;
          },
        };
      };

      const { middleware } = withCache({
        ttlSeconds: 1,
        staleWhileRevalidate: true,
        baseUrl: "https://example.com",
      });

      const cachedClient = middleware(trackingClient);
      const req: HttpRequest = { method: "GET", url: "https://example.com/data" };

      // Populate cache
      const exit1 = await runEffect(cachedClient(req));
      expect(exit1._tag).toBe("Success");
      if (exit1._tag === "Success") {
        expect(exit1.value.bodyText).toBe("original");
      }
      expect(callCount).toBe(1);

      // Advance past TTL
      vi.advanceTimersByTime(1001);

      // Request stale entry — should return stale immediately and trigger revalidation
      const exit2 = await runEffect(cachedClient(req));
      expect(exit2._tag).toBe("Success");
      if (exit2._tag === "Success") {
        // Should get the stale response immediately
        expect(exit2.value.bodyText).toBe("original");
      }

      // Background revalidation should have been triggered
      expect(callCount).toBe(2);
      expect(pendingCallbacks.length).toBe(1);

      // Resolve the revalidation
      pendingCallbacks[0]!({ _tag: "Success", value: makeResponse("refreshed") });

      // Next request should get the fresh response
      const exit3 = await runEffect(cachedClient(req));
      expect(exit3._tag).toBe("Success");
      if (exit3._tag === "Success") {
        expect(exit3.value.bodyText).toBe("refreshed");
      }
    });
  });

  describe("no duplicate SWR revalidation for same key", () => {
    it("does not initiate duplicate revalidation for the same key", async () => {
      let callCount = 0;
      const pendingCallbacks: Array<(exit: Exit<HttpError, HttpWireResponse>) => void> = [];

      const trackingClient: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
        callCount++;

        if (callCount === 1) {
          // First call resolves immediately to populate cache
          return { _tag: "Succeed", value: makeResponse("original") } as any;
        }

        // Subsequent calls are async (for revalidation)
        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            pendingCallbacks.push(cb);
            return undefined;
          },
        };
      };

      const { middleware } = withCache({
        ttlSeconds: 1,
        staleWhileRevalidate: true,
        baseUrl: "https://example.com",
      });

      const cachedClient = middleware(trackingClient);
      const req: HttpRequest = { method: "GET", url: "https://example.com/data" };

      // Populate cache
      await runEffect(cachedClient(req));
      expect(callCount).toBe(1);

      // Advance past TTL
      vi.advanceTimersByTime(1001);

      // First stale request — triggers revalidation
      await runEffect(cachedClient(req));
      expect(callCount).toBe(2);

      // Second stale request while revalidation is still in-flight
      // Should NOT trigger another revalidation
      await runEffect(cachedClient(req));
      expect(callCount).toBe(2); // Still 2, no duplicate revalidation
      expect(pendingCallbacks.length).toBe(1); // Only one pending revalidation

      // Resolve the revalidation
      pendingCallbacks[0]!({ _tag: "Success", value: makeResponse("refreshed") });
    });
  });

  describe("custom cachePolicy function", () => {
    it("uses custom cachePolicy to determine cacheability", async () => {
      const { client, calls } = makeImmediateClient(makeResponse("data", 200));

      const { middleware } = withCache({
        baseUrl: "https://example.com",
        cachePolicy: (req, res) => ({
          cacheable: res.status === 200,
          ttlSeconds: 30,
        }),
      });

      const cachedClient = middleware(client);
      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };

      // First request — cache miss
      const exit1 = await runEffect(cachedClient(req));
      expect(exit1._tag).toBe("Success");
      expect(calls.length).toBe(1);

      // Second request — cache hit (cachePolicy said cacheable)
      const exit2 = await runEffect(cachedClient(req));
      expect(exit2._tag).toBe("Success");
      expect(calls.length).toBe(1); // No new network call
    });

    it("does not cache when cachePolicy returns cacheable: false", async () => {
      const { client, calls } = makeImmediateClient(makeResponse("error", 500));

      const { middleware } = withCache({
        baseUrl: "https://example.com",
        cachePolicy: (req, res) => ({
          cacheable: res.status < 400,
        }),
      });

      const cachedClient = middleware(client);
      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };

      // First request
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(1);

      // Second request — should NOT be cached (status 500, cachePolicy says not cacheable)
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(2); // New network call
    });

    it("uses custom TTL from cachePolicy", async () => {
      const { client, calls } = makeImmediateClient(makeResponse("data"));

      const { middleware } = withCache({
        baseUrl: "https://example.com",
        ttlSeconds: 60, // default TTL
        cachePolicy: (req, res) => ({
          cacheable: true,
          ttlSeconds: 2, // override to 2 seconds
        }),
      });

      const cachedClient = middleware(client);
      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };

      // Populate cache
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(1);

      // Within custom TTL — cache hit
      vi.advanceTimersByTime(1500);
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(1);

      // Past custom TTL — cache miss
      vi.advanceTimersByTime(600);
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(2);
    });

    it("allows caching non-safe methods when cachePolicy says cacheable", async () => {
      const { client, calls } = makeImmediateClient(makeResponse("post-result"));

      const { middleware } = withCache({
        baseUrl: "https://example.com",
        cachePolicy: (req, res) => ({
          cacheable: true,
          ttlSeconds: 10,
        }),
      });

      const cachedClient = middleware(client);
      const req: HttpRequest = { method: "POST", url: "https://example.com/api", body: "{}" };

      // First request — cache miss
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(1);

      // Second request — cache hit (cachePolicy overrides safe-method restriction)
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(1);
    });
  });

  describe("cache.invalidate(key) and cache.clear()", () => {
    it("invalidate removes a specific cache entry", async () => {
      const { client, calls } = makeImmediateClient(makeResponse("data"));

      const { middleware, invalidate } = withCache({
        baseUrl: "https://example.com",
        ttlSeconds: 60,
      });

      const cachedClient = middleware(client);
      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };

      // Populate cache
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(1);

      // Verify cache hit
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(1);

      // Compute the cache key manually to invalidate
      const { computeCacheKey } = await import("../lifecycle/cacheKey");
      const key = computeCacheKey(req, "https://example.com");

      // Invalidate
      invalidate(key);

      // Should be a cache miss now
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(2);
    });

    it("clear removes all cache entries", async () => {
      const { client, calls } = makeImmediateClient(makeResponse("data"));

      const { middleware, clear } = withCache({
        baseUrl: "https://example.com",
        ttlSeconds: 60,
      });

      const cachedClient = middleware(client);
      const req1: HttpRequest = { method: "GET", url: "https://example.com/a" };
      const req2: HttpRequest = { method: "GET", url: "https://example.com/b" };

      // Populate cache with two entries
      await runEffect(cachedClient(req1));
      await runEffect(cachedClient(req2));
      expect(calls.length).toBe(2);

      // Verify both are cached
      await runEffect(cachedClient(req1));
      await runEffect(cachedClient(req2));
      expect(calls.length).toBe(2); // No new calls

      // Clear all
      clear();

      // Both should be cache misses now
      await runEffect(cachedClient(req1));
      await runEffect(cachedClient(req2));
      expect(calls.length).toBe(4);
    });

    it("invalidate and clear work with SWR enabled", async () => {
      const { client, calls } = makeImmediateClient(makeResponse("data"));

      const { middleware, invalidate, clear } = withCache({
        baseUrl: "https://example.com",
        ttlSeconds: 60,
        staleWhileRevalidate: true,
      });

      const cachedClient = middleware(client);
      const req: HttpRequest = { method: "GET", url: "https://example.com/api" };

      // Populate cache
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(1);

      // Verify cache hit
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(1);

      // Invalidate
      const { computeCacheKey } = await import("../lifecycle/cacheKey");
      const key = computeCacheKey(req, "https://example.com");
      invalidate(key);

      // Should be a cache miss now
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(2);

      // Verify cache hit again
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(2);

      // Clear all
      clear();

      // Should be a cache miss
      await runEffect(cachedClient(req));
      expect(calls.length).toBe(3);
    });
  });

  describe("revalidation failure retains stale entry and emits event", () => {
    it("retains stale entry when revalidation fails", async () => {
      let callCount = 0;
      const pendingCallbacks: Array<(exit: Exit<HttpError, HttpWireResponse>) => void> = [];

      const trackingClient: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
        callCount++;

        if (callCount === 1) {
          return { _tag: "Succeed", value: makeResponse("original") } as any;
        }

        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            pendingCallbacks.push(cb);
            return undefined;
          },
        };
      };

      const { middleware } = withCache({
        ttlSeconds: 1,
        staleWhileRevalidate: true,
        baseUrl: "https://example.com",
      });

      const cachedClient = middleware(trackingClient);
      const req: HttpRequest = { method: "GET", url: "https://example.com/data" };

      // Populate cache
      await runEffect(cachedClient(req));
      expect(callCount).toBe(1);

      // Advance past TTL
      vi.advanceTimersByTime(1001);

      // Request stale entry — triggers revalidation
      const staleExit = await runEffect(cachedClient(req));
      expect(staleExit._tag).toBe("Success");
      if (staleExit._tag === "Success") {
        expect(staleExit.value.bodyText).toBe("original");
      }
      expect(callCount).toBe(2);

      // Fail the revalidation
      const error: HttpError = { _tag: "FetchError", message: "network down" };
      pendingCallbacks[0]!({ _tag: "Failure", cause: Cause.fail(error) });

      // Advance time slightly but not past another TTL cycle
      vi.advanceTimersByTime(500);

      // The stale entry should still be available
      const afterFailExit = await runEffect(cachedClient(req));
      expect(afterFailExit._tag).toBe("Success");
      if (afterFailExit._tag === "Success") {
        expect(afterFailExit.value.bodyText).toBe("original");
      }
    });

    it("emits structured failure event on revalidation error", async () => {
      let callCount = 0;
      const pendingCallbacks: Array<(exit: Exit<HttpError, HttpWireResponse>) => void> = [];
      const events: Array<{ type: string; cacheKey: string; error?: any }> = [];

      const trackingClient: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
        callCount++;

        if (callCount === 1) {
          return { _tag: "Succeed", value: makeResponse("original") } as any;
        }

        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            pendingCallbacks.push(cb);
            return undefined;
          },
        };
      };

      const { middleware } = withCache({
        ttlSeconds: 1,
        staleWhileRevalidate: true,
        baseUrl: "https://example.com",
        onEvent: (event) => events.push(event),
      });

      const cachedClient = middleware(trackingClient);
      const req: HttpRequest = { method: "GET", url: "https://example.com/data" };

      // Populate cache
      await runEffect(cachedClient(req));

      // Advance past TTL
      vi.advanceTimersByTime(1001);

      // Trigger revalidation
      await runEffect(cachedClient(req));

      // Fail the revalidation
      const error: HttpError = { _tag: "FetchError", message: "network down" };
      pendingCallbacks[0]!({ _tag: "Failure", cause: Cause.fail(error) });

      // Should have emitted a revalidation-failure event
      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("revalidation-failure");
      expect(events[0]!.cacheKey).toBeDefined();
      expect(events[0]!.error).toEqual(error);
    });

    it("does not propagate revalidation error to the caller", async () => {
      let callCount = 0;
      const pendingCallbacks: Array<(exit: Exit<HttpError, HttpWireResponse>) => void> = [];

      const trackingClient: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
        callCount++;

        if (callCount === 1) {
          return { _tag: "Succeed", value: makeResponse("original") } as any;
        }

        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            pendingCallbacks.push(cb);
            return undefined;
          },
        };
      };

      const { middleware } = withCache({
        ttlSeconds: 1,
        staleWhileRevalidate: true,
        baseUrl: "https://example.com",
      });

      const cachedClient = middleware(trackingClient);
      const req: HttpRequest = { method: "GET", url: "https://example.com/data" };

      // Populate cache
      await runEffect(cachedClient(req));

      // Advance past TTL
      vi.advanceTimersByTime(1001);

      // Request stale — caller gets stale response immediately (not an error)
      const exit = await runEffect(cachedClient(req));
      expect(exit._tag).toBe("Success");

      // Fail the background revalidation
      const error: HttpError = { _tag: "FetchError", message: "network down" };
      pendingCallbacks[0]!({ _tag: "Failure", cause: Cause.fail(error) });

      // The caller already got a success — the error was not propagated
      // Verify by making another request (stale entry retained)
      const exit2 = await runEffect(cachedClient(req));
      expect(exit2._tag).toBe("Success");
      if (exit2._tag === "Success") {
        expect(exit2.value.bodyText).toBe("original");
      }
    });

    it("onEvent callback errors are swallowed", async () => {
      let callCount = 0;
      const pendingCallbacks: Array<(exit: Exit<HttpError, HttpWireResponse>) => void> = [];

      const trackingClient: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
        callCount++;

        if (callCount === 1) {
          return { _tag: "Succeed", value: makeResponse("original") } as any;
        }

        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            pendingCallbacks.push(cb);
            return undefined;
          },
        };
      };

      const { middleware } = withCache({
        ttlSeconds: 1,
        staleWhileRevalidate: true,
        baseUrl: "https://example.com",
        onEvent: () => {
          throw new Error("callback error");
        },
      });

      const cachedClient = middleware(trackingClient);
      const req: HttpRequest = { method: "GET", url: "https://example.com/data" };

      // Populate cache
      await runEffect(cachedClient(req));

      // Advance past TTL
      vi.advanceTimersByTime(1001);

      // Trigger revalidation
      await runEffect(cachedClient(req));

      // Fail the revalidation — onEvent will throw, but it should be swallowed
      const error: HttpError = { _tag: "FetchError", message: "network down" };
      expect(() => {
        pendingCallbacks[0]!({ _tag: "Failure", cause: Cause.fail(error) });
      }).not.toThrow();
    });
  });
});
