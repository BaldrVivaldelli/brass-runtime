import type { Decompressor, DecompressResult, SupportedEncoding } from "./types";

/**
 * Creates a Node.js decompressor backed by the `zlib` built-in module.
 */
export function createNodeDecompressor(zlib: typeof import("node:zlib")): Decompressor {
  return {
    isPassthrough: false,

    decompress(data: Buffer | Uint8Array, encoding: SupportedEncoding): DecompressResult {
      try {
        const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
        let result: Buffer;

        switch (encoding) {
          case "gzip":
            result = zlib.gunzipSync(input);
            break;
          case "br":
            result = zlib.brotliDecompressSync(input);
            break;
          case "deflate":
            result = zlib.inflateSync(input);
            break;
          default:
            return { ok: false, error: `Unsupported encoding: ${encoding}` };
        }

        return { ok: true, data: result };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  };
}
