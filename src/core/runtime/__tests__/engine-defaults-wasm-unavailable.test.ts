import { describe, expect, it, vi } from "vitest";

/**
 * Validates: Requirement 4.5
 *
 * Tests that a descriptive error is thrown when WASM is explicitly requested
 * but not available. Uses vi.mock to force WASM module resolution to return null.
 */

vi.mock("../wasmModule", () => ({
  resolveWasmModule: () => null,
  resetWasmModuleCache: () => {},
  wasmModuleResolutionErrors: () => [],
  wasmModuleCandidates: () => [],
}));

describe("Descriptive error when WASM not available (Req 4.5)", () => {
  it("ring buffer throws descriptive error mentioning build:wasm", async () => {
    // Dynamic import to ensure mock is applied
    const { makeBoundedRingBuffer } = await import("../boundedRingBuffer");
    expect(() => makeBoundedRingBuffer<number>(10, 10, { engine: "wasm" })).toThrow(
      /not available.*build:wasm/i
    );
  });

  it("chunker throws descriptive error mentioning build:wasm", async () => {
    const { makeStreamChunker } = await import("../../stream/chunks");
    expect(() => makeStreamChunker<number>(5, { engine: "wasm" })).toThrow(
      /not available.*build:wasm/i
    );
  });

  it("scheduler throws descriptive error mentioning build:wasm", async () => {
    const { Scheduler } = await import("../scheduler");
    expect(() => new Scheduler({ engine: "wasm" })).toThrow(
      /not available.*build:wasm/i
    );
  });
});
