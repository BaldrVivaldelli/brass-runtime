import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { executeProbe } from "../probe";

/**
 * Property-based tests for the probe mechanism.
 * Feature: http-connection-prewarm, Property 4: Probe Mechanism
 *
 * **Validates: Requirements 2.5**
 */
describe("Probe Mechanism Property Tests", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Arbitrary for valid origin strings */
  const arbOrigin = fc
    .tuple(
      fc.constantFrom("https", "http"),
      fc.stringMatching(/^[a-z][a-z0-9\-]{1,8}$/).filter((s) => !s.endsWith("-")),
      fc.constantFrom(".com", ".org", ".io", ".net"),
      fc.option(fc.integer({ min: 1000, max: 9999 }), { nil: undefined }),
    )
    .map(([scheme, name, tld, port]) =>
      port !== undefined ? `${scheme}://${name}${tld}:${port}` : `${scheme}://${name}${tld}`,
    );

  /**
   * Property 4: For any origin, the probe issues a HEAD request to the root path of that origin.
   *
   * **Validates: Requirements 2.5**
   */
  it("probe issues HEAD request to root path of origin", async () => {
    await fc.assert(
      fc.asyncProperty(arbOrigin, async (origin) => {
        const calls: Array<{ url: string; method: string }> = [];

        globalThis.fetch = vi.fn(async (url: any, init?: any) => {
          calls.push({ url: String(url), method: init?.method ?? "GET" });
          return new Response(null, { status: 200 });
        }) as any;

        const controller = new AbortController();
        await executeProbe(origin, {
          timeoutMs: 5000,
          signal: controller.signal,
          platform: "node",
        });

        expect(calls.length).toBe(1);
        expect(calls[0].url).toBe(`${origin}/`);
        expect(calls[0].method).toBe("HEAD");
      }),
      { numRuns: 100 },
    );
  });
});
