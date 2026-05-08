// src/http/lifecycle/cacheKey.ts
import type { HttpRequest } from "../client";
import { httpBodyKeyPart } from "../body";

/**
 * Components of a parsed Cache_Key, representing the individual parts
 * that make up a deterministic cache key string.
 *
 * @property method - The HTTP method (uppercase), e.g. "GET", "POST"
 * @property resolvedUrl - The fully resolved URL including base URL resolution
 * @property headers - Cache-relevant headers as key-value pairs (lowercase keys)
 * @property body - The request body string, or empty string if no body was present
 */
export type CacheKeyComponents = {
  method: string;
  resolvedUrl: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * Null character (`\u0000`) used as a separator between Cache_Key components.
 *
 * This non-printable character is chosen because it cannot appear in valid HTTP
 * method names, URLs, or header values, ensuring unambiguous key parsing via
 * `parseCacheKey`.
 */
export const SEPARATOR = "\u0000";

/**
 * Default set of HTTP headers included in Cache_Key computation.
 *
 * Value: `["accept", "authorization", "content-type"]`
 *
 * These headers are always factored into the cache key to ensure that requests
 * with different content negotiation, authentication, or body encoding are
 * cached separately. Additional headers can be included via the `extraHeaders`
 * parameter of `computeCacheKey` or the `cacheRelevantHeaders` option in `CacheConfig`.
 */
export const DEFAULT_CACHE_RELEVANT_HEADERS = ["accept", "authorization", "content-type"];

/**
 * Computes a deterministic Cache_Key string from an HTTP request.
 *
 * The key is composed of: method (uppercase), resolved URL, sorted filtered headers,
 * and body — concatenated with null character separators. The resulting string
 * uniquely identifies a cacheable request and can be round-tripped via `parseCacheKey`.
 *
 * @param req - The HTTP request to compute a Cache_Key for
 * @param baseUrl - Base URL for resolving relative request URLs
 * @param extraHeaders - Additional header names to include in the Cache_Key beyond
 *   the defaults in `DEFAULT_CACHE_RELEVANT_HEADERS`
 * @returns A deterministic Cache_Key string suitable for use as a cache lookup key
 *
 * @example
 * ```typescript
 * import { computeCacheKey } from "./cacheKey";
 *
 * const key = computeCacheKey(
 *   { method: "GET", url: "/users", headers: { accept: "application/json" } },
 *   "https://api.example.com"
 * );
 * // key is a deterministic string encoding method, URL, headers, and body
 * ```
 */
export function computeCacheKey(
  req: HttpRequest,
  baseUrl: string,
  extraHeaders: string[] = []
): string {
  const method = req.method.toUpperCase();
  const resolvedUrl = new URL(req.url, baseUrl || undefined).toString();

  const relevantSet = new Set([
    ...DEFAULT_CACHE_RELEVANT_HEADERS,
    ...extraHeaders.map((h) => h.toLowerCase()),
  ]);

  const headers = req.headers ?? {};
  const sortedHeaders = Object.keys(headers)
    .filter((k) => relevantSet.has(k.toLowerCase()))
    .sort()
    .map((k) => `${k.toLowerCase()}:${headers[k]}`)
    .join(",");

  const body = httpBodyKeyPart(req.body);

  return `${method}${SEPARATOR}${resolvedUrl}${SEPARATOR}${sortedHeaders}${SEPARATOR}${body}`;
}

/**
 * Parses a Cache_Key string back into its component parts.
 *
 * Splits on the null character separator and reconstructs the `CacheKeyComponents` object.
 * The body may contain separator characters, so all parts after the third separator
 * are joined back together as the body. This enables round-trip fidelity with
 * `computeCacheKey`.
 *
 * @param key - A Cache_Key string produced by `computeCacheKey`
 * @returns The parsed `CacheKeyComponents` with method, resolvedUrl, headers, and body
 *
 * @example
 * ```typescript
 * import { computeCacheKey, parseCacheKey } from "./cacheKey";
 *
 * const key = computeCacheKey(
 *   { method: "POST", url: "/data", headers: { "content-type": "application/json" }, body: '{"id":1}' },
 *   "https://api.example.com"
 * );
 * const parts = parseCacheKey(key);
 * // parts.method === "POST"
 * // parts.resolvedUrl === "https://api.example.com/data"
 * // parts.headers === { "content-type": "application/json" }
 * // parts.body === '{"id":1}'
 * ```
 */
export function parseCacheKey(key: string): CacheKeyComponents {
  const [method, resolvedUrl, headersStr, ...bodyParts] = key.split(SEPARATOR);
  const body = bodyParts.join(SEPARATOR); // body may contain separator

  const headers: Record<string, string> = {};
  if (headersStr) {
    for (const entry of headersStr.split(",")) {
      const colonIdx = entry.indexOf(":");
      if (colonIdx > 0) {
        headers[entry.slice(0, colonIdx)] = entry.slice(colonIdx + 1);
      }
    }
  }

  return { method: method!, resolvedUrl: resolvedUrl!, headers, body };
}
