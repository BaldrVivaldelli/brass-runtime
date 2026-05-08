import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { makeLifecycleClient } from "../lifecycle/lifecycleClient";
import { makeHttp } from "../client";
import type { HttpMethod, HttpRequest, HttpWireResponse, HttpError } from "../client";
import type { Async } from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Cause } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";

/**
 * Property-based tests for the lifecycle client factory.
 * Feature: http-lifecycle-client
 */
describe("lifecycleClient property tests", () => {
  /**
   * Property 1: Behavioral equivalence without layers
   *
   * For any MakeHttpConfig and any HttpRequest, a LifecycleClient created with
   * no dedup, cache, or priority options SHALL produce the same HttpWireResponse
   * (or same HttpError) as a plain makeHttp wire client created with the same config.
   *
   * **Validates: Requirements 1.6**
   */
  describe("Property 1: Behavioral equivalence without layers", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    /** Arbitrary for HTTP methods */
    const arbMethod: fc.Arbitrary<HttpMethod> = fc.constantFrom(
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    );

    /** Arbitrary for relative URL paths */
    const arbPath = fc
      .array(
        fc.stringMatching(/^[a-z0-9\-_]{1,10}$/),
        { minLength: 1, maxLength: 4 },
      )
      .map((segments) => "/" + segments.join("/"));

    /** Arbitrary for request headers (safe characters only) */
    const arbHeaders: fc.Arbitrary<Record<string, string>> = fc
      .array(
        fc.tuple(
          fc.constantFrom("accept", "content-type", "x-request-id", "x-custom", "authorization"),
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

    /** Arbitrary for a base URL */
    const arbBaseUrl = fc.constantFrom(
      "https://api.example.com",
      "https://service.test.io",
      "https://localhost:3000",
    );

    /** Arbitrary for default headers in config */
    const arbDefaultHeaders: fc.Arbitrary<Record<string, string> | undefined> = fc.oneof(
      fc.constant(undefined),
      fc
        .array(
          fc.tuple(
            fc.constantFrom("x-api-key", "x-tenant", "accept"),
            fc.stringMatching(/^[a-zA-Z0-9\-_.]{1,15}$/).filter((s) => s.length > 0),
          ),
          { minLength: 1, maxLength: 2 },
        )
        .map((entries) => Object.fromEntries(entries)),
    );

    /** Arbitrary for response status codes */
    const arbStatus = fc.integer({ min: 200, max: 599 });

    /** Arbitrary for response body text */
    const arbResponseBody = fc.string({ minLength: 0, maxLength: 100 });

    /**
     * Creates a deterministic mock fetch that returns a response based on the
     * request URL and method. This ensures both clients see the same fetch behavior.
     */
    function createDeterministicFetch(
      responseStatus: number,
      responseBody: string,
    ): typeof globalThis.fetch {
      return (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response(responseBody, {
          status: responseStatus,
          statusText: responseStatus === 200 ? "OK" : "Response",
          headers: { "content-type": "text/plain", "x-test": "true" },
        });
      }) as typeof globalThis.fetch;
    }

    /** Runs an Async effect to completion using the Runtime */
    const rt = Runtime.make({});
    async function runEffect<A>(eff: Async<unknown, any, A>): Promise<Exit<any, A>> {
      return new Promise<Exit<any, A>>((resolve) => {
        try {
          rt.toPromise(eff).then(
            (value) => resolve({ _tag: "Success", value }),
            (error) => resolve({ _tag: "Failure", cause: Cause.fail(error) }),
          );
        } catch (err) {
          resolve({ _tag: "Failure", cause: Cause.fail(err) });
        }
      });
    }

    it("lifecycle client without layers produces same successful response as plain wire client", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbMethod,
          arbPath,
          arbHeaders,
          arbBody,
          arbBaseUrl,
          arbDefaultHeaders,
          arbStatus,
          arbResponseBody,
          async (method, path, headers, body, baseUrl, defaultHeaders, status, responseBody) => {
            const mockFetch = createDeterministicFetch(status, responseBody);
            globalThis.fetch = mockFetch;

            const config = {
              baseUrl,
              headers: defaultHeaders,
            };

            // Create both clients with the same config
            const wireClient = makeHttp(config);
            const lifecycleClient = makeLifecycleClient(config);

            const request: HttpRequest = { method, url: path, headers, body };

            // Run both clients with the same request
            const [wireResult, lifecycleResult] = await Promise.all([
              runEffect<HttpWireResponse>(wireClient(request)),
              runEffect<HttpWireResponse>(lifecycleClient(request)),
            ]);

            // Both should produce the same outcome
            expect(lifecycleResult._tag).toBe(wireResult._tag);

            if (wireResult._tag === "Success" && lifecycleResult._tag === "Success") {
              expect(lifecycleResult.value.status).toBe(wireResult.value.status);
              expect(lifecycleResult.value.statusText).toBe(wireResult.value.statusText);
              expect(lifecycleResult.value.bodyText).toBe(wireResult.value.bodyText);
              expect(lifecycleResult.value.headers).toEqual(wireResult.value.headers);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("lifecycle client without layers produces same error as plain wire client for bad URLs", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbMethod,
          arbBody,
          async (method, body) => {
            // Use a fetch that should never be called (bad URL should fail before fetch)
            const mockFetch = vi.fn().mockRejectedValue(new Error("should not be called"));
            globalThis.fetch = mockFetch;

            // No baseUrl and a relative path → should produce BadUrl error
            const config = {};

            const wireClient = makeHttp(config);
            const lifecycleClient = makeLifecycleClient(config);

            // Use a relative URL without a baseUrl — this should produce a BadUrl error
            const request: HttpRequest = { method, url: "/relative/path", headers: {}, body };

            const [wireResult, lifecycleResult] = await Promise.all([
              runEffect<HttpWireResponse>(wireClient(request)),
              runEffect<HttpWireResponse>(lifecycleClient(request)),
            ]);

            // Both should fail with the same error type
            expect(lifecycleResult._tag).toBe(wireResult._tag);

            if (wireResult._tag === "Failure" && lifecycleResult._tag === "Failure") {
              // Both should produce a BadUrl error
              const wireError = (wireResult.cause as any)?.error as HttpError | undefined;
              const lifecycleError = (lifecycleResult.cause as any)?.error as HttpError | undefined;

              if (wireError && lifecycleError) {
                expect(lifecycleError._tag).toBe(wireError._tag);
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("lifecycle client without layers handles fetch errors identically to wire client", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbMethod,
          arbPath,
          arbBaseUrl,
          fc.string({ minLength: 1, maxLength: 30 }),
          async (method, path, baseUrl, errorMessage) => {
            // Mock fetch that always rejects with a network error
            const mockFetch = (async () => {
              throw new TypeError(errorMessage);
            }) as unknown as typeof globalThis.fetch;
            globalThis.fetch = mockFetch;

            const config = { baseUrl };

            const wireClient = makeHttp(config);
            const lifecycleClient = makeLifecycleClient(config);

            const request: HttpRequest = { method, url: path };

            const [wireResult, lifecycleResult] = await Promise.all([
              runEffect<HttpWireResponse>(wireClient(request)),
              runEffect<HttpWireResponse>(lifecycleClient(request)),
            ]);

            // Both should fail
            expect(lifecycleResult._tag).toBe(wireResult._tag);
            expect(lifecycleResult._tag).toBe("Failure");

            if (wireResult._tag === "Failure" && lifecycleResult._tag === "Failure") {
              const wireError = (wireResult.cause as any)?.error as HttpError | undefined;
              const lifecycleError = (lifecycleResult.cause as any)?.error as HttpError | undefined;

              if (wireError && lifecycleError) {
                expect(lifecycleError._tag).toBe(wireError._tag);
                // Both should be FetchError for network failures
                expect(lifecycleError._tag).toBe("FetchError");
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("lifecycle client without layers preserves config headers identically to wire client", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbMethod,
          arbPath,
          arbHeaders,
          arbBaseUrl,
          arbDefaultHeaders.filter((h) => h !== undefined),
          arbStatus,
          arbResponseBody,
          async (method, path, reqHeaders, baseUrl, defaultHeaders, status, responseBody) => {
            // Track what headers each client sends to fetch
            const wireHeadersCaptured: Record<string, string>[] = [];
            const lifecycleHeadersCaptured: Record<string, string>[] = [];

            let captureTarget = wireHeadersCaptured;

            const capturingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
              const headers: Record<string, string> = {};
              if (init?.headers) {
                const h = init.headers as Record<string, string>;
                for (const [k, v] of Object.entries(h)) {
                  headers[k] = v;
                }
              }
              captureTarget.push(headers);
              return new Response(responseBody, {
                status,
                statusText: "OK",
                headers: { "content-type": "text/plain" },
              });
            }) as typeof globalThis.fetch;

            globalThis.fetch = capturingFetch;

            const config = { baseUrl, headers: defaultHeaders };

            const wireClient = makeHttp(config);
            const lifecycleClient = makeLifecycleClient(config);

            const request: HttpRequest = { method, url: path, headers: reqHeaders };

            // Run wire client
            captureTarget = wireHeadersCaptured;
            await runEffect<HttpWireResponse>(wireClient(request));

            // Run lifecycle client
            captureTarget = lifecycleHeadersCaptured;
            await runEffect<HttpWireResponse>(lifecycleClient(request));

            // Both should have sent the same headers to fetch
            expect(lifecycleHeadersCaptured.length).toBe(wireHeadersCaptured.length);
            if (wireHeadersCaptured.length > 0 && lifecycleHeadersCaptured.length > 0) {
              expect(lifecycleHeadersCaptured[0]).toEqual(wireHeadersCaptured[0]);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
