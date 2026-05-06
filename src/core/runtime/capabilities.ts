import { resolveWasmModule } from "./wasmModule";

export type RuntimeCapabilities = {
  wasmAvailable: boolean;
  wasmFiberEngine: boolean;
  wasmRingBuffer: boolean;
  wasmScheduler: boolean;
  wasmFiberRegistry: boolean;
  wasmFiberReadyQueue: boolean;
  wasmBinaryAbi: boolean;
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
    wasmFiberReadyQueue: typeof mod?.BrassWasmFiberReadyQueue === "function",
    wasmBinaryAbi: hasBinaryVmAbi(mod),
    wasmStreamChunks: typeof mod?.BrassWasmChunkBuffer === "function",
  };
}

function hasBinaryVmAbi(mod: Record<string, unknown> | null): boolean {
  const Ctor = mod?.BrassWasmVm as (new () => unknown) | undefined;
  if (typeof Ctor !== "function") return false;
  try {
    const vm = new Ctor() as Record<string, unknown>;
    return typeof vm.create_fiber_bin === "function" &&
      typeof vm.drive_batch_bin === "function" &&
      typeof vm.provide_value_bin === "function" &&
      typeof vm.provide_error_bin === "function" &&
      typeof vm.provide_effect_bin === "function" &&
      typeof vm.interrupt_bin === "function";
  } catch {
    return false;
  }
}
