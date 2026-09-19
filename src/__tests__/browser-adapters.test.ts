import { describe, expect, it } from "vitest";
import {
  inspectStrictWasmModule,
  isStrictWasmModule,
  resetWasmModuleCache,
  resolveWasmModule,
  wasmModuleCandidates,
  wasmModuleResolutionErrors,
} from "../core/runtime/wasmModule.browser";
import {
  compressData,
  createDecompressor,
} from "../http/compression/decompressor.browser";

describe("browser-specific adapters", () => {
  it("keeps the synchronous Node WASM loader unavailable and explicit", () => {
    expect(resolveWasmModule()).toBeNull();
    expect(isStrictWasmModule(null)).toBe(false);
    expect(inspectStrictWasmModule(null)).toMatchObject({ compatible: false });
    expect(wasmModuleCandidates()).toEqual([]);
    expect(wasmModuleCandidates("custom.wasm.js")).toEqual(["custom.wasm.js"]);
    expect(wasmModuleResolutionErrors()[0]).toContain("browser builds");
    expect(resetWasmModuleCache()).toBeUndefined();
  });

  it("uses fetch passthrough decompression and rejects sync request compression", () => {
    const decompressor = createDecompressor();
    const input = new Uint8Array([1, 2, 3]);
    expect(decompressor.isPassthrough).toBe(true);
    expect(decompressor.decompress(input, "gzip")).toEqual({ ok: true, data: input });
    expect(() => compressData(input, "gzip")).toThrow(/unavailable in browser/i);
  });
});
