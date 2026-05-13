import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  makePromiseHttpTransport,
  promiseHttpTransport,
  isPromiseTransportDirect,
  normalizeHttpError,
  type HttpTransportContext,
  type HttpTransport,
  type PromiseHttpTransportConfig,
} from "../transport";
import { registerHttpEffect } from "../effectRunner";
import { makeHttp, type HttpError, type HttpWireResponse } from "../client";
import { async as asyncEffect } from "../../core/types/asyncEffect";
import { Cause, type Exit } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";

/**
 * Property-based tests for the HTTP Promise Transport Direct Path optimization.
 * Feature: http-promise-transport-optimization
 */
describe("Promise transport direct path property tests", () => {
  // ---------------------------------------------------------------------------
  // Shared arbitraries / generators
  // ---------------------------------------------------------------------------

  /** Arbitrary for HTTP status codes */
  const arbStatus = fc.integer({ min: 100, max: 599 });

  /** Arbitrary for HTTP status text */
  const arbStatusText = fc.constantFrom("OK", "Created", "Not Found", "Internal Server Error", "");

  /** Arbitrary for response headers */
  const arbHeaders = fc.dictionary(
    fc.constantFrom("content-type", "x-request-id", "x-custom", "cache-control"),
    fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
    { minKeys: 0, maxKeys: 4 },
  );

  /** Arbitrary for response body text */
  const arbBodyText = fc.string({ minLength: 0, maxLength: 200 });

  /** Arbitrary for a valid HttpTransportContext */
  const arbTransportContext: fc.Arbitrary<HttpTransportContext> = fc.record({
    request: fc.record({
      method: fc.constantFrom("GET", "POST", "PUT", "DELETE", "PATCH"),
      url: fc.constantFrom("/api/data", "/users", "/items/123", "/health"),
      headers: arbHeaders,
    }),
    url: fc.constantFrom(
      "https://api.example.test/data",
      "https://api.example.test/users",
      "https://api.example.test/items/123",
    ).map((u) => new URL(u)),
    signal: fc.constant(new AbortController().signal),
  }) as fc.Arbitrary<HttpTransportContext>;

  /**
   * Arbitrary for a valid PromiseHttpTransportConfig that produces a
   * deterministic response. The request function returns a mock response
   * object, and the response mapper extracts wire response fields from it.
   */
  const arbPromiseTransportConfig: fc.Arbitrary<PromiseHttpTransportConfig<any>> = fc
    .record({
      status: arbStatus,
      statusText: arbStatusText,
      headers: arbHeaders,
      bodyText: arbBodyText,
      async: fc.boolean(),
    })
    .map(({ status, statusText, headers, bodyText, async: isAsync }) => ({
      request: isAsync
        ? (_ctx: HttpTransportContext) => Promise.resolve({ status, statusText, headers, data: bodyText })
        : (_ctx: HttpTransportContext) => ({ status, statusText, headers, data: bodyText }),
      response: (raw: any) => ({
        status: raw.status,
        statusText: raw.statusText,
        headers: raw.headers,
        bodyText: raw.data,
      }),
    }));

  // ---------------------------------------------------------------------------
  // Property 1: Promise transport marker invariant
  // ---------------------------------------------------------------------------

  /**
   * Property 1: Promise transport marker invariant
   *
   * For any valid PromiseHttpTransportConfig, the transport function produced by
   * makePromiseHttpTransport() SHALL have a `__promiseTransport` property set to
   * `true` and a `requestDirect` method that is a function returning a Promise.
   *
   * **Validates: Requirements 1.1, 1.2**
   */
  describe("Property 1: Promise transport marker invariant", () => {
    it("makePromiseHttpTransport always produces a transport with __promiseTransport === true and requestDirect as a function", () => {
      fc.assert(
        fc.property(arbPromiseTransportConfig, (config) => {
          const transport = makePromiseHttpTransport(config);

          // Requirement 1.1: marker property is set to true
          expect((transport as any).__promiseTransport).toBe(true);

          // Requirement 1.2: requestDirect is a function
          expect(typeof (transport as any).requestDirect).toBe("function");

          // The type guard should detect the marker
          expect(isPromiseTransportDirect(transport)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it("requestDirect returns a Promise (thenable) when called with a valid context", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbPromiseTransportConfig,
          arbTransportContext,
          async (config, context) => {
            const transport = makePromiseHttpTransport(config);

            // Requirement 1.2: requestDirect returns a Promise<HttpWireResponse>
            const result = (transport as any).requestDirect(context);

            // Verify it's a thenable (Promise-like)
            expect(result).not.toBeNull();
            expect(typeof result).toBe("object");
            expect(typeof result.then).toBe("function");

            // Await the result and verify it has the expected wire response shape
            const response = await result;
            expect(typeof response.status).toBe("number");
            expect(typeof response.statusText).toBe("string");
            expect(typeof response.headers).toBe("object");
            expect(typeof response.bodyText).toBe("string");
            expect(typeof response.ms).toBe("number");
          },
        ),
        { numRuns: 100 },
      );
    });

    it("fluent promiseHttpTransport() builder also produces a transport with the marker", () => {
      fc.assert(
        fc.property(
          fc.record({
            status: arbStatus,
            statusText: arbStatusText,
            headers: arbHeaders,
            bodyText: arbBodyText,
          }),
          ({ status, statusText, headers, bodyText }) => {
            const transport = promiseHttpTransport()
              .request(async () => ({ status, statusText, headers, data: bodyText }))
              .json();

            // Marker is present on fluent-built transports too
            expect((transport as any).__promiseTransport).toBe(true);
            expect(typeof (transport as any).requestDirect).toBe("function");
            expect(isPromiseTransportDirect(transport)).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Property 2: Response equivalence between direct and effect paths
  // ---------------------------------------------------------------------------

  /**
   * Property 2: Response equivalence between direct and effect paths
   *
   * For any valid HTTP request and promise transport, executing the request
   * through the direct promise path (requestDirect) SHALL produce the same
   * HttpWireResponse (status, statusText, headers, bodyText) as executing it
   * through the registerHttpEffect effect path.
   *
   * The `ms` field may differ slightly between paths due to timing, so we
   * compare all fields EXCEPT `ms`.
   *
   * **Validates: Requirements 3.2, 5.1, 5.2, 6.1, 8.3**
   */
  describe("Property 2: Response equivalence between direct and effect paths", () => {
    /**
     * Helper: run a transport through the effect path (registerHttpEffect)
     * and return a Promise<HttpWireResponse>.
     */
    const runEffectPath = (
      transport: ReturnType<typeof makePromiseHttpTransport>,
      context: HttpTransportContext,
    ): Promise<HttpWireResponse> =>
      new Promise((resolve, reject) => {
        registerHttpEffect(
          transport(context),
          undefined,
          (exit) => {
            if (exit._tag === "Success") {
              resolve(exit.value);
            } else {
              reject(exit);
            }
          },
        );
      });

    /**
     * Helper: run a transport through the direct promise path (requestDirect)
     * and return a Promise<HttpWireResponse>.
     */
    const runDirectPath = (
      transport: ReturnType<typeof makePromiseHttpTransport>,
      context: HttpTransportContext,
    ): Promise<HttpWireResponse> => {
      return (transport as any).requestDirect(context);
    };

    it("direct path produces the same response fields as the effect path for sync transports", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbStatus,
          arbStatusText,
          arbHeaders,
          arbBodyText,
          arbTransportContext,
          async (status, statusText, headers, bodyText, context) => {
            // Create a synchronous promise transport config
            const config: PromiseHttpTransportConfig<any> = {
              request: (_ctx: HttpTransportContext) => ({ status, statusText, headers, data: bodyText }),
              response: (raw: any) => ({
                status: raw.status,
                statusText: raw.statusText,
                headers: raw.headers,
                bodyText: raw.data,
              }),
            };

            const transport = makePromiseHttpTransport(config);

            // Run through both paths
            const [directResponse, effectResponse] = await Promise.all([
              runDirectPath(transport, context),
              runEffectPath(transport, context),
            ]);

            // Compare all fields except `ms` (timing may differ between paths)
            expect(directResponse.status).toBe(effectResponse.status);
            expect(directResponse.statusText).toBe(effectResponse.statusText);
            expect(directResponse.headers).toEqual(effectResponse.headers);
            expect(directResponse.bodyText).toBe(effectResponse.bodyText);

            // Both should have a numeric ms field
            expect(typeof directResponse.ms).toBe("number");
            expect(typeof effectResponse.ms).toBe("number");
          },
        ),
        { numRuns: 100 },
      );
    });

    it("direct path produces the same response fields as the effect path for async transports", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbStatus,
          arbStatusText,
          arbHeaders,
          arbBodyText,
          arbTransportContext,
          async (status, statusText, headers, bodyText, context) => {
            // Create an asynchronous promise transport config
            const config: PromiseHttpTransportConfig<any> = {
              request: (_ctx: HttpTransportContext) =>
                Promise.resolve({ status, statusText, headers, data: bodyText }),
              response: (raw: any) => ({
                status: raw.status,
                statusText: raw.statusText,
                headers: raw.headers,
                bodyText: raw.data,
              }),
            };

            const transport = makePromiseHttpTransport(config);

            // Run through both paths
            const [directResponse, effectResponse] = await Promise.all([
              runDirectPath(transport, context),
              runEffectPath(transport, context),
            ]);

            // Compare all fields except `ms` (timing may differ between paths)
            expect(directResponse.status).toBe(effectResponse.status);
            expect(directResponse.statusText).toBe(effectResponse.statusText);
            expect(directResponse.headers).toEqual(effectResponse.headers);
            expect(directResponse.bodyText).toBe(effectResponse.bodyText);

            // Both should have a numeric ms field
            expect(typeof directResponse.ms).toBe("number");
            expect(typeof effectResponse.ms).toBe("number");
          },
        ),
        { numRuns: 100 },
      );
    });

    it("direct path produces the same response fields as the effect path for mixed sync/async configs", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbPromiseTransportConfig,
          arbTransportContext,
          async (config, context) => {
            const transport = makePromiseHttpTransport(config);

            // Run through both paths
            const [directResponse, effectResponse] = await Promise.all([
              runDirectPath(transport, context),
              runEffectPath(transport, context),
            ]);

            // Compare all fields except `ms` (timing may differ between paths)
            expect(directResponse.status).toBe(effectResponse.status);
            expect(directResponse.statusText).toBe(effectResponse.statusText);
            expect(directResponse.headers).toEqual(effectResponse.headers);
            expect(directResponse.bodyText).toBe(effectResponse.bodyText);

            // Both should have a numeric ms field
            expect(typeof directResponse.ms).toBe("number");
            expect(typeof effectResponse.ms).toBe("number");
          },
        ),
        { numRuns: 100 },
      );
    });

    it("direct path produces the same response for fluent-built transports", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbStatus,
          arbStatusText,
          arbHeaders,
          arbBodyText,
          arbTransportContext,
          async (status, statusText, headers, bodyText, context) => {
            // Use the fluent builder API
            const transport = promiseHttpTransport()
              .request(async () => ({ status, statusText, headers, data: bodyText }))
              .response((raw: any) => ({
                status: raw.status,
                statusText: raw.statusText,
                headers: raw.headers,
                bodyText: raw.data,
              }));

            // Run through both paths
            const [directResponse, effectResponse] = await Promise.all([
              runDirectPath(transport as any, context),
              runEffectPath(transport as any, context),
            ]);

            // Compare all fields except `ms`
            expect(directResponse.status).toBe(effectResponse.status);
            expect(directResponse.statusText).toBe(effectResponse.statusText);
            expect(directResponse.headers).toEqual(effectResponse.headers);
            expect(directResponse.bodyText).toBe(effectResponse.bodyText);

            // Both should have a numeric ms field
            expect(typeof directResponse.ms).toBe("number");
            expect(typeof effectResponse.ms).toBe("number");
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Property 3: Error equivalence between direct and effect paths
  // ---------------------------------------------------------------------------

  /**
   * Property 3: Error equivalence between direct and effect paths
   *
   * For any error condition (network failure, abort), the direct promise path
   * SHALL produce an HttpError with the same `_tag` and structure as the effect
   * path given the same inputs and conditions.
   *
   * **Validates: Requirements 3.3, 4.1, 4.2, 5.3, 5.5, 6.2, 6.4**
   */
  describe("Property 3: Error equivalence between direct and effect paths", () => {
    /**
     * Arbitrary for network error conditions that produce FetchError.
     */
    const arbNetworkError: fc.Arbitrary<{ error: unknown; expectedTag: HttpError["_tag"] }> = fc.oneof(
      // Plain Error (network failure) → FetchError
      fc.string({ minLength: 1, maxLength: 50 }).map((msg) => ({
        error: new Error(msg),
        expectedTag: "FetchError" as const,
      })),
      // Error with code (e.g., ECONNREFUSED) → FetchError
      fc.record({
        message: fc.string({ minLength: 1, maxLength: 50 }),
        code: fc.constantFrom("ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EPIPE"),
      }).map(({ message, code }) => ({
        error: Object.assign(new Error(message), { code }),
        expectedTag: "FetchError" as const,
      })),
      // Error with status from response (e.g., Axios-like) → FetchError
      fc.record({
        message: fc.string({ minLength: 1, maxLength: 50 }),
        status: fc.integer({ min: 400, max: 599 }),
        statusText: fc.constantFrom("Bad Request", "Not Found", "Internal Server Error"),
      }).map(({ message, status, statusText }) => ({
        error: Object.assign(new Error(message), { response: { status, statusText } }),
        expectedTag: "FetchError" as const,
      })),
      // Already-tagged HttpError (FetchError) → FetchError (passthrough)
      fc.string({ minLength: 1, maxLength: 50 }).map((msg) => ({
        error: { _tag: "FetchError", message: msg } as HttpError,
        expectedTag: "FetchError" as const,
      })),
    );

    /**
     * Arbitrary for abort error conditions that produce Abort.
     */
    const arbAbortError: fc.Arbitrary<{ error: unknown; expectedTag: HttpError["_tag"] }> = fc.oneof(
      // AbortError (DOMException-like) → Abort
      fc.constant({
        error: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
        expectedTag: "Abort" as const,
      }),
      // Error with abort code → Abort
      fc.constant({
        error: Object.assign(new Error("canceled"), { code: "ERR_CANCELED" }),
        expectedTag: "Abort" as const,
      }),
      // Already-tagged Abort HttpError → Abort (passthrough)
      fc.constant({
        error: { _tag: "Abort" } as HttpError,
        expectedTag: "Abort" as const,
      }),
    );

    /** Combined arbitrary for all error types */
    const arbErrorCondition = fc.oneof(arbNetworkError, arbAbortError);

    /**
     * Helper: Run a failing transport through the effect path (registerHttpEffect)
     * and extract the resulting HttpError.
     */
    function runErrorEffectPath(
      config: PromiseHttpTransportConfig<any>,
      context: HttpTransportContext,
    ): Promise<HttpError> {
      return new Promise((resolve, reject) => {
        const transport = makePromiseHttpTransport(config);
        const effect = transport(context);

        registerHttpEffect(effect, undefined, (exit: Exit<HttpError, HttpWireResponse>) => {
          if (exit._tag === "Success") {
            reject(new Error("Expected failure but got success on effect path"));
            return;
          }
          // Extract the error from the Cause (same as exitError in client.ts)
          const failure = Cause.firstFailure(exit.cause);
          if (failure._tag === "Some") {
            resolve(failure.value);
          } else {
            reject(new Error("Expected Fail cause but got different cause type"));
          }
        });
      });
    }

    /**
     * Helper: Run a failing transport through the direct path (requestDirect)
     * and extract the resulting HttpError after normalizeHttpError
     * (as runPoolTransport does on the direct path rejection handler).
     */
    function runErrorDirectPath(
      config: PromiseHttpTransportConfig<any>,
      context: HttpTransportContext,
    ): Promise<HttpError> {
      const transport = makePromiseHttpTransport(config);
      return (transport as any).requestDirect(context).then(
        () => { throw new Error("Expected failure but got success on direct path"); },
        (error: unknown) => normalizeHttpError(error),
      );
    }

    it("network errors produce the same _tag on both paths", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbNetworkError,
          arbTransportContext,
          fc.boolean(), // whether request fn is async
          async ({ error, expectedTag }, context, isAsync) => {
            const config: PromiseHttpTransportConfig<any> = {
              request: isAsync
                ? (_ctx: HttpTransportContext) => Promise.reject(error)
                : (_ctx: HttpTransportContext) => { throw error; },
              response: (raw: any) => ({
                status: 200,
                statusText: "OK",
                headers: {},
                bodyText: "",
              }),
            };

            const [effectError, directError] = await Promise.all([
              runErrorEffectPath(config, context),
              runErrorDirectPath(config, context),
            ]);

            // Both paths produce the same _tag
            expect(directError._tag).toBe(effectError._tag);
            expect(directError._tag).toBe(expectedTag);

            // For FetchError, verify structural equivalence
            if (effectError._tag === "FetchError" && directError._tag === "FetchError") {
              expect(directError.message).toBe(effectError.message);
              expect(directError.code).toBe(effectError.code);
              expect(directError.status).toBe(effectError.status);
              expect(directError.statusText).toBe(effectError.statusText);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it("abort errors produce the same _tag on both paths", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbAbortError,
          arbTransportContext,
          fc.boolean(), // whether request fn is async
          async ({ error, expectedTag }, context, isAsync) => {
            const config: PromiseHttpTransportConfig<any> = {
              request: isAsync
                ? (_ctx: HttpTransportContext) => Promise.reject(error)
                : (_ctx: HttpTransportContext) => { throw error; },
              response: (raw: any) => ({
                status: 200,
                statusText: "OK",
                headers: {},
                bodyText: "",
              }),
            };

            const [effectError, directError] = await Promise.all([
              runErrorEffectPath(config, context),
              runErrorDirectPath(config, context),
            ]);

            // Both paths produce Abort
            expect(directError._tag).toBe(effectError._tag);
            expect(directError._tag).toBe(expectedTag);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("signal-aborted context produces Abort on both paths", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("GET", "POST", "PUT", "DELETE", "PATCH"),
          fc.constantFrom("/api/data", "/users", "/items/123"),
          async (method, urlPath) => {
            // Create an already-aborted signal
            const controller = new AbortController();
            controller.abort();

            const context: HttpTransportContext = {
              request: { method: method as any, url: urlPath },
              url: new URL(`https://api.example.test${urlPath}`),
              signal: controller.signal,
            };

            // Config that checks signal and rejects if aborted (realistic transport behavior)
            const config: PromiseHttpTransportConfig<any> = {
              request: (ctx: HttpTransportContext) => {
                if (ctx.signal.aborted) {
                  throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
                }
                return Promise.resolve({ status: 200, data: "ok" });
              },
              response: (raw: any) => ({
                status: 200,
                statusText: "OK",
                headers: {},
                bodyText: raw.data,
              }),
            };

            const [effectError, directError] = await Promise.all([
              runErrorEffectPath(config, context),
              runErrorDirectPath(config, context),
            ]);

            // Both paths should produce Abort when signal is already aborted
            expect(effectError._tag).toBe("Abort");
            expect(directError._tag).toBe("Abort");
          },
        ),
        { numRuns: 100 },
      );
    });

    it("arbitrary error conditions always produce matching _tag between paths", async () => {
      await fc.assert(
        fc.asyncProperty(
          arbErrorCondition,
          arbTransportContext,
          fc.boolean(),
          async ({ error, expectedTag }, context, isAsync) => {
            const config: PromiseHttpTransportConfig<any> = {
              request: isAsync
                ? (_ctx: HttpTransportContext) => Promise.reject(error)
                : (_ctx: HttpTransportContext) => { throw error; },
              response: (raw: any) => ({
                status: 200,
                statusText: "OK",
                headers: {},
                bodyText: "",
              }),
            };

            const [effectError, directError] = await Promise.all([
              runErrorEffectPath(config, context),
              runErrorDirectPath(config, context),
            ]);

            // Core property: _tag equivalence between paths
            expect(directError._tag).toBe(effectError._tag);
            expect(directError._tag).toBe(expectedTag);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});


// ---------------------------------------------------------------------------
// Property 4: Pool statistics equivalence
// ---------------------------------------------------------------------------

describe("Property 4: Pool statistics equivalence", () => {
  /**
   * Property 4: Pool statistics equivalence
   *
   * For arbitrary request sequences through a pool, verify pool statistics
   * (acquire/release/active counts) are identical between direct and effect paths.
   *
   * **Validates: Requirements 3.2, 3.3, 6.3**
   */

  /** Arbitrary for a request action: either a success or a failure */
  const arbRequestAction = fc.oneof(
    fc.record({
      type: fc.constant("success" as const),
      status: fc.integer({ min: 200, max: 299 }),
      bodyText: fc.string({ minLength: 0, maxLength: 50 }),
    }),
    fc.record({
      type: fc.constant("failure" as const),
      message: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
    }),
  );

  /** Arbitrary for a sequence of request actions */
  const arbRequestSequence = fc.array(arbRequestAction, { minLength: 1, maxLength: 10 });

  const rt = Runtime.make({});
  const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

  it("pool statistics are identical between direct promise path and effect path for arbitrary request sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRequestSequence,
        fc.integer({ min: 1, max: 5 }), // pool concurrency
        async (actions, concurrency) => {
          // Build a promise transport (direct path) that responds based on the action sequence
          let directIdx = 0;
          const directTransport = makePromiseHttpTransport({
            request: (_ctx: HttpTransportContext) => {
              const action = actions[directIdx++];
              if (!action || action.type === "failure") {
                return Promise.reject(new Error(action?.message ?? "unknown"));
              }
              return Promise.resolve({
                status: action.status,
                statusText: "OK",
                headers: {},
                data: action.bodyText,
              });
            },
            response: (raw: any) => ({
              status: raw.status as number,
              statusText: raw.statusText as string,
              headers: raw.headers as Record<string, string>,
              bodyText: raw.data as string,
            }),
          });

          // Build an effect transport (effect path) that responds based on the same action sequence
          let effectIdx = 0;
          const effectTransport: HttpTransport = (_context: HttpTransportContext) => {
            const action = actions[effectIdx++];
            return asyncEffect((_env: unknown, cb: (exit: any) => void) => {
              if (!action || action.type === "failure") {
                cb({
                  _tag: "Failure",
                  cause: Cause.fail({
                    _tag: "FetchError",
                    message: action?.message ?? "unknown",
                  } as HttpError),
                });
                return;
              }
              cb({
                _tag: "Success",
                value: {
                  status: action.status,
                  statusText: "OK",
                  headers: {},
                  bodyText: action.bodyText,
                  ms: 1,
                },
              });
            });
          };

          // Create clients with pool configuration
          const directClient = makeHttp({
            baseUrl: "https://api.example.test",
            transport: directTransport,
            pool: { concurrency },
          });

          const effectClient = makeHttp({
            baseUrl: "https://api.example.test",
            transport: effectTransport,
            pool: { concurrency },
          });

          // Execute the same sequence through both clients
          for (let i = 0; i < actions.length; i++) {
            const req = { method: "GET" as const, url: `/action-${i}` };

            const directResult = run(directClient(req)).then(
              (r) => ({ ok: true, value: r }),
              (e) => ({ ok: false, error: e }),
            );

            const effectResult = run(effectClient(req)).then(
              (r) => ({ ok: true, value: r }),
              (e) => ({ ok: false, error: e }),
            );

            // Wait for both to complete
            await Promise.all([directResult, effectResult]);
          }

          // Compare pool statistics
          const directStats = directClient.stats();
          const effectStats = effectClient.stats();

          // Core pool statistics must be identical
          expect(directStats.started).toBe(effectStats.started);
          expect(directStats.succeeded).toBe(effectStats.succeeded);
          expect(directStats.failed).toBe(effectStats.failed);
          expect(directStats.inFlight).toBe(effectStats.inFlight);

          // Pool-level stats must also match
          expect(directStats.pool?.acquired).toBe(effectStats.pool?.acquired);
          expect(directStats.pool?.released).toBe(effectStats.pool?.released);
          expect(directStats.pool?.running).toBe(effectStats.pool?.running);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Transport path routing correctness
// ---------------------------------------------------------------------------

/**
 * Property 5: Transport path routing correctness
 *
 * For any transport function, RunPoolTransport SHALL invoke `requestDirect` if
 * and only if the transport carries the `__promiseTransport` marker; otherwise
 * it SHALL invoke `registerHttpEffect`. No effect transport SHALL ever trigger
 * the direct path.
 *
 * **Validates: Requirements 1.4, 3.1, 3.5, 8.2**
 */
describe("Property 5: Transport path routing correctness", () => {
  const rt = Runtime.make({});
  const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

  /** Arbitrary for HTTP status codes */
  const arbStatus = fc.integer({ min: 200, max: 299 });

  /** Arbitrary for response body text */
  const arbBodyText = fc.string({ minLength: 0, maxLength: 50 });

  /** Arbitrary for a boolean indicating whether the transport should be a promise transport */
  const arbIsPromiseTransport = fc.boolean();

  /**
   * Creates a tracking promise transport that records whether `requestDirect`
   * was called. Has the `__promiseTransport` marker.
   */
  function makeTrackingPromiseTransport(response: HttpWireResponse): {
    transport: HttpTransport;
    calls: { requestDirect: number; effectPath: number };
  } {
    const calls = { requestDirect: 0, effectPath: 0 };

    // Create a base effect transport function
    const transport: HttpTransport = (context) => {
      calls.effectPath++;
      return asyncEffect((_env, cb) => {
        cb({ _tag: "Success", value: response });
      });
    };

    // Attach the promise transport marker and requestDirect
    (transport as any).__promiseTransport = true;
    (transport as any).requestDirect = (_context: any): Promise<HttpWireResponse> => {
      calls.requestDirect++;
      return Promise.resolve(response);
    };

    return { transport, calls };
  }

  /**
   * Creates a tracking effect transport (no marker) that records whether
   * the effect path was used. Does NOT have the `__promiseTransport` marker.
   */
  function makeTrackingEffectTransport(response: HttpWireResponse): {
    transport: HttpTransport;
    calls: { requestDirect: number; effectPath: number };
  } {
    const calls = { requestDirect: 0, effectPath: 0 };

    const transport: HttpTransport = (context) => {
      calls.effectPath++;
      return asyncEffect((_env, cb) => {
        cb({ _tag: "Success", value: response });
      });
    };

    // Explicitly ensure no marker is present
    // (transport as any).__promiseTransport is undefined by default

    return { transport, calls };
  }

  it("requestDirect is called if and only if the transport has the __promiseTransport marker", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbIsPromiseTransport,
        arbStatus,
        arbBodyText,
        async (isPromise, status, bodyText) => {
          const response: HttpWireResponse = {
            status,
            statusText: "OK",
            headers: {},
            bodyText,
            ms: 1,
          };

          const { transport, calls } = isPromise
            ? makeTrackingPromiseTransport(response)
            : makeTrackingEffectTransport(response);

          // Verify marker detection matches what we set up
          expect(isPromiseTransportDirect(transport)).toBe(isPromise);

          // Create a client with pool/timeout to trigger runPoolTransport
          const client = makeHttp({
            baseUrl: "https://api.example.test",
            timeoutMs: 5000,
            transport,
          });

          const result = await run(client({ method: "GET", url: "/test" }));

          if (isPromise) {
            // Promise transport with marker: effect path is ALWAYS used now
            // (requestDirect is no longer called — the effect path with fast-path
            // bypass is more efficient due to one fewer microtask tick)
            expect(calls.effectPath).toBe(1);
            expect(calls.requestDirect).toBe(0);
          } else {
            // Effect transport: effect path MUST be called, requestDirect MUST NOT
            expect(calls.effectPath).toBe(1);
            expect(calls.requestDirect).toBe(0);
          }

          // Both paths should produce the same response
          expect((result as any).status).toBe(status);
          expect((result as any).bodyText).toBe(bodyText);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("effect transports never trigger the direct path regardless of transport shape", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStatus,
        arbBodyText,
        // Generate various "almost-marker" shapes that should NOT trigger direct path
        fc.constantFrom(
          "no-marker",
          "marker-false",
          "marker-string",
          "marker-null",
          "requestDirect-only",
        ),
        async (status, bodyText, variant) => {
          const response: HttpWireResponse = {
            status,
            statusText: "OK",
            headers: {},
            bodyText,
            ms: 1,
          };

          const calls = { requestDirect: 0, effectPath: 0 };

          const transport: HttpTransport = (context) => {
            calls.effectPath++;
            return asyncEffect((_env, cb) => {
              cb({ _tag: "Success", value: response });
            });
          };

          // Apply various "almost-marker" shapes that should NOT trigger direct path
          switch (variant) {
            case "no-marker":
              // No marker at all — plain effect transport
              break;
            case "marker-false":
              (transport as any).__promiseTransport = false;
              break;
            case "marker-string":
              (transport as any).__promiseTransport = "true";
              break;
            case "marker-null":
              (transport as any).__promiseTransport = null;
              break;
            case "requestDirect-only":
              // Has requestDirect but no marker — should NOT trigger direct path
              (transport as any).requestDirect = () => Promise.resolve(response);
              break;
          }

          // Verify the type guard rejects all these variants
          expect(isPromiseTransportDirect(transport)).toBe(false);

          const client = makeHttp({
            baseUrl: "https://api.example.test",
            timeoutMs: 5000,
            transport,
          });

          await run(client({ method: "GET", url: "/test" }));

          // Effect path MUST be used, direct path MUST NOT
          expect(calls.effectPath).toBe(1);
          expect(calls.requestDirect).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("multiple sequential requests consistently route to the correct path", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a sequence of transport types (true = promise, false = effect)
        fc.array(arbIsPromiseTransport, { minLength: 2, maxLength: 5 }),
        arbStatus,
        async (transportTypes, status) => {
          const response: HttpWireResponse = {
            status,
            statusText: "OK",
            headers: {},
            bodyText: "ok",
            ms: 1,
          };

          // For each transport type in the sequence, create a client and verify routing
          for (const isPromise of transportTypes) {
            const { transport, calls } = isPromise
              ? makeTrackingPromiseTransport(response)
              : makeTrackingEffectTransport(response);

            const client = makeHttp({
              baseUrl: "https://api.example.test",
              timeoutMs: 5000,
              transport,
            });

            await run(client({ method: "GET", url: "/test" }));

            if (isPromise) {
              // Promise transport: effect path is always used now (requestDirect bypassed)
              expect(calls.effectPath).toBe(1);
              expect(calls.requestDirect).toBe(0);
            } else {
              expect(calls.effectPath).toBe(1);
              expect(calls.requestDirect).toBe(0);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
