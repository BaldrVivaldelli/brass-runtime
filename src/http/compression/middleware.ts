// src/http/compression/middleware.ts
import { asyncFold, asyncSucceed, asyncFail } from "../../core/types/asyncEffect";
import type { HttpClientFn, HttpRequest, HttpWireResponse } from "../client";
import { httpBodyByteLength, httpBodyToBuffer } from "../body";
import { createDecompressor } from "./decompressor";
import type {
  CompressionConfig,
  CompressionMiddlewareResult,
  CompressionStats,
  MutableRequestCompressionStats,
  RequestCompressionConfig,
  RequestCompressionMiddlewareResult,
  RequestCompressionStats,
  Decompressor,
  MutableCompressionStats,
  SupportedEncoding,
} from "./types";
import { SUPPORTED_ENCODINGS, emptyRequestCompressionStats, emptyStats } from "./types";

/**
 * Injects the Accept-Encoding header into a request if not already present.
 */
function injectAcceptEncoding(
  req: HttpRequest,
  encodings: SupportedEncoding[],
): HttpRequest {
  const headers = req.headers ?? {};
  const hasAcceptEncoding = Object.keys(headers).some(
    (k) => k.toLowerCase() === "accept-encoding",
  );

  if (hasAcceptEncoding) return req;

  return {
    ...req,
    headers: {
      ...headers,
      "Accept-Encoding": encodings.join(", "),
    },
  };
}

/**
 * Checks if an encoding string is a supported encoding.
 */
function isSupportedEncoding(enc: string): enc is SupportedEncoding {
  return (SUPPORTED_ENCODINGS as readonly string[]).includes(enc);
}

/**
 * Processes a response, decompressing the body if needed.
 * Returns the (possibly modified) response.
 */
function processResponse(
  res: HttpWireResponse,
  decompressor: Decompressor,
  enabledEncodings: SupportedEncoding[],
  stats: MutableCompressionStats,
): HttpWireResponse {
  const contentEncodingKey = Object.keys(res.headers).find(
    (k) => k.toLowerCase() === "content-encoding",
  );

  const contentEncodingValue = contentEncodingKey
    ? res.headers[contentEncodingKey]?.trim()
    : undefined;

  // No Content-Encoding or identity — passthrough
  if (!contentEncodingValue || contentEncodingValue.toLowerCase() === "identity") {
    stats.passthroughCount++;
    return res;
  }

  // Parse encoding chain (may be comma-separated for multiple encodings)
  const encodings = contentEncodingValue
    .split(",")
    .map((e) => e.trim().toLowerCase());

  // Process in reverse order (last-applied encoding first)
  const reversedEncodings = [...encodings].reverse();

  // Start with the body as a Buffer
  let currentData: Buffer = Buffer.from(res.bodyText, "latin1");
  const originalData = currentData;
  let decompressedCount = 0;

  for (let i = 0; i < reversedEncodings.length; i++) {
    const enc = reversedEncodings[i];

    // Check if encoding is supported
    if (!isSupportedEncoding(enc)) {
      // Unsupported encoding — stop decompression here
      stats.unsupportedEncodingCount++;

      if (decompressedCount === 0) {
        // No decompression happened at all — return original
        stats.passthroughCount++;
        return res;
      }

      // Partial decompression: return what we have with remaining encodings
      const remainingEncodings = reversedEncodings.slice(i).reverse();
      const newHeaders = { ...res.headers };
      if (contentEncodingKey) {
        newHeaders[contentEncodingKey] = remainingEncodings.join(", ");
      }
      newHeaders["Content-Length"] = String(currentData.byteLength);
      return {
        ...res,
        headers: newHeaders,
        bodyText: currentData.toString("latin1"),
      };
    }

    // Check if encoding is enabled in config
    if (!enabledEncodings.includes(enc)) {
      // Disabled encoding — skip decompression
      stats.passthroughCount++;

      if (decompressedCount === 0) {
        return res;
      }

      // Partial decompression with remaining encodings
      const remainingEncodings = reversedEncodings.slice(i).reverse();
      const newHeaders = { ...res.headers };
      if (contentEncodingKey) {
        newHeaders[contentEncodingKey] = remainingEncodings.join(", ");
      }
      newHeaders["Content-Length"] = String(currentData.byteLength);
      return {
        ...res,
        headers: newHeaders,
        bodyText: currentData.toString("latin1"),
      };
    }

    // Attempt decompression
    const result = decompressor.decompress(currentData, enc);

    if (!result.ok) {
      // Decompression error — return original response unchanged
      stats.errorCount++;
      return res;
    }

    // Track compressed bytes for this step
    stats.compressedBytes += currentData.byteLength;
    stats.decompressedBytes += result.data.byteLength;
    stats.decompressed[enc]++;
    decompressedCount++;
    currentData = result.data as Buffer;
  }

  // All encodings successfully decompressed
  const newHeaders = { ...res.headers };

  // Remove Content-Encoding header
  if (contentEncodingKey) {
    delete newHeaders[contentEncodingKey];
  }
  // Also remove any lowercase variant if different
  const lowerKey = Object.keys(newHeaders).find(
    (k) => k.toLowerCase() === "content-encoding",
  );
  if (lowerKey) {
    delete newHeaders[lowerKey];
  }

  // Update Content-Length
  newHeaders["Content-Length"] = String(currentData.byteLength);

  return {
    ...res,
    headers: newHeaders,
    bodyText: currentData.toString("utf-8"),
  };
}

