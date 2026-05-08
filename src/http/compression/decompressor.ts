// src/http/compression/decompressor.ts
import zlib from "node:zlib";
import { isNodeEnvironment } from "./environment";
import type { Decompressor } from "./types";
import { createNodeDecompressor } from "./decompressor.node";
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
