import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { withDedup } from "../lifecycle/dedup";
import { SAFE_METHODS } from "../lifecycle/dedupKey";
import type { HttpClientFn, HttpMethod, HttpRequest, HttpWireResponse } from "../client";
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";

/**
 * Property-based tests for request deduplication.
 * Feature: http-lifecycle-client
 */
describe("dedup property tests", () => {
  /**
   * Property 7: Dedup only applies to safe methods
   *
   * For any request with a non-safe HTTP method (POST, PUT, PATCH, DELETE),
   * the deduplicator SHALL NOT collapse it with any other request, even if
   * the computed key would match.
   *
   * **Validates: Requirements 2.7**
   */
  describe("Property 7: Dedup only applies to safe methods", () => {
    /** Non-safe HTTP methods that should never be deduplicated */
    const NON_SAFE_METHODS: HttpMethod[] = ["POST", "PUT", "PATCH", "DELETE"];

    /** Arbitrary for non-safe HTTP methods */
    const arbNonSafeMethod: fc.Arbitrary<HttpMethod> = fc.constantFrom(...NON_SAFE_METHODS);

    /** Arbitrary for absolute URLs (required by computeDedupKey's URL resolution) */
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
        body: `response-${id}`,
      };
    }

    /** Creates a mock next function that resolves synchronously and tracks call count */
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

    it("non-safe method requests are never deduplicated — each call results in a separate network call", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbNonSafeMethod,
          arbUrl,
          arbHeaders,
          arbBody,
          fc.integer({ min: 2, max: 5 }),
          async (method, url, headers, body, concurrentCount) => {
            const { next, callCount } = createTrackingNext();
            const middleware = withDedup();
            const dedupClient = middleware(next);

            const request: HttpRequest = { method, url, headers, body };

            // Issue multiple identical requests concurrently
            const effects = Array.from({ length: concurrentCount }, () =>
              dedupClient(request),
            );

            // Run all effects
            const results = await Promise.all(effects.map(runEffect));

            // Each request should have triggered a separate network call
            expect(callCount()).toBe(concurrentCount);

            // Each result should be a success with a unique response
            for (const result of results) {
              expect(result._tag).toBe("Success");
            }

            // Verify responses are distinct (different call IDs)
            const callIds = results.map((r) =>
              r._tag === "Success" ? r.value.headers["x-call-id"] : null,
            );
            const uniqueIds = new Set(callIds);
            expect(uniqueIds.size).toBe(concurrentCount);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("non-safe methods pass through even when a safe-method request with the same key is in-flight", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbNonSafeMethod,
          arbUrl,
          arbHeaders,
          arbBody,
          async (method, url, headers, body) => {
            let networkCallCount = 0;
            const pendingCallbacks: Array<(exit: Exit<never, HttpWireResponse>) => void> = [];

            // A next function that holds requests pending until we resolve them
            const next: HttpClientFn = (_req: HttpRequest): Async<unknown, never, HttpWireResponse> => {
              networkCallCount++;
              return {
                _tag: "Async",
                register: (_env: unknown, cb: (exit: Exit<never, HttpWireResponse>) => void) => {
                  pendingCallbacks.push(cb);
                  return () => {};
                },
              } as Async<unknown, never, HttpWireResponse>;
            };

            const middleware = withDedup();
            const dedupClient = middleware(next);

            // First, issue a GET request (safe method) that will be held in-flight
            const safeRequest: HttpRequest = { method: "GET", url, headers, body };
            const safeEffect = dedupClient(safeRequest);
            const safePromise = runEffect(safeEffect);

            // Now issue a non-safe method request with the same URL/headers/body
            const nonSafeRequest: HttpRequest = { method, url, headers, body };
            const nonSafeEffect = dedupClient(nonSafeRequest);
            const nonSafePromise = runEffect(nonSafeEffect);

            // The non-safe request should have triggered its own network call
            // (1 for the GET + 1 for the non-safe method)
            expect(networkCallCount).toBe(2);

            // Resolve both pending callbacks
            for (let i = 0; i < pendingCallbacks.length; i++) {
              pendingCallbacks[i]({ _tag: "Success", value: mockResponse(i + 1) });
            }

            const [safeResult, nonSafeResult] = await Promise.all([safePromise, nonSafePromise]);

            expect(safeResult._tag).toBe("Success");
            expect(nonSafeResult._tag).toBe("Success");
          },
        ),
        { numRuns: 100 },
      );
    });

    it("safe methods ARE deduplicated (control test to confirm non-safe methods differ)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("GET" as HttpMethod, "HEAD" as HttpMethod, "OPTIONS" as HttpMethod),
          arbUrl,
          fc.integer({ min: 2, max: 5 }),
          async (method, url, concurrentCount) => {
            let networkCallCount = 0;
            const pendingCallbacks: Array<(exit: Exit<never, HttpWireResponse>) => void> = [];

            const next: HttpClientFn = (_req: HttpRequest): Async<unknown, never, HttpWireResponse> => {
              networkCallCount++;
              return {
                _tag: "Async",
                register: (_env: unknown, cb: (exit: Exit<never, HttpWireResponse>) => void) => {
                  pendingCallbacks.push(cb);
                  return () => {};
                },
              } as Async<unknown, never, HttpWireResponse>;
            };

            const middleware = withDedup();
            const dedupClient = middleware(next);

            const request: HttpRequest = { method, url };

            // Issue multiple identical safe-method requests
            const effects = Array.from({ length: concurrentCount }, () =>
              dedupClient(request),
            );

            // Start all effects (they will be pending)
            const promises = effects.map(runEffect);

            // Safe methods should be deduplicated — only 1 network call
            expect(networkCallCount).toBe(1);

            // Resolve the single pending callback
            pendingCallbacks[0]({ _tag: "Success", value: mockResponse(1) });

            const results = await Promise.all(promises);

            // All callers should receive the same response
            for (const result of results) {
              expect(result._tag).toBe("Success");
              if (result._tag === "Success") {
                expect(result.value.headers["x-call-id"]).toBe("1");
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("case-insensitive method matching: non-safe methods in any case are never deduplicated", async () => {
      // The dedup middleware uppercases the method before checking SAFE_METHODS
      const arbMixedCaseNonSafe = fc.constantFrom(
        "post", "Post", "POST",
        "put", "Put", "PUT",
        "patch", "Patch", "PATCH",
        "delete", "Delete", "DELETE",
      ) as fc.Arbitrary<HttpMethod>;

      await fc.assert(
        fc.asyncProperty(
          arbMixedCaseNonSafe,
          arbUrl,
          async (method, url) => {
            const { next, callCount } = createTrackingNext();
            const middleware = withDedup();
            const dedupClient = middleware(next);

            const request: HttpRequest = { method, url };

            // Issue two identical requests
            const effect1 = dedupClient(request);
            const effect2 = dedupClient(request);

            await Promise.all([runEffect(effect1), runEffect(effect2)]);

            // Both should have triggered separate network calls
            expect(callCount()).toBe(2);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
