import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { withRetry } from "../retry/retry";
import type { RetryEvent, RetryPolicy } from "../retry/retry";
import type { HttpClientFn, HttpError, HttpMethod, HttpRequest, HttpWireResponse } from "../client";
import type { Async } from "../../core/types/asyncEffect";
import { asyncFail, asyncSucceed } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";

/**
 * Property-based tests for HTTP retry middleware.
 * Feature: http-retry-backoff
 */

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

describe("retry property tests", () => {
  /** Runs an Async effect tree (handles Succeed, Fail, Async, FlatMap, Fold, Sync) */
  function runEffect<E, A>(effect: Async<unknown, E, A>): Promise<Exit<E, A>> {
    return new Promise((resolve) => {
      runAnyEffect(effect as any, resolve);
    });
  }

  function runAnyEffect(effect: any, resolve: (exit: Exit<any, any>) => void): void {
    if (effect._tag === "Succeed") {
      resolve({ _tag: "Success", value: effect.value });
    } else if (effect._tag === "Fail") {
      resolve({ _tag: "Failure", cause: Cause.fail(effect.error) });
    } else if (effect._tag === "Async") {
      const cancel = effect.register(undefined, (exit: Exit<any, any>) => resolve(exit));
      // We don't cancel in tests — let it run
      void cancel;
    } else if (effect._tag === "FlatMap") {
      runAnyEffect(effect.first, (exit: Exit<any, any>) => {
        if (exit._tag === "Failure") {
          resolve(exit);
          return;
        }
        try {
          const nextEff = effect.andThen(exit.value);
          runAnyEffect(nextEff, resolve);
        } catch (e) {
          resolve({ _tag: "Failure", cause: Cause.die(e) as any });
        }
      });
    } else if (effect._tag === "Fold") {
      runAnyEffect(effect.first, (exit: Exit<any, any>) => {
        try {
          let nextEff: any;
          if (exit._tag === "Success") {
            nextEff = effect.onSuccess(exit.value);
          } else {
            if (exit.cause._tag === "Fail") {
              nextEff = effect.onFailure(exit.cause.error);
            } else {
              resolve(exit);
              return;
            }
          }
          runAnyEffect(nextEff, resolve);
        } catch (e) {
          resolve({ _tag: "Failure", cause: Cause.die(e) as any });
        }
      });
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

  /**
   * Property 7: Non-Retryable Errors
   *
   * For any policy configuration, verify that `Abort`, `BadUrl`, `PoolRejected`,
   * and `CircuitBreakerOpen` errors are never retried.
   *
   * **Validates: Requirements 6.4, 6.5, 8.1**
   */
  describe("Feature: http-retry-backoff, Property 7: Non-Retryable Errors", () => {
    /** Non-retryable error types with their _tag fields */
    const nonRetryableErrors: HttpError[] = [
      { _tag: "Abort" },
      { _tag: "BadUrl", message: "invalid url" },
      { _tag: "PoolRejected", key: "test-pool", limit: 10, message: "pool full" },
    ];

    /** CircuitBreakerOpen error (uses any cast since it's not in the HttpError union directly) */
    const circuitBreakerOpenError = { _tag: "CircuitBreakerOpen" } as any as HttpError;

    /** All non-retryable errors including CircuitBreakerOpen */
    const allNonRetryableErrors = [...nonRetryableErrors, circuitBreakerOpenError];

    /** Arbitrary for non-retryable error selection */
    const arbNonRetryableError: fc.Arbitrary<HttpError> = fc.constantFrom(...allNonRetryableErrors);

    /** Arbitrary for retry policy with random configurations */
    const arbRetryPolicy: fc.Arbitrary<RetryPolicy> = fc.record({
      maxRetries: fc.integer({ min: 1, max: 10 }),
      baseDelayMs: fc.integer({ min: 1, max: 5000 }),
      maxDelayMs: fc.integer({ min: 1, max: 30000 }),
      maxElapsedMs: fc.option(fc.integer({ min: 100, max: 60000 }), { nil: undefined }),
    }).map((r) => ({
      ...r,
      // Force retryOnError to always return true — even so, non-retryable errors must not be retried
      retryOnError: () => true,
      retryOnMethods: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as any,
    }));

    /** Creates a downstream client that always fails with the given error and tracks call count */
    function createFailingNext(error: HttpError): { next: HttpClientFn; callCount: () => number } {
      let count = 0;
      const next: HttpClientFn = (_req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
        count++;
        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            cb({ _tag: "Failure", cause: Cause.fail(error) });
            return () => {};
          },
        } as Async<unknown, HttpError, HttpWireResponse>;
      };
      return { next, callCount: () => count };
    }

    it("non-retryable errors are never retried regardless of policy configuration", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbRetryPolicy,
          arbNonRetryableError,
          fc.constantFrom("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS") as fc.Arbitrary<string>,
          async (policy, error, method) => {
            const { next, callCount } = createFailingNext(error);
            const middleware = withRetry(policy);
            const retryClient = middleware(next);

            const request: HttpRequest = {
              method: method as any,
              url: "https://api.example.com/test",
            };

            const result = await runEffect(retryClient(request));

            // The request should have failed (not retried)
            expect(result._tag).toBe("Failure");

            // The downstream should have been called exactly once (no retry)
            expect(callCount()).toBe(1);

            // The error should be propagated as-is
            if (result._tag === "Failure" && result.cause._tag === "Fail") {
              expect((result.cause.error as any)._tag).toBe((error as any)._tag);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("non-retryable errors propagate immediately even with custom retryOnError returning true", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbRetryPolicy,
          arbNonRetryableError,
          async (policy, error) => {
            // Explicitly set retryOnError to always return true
            const aggressivePolicy: RetryPolicy = {
              ...policy,
              retryOnError: () => true,
              maxRetries: 5,
            };

            const { next, callCount } = createFailingNext(error);
            const middleware = withRetry(aggressivePolicy);
            const retryClient = middleware(next);

            const request: HttpRequest = {
              method: "GET",
              url: "https://api.example.com/resource",
            };

            const result = await runEffect(retryClient(request));

            // Should fail immediately without retry
            expect(result._tag).toBe("Failure");
            expect(callCount()).toBe(1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("non-retryable errors are not retried regardless of maxRetries value", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          arbNonRetryableError,
          async (maxRetries, error) => {
            const policy: RetryPolicy = {
              maxRetries,
              baseDelayMs: 10,
              maxDelayMs: 100,
              retryOnError: () => true,
              retryOnMethods: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"] as any,
            };

            const { next, callCount } = createFailingNext(error);
            const middleware = withRetry(policy);
            const retryClient = middleware(next);

            const request: HttpRequest = {
              method: "GET",
              url: "https://api.example.com/data",
            };

            const result = await runEffect(retryClient(request));

            // Should fail immediately — exactly 1 call, no retries
            expect(result._tag).toBe("Failure");
            expect(callCount()).toBe(1);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 8: Priority Boost Formula
   *
   * For any priority p in [0, 9], verify retried request has priority `max(0, p - 1)`.
   *
   * **Validates: Requirements 7.1, 7.2, 7.3**
   */
  describe("Feature: http-retry-backoff, Property 8: Priority Boost Formula", () => {
    /** Arbitrary for priority values in [0, 9] */
    const arbPriority = fc.integer({ min: 0, max: 9 });

    /** Creates a mock response */
    function mockResponse(): HttpWireResponse {
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        bodyText: "ok",
        ms: 10,
      };
    }

    /**
     * Creates a downstream mock that fails on the first call with a retryable error
     * and succeeds on the second call. Captures all requests passed to next().
     */
    function createFailThenSucceedNext(): {
      next: HttpClientFn;
      capturedRequests: () => HttpRequest[];
    } {
      let callCount = 0;
      const requests: HttpRequest[] = [];

      const next: HttpClientFn = (req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
        requests.push({ ...req });
        callCount++;

        if (callCount === 1) {
          // First call fails with a retryable FetchError
          return {
            _tag: "Async",
            register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
              cb({ _tag: "Failure", cause: Cause.fail({ _tag: "FetchError", message: "connection reset" } as HttpError) });
              return () => {};
            },
          } as Async<unknown, HttpError, HttpWireResponse>;
        }

        // Subsequent calls succeed
        return {
          _tag: "Async",
          register: (_env: unknown, cb: (exit: Exit<HttpError, HttpWireResponse>) => void) => {
            cb({ _tag: "Success", value: mockResponse() });
            return () => {};
          },
        } as Async<unknown, HttpError, HttpWireResponse>;
      };

      return { next, capturedRequests: () => requests };
    }

    it("retried request has priority max(0, p - 1) for any original priority p in [0, 9]", async () => {
      await fc.assert(
        fc.asyncProperty(arbPriority, async (priority) => {
          const policy: RetryPolicy = {
            maxRetries: 3,
            baseDelayMs: 0, // No delay for fast tests
            maxDelayMs: 0,
            retryOnMethods: ["GET"],
          };

          const { next, capturedRequests } = createFailThenSucceedNext();
          const middleware = withRetry(policy);
          const client = middleware(next);

          const request: HttpRequest = {
            method: "GET",
            url: "https://api.example.com/test",
          };
          (request as any).priority = priority;

          const result = await runEffect(client(request));
          expect(result._tag).toBe("Success");

          const requests = capturedRequests();
          // Should have 2 calls: initial attempt + 1 retry
          expect(requests.length).toBe(2);

          // First request should have the original priority
          expect((requests[0] as any).priority).toBe(priority);

          // Retried request should have boosted priority: max(0, p - 1)
          const expectedBoostedPriority = Math.max(0, priority - 1);
          expect((requests[1] as any).priority).toBe(expectedBoostedPriority);
        }),
        { numRuns: 100 },
      );
    });

    it("priority 0 remains at 0 after boost (cannot go below minimum)", async () => {
      await fc.assert(
        fc.asyncProperty(fc.constant(0), async (priority) => {
          const policy: RetryPolicy = {
            maxRetries: 3,
            baseDelayMs: 0,
            maxDelayMs: 0,
            retryOnMethods: ["GET"],
          };

          const { next, capturedRequests } = createFailThenSucceedNext();
          const middleware = withRetry(policy);
          const client = middleware(next);

          const request: HttpRequest = {
            method: "GET",
            url: "https://api.example.com/test",
          };
          (request as any).priority = priority;

          const result = await runEffect(client(request));
          expect(result._tag).toBe("Success");

          const requests = capturedRequests();
          expect(requests.length).toBe(2);

          // Priority 0 should stay at 0 (max(0, 0 - 1) = 0)
          expect((requests[1] as any).priority).toBe(0);
        }),
        { numRuns: 100 },
      );
    });

    it("boosted priority is always non-negative for any priority in [0, 9]", async () => {
      await fc.assert(
        fc.asyncProperty(arbPriority, async (priority) => {
          const policy: RetryPolicy = {
            maxRetries: 3,
            baseDelayMs: 0,
            maxDelayMs: 0,
            retryOnMethods: ["GET"],
          };

          const { next, capturedRequests } = createFailThenSucceedNext();
          const middleware = withRetry(policy);
          const client = middleware(next);

          const request: HttpRequest = {
            method: "GET",
            url: "https://api.example.com/test",
          };
          (request as any).priority = priority;

          const result = await runEffect(client(request));
          expect(result._tag).toBe("Success");

          const requests = capturedRequests();
          expect(requests.length).toBe(2);

          // Boosted priority must always be >= 0
          const boostedPriority = (requests[1] as any).priority;
          expect(boostedPriority).toBeGreaterThanOrEqual(0);
          expect(boostedPriority).toBe(Math.max(0, priority - 1));
        }),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 10: Per-Request Override Merge
   *
   * For any base RetryPolicy and any partial per-request override object,
   * the effective policy SHALL use the per-request value for each field that
   * is defined in the override, and the base policy value for all other fields.
   *
   * We test this through observable behavior:
   * - maxRetries: count how many times downstream is called
   * - retryOnStatus: observe whether a given status triggers retries
   *
   * **Validates: Requirements 9.2, 9.3, 9.4**
   */
  describe("Feature: http-retry-backoff, Property 10: Per-Request Override Merge", () => {
    /** Arbitrary for a valid base RetryPolicy */
    const arbBasePolicy = fc.record({
      maxRetries: fc.integer({ min: 1, max: 5 }),
      baseDelayMs: fc.integer({ min: 0, max: 50 }),
      maxDelayMs: fc.integer({ min: 0, max: 50 }),
    });

    it("maxRetries override controls the number of retry attempts instead of base policy", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBasePolicy,
          fc.integer({ min: 1, max: 5 }),
          async (basePolicy, overrideMaxRetries) => {
            // Ensure override differs from base to make the test meaningful
            fc.pre(overrideMaxRetries !== basePolicy.maxRetries);

            let callCount = 0;
            const alwaysFail: HttpClientFn = () => {
              callCount++;
              return asyncSucceed({
                status: 503,
                statusText: "Unavailable",
                headers: {},
                bodyText: "fail",
                ms: 1,
              });
            };

            const policy: RetryPolicy = {
              ...basePolicy,
              baseDelayMs: 0,
              maxDelayMs: 0,
            };

            const middleware = withRetry(policy)(alwaysFail);

            const req: any = {
              method: "GET" as const,
              url: "/test",
              retry: { maxRetries: overrideMaxRetries },
            };

            callCount = 0;
            await run<HttpWireResponse>(middleware(req));

            // The effective maxRetries should be the override value.
            // Total calls = 1 (initial) + overrideMaxRetries (retries)
            expect(callCount).toBe(overrideMaxRetries + 1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("retryOnStatus override controls which statuses trigger retries", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBasePolicy,
          fc.constantFrom(400, 401, 403, 404, 418),
          async (basePolicy, statusCode) => {
            // Base policy uses default retryOnStatus which does NOT retry 4xx (except 408, 429)
            // Override makes it retry the given status code
            let callCount = 0;
            const respondWithStatus: HttpClientFn = () => {
              callCount++;
              return asyncSucceed({
                status: statusCode,
                statusText: "Error",
                headers: {},
                bodyText: "fail",
                ms: 1,
              });
            };

            const policy: RetryPolicy = {
              ...basePolicy,
              maxRetries: 2,
              baseDelayMs: 0,
              maxDelayMs: 0,
              // Default retryOnStatus does NOT retry these status codes
            };

            const middleware = withRetry(policy)(respondWithStatus);

            // Without override: should NOT retry (only 1 call)
            const reqNoOverride: any = {
              method: "GET" as const,
              url: "/test",
            };

            callCount = 0;
            await run<HttpWireResponse>(middleware(reqNoOverride));
            expect(callCount).toBe(1); // No retries for non-retryable status

            // With override: should retry the status code
            const reqWithOverride: any = {
              method: "GET" as const,
              url: "/test",
              retry: { retryOnStatus: (s: number) => s === statusCode },
            };

            callCount = 0;
            await run<HttpWireResponse>(middleware(reqWithOverride));
            // Should retry: 1 initial + 2 retries = 3 calls
            expect(callCount).toBe(3);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("fields not in the override use base policy values (maxRetries from base when not overridden)", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbBasePolicy,
          // Generate override that only overrides baseDelayMs/maxDelayMs (not maxRetries)
          fc.record({
            baseDelayMs: fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }),
            maxDelayMs: fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }),
          }).filter((o) => o.baseDelayMs !== undefined || o.maxDelayMs !== undefined),
          async (basePolicy, override) => {
            // We test that when override does NOT provide maxRetries,
            // the base policy's maxRetries is used.
            let callCount = 0;
            const alwaysFail: HttpClientFn = () => {
              callCount++;
              return asyncSucceed({
                status: 503,
                statusText: "Unavailable",
                headers: {},
                bodyText: "fail",
                ms: 1,
              });
            };

            const policy: RetryPolicy = {
              ...basePolicy,
              baseDelayMs: 0,
              maxDelayMs: 0,
            };

            const middleware = withRetry(policy)(alwaysFail);

            const req: any = {
              method: "GET" as const,
              url: "/test",
              retry: override,
            };

            callCount = 0;
            await run<HttpWireResponse>(middleware(req));

            // Since override doesn't include maxRetries, base policy's maxRetries is used
            // Total calls = 1 (initial) + basePolicy.maxRetries (retries)
            expect(callCount).toBe(basePolicy.maxRetries + 1);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 3: Retry-After Parsing and Clamping
   *
   * For any positive integer s and maxDelayMs, verify effective delay equals
   * `min(s * 1000, maxDelayMs)`.
   *
   * **Validates: Requirements 3.1, 3.3**
   */
  describe("Feature: http-retry-backoff, Property 3: Retry-After Parsing and Clamping", () => {
    /** Arbitrary for Retry-After header value in seconds [1, 3600] */
    const arbRetryAfterSeconds = fc.integer({ min: 1, max: 3600 });

    /**
     * Arbitrary for maxDelayMs [1, 50]. Kept small so actual sleeps complete quickly.
     * Since s >= 1 means s*1000 >= 1000 > 50, the formula min(s*1000, maxDelayMs)
     * exercises the clamping path. A second test covers the non-clamped path.
     */
    const arbMaxDelayMs = fc.integer({ min: 1, max: 50 });

    it("effective delay equals min(s * 1000, maxDelayMs) for any positive integer Retry-After header", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbRetryAfterSeconds,
          arbMaxDelayMs,
          async (retryAfterSeconds, maxDelayMs) => {
            const events: RetryEvent[] = [];

            const policy: RetryPolicy = {
              maxRetries: 1,
              baseDelayMs: 0, // irrelevant when Retry-After is present
              maxDelayMs,
              // respectRetryAfter defaults to true
              onRetry: (event) => {
                events.push(event);
              },
            };

            // Downstream returns 429 with Retry-After header on first call, then 200
            let callCount = 0;
            const next: HttpClientFn = (): Async<unknown, HttpError, HttpWireResponse> => {
              callCount++;
              if (callCount === 1) {
                return asyncSucceed({
                  status: 429,
                  statusText: "Too Many Requests",
                  headers: { "Retry-After": String(retryAfterSeconds) },
                  bodyText: "",
                  ms: 1,
                } as HttpWireResponse);
              }
              return asyncSucceed({
                status: 200,
                statusText: "OK",
                headers: {},
                bodyText: "ok",
                ms: 1,
              } as HttpWireResponse);
            };

            const retried = withRetry(policy)(next);
            await run<HttpWireResponse>(retried({ method: "GET", url: "/test" }));

            // Should have exactly 1 retry event
            expect(events.length).toBe(1);

            // The delay should be min(s * 1000, maxDelayMs)
            const expectedDelay = Math.min(retryAfterSeconds * 1000, maxDelayMs);
            expect(events[0].delayMs).toBe(expectedDelay);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("effective delay equals s * 1000 when maxDelayMs is larger (non-clamped path)", async () => {
      // Verify the non-clamped case: when maxDelayMs >= s*1000, delay = s*1000.
      // Use s=1 (smallest integer) so delay = 1000ms, with maxDelayMs = 2000.
      // Actual sleep is 1000ms — acceptable for a single verification.
      const events: RetryEvent[] = [];
      const policy: RetryPolicy = {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 2000, // larger than 1*1000
        onRetry: (event) => {
          events.push(event);
        },
      };

      let callCount = 0;
      const next: HttpClientFn = (): Async<unknown, HttpError, HttpWireResponse> => {
        callCount++;
        if (callCount === 1) {
          return asyncSucceed({
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Retry-After": "1" },
            bodyText: "",
            ms: 1,
          } as HttpWireResponse);
        }
        return asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          bodyText: "ok",
          ms: 1,
        } as HttpWireResponse);
      };

      const retried = withRetry(policy)(next);
      await run<HttpWireResponse>(retried({ method: "GET", url: "/test" }));

      expect(events.length).toBe(1);
      // min(1*1000, 2000) = 1000 (no clamping)
      expect(events[0].delayMs).toBe(1000);
    }, 15000);
  });

  /**
   * Property 5: Time Budget Exhaustion
   *
   * For any policy with `maxElapsedMs`, verify retries stop when budget is exceeded.
   * With `maxElapsedMs` set very low (0 or 1) and a downstream that always returns
   * a retryable status, the middleware stops retrying rather than retrying indefinitely.
   *
   * **Validates: Requirements 5.7**
   */
  describe("Feature: http-retry-backoff, Property 5: Time Budget Exhaustion", () => {
    /** Arbitrary for maxRetries — generous to prove budget is the limiting factor */
    const arbMaxRetries = fc.integer({ min: 2, max: 10 });

    /** Arbitrary for baseDelayMs — positive to ensure budget would be consumed by delays */
    const arbBaseDelayMs = fc.integer({ min: 1, max: 100 });

    /** Arbitrary for maxDelayMs — positive */
    const arbMaxDelayMs = fc.integer({ min: 1, max: 200 });

    /** Arbitrary for retryable status codes */
    const arbRetryableStatus = fc.constantFrom(408, 429, 500, 502, 503, 504);

    /** Arbitrary for retryable HTTP methods */
    const arbRetryableMethod: fc.Arbitrary<HttpMethod> = fc.constantFrom("GET", "HEAD", "OPTIONS");

    it("retries stop when time budget is exhausted — callCount never exceeds maxRetries + 1", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 5 }), // maxElapsedMs: small budget
          arbMaxRetries,
          arbBaseDelayMs,
          arbMaxDelayMs,
          arbRetryableStatus,
          arbRetryableMethod,
          async (maxElapsedMs, maxRetries, baseDelayMs, maxDelayMs, retryableStatus, method) => {
            let callCount = 0;

            // Downstream always returns a retryable status
            const alwaysRetryable: HttpClientFn = (): Async<unknown, HttpError, HttpWireResponse> => {
              callCount++;
              return asyncSucceed({
                status: retryableStatus,
                statusText: "Error",
                headers: {},
                bodyText: "fail",
                ms: 1,
              } as HttpWireResponse);
            };

            const policy: RetryPolicy = {
              maxRetries,
              baseDelayMs,
              maxDelayMs,
              maxElapsedMs,
            };

            const middleware = withRetry(policy);
            const retryClient = middleware(alwaysRetryable);

            const request: HttpRequest = {
              method,
              url: "https://api.example.com/resource",
            };

            const result = await runEffect(retryClient(request));

            // The middleware should return a success (the last retryable response)
            // rather than retrying indefinitely
            expect(result._tag).toBe("Success");

            // With a very small maxElapsedMs, the budget is exhausted quickly.
            // The key property: callCount is bounded and less than what would
            // happen without a budget (maxRetries + 1). With maxElapsedMs=0,
            // only 1 call is made. With maxElapsedMs > 0, at most a few calls
            // can happen before budget runs out.
            expect(callCount).toBeGreaterThanOrEqual(1);
            expect(callCount).toBeLessThanOrEqual(maxRetries + 1);

            // The returned response should be the retryable status (last response)
            if (result._tag === "Success") {
              expect(result.value.status).toBe(retryableStatus);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("with maxElapsedMs=0, downstream is called exactly once regardless of policy", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbMaxRetries,
          arbBaseDelayMs,
          arbMaxDelayMs,
          arbRetryableStatus,
          async (maxRetries, baseDelayMs, maxDelayMs, retryableStatus) => {
            let callCount = 0;

            const alwaysRetryable: HttpClientFn = (): Async<unknown, HttpError, HttpWireResponse> => {
              callCount++;
              return asyncSucceed({
                status: retryableStatus,
                statusText: "Error",
                headers: {},
                bodyText: "fail",
                ms: 1,
              } as HttpWireResponse);
            };

            const policy: RetryPolicy = {
              maxRetries,
              baseDelayMs,
              maxDelayMs,
              maxElapsedMs: 0, // Budget is zero — no retries allowed
            };

            const middleware = withRetry(policy);
            const retryClient = middleware(alwaysRetryable);

            const request: HttpRequest = {
              method: "GET",
              url: "https://api.example.com/data",
            };

            const result = await runEffect(retryClient(request));

            // Should succeed with the retryable response (no retry attempted)
            expect(result._tag).toBe("Success");
            expect(callCount).toBe(1);

            if (result._tag === "Success") {
              expect(result.value.status).toBe(retryableStatus);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("budget exhaustion also stops retries on error path", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbMaxRetries,
          arbBaseDelayMs,
          arbMaxDelayMs,
          async (maxRetries, baseDelayMs, maxDelayMs) => {
            let callCount = 0;

            // Downstream always fails with a retryable error
            const alwaysFetchError: HttpClientFn = (): Async<unknown, HttpError, HttpWireResponse> => {
              callCount++;
              return asyncFail({ _tag: "FetchError", message: "connection reset" } as HttpError);
            };

            const policy: RetryPolicy = {
              maxRetries,
              baseDelayMs,
              maxDelayMs,
              maxElapsedMs: 0, // Budget is zero — no retries allowed
              retryOnMethods: ["GET", "HEAD", "OPTIONS"],
            };

            const middleware = withRetry(policy);
            const retryClient = middleware(alwaysFetchError);

            const request: HttpRequest = {
              method: "GET",
              url: "https://api.example.com/data",
            };

            const result = await runEffect(retryClient(request));

            // Should fail with the error (no retry attempted)
            expect(result._tag).toBe("Failure");
            expect(callCount).toBe(1);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 2: Backoff Delay Bounds
   *
   * For any attempt n, baseDelay b > 0, maxDelay m > 0, verify delay is in
   * `[0, min(b * 2^n, m)]`.
   *
   * **Validates: Requirements 2.1, 2.2, 2.3**
   */
  describe("Feature: http-retry-backoff, Property 2: Backoff Delay Bounds", () => {
    /** Arbitrary for attempt count (how many retries to trigger) in [1, 20] */
    const arbAttemptCount = fc.integer({ min: 1, max: 20 });

    /** Arbitrary for base delay in [1, 10000] */
    const arbBaseDelay = fc.integer({ min: 1, max: 10000 });

    /** Arbitrary for max delay in [1, 60000] */
    const arbMaxDelay = fc.integer({ min: 1, max: 60000 });

    it("each retry delay is in [0, min(baseDelay * 2^attempt, maxDelay)]", async () => {
      vi.useFakeTimers();
      try {
        await fc.assert(
          fc.asyncProperty(
            arbAttemptCount,
            arbBaseDelay,
            arbMaxDelay,
            async (attemptCount, baseDelay, maxDelay) => {
              const maxRetries = attemptCount;
              const events: RetryEvent[] = [];

              const policy: RetryPolicy = {
                maxRetries,
                baseDelayMs: baseDelay,
                maxDelayMs: maxDelay,
                onRetry: (event) => {
                  events.push(event);
                },
              };

              // Downstream always returns 503 to trigger retries
              const alwaysFail: HttpClientFn = (): Async<unknown, HttpError, HttpWireResponse> => {
                return asyncSucceed({
                  status: 503,
                  statusText: "Service Unavailable",
                  headers: {},
                  bodyText: "fail",
                  ms: 1,
                } as HttpWireResponse);
              };

              const retried = withRetry(policy)(alwaysFail);
              const resultPromise = run<HttpWireResponse>(retried({ method: "GET", url: "/test" }));

              // Advance timers to resolve all sleeps
              for (let i = 0; i < maxRetries; i++) {
                await vi.advanceTimersByTimeAsync(maxDelay + 1);
              }

              await resultPromise;

              // We should have exactly maxRetries events
              expect(events.length).toBe(maxRetries);

              // Verify each delay is within bounds
              for (let i = 0; i < events.length; i++) {
                const event = events[i];
                const attempt = event.attempt;
                const upperBound = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

                // delayMs must be >= 0
                expect(event.delayMs).toBeGreaterThanOrEqual(0);

                // delayMs must be <= min(baseDelay * 2^attempt, maxDelay)
                expect(event.delayMs).toBeLessThanOrEqual(upperBound);
              }
            },
          ),
          { numRuns: 100 },
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * Property 1: Middleware Transparency
   *
   * For any request with a retryable method and any response with a non-retryable
   * status code, the middleware returns the exact same response without modification.
   *
   * **Validates: Requirements 1.2**
   */
  describe("Feature: http-retry-backoff, Property 1: Middleware Transparency", () => {
    /** Non-retryable status codes: anything NOT in {408, 429, 500, 501, 502, 503, 504} */
    const nonRetryableStatuses = fc.integer({ min: 100, max: 599 }).filter(
      (s) => s !== 408 && s !== 429 && s !== 500 && s !== 502 && s !== 503 && s !== 504,
    );

    /** Arbitrary for retryable HTTP methods */
    const arbRetryableMethod: fc.Arbitrary<HttpMethod> = fc.constantFrom("GET", "HEAD", "OPTIONS");

    /** Arbitrary for a valid URL */
    const arbUrl = fc.stringMatching(/^https?:\/\/[a-z0-9]+\.[a-z]{2,4}(\/[a-z0-9\-]*){0,3}$/).filter(
      (s) => s.length > 0,
    );

    /** Arbitrary for response headers */
    const arbHeaders: fc.Arbitrary<Record<string, string>> = fc.dictionary(
      fc.stringMatching(/^[a-z\-]{1,15}$/).filter((s) => s.length > 0),
      fc.stringMatching(/^[a-zA-Z0-9 ,;=\-\/\.]{1,30}$/).filter((s) => s.length > 0),
      { minKeys: 0, maxKeys: 5 },
    );

    /** Arbitrary for response body text */
    const arbBodyText = fc.string({ minLength: 0, maxLength: 200 });

    /** Arbitrary for response time in ms */
    const arbMs = fc.integer({ min: 0, max: 5000 });

    /** Arbitrary for a complete HttpWireResponse with non-retryable status */
    const arbNonRetryableResponse: fc.Arbitrary<HttpWireResponse> = fc.record({
      status: nonRetryableStatuses,
      statusText: fc.stringMatching(/^[A-Za-z ]{1,20}$/).filter((s) => s.length > 0),
      headers: arbHeaders,
      bodyText: arbBodyText,
      ms: arbMs,
    });

    /** Arbitrary for request headers */
    const arbRequestHeaders: fc.Arbitrary<Record<string, string> | undefined> = fc.option(
      fc.dictionary(
        fc.stringMatching(/^[a-z\-]{1,15}$/).filter((s) => s.length > 0),
        fc.stringMatching(/^[a-zA-Z0-9 ,;=\-\/\.]{1,30}$/).filter((s) => s.length > 0),
        { minKeys: 0, maxKeys: 3 },
      ),
      { nil: undefined },
    );

    /** Arbitrary for a complete HttpRequest with retryable method */
    const arbRequest: fc.Arbitrary<HttpRequest> = fc.record({
      method: arbRetryableMethod,
      url: arbUrl,
      headers: arbRequestHeaders,
      body: fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: undefined }),
    });

    /** Arbitrary for a retry policy (various configurations) */
    const arbRetryPolicy: fc.Arbitrary<RetryPolicy> = fc.record({
      maxRetries: fc.integer({ min: 1, max: 10 }),
      baseDelayMs: fc.integer({ min: 1, max: 5000 }),
      maxDelayMs: fc.integer({ min: 1, max: 30000 }),
      maxElapsedMs: fc.option(fc.integer({ min: 100, max: 60000 }), { nil: undefined }),
    });

    it("returns the exact same response for any non-retryable status code", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbRequest,
          arbNonRetryableResponse,
          arbRetryPolicy,
          async (request, expectedResponse, policy) => {
            let callCount = 0;

            // Downstream client that always returns the given response
            const next: HttpClientFn = (_req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
              callCount++;
              return asyncSucceed(expectedResponse);
            };

            const middleware = withRetry(policy);
            const retryClient = middleware(next);

            const result = await runEffect(retryClient(request));

            // Should succeed
            expect(result._tag).toBe("Success");

            // Downstream called exactly once (no retry for non-retryable status)
            expect(callCount).toBe(1);

            // Response should be the exact same object/values
            if (result._tag === "Success") {
              expect(result.value.status).toBe(expectedResponse.status);
              expect(result.value.statusText).toBe(expectedResponse.statusText);
              expect(result.value.headers).toEqual(expectedResponse.headers);
              expect(result.value.bodyText).toBe(expectedResponse.bodyText);
              expect(result.value.ms).toBe(expectedResponse.ms);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 4: Case-Insensitive Header Lookup
   *
   * For any casing variation of "retry-after", verify the header value is extracted.
   *
   * **Validates: Requirements 3.5**
   */
  describe("Feature: http-retry-backoff, Property 4: Case-Insensitive Header Lookup", () => {
    /**
     * Generator: random casing permutation of "retry-after".
     * Each character is independently uppercased or lowercased.
     */
    const arbRetryAfterCasing: fc.Arbitrary<string> = fc.tuple(
      ...Array.from("retry-after").map((ch) =>
        ch === "-"
          ? fc.constant("-")
          : fc.boolean().map((upper) => (upper ? ch.toUpperCase() : ch.toLowerCase())),
      ),
    ).map((chars) => chars.join(""));

    /** Arbitrary for Retry-After value in seconds (positive integer) */
    const arbRetryAfterSeconds = fc.integer({ min: 1, max: 60 });

    /**
     * Arbitrary for maxDelayMs — kept small (5-50ms) so tests run fast.
     * Since retryAfterSecs >= 1, retryAfterSecs * 1000 >= 1000 > maxDelayMs,
     * so the effective delay will be clamped to maxDelayMs.
     * With baseDelayMs = 0, if the header were NOT found, backoff would be 0.
     * This lets us distinguish: delay === maxDelayMs means header was found.
     */
    const arbMaxDelayMs = fc.integer({ min: 5, max: 50 });

    it("header value is extracted regardless of casing variation of 'retry-after'", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbRetryAfterCasing,
          arbRetryAfterSeconds,
          arbMaxDelayMs,
          async (headerName, retryAfterSecs, maxDelayMs) => {
            const events: RetryEvent[] = [];

            const policy: RetryPolicy = {
              maxRetries: 1,
              baseDelayMs: 0, // backoff without header would be 0
              maxDelayMs,
              onRetry: (event) => {
                events.push(event);
              },
            };

            let callCount = 0;
            const next: HttpClientFn = (): Async<unknown, HttpError, HttpWireResponse> => {
              callCount++;
              if (callCount === 1) {
                // First call returns 429 with Retry-After header in random casing
                return asyncSucceed({
                  status: 429,
                  statusText: "Too Many Requests",
                  headers: { [headerName]: String(retryAfterSecs) },
                  bodyText: "",
                  ms: 1,
                } as HttpWireResponse);
              }
              // Second call succeeds
              return asyncSucceed({
                status: 200,
                statusText: "OK",
                headers: {},
                bodyText: "ok",
                ms: 1,
              } as HttpWireResponse);
            };

            const retried = withRetry(policy)(next);
            await run<HttpWireResponse>(retried({ method: "GET", url: "/test" }));

            // Should have retried (2 calls total)
            expect(callCount).toBe(2);

            // Should have emitted exactly 1 retry event
            expect(events.length).toBe(1);

            // The delay should reflect the Retry-After value clamped to maxDelayMs.
            // Since retryAfterSecs * 1000 >= 1000 > maxDelayMs (max 50),
            // the effective delay is maxDelayMs — proving the header was found.
            // If the header were NOT found, delay would be backoffDelayMs(0, 0, maxDelayMs)
            // which is random(0, min(0 * 2^0, maxDelayMs)) = random(0, 0) = 0.
            const expectedDelay = Math.min(retryAfterSecs * 1000, maxDelayMs);
            expect(events[0].delayMs).toBe(expectedDelay);
            // Since retryAfterSecs >= 1 and maxDelayMs >= 5, expectedDelay >= 5 > 0
            // This confirms the header was successfully extracted (case-insensitively)
            expect(events[0].delayMs).toBeGreaterThan(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 12: Method Guard
   *
   * For any HTTP method not in the configured `retryOnMethods` list (default: GET, HEAD, OPTIONS),
   * the retry middleware SHALL pass the request to the downstream client exactly once without
   * retry logic, regardless of the response.
   *
   * **Validates: Requirements 12.1, 12.2**
   */
  describe("Feature: http-retry-backoff, Property 12: Method Guard", () => {
    /** All valid HTTP methods */
    const allMethods: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

    /** Arbitrary for a random subset of methods to use as retryOnMethods */
    const arbRetryOnMethods: fc.Arbitrary<HttpMethod[]> = fc.subarray(allMethods, { minLength: 0, maxLength: allMethods.length });

    /** Arbitrary for a random HTTP method */
    const arbMethod: fc.Arbitrary<HttpMethod> = fc.constantFrom(...allMethods);

    it("methods not in retryOnMethods are passed through exactly once without retry", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbMethod,
          arbRetryOnMethods,
          async (method, retryOnMethods) => {
            // Only test methods NOT in the retryOnMethods list
            fc.pre(!retryOnMethods.includes(method));

            let callCount = 0;
            const downstream: HttpClientFn = (_req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
              callCount++;
              // Return a retryable status (503) — should still NOT retry for non-retryable methods
              return asyncSucceed({
                status: 503,
                statusText: "Service Unavailable",
                headers: {},
                bodyText: "unavailable",
                ms: 5,
              } as HttpWireResponse);
            };

            const policy: RetryPolicy = {
              maxRetries: 5,
              baseDelayMs: 0,
              maxDelayMs: 0,
              retryOnMethods,
            };

            const middleware = withRetry(policy);
            const client = middleware(downstream);

            const request: HttpRequest = {
              method,
              url: "https://api.example.com/resource",
            };

            const result = await runEffect(client(request));

            // Should succeed (pass-through the 503 response without retry)
            expect(result._tag).toBe("Success");

            // Downstream should be called exactly once — no retries
            expect(callCount).toBe(1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("default retryOnMethods (GET, HEAD, OPTIONS) — non-default methods are not retried", async () => {
      const nonDefaultRetryable: HttpMethod[] = ["POST", "PUT", "DELETE", "PATCH"];
      const arbNonDefaultMethod: fc.Arbitrary<HttpMethod> = fc.constantFrom(...nonDefaultRetryable);

      await fc.assert(
        fc.asyncProperty(
          arbNonDefaultMethod,
          async (method) => {
            let callCount = 0;
            const downstream: HttpClientFn = (_req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
              callCount++;
              return asyncSucceed({
                status: 503,
                statusText: "Service Unavailable",
                headers: {},
                bodyText: "unavailable",
                ms: 5,
              } as HttpWireResponse);
            };

            // No retryOnMethods specified — uses default (GET, HEAD, OPTIONS)
            const policy: RetryPolicy = {
              maxRetries: 5,
              baseDelayMs: 0,
              maxDelayMs: 0,
            };

            const middleware = withRetry(policy);
            const client = middleware(downstream);

            const request: HttpRequest = {
              method,
              url: "https://api.example.com/resource",
            };

            const result = await runEffect(client(request));

            // Should succeed (pass-through the 503 response without retry)
            expect(result._tag).toBe("Success");

            // Downstream should be called exactly once — no retries
            expect(callCount).toBe(1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("methods IN retryOnMethods ARE retried (control test to confirm guard only blocks non-listed methods)", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbMethod,
          arbRetryOnMethods.filter((methods) => methods.length > 0),
          async (method, retryOnMethods) => {
            // Only test methods that ARE in the retryOnMethods list
            fc.pre(retryOnMethods.includes(method));

            let callCount = 0;
            const downstream: HttpClientFn = (_req: HttpRequest): Async<unknown, HttpError, HttpWireResponse> => {
              callCount++;
              return asyncSucceed({
                status: 503,
                statusText: "Service Unavailable",
                headers: {},
                bodyText: "unavailable",
                ms: 5,
              } as HttpWireResponse);
            };

            const policy: RetryPolicy = {
              maxRetries: 2,
              baseDelayMs: 0,
              maxDelayMs: 0,
              retryOnMethods,
            };

            const middleware = withRetry(policy);
            const client = middleware(downstream);

            const request: HttpRequest = {
              method,
              url: "https://api.example.com/resource",
            };

            const result = await runEffect(client(request));

            // Should succeed (returns the 503 after exhausting retries)
            expect(result._tag).toBe("Success");

            // Downstream should be called more than once (retries happened)
            // 1 initial + 2 retries = 3 calls
            expect(callCount).toBe(3);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 11: Retry Event Emission
   *
   * For any retry attempt where an `onRetry` callback is configured, the emitted
   * `RetryEvent` SHALL contain a valid `attempt` number (>= 0), a non-negative `delayMs`,
   * the request `url` and `method`, a `timestamp` > 0, and either an `error` or `status`
   * field (but not both undefined).
   *
   * **Validates: Requirements 10.1, 10.4**
   */
  describe("Feature: http-retry-backoff, Property 11: Retry Event Emission", () => {
    /** Arbitrary for retryable HTTP methods (only these will trigger retry logic) */
    const arbRetryableMethod: fc.Arbitrary<HttpMethod> = fc.constantFrom("GET", "HEAD", "OPTIONS");

    /** Arbitrary for non-empty URL strings */
    const arbUrl = fc.stringMatching(/^\/[a-z0-9\-\/]{1,30}$/).filter((s) => s.length > 0);

    /** Arbitrary for retryable status codes */
    const arbRetryableStatus = fc.constantFrom(408, 429, 500, 502, 503, 504);

    /** Arbitrary for retryable error types */
    const arbRetryableError: fc.Arbitrary<HttpError> = fc.oneof(
      fc.constant({ _tag: "FetchError", message: "network error" } as HttpError),
      fc.constant({ _tag: "Timeout", timeoutMs: 5000, message: "timed out" } as HttpError),
      fc.constant({ _tag: "PoolTimeout", key: "origin", timeoutMs: 3000, message: "pool timeout" } as HttpError),
    );

    /** Arbitrary for number of retries before success (1 to 5) */
    const arbFailCount = fc.integer({ min: 1, max: 5 });

    /** Arbitrary for base delay (keep small for test speed) */
    const arbBaseDelay = fc.integer({ min: 0, max: 10 });

    /** Arbitrary for max delay (keep small for test speed) */
    const arbMaxDelay = fc.integer({ min: 0, max: 20 });

    /** Whether to fail with error or retryable status */
    const arbFailMode = fc.constantFrom("error", "status") as fc.Arbitrary<"error" | "status">;

    it("emitted events have valid attempt >= 0, non-negative delayMs, non-empty url and method, timestamp > 0, and either error or status defined", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbRetryableMethod,
          arbUrl,
          arbFailCount,
          arbBaseDelay,
          arbMaxDelay,
          arbFailMode,
          arbRetryableStatus,
          arbRetryableError,
          async (method, url, failCount, baseDelay, maxDelay, failMode, retryableStatus, retryableError) => {
            const events: RetryEvent[] = [];
            let callCount = 0;

            const policy: RetryPolicy = {
              maxRetries: failCount + 1, // allow enough retries
              baseDelayMs: baseDelay,
              maxDelayMs: maxDelay,
              onRetry: (event) => {
                events.push(event);
              },
            };

            // Downstream that fails `failCount` times then succeeds
            const next: HttpClientFn = () => {
              callCount++;
              if (callCount <= failCount) {
                if (failMode === "error") {
                  return asyncFail(retryableError);
                } else {
                  return asyncSucceed({
                    status: retryableStatus,
                    statusText: "Error",
                    headers: {},
                    bodyText: "",
                    ms: 1,
                  } as HttpWireResponse);
                }
              }
              return asyncSucceed({
                status: 200,
                statusText: "OK",
                headers: {},
                bodyText: "ok",
                ms: 1,
              } as HttpWireResponse);
            };

            const retried = withRetry(policy)(next);
            await run<HttpWireResponse>(retried({ method, url }));

            // We should have exactly `failCount` events (one per retry decision)
            expect(events.length).toBe(failCount);

            // Validate each emitted event
            for (const event of events) {
              // attempt >= 0
              expect(event.attempt).toBeGreaterThanOrEqual(0);

              // delayMs >= 0
              expect(event.delayMs).toBeGreaterThanOrEqual(0);

              // non-empty url
              expect(event.url).toBeTruthy();
              expect(event.url.length).toBeGreaterThan(0);

              // non-empty method
              expect(event.method).toBeTruthy();
              expect(event.method.length).toBeGreaterThan(0);

              // timestamp > 0
              expect(event.timestamp).toBeGreaterThan(0);

              // either error or status defined (not both undefined)
              const hasError = event.error !== undefined;
              const hasStatus = event.status !== undefined;
              expect(hasError || hasStatus).toBe(true);

              // Verify consistency with fail mode
              if (failMode === "error") {
                expect(event.error).toBeDefined();
                expect(event.status).toBeUndefined();
              } else {
                expect(event.status).toBeDefined();
                expect(event.error).toBeUndefined();
              }
            }

            // Verify url and method match the request
            for (const event of events) {
              expect(event.url).toBe(url);
              expect(event.method).toBe(method);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 6: Default Status Predicate
   *
   * For all status codes in [100, 599], the default `retryOnStatus` predicate
   * SHALL return `true` if and only if the status is 408, 429, 500, 502, 503, or 504.
   *
   * **Validates: Requirements 6.2, 6.3**
   */
  describe("Feature: http-retry-backoff, Property 6: Default Status Predicate", () => {
    /** The set of status codes that should trigger a retry by default */
    const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

    it("default predicate returns true only for 408, 429, 500, 502, 503, 504", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 100, max: 599 }),
          async (statusCode) => {
            const shouldRetry = RETRYABLE_STATUSES.has(statusCode);

            let callCount = 0;

            // Downstream returns the given status on first call, 200 on subsequent calls
            const next: HttpClientFn = (): Async<unknown, HttpError, HttpWireResponse> => {
              callCount++;
              if (callCount === 1) {
                return asyncSucceed({
                  status: statusCode,
                  statusText: "Test",
                  headers: {},
                  bodyText: "",
                  ms: 1,
                } as HttpWireResponse);
              }
              return asyncSucceed({
                status: 200,
                statusText: "OK",
                headers: {},
                bodyText: "ok",
                ms: 1,
              } as HttpWireResponse);
            };

            // Policy with NO custom retryOnStatus — uses the default predicate
            const policy: RetryPolicy = {
              maxRetries: 1,
              baseDelayMs: 0,
              maxDelayMs: 0,
            };

            const retried = withRetry(policy)(next);
            await run<HttpWireResponse>(retried({ method: "GET", url: "/test" }));

            if (shouldRetry) {
              // Retryable status: downstream should be called more than once (retry triggered)
              expect(callCount).toBe(2);
            } else {
              // Non-retryable status: downstream should be called exactly once (no retry)
              expect(callCount).toBe(1);
            }
          },
        ),
        { numRuns: 500 },
      );
    });

    it("exhaustive: every status in [100, 599] matches expected retry behavior", async () => {
      // Exhaustive test over all 500 status codes for complete coverage
      for (let statusCode = 100; statusCode <= 599; statusCode++) {
        const shouldRetry = RETRYABLE_STATUSES.has(statusCode);

        let callCount = 0;

        const next: HttpClientFn = (): Async<unknown, HttpError, HttpWireResponse> => {
          callCount++;
          if (callCount === 1) {
            return asyncSucceed({
              status: statusCode,
              statusText: "Test",
              headers: {},
              bodyText: "",
              ms: 1,
            } as HttpWireResponse);
          }
          return asyncSucceed({
            status: 200,
            statusText: "OK",
            headers: {},
            bodyText: "ok",
            ms: 1,
          } as HttpWireResponse);
        };

        const policy: RetryPolicy = {
          maxRetries: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
        };

        const retried = withRetry(policy)(next);
        await run<HttpWireResponse>(retried({ method: "GET", url: "/test" }));

        if (shouldRetry) {
          expect(callCount).toBe(2);
        } else {
          expect(callCount).toBe(1);
        }
      }
    });
  });
});
