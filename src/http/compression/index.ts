// src/http/compression/index.ts
export {
  makeCompressionMiddleware,
  makeResponseCompressionMiddleware,
  makeRequestCompressionMiddleware,
} from "./middleware";
export type {
  SupportedEncoding,
  CompressionConfig,
  RequestCompressionConfig,
  CompressionStats,
  RequestCompressionStats,
  CompressionMiddlewareResult,
  RequestCompressionMiddlewareResult,
  Decompressor,
  DecompressResult,
} from "./types";
export { SUPPORTED_ENCODINGS } from "./types";
