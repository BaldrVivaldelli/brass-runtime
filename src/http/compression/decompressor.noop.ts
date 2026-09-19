// src/http/compression/decompressor.noop.ts
import type { Decompressor, DecompressResult, SupportedEncoding } from "./types";

/**
 * Creates a no-op (passthrough) decompressor for browser environments.
 * Returns input data unchanged — browsers handle decompression natively.
 */
export function createNoopDecompressor(): Decompressor {
  return {
    isPassthrough: true,

    decompress(data: Uint8Array, _encoding: SupportedEncoding): DecompressResult {
      return { ok: true, data };
    },
  };
}
