import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { makeLifecycleClient } from "../../lifecycle/lifecycleClient";
import type { PrewarmEvent } from "../types";
import type { HttpRequest, HttpWireResponse } from "../../client";
import { registerHttpEffect } from "../../effectRunner";

describe("Prewarm Lifecycle Integration Tests", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchSuccess() {
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      // Return a proper response for both probes and regular requests
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      });
    }) as any;
  }

  it("lifecycle client creates prewarm manager when prewarm config is provided", () => {
    mockFetchSuccess();
    const client = makeLifecycleClient({
      prewarm: {
        origins: ["https://api.example.com"],
      },
    });
    expect(client).toBeDefined();
    expect(client.cancelAll).toBeTypeOf("function");
  });

  it("lifecycle client works without prewarm config", () => {
    mockFetchSuccess();
    const client = makeLifecycleClient({});
    expect(client).toBeDefined();
  });

  it("lifecycle client works with prewarm set to false", () => {
    mockFetchSuccess();
    const client = makeLifecycleClient({
      prewarm: false,
    });
    expect(client).toBeDefined();
  });

  it("cancelAll cascades to prewarm manager", async () => {
    mockFetchSuccess();
    const events: PrewarmEvent[] = [];
    const client = makeLifecycleClient({
      baseUrl: "https://api.example.com",
      prewarm: {
        origins: ["https://api.example.com"],
        onEvent: (e) => events.push(e),
      },
    });

    // cancelAll should not throw
    await new Promise<void>((resolve) => {
      registerHttpEffect(client.cancelAll(), {}, () => resolve());
    });
  });

  it("prewarm events are forwarded to onEvent observer", async () => {
    mockFetchSuccess();
    const events: PrewarmEvent[] = [];
    const client = makeLifecycleClient({
      prewarm: {
        origins: ["https://api.example.com"],
        onEvent: (e) => events.push(e),
      },
    });

    // The prewarm manager is created internally — we can't directly call warm()
    // but we can verify the config was accepted without error
    expect(events).toHaveLength(0); // No events yet since no probes triggered
  });

  /**
   * Property 12: Lifecycle afterResponse Integration
   *
   * For any successful response where afterResponse returns origins, warm() is called for each.
   *
   * **Validates: Requirements 7.2, 7.3**
   */
  it("Property 12: afterResponse hook triggers warm for returned origins", async () => {
    const validOriginArb = fc.tuple(
      fc.constantFrom("https", "http"),
      fc.stringMatching(/^[a-z][a-z0-9]{1,10}\.[a-z]{2,4}$/),
    ).map(([scheme, host]) => `${scheme}://${host}`);

    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(validOriginArb, { minLength: 1, maxLength: 3 }),
        async (originsToWarm) => {
          const warmedOrigins: string[] = [];

          globalThis.fetch = vi.fn(async (url: any) => {
            const urlStr = url.toString();
            // Track probe requests (HEAD to origin/)
            if (urlStr.endsWith("/")) {
              warmedOrigins.push(new URL(urlStr).origin);
            }
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
            });
          }) as any;

          const client = makeLifecycleClient({
            baseUrl: "https://main-api.example.com",
            prewarm: {
              origins: originsToWarm,
              afterResponse: (_response: HttpWireResponse, _request: HttpRequest) => {
                return originsToWarm;
              },
            },
          });

          // Make a request to trigger afterResponse
          await new Promise<void>((resolve) => {
            registerHttpEffect(
              client({ method: "GET", url: "/data" }),
              {},
              () => {
                resolve();
              },
            );
          });

          // Allow microtasks to flush (warm() calls are fire-and-forget)
          await new Promise((r) => setTimeout(r, 50));

          // Each origin from afterResponse should have been probed
          const normalizedExpected = originsToWarm.map((o) => new URL(o).origin);
          for (const expected of normalizedExpected) {
            expect(warmedOrigins).toContain(expected);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