/**
 * Creates the compression middleware with optional configuration.
 *
 * The middleware:
 * 1. Injects Accept-Encoding header on outgoing requests (if missing)
 * 2. Decompresses response bodies based on Content-Encoding header
 * 3. Tracks compression statistics
 */
export function makeCompressionMiddleware(
  config?: CompressionConfig,
): CompressionMiddlewareResult {
  const enabledEncodings: SupportedEncoding[] =
    config?.encodings ?? [...SUPPORTED_ENCODINGS];

  const decompressor = createDecompressor();
  const mutableStats = emptyStats();

  const middleware = (next: HttpClientFn): HttpClientFn => {
    return (req: HttpRequest) => {
      // 1. Inject Accept-Encoding if missing
      const modifiedReq = injectAcceptEncoding(req, enabledEncodings);

      // 2. Call downstream and process response
      return asyncFold(
        next(modifiedReq),
        // Pass HttpErrors through unchanged
        (error) => asyncFail(error),
        // Process successful responses
        (res) => {
          // In passthrough mode, skip decompression entirely
          if (decompressor.isPassthrough) {
            mutableStats.passthroughCount++;
            return asyncSucceed(res);
          }

          // Decompress if needed
          const processed = processResponse(
            res,
            decompressor,
            enabledEncodings,
            mutableStats,
          );
          return asyncSucceed(processed);
        },
      );
    };
  };

  const stats = (): CompressionStats =>
    Object.freeze({
      decompressed: Object.freeze({ ...mutableStats.decompressed }),
      compressedBytes: mutableStats.compressedBytes,
      decompressedBytes: mutableStats.decompressedBytes,
      passthroughCount: mutableStats.passthroughCount,
      errorCount: mutableStats.errorCount,
      unsupportedEncodingCount: mutableStats.unsupportedEncodingCount,
    });

  return { middleware, stats };
}

export const makeResponseCompressionMiddleware = makeCompressionMiddleware;

const DEFAULT_REQUEST_COMPRESS_METHODS = ["POST", "PUT", "PATCH"];

export function makeRequestCompressionMiddleware(
  config?: RequestCompressionConfig,
): RequestCompressionMiddlewareResult {
  const encoding = config?.encoding ?? "gzip";
  const minBytes = Math.max(0, Math.floor(config?.minBytes ?? 1024));
  const methods = new Set((config?.methods ?? DEFAULT_REQUEST_COMPRESS_METHODS).map((m) => m.toUpperCase()));
  const mutableStats = emptyRequestCompressionStats();

  const middleware = (next: HttpClientFn): HttpClientFn => {
    return (req: HttpRequest) => {
      const compressed = compressRequest(req, encoding, minBytes, methods, mutableStats);
      return next(compressed);
    };
  };

  const stats = (): RequestCompressionStats =>
    Object.freeze({
      compressedCount: mutableStats.compressedCount,
      skippedCount: mutableStats.skippedCount,
      errorCount: mutableStats.errorCount,
      originalBytes: mutableStats.originalBytes,
      compressedBytes: mutableStats.compressedBytes,
    });

  return { middleware, stats };
}

function compressRequest(
  req: HttpRequest,
  encoding: SupportedEncoding,
  minBytes: number,
  methods: ReadonlySet<string>,
  stats: MutableRequestCompressionStats,
): HttpRequest {
  if (!methods.has(req.method.toUpperCase())) {
    stats.skippedCount++;
    return req;
  }

  if (req.body === undefined || hasHeader(req.headers, "content-encoding")) {
    stats.skippedCount++;
    return req;
  }

  const originalBytes = httpBodyByteLength(req.body);
  if (originalBytes < minBytes) {
    stats.skippedCount++;
    return req;
  }

  try {
    const compressed = compressBuffer(httpBodyToBuffer(req.body), encoding);
    stats.compressedCount++;
    stats.originalBytes += originalBytes;
    stats.compressedBytes += compressed.byteLength;
    return {
      ...req,
      body: compressed,
      headers: setHeaders(req.headers, {
        "Content-Encoding": encoding,
        "Content-Length": String(compressed.byteLength),
      }),
    };
  } catch {
    stats.errorCount++;
    return req;
  }
}

function compressBuffer(input: Buffer, encoding: SupportedEncoding): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require("node:zlib") as typeof import("node:zlib");
  switch (encoding) {
    case "gzip":
      return zlib.gzipSync(input);
    case "br":
      return zlib.brotliCompressSync(input);
    case "deflate":
      return zlib.deflateSync(input);
  }
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) return false;
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function setHeaders(
  headers: Record<string, string> | undefined,
  values: Record<string, string>,
): Record<string, string> {
  const out = { ...(headers ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    const existing = Object.keys(out).find((h) => h.toLowerCase() === key.toLowerCase());
    if (existing) out[existing] = value;
    else out[key] = value;
  }
  return out;
}
