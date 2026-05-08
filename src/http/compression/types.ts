// src/http/compression/types.ts
import type { HttpMiddleware } from "../client";

/**
 * Supported content encoding algorithms.
 */
export type SupportedEncoding = "gzip" | "br" | "deflate";

/**
 * All supported encodings in default preference order (Brotli first).
 */
export const SUPPORTED_ENCODINGS: readonly SupportedEncoding[] = ["br", "gzip", "deflate"] as const;

/**
 * Configuration for the compression middleware.
 */
export type CompressionConfig = {
  /**
   * Enabled encodings in preference order.
   * Default: ["br", "gzip", "deflate"]
   */
  encodings?: SupportedEncoding[];
};

export type RequestCompressionConfig = {
  /**
   * Encoding to apply to outbound request bodies.
   * Default: "gzip".
   */
  encoding?: SupportedEncoding;
  /**
   * Minimum uncompressed body size in bytes before compression is attempted.
   * Default: 1024.
   */
  minBytes?: number;
  /**
   * HTTP methods eligible for request compression.
   * Default: ["POST", "PUT", "PATCH"].
   */
  methods?: readonly string[];
};

/**
 * Frozen snapshot of compression statistics.
 */
export type CompressionStats = {
  /** Responses decompressed per encoding type */
  readonly decompressed: Readonly<Record<SupportedEncoding, number>>;
  /** Total compressed bytes received */
  readonly compressedBytes: number;
  /** Total decompressed bytes produced */
  readonly decompressedBytes: number;
  /** Responses that bypassed decompression */
  readonly passthroughCount: number;
  /** Decompression errors encountered */
  readonly errorCount: number;
  /** Unsupported encoding warnings */
  readonly unsupportedEncodingCount: number;
};

export type RequestCompressionStats = {
  readonly compressedCount: number;
  readonly skippedCount: number;
  readonly errorCount: number;
  readonly originalBytes: number;
  readonly compressedBytes: number;
};

/**
 * Internal mutable stats used during middleware operation.
 */
export type MutableCompressionStats = {
  decompressed: Record<SupportedEncoding, number>;
  compressedBytes: number;
  decompressedBytes: number;
  passthroughCount: number;
  errorCount: number;
  unsupportedEncodingCount: number;
};

export type MutableRequestCompressionStats = {
  compressedCount: number;
  skippedCount: number;
  errorCount: number;
  originalBytes: number;
  compressedBytes: number;
};

/**
 * Factory for creating a fresh mutable stats object.
 */
export function emptyStats(): MutableCompressionStats {
  return {
    decompressed: { gzip: 0, br: 0, deflate: 0 },
    compressedBytes: 0,
    decompressedBytes: 0,
    passthroughCount: 0,
    errorCount: 0,
    unsupportedEncodingCount: 0,
  };
}

export function emptyRequestCompressionStats(): MutableRequestCompressionStats {
  return {
    compressedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    originalBytes: 0,
    compressedBytes: 0,
  };
}

/**
 * Result of a decompression attempt.
 */
export type DecompressResult =
  | { ok: true; data: Buffer }
  | { ok: false; error: string };

/**
 * Abstraction over zlib / noop decompression.
 */
export interface Decompressor {
  readonly isPassthrough: boolean;
  decompress(data: Buffer | Uint8Array, encoding: SupportedEncoding): DecompressResult;
}

/**
 * Result of makeCompressionMiddleware — the middleware plus a stats accessor.
 */
export type CompressionMiddlewareResult = {
  middleware: HttpMiddleware;
  stats: () => CompressionStats;
};

export type RequestCompressionMiddlewareResult = {
  middleware: HttpMiddleware;
  stats: () => RequestCompressionStats;
};
