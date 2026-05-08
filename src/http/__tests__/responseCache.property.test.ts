import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { withCache } from "../lifecycle/responseCache";
import { SAFE_METHODS } from "../lifecycle/dedupKey";
import type { HttpClientFn, HttpMethod, HttpRequest, HttpWireResponse } from "../client";
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";

/**
 * Property-based tests for response cache middleware.
 * Feature: http-lifecycle-client
 */
describe("responseCache property tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  /**
   * Property 12: Cache only applies to safe methods
   *
   * For any response to a non-safe HTTP method (POST, PUT, PATCH, DELETE),
   * the cache SHALL NOT store the response regardless of cache policy.
   *
   * **Validates: Requirements 3.6**
   */
  describe("Property 12: Cache only applies to safe methods", () => {
    /** Non-safe HTTP methods that should never be cached */
    const NON_SAFE_METHODS: HttpMethod[] = ["POST", "PUT", "PATCH", "DELETE"];

    /** Arbitrary for non-safe HTTP methods */
    const arbNonSafeMethod: fc.Arbitrary<HttpMethod> = fc.constantFrom(...NON_SAFE_METHODS);

    /** Arbitrary for absolute URLs */
    const arbUrl = fc.constantFrom(
      "https://api.example.com/users",
      "https://api.example.com/data",
      "https://api.example.com/items/123",
      "https://api.example.com/submit",
      "https://api.example.com/resources",
    );

    /** Arbitrary for headers */
    const arbHeaders: fc.Arbitrary<Record<string, string>> = fc
      .array(
        fc.tuple(
          fc.constantFrom("content-type", "accept", "x-request-id", "x-custom"),
          fc.stringMatching(/^[a-zA-Z0-9/\-_.+]{1,20}$/).filter((s) => s.length > 0),
        ),
        { minLength: 0, maxLength: 3 },
      )
      .map((entries) => Object.fromEntries(entries));

    /** Arbitrary for request body */
    const arbBody = fc.option(
      fc.stringMatching(/^[a-zA-Z0-9 {}[\]"':,.\-_]{1,50}$/).filter((s) => s.length > 0),
      { nil: undefined },
    );

    /** Creates a mock response */
    function mockResponse(id: number): HttpWireResponse {
      return {
        status: 200,
        statusText: "OK",
        headers: { "x-call-id": String(id) },
        bodyText: `response-${id}`,
        ms: 10,
      };
    }

    /** Creates a mock next function that tracks call count and returns unique responses */
    function createTrackingNext(): { next: HttpClientFn; callCount: () => number } {
      let count = 0;
      const next: HttpClientFn = (_req: HttpRequest): Async<unknown, never, HttpWireResponse> => {
        const id = ++count;
        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<never, HttpWireResponse>) => void) => {
            cb({ _tag: "Success", value: mockResponse(id) });
            return () => {};
          },
        } as Async<unknown, never, HttpWireResponse>;
      };
      return { next, callCount: () => count };
    }

    /** Runs an Async effect and returns the result */
    function runEffect<E, A>(effect: Async<unknown, E, A>): Promise<Exit<E, A>> {
      return new Promise((resolve) => {
        if (effect._tag === "Succeed") {
          resolve({ _tag: "Success", value: effect.value });
        } else if (effect._tag === "Fail") {
          resolve({ _tag: "Failure", cause: Cause.fail(effect.error) });
        } else if (effect._tag === "Async") {
          effect.register(undefined, (exit) => resolve(exit));
        } else {
          resolve({ _tag: "Success", value: undefined as any });
        }
      });
    }

    it("non-safe method responses are never cached — repeated requests always hit the network", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbNonSafeMethod,
          arbUrl,
          arbHeaders,
          arbBody,
          async (method, url, headers, body) => {
            const { next, callCount } = createTrackingNext();
            const { middleware } = withCache({
              ttlSeconds: 300, // long TTL to ensure caching would persist if it happened
              baseUrl: "",
            });
            const cachedClient = middleware(next);

            const request: HttpRequest = { method, url, headers, body };

            // First request
            const result1 = await runEffect(cachedClient(request));
            expect(result1._tag).toBe("Success");

            // Second identical request — should NOT be served from cache
            const result2 = await runEffect(cachedClient(request));
            expect(result2._tag).toBe("Success");

            // Both requests should have hit the network (2 calls, not 1)
            expect(callCount()).toBe(2);

            // Responses should be distinct (different call IDs prove separate network calls)
            if (result1._tag === "Success" && result2._tag === "Success") {
              expect(result1.value.headers["x-call-id"]).not.toBe(
                result2.value.headers["x-call-id"],
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("non-safe method responses are never cached even with multiple repeated requests", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbNonSafeMethod,
          arbUrl,
          fc.integer({ min: 3, max: 6 }),
          async (method, url, repeatCount) => {
            const { next, callCount } = createTrackingNext();
            const { middleware } = withCache({
              ttlSeconds: 300,
              baseUrl: "",
            });
            const cachedClient = middleware(next);

            const request: HttpRequest = { method, url };

            // Issue the same request multiple times sequentially
            for (let i = 0; i < repeatCount; i++) {
              const result = await runEffect(cachedClient(request));
              expect(result._tag).toBe("Success");
            }

            // Every request should have hit the network
            expect(callCount()).toBe(repeatCount);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("safe methods ARE cached (control test to confirm non-safe methods differ)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("GET" as HttpMethod, "HEAD" as HttpMethod, "OPTIONS" as HttpMethod),
          arbUrl,
          async (method, url) => {
            const { next, callCount } = createTrackingNext();
            const { middleware } = withCache({
              ttlSeconds: 300,
              baseUrl: "",
            });
            const cachedClient = middleware(next);

            const request: HttpRequest = { method, url };

            // First request — cache miss, hits network
            const result1 = await runEffect(cachedClient(request));
            expect(result1._tag).toBe("Success");

            // Second identical request — should be served from cache
            const result2 = await runEffect(cachedClient(request));
            expect(result2._tag).toBe("Success");

            // Only 1 network call should have been made (second was cached)
            expect(callCount()).toBe(1);

            // Both results should be the same response
            if (result1._tag === "Success" && result2._tag === "Success") {
              expect(result1.value.headers["x-call-id"]).toBe(
                result2.value.headers["x-call-id"],
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("non-safe methods bypass cache even when staleWhileRevalidate is enabled", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbNonSafeMethod,
          arbUrl,
          arbHeaders,
          async (method, url, headers) => {
            const { next, callCount } = createTrackingNext();
            const { middleware } = withCache({
              ttlSeconds: 300,
              staleWhileRevalidate: true,
              baseUrl: "",
            });
            const cachedClient = middleware(next);

            const request: HttpRequest = { method, url, headers };

            // First request
            const result1 = await runEffect(cachedClient(request));
            expect(result1._tag).toBe("Success");

            // Second identical request — should NOT be served from cache
            const result2 = await runEffect(cachedClient(request));
            expect(result2._tag).toBe("Success");

            // Both requests should have hit the network
            expect(callCount()).toBe(2);

            // Responses should be distinct
            if (result1._tag === "Success" && result2._tag === "Success") {
              expect(result1.value.headers["x-call-id"]).not.toBe(
                result2.value.headers["x-call-id"],
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("cache.invalidate and cache.clear have no effect on non-safe method behavior", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbNonSafeMethod,
          arbUrl,
          async (method, url) => {
            const { next, callCount } = createTrackingNext();
            const { middleware, invalidate, clear } = withCache({
              ttlSeconds: 300,
              baseUrl: "",
            });
            const cachedClient = middleware(next);

            const request: HttpRequest = { method, url };

            // Issue request
            const result1 = await runEffect(cachedClient(request));
            expect(result1._tag).toBe("Success");

            // Calling invalidate/clear should not throw or affect behavior
            invalidate("any-key");
            clear();

            // Issue same request again — still hits network
            const result2 = await runEffect(cachedClient(request));
            expect(result2._tag).toBe("Success");

            expect(callCount()).toBe(2);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 9: Cache expiration after TTL
   *
   * For any cache entry with TTL T, a request arriving at time t ≥ storedAt + T
   * SHALL be treated as a cache miss and forwarded to the network.
   *
   * **Validates: Requirements 3.3**
   */
  describe("Property 9: Cache expiration after TTL", () => {
    /** Arbitrary for a valid TTL in seconds [1, 86400] */
    const arbTtlSeconds = fc.integer({ min: 1, max: 86400 });

    /** Arbitrary for a safe HTTP method */
    const arbSafeMethod: fc.Arbitrary<HttpMethod> = fc.constantFrom(
      "GET" as HttpMethod,
      "HEAD" as HttpMethod,
      "OPTIONS" as HttpMethod,
    );

    /** Arbitrary for absolute URLs */
    const arbUrl = fc.constantFrom(
      "https://api.example.com/users",
      "https://api.example.com/data",
      "https://api.example.com/items/123",
      "https://api.example.com/resources",
      "https://api.example.com/config",
    );

    /** Arbitrary for response status */
    const arbStatus = fc.constantFrom(200, 201, 204, 301, 304);

    /** Arbitrary for response body text */
    const arbBodyText = fc.string({ minLength: 1, maxLength: 50 });

    /** Creates a mock response */
    function makeMockResponse(id: number, status: number, bodyText: string): HttpWireResponse {
      return {
        status,
        statusText: status === 200 ? "OK" : "Response",
        headers: { "content-type": "application/json", "x-call-id": String(id) },
        bodyText,
        ms: 10,
      };
    }

    /** Creates a tracking next function that returns unique responses per call */
    function createCountingNext(
      status: number,
      bodyText1: string,
      bodyText2: string,
    ): { next: HttpClientFn; callCount: () => number } {
      let count = 0;
      const next: HttpClientFn = (_req: HttpRequest): Async<unknown, never, HttpWireResponse> => {
        count++;
        const body = count === 1 ? bodyText1 : bodyText2;
        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<never, HttpWireResponse>) => void) => {
            cb({ _tag: "Success", value: makeMockResponse(count, status, body) });
            return () => {};
          },
        } as Async<unknown, never, HttpWireResponse>;
      };
      return { next, callCount: () => count };
    }

    /** Runs an Async effect synchronously */
    function runEffectSync(
      effect: Async<unknown, any, HttpWireResponse>,
    ): Exit<any, HttpWireResponse> {
      let result: Exit<any, HttpWireResponse> | undefined;
      if (effect._tag === "Succeed") {
        return { _tag: "Success", value: effect.value };
      }
      if (effect._tag === "Fail") {
        return { _tag: "Failure", cause: Cause.fail(effect.error) };
      }
      if (effect._tag === "Async") {
        effect.register(undefined, (exit) => {
          result = exit;
        });
      }
      return result!;
    }

    it("request at or after TTL expiration results in a cache miss and network call", () => {
      fc.assert(
        fc.property(
          arbTtlSeconds,
          arbSafeMethod,
          arbUrl,
          arbStatus,
          arbBodyText,
          arbBodyText,
          (ttlSeconds, method, url, status, bodyText1, bodyText2) => {
            vi.setSystemTime(new Date(0));

            const { next, callCount } = createCountingNext(status, bodyText1, bodyText2);
            const { middleware } = withCache({ ttlSeconds, baseUrl: "" });
            const cachedClient = middleware(next);

            const request: HttpRequest = { method, url };

            // First call: populates the cache
            const exit1 = runEffectSync(cachedClient(request));
            expect(exit1._tag).toBe("Success");
            expect(callCount()).toBe(1);

            // Advance time to exactly the TTL boundary (storedAt + TTL)
            const ttlMs = ttlSeconds * 1000;
            vi.advanceTimersByTime(ttlMs);

            // Second call: should be a cache miss since TTL has elapsed
            const exit2 = runEffectSync(cachedClient(request));
            expect(exit2._tag).toBe("Success");
            // Network call should have been made (cache miss)
            expect(callCount()).toBe(2);

            // The response should be from the second network call
            if (exit2._tag === "Success") {
              expect(exit2.value.headers["x-call-id"]).toBe("2");
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("request just before TTL expires is still a cache hit (no network call)", () => {
      fc.assert(
        fc.property(
          arbTtlSeconds.filter((t) => t >= 2), // need at least 2s to have a "just before" moment
          arbSafeMethod,
          arbUrl,
          arbStatus,
          arbBodyText,
          arbBodyText,
          (ttlSeconds, method, url, status, bodyText1, bodyText2) => {
            vi.setSystemTime(new Date(0));

            const { next, callCount } = createCountingNext(status, bodyText1, bodyText2);
            const { middleware } = withCache({ ttlSeconds, baseUrl: "" });
            const cachedClient = middleware(next);

            const request: HttpRequest = { method, url };

            // First call: populates the cache
            const exit1 = runEffectSync(cachedClient(request));
            expect(exit1._tag).toBe("Success");
            expect(callCount()).toBe(1);

            // Advance time to just before TTL expires (1ms before)
            const ttlMs = ttlSeconds * 1000;
            vi.advanceTimersByTime(ttlMs - 1);

            // Second call: should still be a cache hit
            const exit2 = runEffectSync(cachedClient(request));
            expect(exit2._tag).toBe("Success");
            // No additional network call should have been made
            expect(callCount()).toBe(1);

            // The response should be the cached one (from first call)
            if (exit1._tag === "Success" && exit2._tag === "Success") {
              expect(exit2.value.headers["x-call-id"]).toBe(
                exit1.value.headers["x-call-id"],
              );
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("request well past TTL is always a cache miss regardless of extra time elapsed", () => {
      fc.assert(
        fc.property(
          arbTtlSeconds,
          arbSafeMethod,
          arbUrl,
          arbStatus,
          arbBodyText,
          arbBodyText,
          // Extra time past TTL (1 to 10000 additional seconds)
          fc.integer({ min: 1, max: 10000 }),
          (ttlSeconds, method, url, status, bodyText1, bodyText2, extraSeconds) => {
            vi.setSystemTime(new Date(0));

            const { next, callCount } = createCountingNext(status, bodyText1, bodyText2);
            const { middleware } = withCache({ ttlSeconds, baseUrl: "" });
            const cachedClient = middleware(next);

            const request: HttpRequest = { method, url };

            // First call: populates the cache
            const exit1 = runEffectSync(cachedClient(request));
            expect(exit1._tag).toBe("Success");
            expect(callCount()).toBe(1);

            // Advance time well past TTL
            const ttlMs = ttlSeconds * 1000;
            const extraMs = extraSeconds * 1000;
            vi.advanceTimersByTime(ttlMs + extraMs);

            // Second call: should be a cache miss
            const exit2 = runEffectSync(cachedClient(request));
            expect(exit2._tag).toBe("Success");
            // Network call should have been made (cache miss)
            expect(callCount()).toBe(2);

            // The response should be from the second network call
            if (exit2._tag === "Success") {
              expect(exit2.value.headers["x-call-id"]).toBe("2");
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
