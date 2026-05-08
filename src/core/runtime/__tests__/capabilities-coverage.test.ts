import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../wasmModule");
});

describe("runtime capabilities", () => {
  it("reports unavailable WASM capabilities when no module resolves", async () => {
    vi.doMock("../wasmModule", () => ({ resolveWasmModule: () => null }));
    const { runtimeCapabilities } = await import("../capabilities");

    expect(runtimeCapabilities()).toEqual({
      wasmAvailable: false,
      wasmFiberEngine: false,
      wasmRingBuffer: false,
      wasmScheduler: false,
      wasmFiberRegistry: false,
      wasmFiberReadyQueue: false,
      wasmBinaryAbi: false,
      wasmStreamChunks: false,
    });
  });

  it("detects individual WASM exports and the binary VM ABI", async () => {
    class BinaryVm {
      create_fiber_bin() { return undefined; }
      drive_batch_bin() { return undefined; }
      provide_value_bin() { return undefined; }
      provide_error_bin() { return undefined; }
      provide_effect_bin() { return undefined; }
      interrupt_bin() { return undefined; }
    }
    vi.doMock("../wasmModule", () => ({
      resolveWasmModule: () => ({
        BrassWasmVm: BinaryVm,
        BrassWasmRingBuffer: class {},
        BrassWasmSchedulerStateMachine: class {},
        BrassWasmFiberRegistry: class {},
        BrassWasmFiberReadyQueue: class {},
        BrassWasmChunkBuffer: class {},
      }),
    }));
    const { runtimeCapabilities } = await import("../capabilities");

    expect(runtimeCapabilities()).toEqual({
      wasmAvailable: true,
      wasmFiberEngine: true,
      wasmRingBuffer: true,
      wasmScheduler: true,
      wasmFiberRegistry: true,
      wasmFiberReadyQueue: true,
      wasmBinaryAbi: true,
      wasmStreamChunks: true,
    });
  });

  it("treats a throwing WASM VM constructor as missing binary ABI", async () => {
    class ThrowingVm {
      constructor() {
        throw new Error("bad wasm");
      }
    }
    vi.doMock("../wasmModule", () => ({ resolveWasmModule: () => ({ BrassWasmVm: ThrowingVm }) }));
    const { runtimeCapabilities } = await import("../capabilities");

    expect(runtimeCapabilities()).toMatchObject({
      wasmAvailable: true,
      wasmFiberEngine: true,
      wasmBinaryAbi: false,
    });
  });
});
