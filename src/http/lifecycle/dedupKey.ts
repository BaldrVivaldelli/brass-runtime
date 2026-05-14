// src/http/lifecycle/dedupKey.ts
import type { HttpRequest } from "../client";
import { httpBodyKeyPart } from "../body";
import { resolveKeyUrl, SEPARATOR } from "./cacheKey";

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
/**
 * Pre-computed dedup key context.
 */
export type DedupKeyContext = {
  readonly baseUrl: string;
  readonly cachedOrigin: string | undefined;
};

import { absoluteOrigin } from "./cacheKey";

/**
 * Pre-compute the dedup key context once at middleware construction.
 */
export function makeDedupKeyContext(baseUrl: string): DedupKeyContext {
  return {
    baseUrl,
    cachedOrigin: baseUrl ? absoluteOrigin(baseUrl) : undefined,
  };
}

/**
 * Fast-path dedup key computation using a pre-computed context.
 */
export function computeDedupKeyFast(req: HttpRequest, ctx: DedupKeyContext): string {
  // Skip toUpperCase if already uppercase
  const m: string = req.method;
  const method = (m === "GET" || m === "POST" || m === "PUT" || m === "DELETE" || m === "PATCH" || m === "HEAD" || m === "OPTIONS")
    ? m
    : (m as string).toUpperCase();

  // Resolve URL — fast path for absolute paths with cached origin
  let resolvedUrl: string;
  const url = req.url;
  if (ctx.cachedOrigin && url.length > 0 && url.charCodeAt(0) === 47 && url.charCodeAt(1) !== 47) {
    resolvedUrl = ctx.cachedOrigin + url;
  } else {
    resolvedUrl = resolveKeyUrl(url, ctx.baseUrl);
  }

  // Header filtering — skip if no headers
  const headers = req.headers;
  let sortedHeaders = "";
  if (headers) {
    const keys = Object.keys(headers);
    if (keys.length > 0) {
      const matched: string[] = [];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const lk = k.toLowerCase();
        if (!HOP_BY_HOP.has(lk) && lk !== "authorization") {
          matched.push(`${lk}:${headers[k]}`);
        }
      }
      if (matched.length > 0) {
        if (matched.length === 1) {
          sortedHeaders = matched[0];
        } else {
          matched.sort();
          sortedHeaders = matched.join(",");
        }
      }
    }
  }

  const body = httpBodyKeyPart(req.body);

  return `${method}${SEPARATOR}${resolvedUrl}${SEPARATOR}${sortedHeaders}${SEPARATOR}${body}`;
}

export function computeDedupKey(req: HttpRequest, baseUrl: string): string {
  const method = req.method.toUpperCase();
  const resolvedUrl = resolveKeyUrl(req.url, baseUrl);

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
