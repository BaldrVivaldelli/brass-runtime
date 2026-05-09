import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { validateOrigin } from "../validation";

/**
 * Property-based tests for origin validation.
 * Feature: http-connection-prewarm, Property 1: Origin Validation Round-Trip
 *
 * **Validates: Requirements 1.1, 1.2**
 */
describe("Origin Validation Property Tests", () => {
  /** Arbitrary for valid hostnames */
  const arbHostname = fc
    .tuple(
      fc.stringMatching(/^[a-z][a-z0-9\-]{0,10}$/),
      fc.constantFrom(".com", ".org", ".io", ".net", ".dev", ".example"),
    )
    .map(([name, tld]) => `${name}${tld}`)
    .filter((h) => h.length > 4 && !h.includes("--"));

  /** Arbitrary for valid schemes */
  const arbScheme = fc.constantFrom("http", "https");

  /** Arbitrary for optional port */
  const arbPort = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined });

  /** Arbitrary for valid origin strings */
  const arbValidOrigin = fc
    .tuple(arbScheme, arbHostname, arbPort)
    .map(([scheme, host, port]) =>
      port !== undefined ? `${scheme}://${host}:${port}` : `${scheme}://${host}`,
    );

  /**
   * Property 1: For any valid origin string (scheme + host + port),
   * validation succeeds and returns a normalized origin.
   *
   * **Validates: Requirements 1.1, 1.2**
   */
  it("valid origins are accepted and normalized", () => {
    fc.assert(
      fc.property(arbValidOrigin, (origin) => {
        const result = validateOrigin(origin);
        // Result should be a valid origin (scheme + host + optional port)
        expect(result).toMatch(/^https?:\/\/[^/]+$/);
        // Should not contain paths, query, or fragment
        expect(result).not.toContain("?");
        expect(result).not.toContain("#");
        // Should not end with a slash
        expect(result).not.toMatch(/\/$/);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property 1 (inverse): For any string with a path component,
   * validation throws.
   *
   * **Validates: Requirements 1.1, 1.2**
   */
  it("origins with paths are rejected", () => {
    const arbOriginWithPath = fc
      .tuple(
        arbValidOrigin,
        fc.stringMatching(/^\/[a-z][a-z0-9/]{0,10}$/).filter((p) => p.length > 1),
      )
      .map(([origin, path]) => `${origin}${path}`);

    fc.assert(
      fc.property(arbOriginWithPath, (originWithPath) => {
        expect(() => validateOrigin(originWithPath)).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * Property 1 (inverse): For any string without a valid scheme,
   * validation throws.
   *
   * **Validates: Requirements 1.1, 1.2**
   */
  it("strings without valid scheme are rejected", () => {
    const arbNoScheme = arbHostname.map((host) => host);

    fc.assert(
      fc.property(arbNoScheme, (noScheme) => {
        expect(() => validateOrigin(noScheme)).toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
