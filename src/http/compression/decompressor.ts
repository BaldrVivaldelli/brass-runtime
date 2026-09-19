// src/http/compression/decompressor.ts
import zlib from "node:zlib";
import { isNodeEnvironment } from "./environment";
import type { Decompressor } from "./types";
import type { SupportedEncoding } from "./types";
import { createNodeDecompressor } from "./decompressor.node.js";
import { createNoopDecompressor } from "./decompressor.noop";

/**
 * Creates the appropriate decompressor for the current runtime.
 * - Node.js: uses `zlib` for real decompression
 * - Browser/other: passthrough (no-op)
 */
export function createDecompressor(): Decompressor {
  if (isNodeEnvironment()) {
    return createNodeDecompressor(zlib);
  }

  return createNoopDecompressor();
}

export function compressData(input: Uint8Array, encoding: SupportedEncoding): Uint8Array {
  switch (encoding) {
    case "gzip":
      return zlib.gzipSync(input);
    case "br":
      return zlib.brotliCompressSync(input);
    case "deflate":
      return zlib.deflateSync(input);
  }
}
