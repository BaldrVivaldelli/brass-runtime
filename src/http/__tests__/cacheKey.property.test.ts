import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  computeCacheKey,
  parseCacheKey,
  SEPARATOR,
  DEFAULT_CACHE_RELEVANT_HEADERS,
  type CacheKeyComponents,
} from "../lifecycle/cacheKey";
import type { HttpRequest, HttpMethod } from "../client";

/**
 * Property-based tests for cache key computation.
 * Feature: http-lifecycle-client
 */
describe("cacheKey property tests", () => {
  const baseUrl = "https://api.example.com";

  /**
   * Property 21: Cache key header order independence
   *
   * For any two HttpRequest objects that differ only in the insertion order
   * of their headers, computeCacheKey SHALL produce identical strings.
   *
   * **Validates: Requirements 9.4**
   */
  describe("Property 21: Cache key header order independence", () => {
    /** Arbitrary for HTTP methods */
    const arbMethod = fc.constantFrom(
      "GET" as const,
      "POST" as const,
      "PUT" as const,
      "PATCH" as const,
      "DELETE" as const,
      "HEAD" as const,
      "OPTIONS" as const,
    );

    /** Arbitrary for URL paths — must be valid relative URLs that resolve against baseUrl */
    const arbPath = fc
      .tuple(
        fc.constantFrom("/users", "/api", "/data", "/items", "/test", "/v1", "/v2"),
        fc.option(
          fc.stringMatching(/^\/[a-z0-9\-_]{1,10}$/).filter((s) => s.length > 1),
          { nil: "" },
        ),
      )
      .map(([prefix, suffix]) => `${prefix}${suffix}`);

    /**
     * Arbitrary for header names restricted to cache-relevant headers
     * (since non-relevant headers are filtered out and wouldn't affect the key).
     * We use the default relevant headers plus some extra ones to test with.
     */
    const arbRelevantHeaderName = fc.constantFrom(...DEFAULT_CACHE_RELEVANT_HEADERS);

    /** Arbitrary for header values (printable ASCII, no commas or colons to avoid ambiguity) */
    const arbHeaderValue = fc
      .stringMatching(/^[a-zA-Z0-9 /.;=\-_*+]{1,30}$/)
      .filter((s) => s.length > 0);

    /**
     * Generate a record of cache-relevant headers with 1-3 entries,
     * then produce two versions with different insertion orders.
     */
    const arbHeaderPair = fc
      .array(fc.tuple(arbRelevantHeaderName, arbHeaderValue), { minLength: 2, maxLength: 3 })
      .chain((entries) => {
        // Deduplicate by header name (keep last)
        const deduped = new Map(entries);
        const dedupedEntries = [...deduped.entries()];
        if (dedupedEntries.length < 2) {
          // Need at least 2 distinct headers to test order independence
          return fc.constant(null);
        }
        // Generate a shuffled version
        return fc.shuffledSubarray(dedupedEntries, { minLength: dedupedEntries.length, maxLength: dedupedEntries.length }).map(
          (shuffled) => ({ original: dedupedEntries, shuffled }),
        );
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    it("produces identical cache keys regardless of header insertion order", () => {
      fc.assert(
        fc.property(
          arbMethod,
          arbPath,
          arbHeaderPair,
          fc.option(fc.string({ minLength: 0, maxLength: 50 }), { nil: undefined }),
          (method, path, headerPair, body) => {
            // Build headers object with original insertion order
            const headers1: Record<string, string> = {};
            for (const [k, v] of headerPair.original) {
              headers1[k] = v;
            }

            // Build headers object with shuffled insertion order
            const headers2: Record<string, string> = {};
            for (const [k, v] of headerPair.shuffled) {
              headers2[k] = v;
            }

            const req1: HttpRequest = { method, url: path, headers: headers1, body };
            const req2: HttpRequest = { method, url: path, headers: headers2, body };

            const key1 = computeCacheKey(req1, baseUrl);
            const key2 = computeCacheKey(req2, baseUrl);

            expect(key1).toBe(key2);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("produces identical cache keys with extra headers in different order", () => {
      const arbExtraHeaderName = fc
        .stringMatching(/^x-[a-z]{2,8}$/)
        .filter((s) => s.length > 2);

      const arbExtraHeaderPair = fc
        .array(fc.tuple(arbExtraHeaderName, arbHeaderValue), { minLength: 2, maxLength: 4 })
        .chain((entries) => {
          const deduped = new Map(entries);
          const dedupedEntries = [...deduped.entries()];
          if (dedupedEntries.length < 2) {
            return fc.constant(null);
          }
          return fc.shuffledSubarray(dedupedEntries, { minLength: dedupedEntries.length, maxLength: dedupedEntries.length }).map(
            (shuffled) => ({ original: dedupedEntries, shuffled }),
          );
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);

      fc.assert(
        fc.property(
          arbMethod,
          arbPath,
          arbExtraHeaderPair,
          (method, path, headerPair) => {
            const extraHeaders = headerPair.original.map(([k]) => k);

            // Build headers with original order
            const headers1: Record<string, string> = {};
            for (const [k, v] of headerPair.original) {
              headers1[k] = v;
            }

            // Build headers with shuffled order
            const headers2: Record<string, string> = {};
            for (const [k, v] of headerPair.shuffled) {
              headers2[k] = v;
            }

            const req1: HttpRequest = { method, url: path, headers: headers1 };
            const req2: HttpRequest = { method, url: path, headers: headers2 };

            const key1 = computeCacheKey(req1, baseUrl, extraHeaders);
            const key2 = computeCacheKey(req2, baseUrl, extraHeaders);

            expect(key1).toBe(key2);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * Property 22: Cache key serialization round-trip
   *
   * For any valid cache key string K, `computeCacheKey(parseCacheKey(K))` SHALL
   * produce a string equal to K. Specifically, serializing CacheKeyComponents to
   * a key string and parsing it back should produce the same components, and
   * re-serializing those components should produce the original key string.
   *
   * **Validates: Requirements 9.6**
   */
  describe("Property 22: Cache key serialization round-trip", () => {
    /** Arbitrary for HTTP methods (uppercase) */
    const arbMethod: fc.Arbitrary<HttpMethod> = fc.constantFrom(
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    );

    /** Arbitrary for a valid absolute URL (no null characters) */
    const arbAbsoluteUrl: fc.Arbitrary<string> = fc
      .tuple(
        fc.constantFrom("http", "https"),
        fc.stringMatching(/^[a-z0-9]{3,15}$/).filter((s) => s.length >= 3),
        fc.stringMatching(/^[a-z0-9/_-]{0,20}$/),
      )
      .map(([protocol, host, path]) => `${protocol}://${host}.com/${path}`);

    /** Arbitrary for header keys (lowercase, no commas, no colons, no null chars) */
    const arbHeaderKey: fc.Arbitrary<string> = fc.constantFrom(
      ...DEFAULT_CACHE_RELEVANT_HEADERS,
    );

    /** Arbitrary for header values (no commas or null chars to avoid ambiguity in serialization) */
    const arbHeaderValue: fc.Arbitrary<string> = fc
      .stringMatching(/^[a-zA-Z0-9 /\-_.+*;=]{1,30}$/)
      .filter((s) => s.length > 0 && !s.includes(",") && !s.includes("\u0000"));

    /** Arbitrary for sorted headers record (only cache-relevant header keys) */
    const arbHeaders: fc.Arbitrary<Record<string, string>> = fc
      .uniqueArray(fc.tuple(arbHeaderKey, arbHeaderValue), {
        minLength: 0,
        maxLength: 3,
        selector: ([k]) => k,
      })
      .map((entries) => {
        const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
        return Object.fromEntries(sorted);
      });

    /** Arbitrary for body content (safe characters, no null chars) */
    const arbBodySafe: fc.Arbitrary<string> = fc
      .stringMatching(/^[a-zA-Z0-9 {}[\]"':,.\-_+=/@#$%^&*()]{0,50}$/)
      .filter((s) => !s.includes("\u0000"));

    /** Arbitrary for body that may contain null character separators */
    const arbBodyWithSeparator: fc.Arbitrary<string> = fc
      .array(
        fc.oneof(
          fc.stringMatching(/^[a-z0-9]{1,10}$/).filter((s) => s.length >= 1),
          fc.constant(SEPARATOR),
        ),
        { minLength: 0, maxLength: 5 },
      )
      .map((parts) => parts.join(""));

    /** Arbitrary for CacheKeyComponents */
    const arbCacheKeyComponents: fc.Arbitrary<CacheKeyComponents> = fc.record({
      method: arbMethod.map((m) => m.toUpperCase()),
      resolvedUrl: arbAbsoluteUrl,
      headers: arbHeaders,
      body: arbBodySafe,
    });

    /** Helper: serialize CacheKeyComponents to a cache key string */
    function serializeComponents(components: CacheKeyComponents): string {
      const headersStr = Object.entries(components.headers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v}`)
        .join(",");
      return `${components.method}${SEPARATOR}${components.resolvedUrl}${SEPARATOR}${headersStr}${SEPARATOR}${components.body}`;
    }

    it("parseCacheKey(serialize(components)) round-trips: re-serializing parsed components produces the original key", () => {
      fc.assert(
        fc.property(arbCacheKeyComponents, (components) => {
          const serialized = serializeComponents(components);
          const parsed = parseCacheKey(serialized);
          const reSerialized = serializeComponents(parsed);

          expect(reSerialized).toBe(serialized);
        }),
        { numRuns: 200 },
      );
    });

    it("parseCacheKey preserves all components from a serialized key", () => {
      fc.assert(
        fc.property(arbCacheKeyComponents, (components) => {
          const serialized = serializeComponents(components);
          const parsed = parseCacheKey(serialized);

          expect(parsed.method).toBe(components.method);
          expect(parsed.resolvedUrl).toBe(components.resolvedUrl);
          expect(parsed.headers).toEqual(components.headers);
          expect(parsed.body).toBe(components.body);
        }),
        { numRuns: 200 },
      );
    });

    it("round-trips through computeCacheKey → parseCacheKey → serialize", () => {
      const arbRequest: fc.Arbitrary<{ req: HttpRequest; baseUrl: string }> = fc
        .tuple(arbMethod, arbAbsoluteUrl, arbHeaders, arbBodySafe)
        .map(([method, baseUrl, headers, body]) => ({
          req: {
            method,
            url: "/test-path",
            headers: Object.keys(headers).length > 0 ? headers : undefined,
            body: body || undefined,
          } as HttpRequest,
          baseUrl,
        }));

      fc.assert(
        fc.property(arbRequest, ({ req, baseUrl }) => {
          const key = computeCacheKey(req, baseUrl);
          const parsed = parseCacheKey(key);
          const reSerialized = serializeComponents(parsed);

          expect(reSerialized).toBe(key);
        }),
        { numRuns: 200 },
      );
    });

    it("handles body containing null character separators in round-trip", () => {
      const arbComponentsWithSepBody: fc.Arbitrary<CacheKeyComponents> = fc.record({
        method: arbMethod.map((m) => m.toUpperCase()),
        resolvedUrl: arbAbsoluteUrl,
        headers: arbHeaders,
        body: arbBodyWithSeparator,
      });

      fc.assert(
        fc.property(arbComponentsWithSepBody, (components) => {
          const serialized = serializeComponents(components);
          const parsed = parseCacheKey(serialized);
          const reSerialized = serializeComponents(parsed);

          expect(reSerialized).toBe(serialized);
          expect(parsed.body).toBe(components.body);
        }),
        { numRuns: 200 },
      );
    });
  });
});
