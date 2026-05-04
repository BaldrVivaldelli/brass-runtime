import { resolveWasmModule } from "./wasmModule";

export type RuntimeCapabilities = {
  wasmAvailable: boolean;
  wasmFiberEngine: boolean;
  wasmRingBuffer: boolean;
  wasmScheduler: boolean;
  wasmFiberRegistry: boolean;
  wasmStreamChunks: boolean;
};

export function runtimeCapabilities(): RuntimeCapabilities {
  const mod = resolveWasmModule() as Record<string, unknown> | null;
  return {
    wasmAvailable: !!mod,
    wasmFiberEngine: typeof mod?.BrassWasmVm === "function",
    wasmRingBuffer: typeof mod?.BrassWasmRingBuffer === "function",
    wasmScheduler: typeof mod?.BrassWasmSchedulerStateMachine === "function",
    wasmFiberRegistry: typeof mod?.BrassWasmFiberRegistry === "function",
    wasmStreamChunks: typeof mod?.BrassWasmChunkBuffer === "function",
  };
}
