import { createNoopDecompressor } from "./decompressor.noop";
import type { Decompressor, SupportedEncoding } from "./types";

/** Browsers already decompress fetch responses transparently. */
export function createDecompressor(): Decompressor {
  return createNoopDecompressor();
}

/**
 * Synchronous request compression is Node-only. The middleware catches this
 * error and leaves the request unchanged while recording an error statistic.
 */
export function compressData(
  _input: Uint8Array,
  _encoding: SupportedEncoding,
): Uint8Array {
  throw new Error("Synchronous request compression is unavailable in browser builds");
}
