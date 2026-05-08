import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { makeLifecycleClient } from "../lifecycle/lifecycleClient";
import { computeCacheKey } from "../lifecycle/cacheKey";
import type { HttpClientFn, HttpError, HttpMiddleware, HttpRequest, HttpWireResponse } from "../client";
import type { Async } from "../../core/types/asyncEffect";
import { asyncFold, asyncSucceed } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";

/**
 * Property-based tests for middleware composition.
 * Feature: http-lifecycle-client
 */
describe("middleware property tests", () => {
  let originalFetch: typeof globalThis.fetch;
  const rt = Runtime.make({});
  const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

  /** A plain mock fetch that always returns a 200 response */
  const plainMockFetch = (async () =>
    new Response("ok", {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/plain" },
    })) as unknown as typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = plainMockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Property 17: Middleware composition order
   *
   * For any sequence of middleware [M0, M1, ..., Mn-1] applied via chained `.with()` calls,
   * the request-path execution order SHALL be Mn-1 → Mn-2 → ... → M0 → network
   * (last-applied is outermost), and the response-path order SHALL be
   * M0 → M1 → ... → Mn-1 (first-applied is innermost on response path).
   *
   * **Validates: Requirements 6.2**
   */
  describe("Property 17: Middleware composition order", () => {
    /**
     * Creates a middleware that records its index on both request and response paths.
     */
    function createTracingMiddleware(
      index: number,
      requestLog: number[],
      responseLog: number[],
    ): HttpMiddleware {
      return (next: HttpClientFn): HttpClientFn => {
        return (req) => {
          requestLog.push(index);
          return asyncFold(
            next(req),
            (error: any) => {
              responseLog.push(index);
              return { _tag: "Fail", error } as any;
            },
            (res: HttpWireResponse) => {
              responseLog.push(index);
              return asyncSucceed(res);
            },
          );
        };
      };
    }

    const arbMiddlewareCount = fc.integer({ min: 1, max: 10 });

    it("request-path order is last-applied first (outermost) for N middleware", async () => {
      await fc.assert(
        fc.asyncProperty(arbMiddlewareCount, async (n) => {
          globalThis.fetch = plainMockFetch;
          const requestLog: number[] = [];
          const responseLog: number[] = [];

          const middlewares: HttpMiddleware[] = [];
          for (let i = 0; i < n; i++) {
            middlewares.push(createTracingMiddleware(i, requestLog, responseLog));
          }

          let client = makeLifecycleClient({ baseUrl: "https://example.com" });
          for (const mw of middlewares) {
            client = client.with(mw);
          }

          await run<HttpWireResponse>(client({ method: "GET", url: "/test" }));

          const expectedRequestOrder = Array.from({ length: n }, (_, i) => n - 1 - i);
          expect(requestLog).toEqual(expectedRequestOrder);

          const expectedResponseOrder = Array.from({ length: n }, (_, i) => i);
          expect(responseLog).toEqual(expectedResponseOrder);
        }),
        { numRuns: 100 },
      );
    });

    it("response-path order is the exact reverse of request-path order", async () => {
      await fc.assert(
        fc.asyncProperty(arbMiddlewareCount, async (n) => {
          globalThis.fetch = plainMockFetch;
          const requestLog: number[] = [];
          const responseLog: number[] = [];

          const middlewares: HttpMiddleware[] = [];
          for (let i = 0; i < n; i++) {
            middlewares.push(createTracingMiddleware(i, requestLog, responseLog));
          }

          let client = makeLifecycleClient({ baseUrl: "https://example.com" });
          for (const mw of middlewares) {
            client = client.with(mw);
          }

          await run<HttpWireResponse>(client({ method: "GET", url: "/test" }));

          expect(responseLog).toEqual([...requestLog].reverse());
        }),
        { numRuns: 100 },
      );
    });

    it("each middleware sees the request exactly once on request path and once on response path", async () => {
      await fc.assert(
        fc.asyncProperty(arbMiddlewareCount, async (n) => {
          globalThis.fetch = plainMockFetch;
          const requestCounts = new Map<number, number>();
          const responseCounts = new Map<number, number>();

          const middlewares: HttpMiddleware[] = [];
          for (let i = 0; i < n; i++) {
            const idx = i;
            middlewares.push((next: HttpClientFn): HttpClientFn => {
              return (req) => {
                requestCounts.set(idx, (requestCounts.get(idx) ?? 0) + 1);
                return asyncFold(
                  next(req),
                  (error: any) => {
                    responseCounts.set(idx, (responseCounts.get(idx) ?? 0) + 1);
                    return { _tag: "Fail", error } as any;
                  },
                  (res: HttpWireResponse) => {
                    responseCounts.set(idx, (responseCounts.get(idx) ?? 0) + 1);
                    return asyncSucceed(res);
                  },
                );
              };
            });
          }

          let client = makeLifecycleClient({ baseUrl: "https://example.com" });
          for (const mw of middlewares) {
            client = client.with(mw);
          }

          await run<HttpWireResponse>(client({ method: "GET", url: "/test" }));

          for (let i = 0; i < n; i++) {
            expect(requestCounts.get(i)).toBe(1);
            expect(responseCounts.get(i)).toBe(1);
          }
        }),
        { numRuns: 100 },
      );
    });

    it("middleware composition preserves order regardless of how many are applied", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
          globalThis.fetch = plainMockFetch;
          const requestLogAll: number[] = [];
          const responseLogAll: number[] = [];

          let clientAll = makeLifecycleClient({ baseUrl: "https://example.com" });
          for (let i = 0; i < n; i++) {
            clientAll = clientAll.with(
              createTracingMiddleware(i, requestLogAll, responseLogAll),
            );
          }

          await run<HttpWireResponse>(clientAll({ method: "GET", url: "/test" }));

          for (let i = 0; i < n - 1; i++) {
            expect(requestLogAll[i]).toBeGreaterThan(requestLogAll[i + 1]!);
            expect(responseLogAll[i]).toBeLessThan(responseLogAll[i + 1]!);
          }

          expect(requestLogAll[0]).toBe(n - 1);
          expect(requestLogAll[n - 1]).toBe(0);
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 18: Middleware request modification affects cache key
   *
   * For any middleware that modifies the request (e.g., adds a header),
   * the cache key SHALL be computed from the final modified request, not the original.
   *
   * **Validates: Requirements 6.4**
   */
  describe("Property 18: Middleware request modification affects cache key", () => {
    /** Arbitrary for header names that are cache-relevant */
    const arbCacheRelevantHeader = fc.constantFrom("accept", "authorization", "content-type");

    /** Arbitrary for header values */
    const arbHeaderValue = fc
      .stringMatching(/^[a-zA-Z0-9/\-_.+= ]{1,30}$/)
      .filter((s) => s.length > 0);

    /** Arbitrary for safe HTTP methods (only safe methods are cached) */
    const arbSafeMethod = fc.constantFrom("GET" as const, "HEAD" as const, "OPTIONS" as const);

    /** Arbitrary for absolute URLs */
    const arbUrl = fc.constantFrom(
      "https://api.example.com/users",
      "https://api.example.com/data",
      "https://api.example.com/items/123",
      "https://api.example.com/resources",
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

    /** Creates a tracking next function that records the requests it receives */
    function createTrackingNext(): {
      next: HttpClientFn;
      callCount: () => number;
      receivedRequests: () => HttpRequest[];
    } {
      let count = 0;
      const requests: HttpRequest[] = [];
      const next: HttpClientFn = (req: HttpRequest): Async<unknown, never, HttpWireResponse> => {
        const id = ++count;
        requests.push(req);
        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<never, HttpWireResponse>) => void) => {
            cb({ _tag: "Success", value: mockResponse(id) });
            return () => {};
          },
        } as Async<unknown, never, HttpWireResponse>;
      };
      return { next, callCount: () => count, receivedRequests: () => requests };
    }

    /** Runs an Async effect and returns the result */
    function runEffect18<E, A>(effect: Async<unknown, E, A>): Promise<Exit<E, A>> {
      return new Promise((resolve) => {
        runAnyEffect(effect as any, resolve);
      });
    }

    /** Runs a FlatMap effect */
    function runFlatMapEffect(effect: any, resolve: (exit: Exit<any, any>) => void): void {
      const first = effect.first;
      const andThen = effect.andThen;

      const handleFirst = (exit: Exit<any, any>) => {
        if (exit._tag === "Failure") {
          resolve(exit);
          return;
        }
        try {
          const nextEff = andThen(exit.value);
          runAnyEffect(nextEff, resolve);
        } catch (e) {
          resolve({ _tag: "Failure", cause: Cause.die(e) as any });
        }
      };

      runAnyEffect(first, handleFirst);
    }

    /** Runs a Fold effect */
    function runFoldEffect(effect: any, resolve: (exit: Exit<any, any>) => void): void {
      const first = effect.first;
      const onSuccess = effect.onSuccess;
      const onFailure = effect.onFailure;

      const handleFirst = (exit: Exit<any, any>) => {
        try {
          let nextEff: any;
          if (exit._tag === "Success") {
            nextEff = onSuccess(exit.value);
          } else {
            if (exit.cause._tag === "Fail") {
              nextEff = onFailure(exit.cause.error);
            } else {
              resolve(exit);
              return;
            }
          }
          runAnyEffect(nextEff, resolve);
        } catch (e) {
          resolve({ _tag: "Failure", cause: Cause.die(e) as any });
        }
      };

      runAnyEffect(first, handleFirst);
    }

    /** Generic effect runner that dispatches based on _tag */
    function runAnyEffect(effect: any, resolve: (exit: Exit<any, any>) => void): void {
      if (effect._tag === "Succeed") {
        resolve({ _tag: "Success", value: effect.value });
      } else if (effect._tag === "Fail") {
        resolve({ _tag: "Failure", cause: Cause.fail(effect.error) });
      } else if (effect._tag === "Async") {
        effect.register(undefined, (exit: Exit<any, any>) => resolve(exit));
      } else if (effect._tag === "FlatMap") {
        runFlatMapEffect(effect, resolve);
      } else if (effect._tag === "Fold") {
        runFoldEffect(effect, resolve);
      } else if (effect._tag === "Sync") {
        try {
          resolve({ _tag: "Success", value: effect.thunk(undefined) });
        } catch (e) {
          resolve({ _tag: "Failure", cause: Cause.die(e) as any });
        }
      } else {
        resolve({ _tag: "Success", value: undefined as any });
      }
    }

    it("middleware that adds a cache-relevant header causes different cache key than without", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbSafeMethod,
          arbUrl,
          arbCacheRelevantHeader,
          arbHeaderValue,
          async (method, url, headerName, headerValue) => {
            // Create a middleware that adds a cache-relevant header
            const addHeaderMiddleware: HttpMiddleware = (next: HttpClientFn): HttpClientFn => {
              return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
                const modifiedReq: HttpRequest = {
                  ...req,
                  headers: {
                    ...(req.headers ?? {}),
                    [headerName]: headerValue,
                  },
                };
                return next(modifiedReq);
              };
            };

            const { next: trackingNext, callCount, receivedRequests } = createTrackingNext();

            // Apply middleware to the tracking next directly
            const withMiddleware = addHeaderMiddleware(trackingNext);

            const request: HttpRequest = { method, url };

            // Execute the request through middleware
            const result = await runEffect18(withMiddleware(request));
            expect(result._tag).toBe("Success");
            expect(callCount()).toBe(1);

            // The request received by the next layer should have the added header
            const receivedReq = receivedRequests()[0]!;
            expect(receivedReq.headers?.[headerName]).toBe(headerValue);

            // Compute cache key from original request vs modified request
            const originalCacheKey = computeCacheKey(request, "");
            const modifiedCacheKey = computeCacheKey(receivedReq, "");

            // The cache keys should be different because the middleware modified the request
            expect(modifiedCacheKey).not.toBe(originalCacheKey);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("cache key is computed from the final modified request when middleware modifies headers", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbSafeMethod,
          arbUrl,
          arbCacheRelevantHeader,
          arbHeaderValue,
          async (method, url, headerName, headerValue) => {
            let networkCallCount = 0;
            const mockFetchFn = vi.fn().mockImplementation((_input: any, _init: any) => {
              networkCallCount++;
              return Promise.resolve(
                new Response(`response-${networkCallCount}`, {
                  status: 200,
                  statusText: "OK",
                  headers: { "x-call-id": String(networkCallCount) },
                }),
              );
            });
            (globalThis as any).fetch = mockFetchFn;

            // Create lifecycle client with cache enabled
            const client = makeLifecycleClient({
              baseUrl: "https://api.example.com",
              cache: { ttlSeconds: 300 },
            });

            // Create a middleware that adds a cache-relevant header
            const addHeaderMiddleware: HttpMiddleware = (next: HttpClientFn): HttpClientFn => {
              return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
                const modifiedReq: HttpRequest = {
                  ...req,
                  headers: {
                    ...(req.headers ?? {}),
                    [headerName]: headerValue,
                  },
                };
                return next(modifiedReq);
              };
            };

            // Apply middleware to the lifecycle client
            const clientWithMiddleware = client.with(addHeaderMiddleware);

            const request: HttpRequest = { method, url };

            // First request through middleware — should hit network
            const result1 = await runEffect18(clientWithMiddleware(request));
            expect(result1._tag).toBe("Success");

            // Second identical request through middleware — should be cached
            // because the middleware produces the same modified request
            const result2 = await runEffect18(clientWithMiddleware(request));
            expect(result2._tag).toBe("Success");

            // Only 1 network call should have been made (second was cached)
            // The cache key was computed from the modified request (with the added header)
            expect(mockFetchFn).toHaveBeenCalledTimes(1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("different middleware header values produce different cache keys (cache misses)", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbSafeMethod,
          arbUrl,
          arbCacheRelevantHeader,
          arbHeaderValue,
          arbHeaderValue.filter((v) => v.length > 0),
          async (method, url, headerName, headerValue1, headerValue2) => {
            // Skip if values are the same
            fc.pre(headerValue1 !== headerValue2);

            let networkCallCount = 0;
            const mockFetchFn = vi.fn().mockImplementation((_input: any, _init: any) => {
              networkCallCount++;
              return Promise.resolve(
                new Response(`response-${networkCallCount}`, {
                  status: 200,
                  statusText: "OK",
                  headers: { "x-call-id": String(networkCallCount) },
                }),
              );
            });
            (globalThis as any).fetch = mockFetchFn;

            // Create lifecycle client with cache enabled
            const client = makeLifecycleClient({
              baseUrl: "https://api.example.com",
              cache: { ttlSeconds: 300 },
            });

            // Two different middleware that add different values for the same header
            const addHeader1: HttpMiddleware = (next: HttpClientFn): HttpClientFn => {
              return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
                const modifiedReq: HttpRequest = {
                  ...req,
                  headers: { ...(req.headers ?? {}), [headerName]: headerValue1 },
                };
                return next(modifiedReq);
              };
            };

            const addHeader2: HttpMiddleware = (next: HttpClientFn): HttpClientFn => {
              return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
                const modifiedReq: HttpRequest = {
                  ...req,
                  headers: { ...(req.headers ?? {}), [headerName]: headerValue2 },
                };
                return next(modifiedReq);
              };
            };

            const clientWithMw1 = client.with(addHeader1);
            const clientWithMw2 = client.with(addHeader2);

            const request: HttpRequest = { method, url };

            // Request through middleware 1
            const result1 = await runEffect18(clientWithMw1(request));
            expect(result1._tag).toBe("Success");

            // Request through middleware 2 with different header value
            // Should be a cache miss because the modified request is different
            const result2 = await runEffect18(clientWithMw2(request));
            expect(result2._tag).toBe("Success");

            // Both should have hit the network (different cache keys)
            expect(mockFetchFn).toHaveBeenCalledTimes(2);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("middleware that modifies non-cache-relevant headers does not affect cache key", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbSafeMethod,
          arbUrl,
          // Non-cache-relevant headers (not in accept, authorization, content-type)
          fc.constantFrom("x-request-id", "x-trace-id", "x-custom-header", "user-agent"),
          arbHeaderValue,
          arbHeaderValue,
          async (method, url, headerName, headerValue1, headerValue2) => {
            // Skip if values are the same
            fc.pre(headerValue1 !== headerValue2);

            let networkCallCount = 0;
            const mockFetchFn = vi.fn().mockImplementation((_input: any, _init: any) => {
              networkCallCount++;
              return Promise.resolve(
                new Response(`response-${networkCallCount}`, {
                  status: 200,
                  statusText: "OK",
                  headers: { "x-call-id": String(networkCallCount) },
                }),
              );
            });
            (globalThis as any).fetch = mockFetchFn;

            // Create lifecycle client with cache enabled
            const client = makeLifecycleClient({
              baseUrl: "https://api.example.com",
              cache: { ttlSeconds: 300 },
            });

            // Two different middleware that add different values for a non-relevant header
            const addHeader1: HttpMiddleware = (next: HttpClientFn): HttpClientFn => {
              return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
                const modifiedReq: HttpRequest = {
                  ...req,
                  headers: { ...(req.headers ?? {}), [headerName]: headerValue1 },
                };
                return next(modifiedReq);
              };
            };

            const addHeader2: HttpMiddleware = (next: HttpClientFn): HttpClientFn => {
              return (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
                const modifiedReq: HttpRequest = {
                  ...req,
                  headers: { ...(req.headers ?? {}), [headerName]: headerValue2 },
                };
                return next(modifiedReq);
              };
            };

            const clientWithMw1 = client.with(addHeader1);
            const clientWithMw2 = client.with(addHeader2);

            const request: HttpRequest = { method, url };

            // Request through middleware 1
            const result1 = await runEffect18(clientWithMw1(request));
            expect(result1._tag).toBe("Success");

            // Request through middleware 2 with different non-relevant header value
            // Should be a cache HIT because non-relevant headers don't affect cache key
            const result2 = await runEffect18(clientWithMw2(request));
            expect(result2._tag).toBe("Success");

            // Only 1 network call — second was served from cache
            // because non-cache-relevant headers don't affect the cache key
            expect(mockFetchFn).toHaveBeenCalledTimes(1);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
