// src/http/lifecycle/dedupKey.ts
import type { HttpRequest } from "../client";
import { httpBodyKeyPart } from "../body";
import { SEPARATOR } from "./cacheKey";

/**
 * Hop-by-hop headers excluded from dedup key computation.
 * These are connection-specific and should not affect request identity.
 */
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Safe HTTP methods eligible for request deduplication.
 */
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Computes a deterministic dedup key string from an HTTP request.
 *
 * Similar to `computeCacheKey` but excludes hop-by-hop headers and the
 * Authorization header, since deduplication should collapse requests that
 * differ only in connection-specific or auth headers.
 *
 * @param req - The HTTP request to compute a dedup key for
 * @param baseUrl - Base URL for resolving relative request URLs
 * @returns A deterministic dedup key string
 */
export function computeDedupKey(req: HttpRequest, baseUrl: string): string {
  const method = req.method.toUpperCase();
  const resolvedUrl = new URL(req.url, baseUrl || undefined).toString();

  const headers = req.headers ?? {};
  const sortedHeaders = Object.keys(headers)
    .filter((k) => {
      const lower = k.toLowerCase();
      return !HOP_BY_HOP.has(lower) && lower !== "authorization";
    })
    .sort()
    .map((k) => `${k.toLowerCase()}:${headers[k]}`)
    .join(",");

  const body = httpBodyKeyPart(req.body);

  return `${method}${SEPARATOR}${resolvedUrl}${SEPARATOR}${sortedHeaders}${SEPARATOR}${body}`;
}
