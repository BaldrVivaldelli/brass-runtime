import type { EngineEvent, WasmBridge } from "../types";
import type { FiberId, NodeId, OpcodeNode, OpcodeProgram, RefId } from "../opcodes";
import { decodeEventBatch, encodeOpcodeNodes, encodeOpcodeProgram } from "../binaryAbi";
import { resolveWasmModule, wasmModuleResolutionErrors } from "../../wasmModule";

type WasmMemoryLike = { readonly buffer: ArrayBufferLike };

type WasmVm = {
  create_fiber(programJson: string): number;
  poll(fiberId: number): string;
  provide_value(fiberId: number, valueRef: number): string;
  provide_error(fiberId: number, errorRef: number): string;
  provide_effect(fiberId: number, root: number, nodesJson: string): string;
  interrupt(fiberId: number, reasonRef: number): string;
  drop_fiber(fiberId: number): void;
  stats_json(): string;

  create_fiber_bin?: (programWords: Uint32Array) => number;
  drive_batch_bin?: (fiberId: number, budget: number) => Uint32Array;
  poll_bin?: (fiberId: number) => Uint32Array;
  provide_value_bin?: (fiberId: number, valueRef: number, budget: number) => Uint32Array;
  provide_error_bin?: (fiberId: number, errorRef: number, budget: number) => Uint32Array;
  provide_effect_bin?: (fiberId: number, root: number, nodesWords: Uint32Array, budget: number) => Uint32Array;
  interrupt_bin?: (fiberId: number, reasonRef: number, budget: number) => Uint32Array;

  memory?: () => WasmMemoryLike;
  prepare_program_words?: (wordLen: number) => number;
  prepare_patch_words?: (wordLen: number) => number;
  create_fiber_from_program_words?: (wordLen: number) => number;
  drive_batch_ptr?: (fiberId: number, budget: number) => number;
  event_batch_len?: () => number;
  provide_value_ptr?: (fiberId: number, valueRef: number, budget: number) => number;
  provide_error_ptr?: (fiberId: number, errorRef: number, budget: number) => number;
  provide_effect_from_words?: (fiberId: number, root: number, wordLen: number, budget: number) => number;
  interrupt_ptr?: (fiberId: number, reasonRef: number, budget: number) => number;
  metrics_snapshot_ptr?: () => number;
  metrics_snapshot_len?: () => number;
  metric_u64?: (id: number) => number;
};

type WasmVmModule = {
  BrassWasmVm: new () => WasmVm;
};

const VM_METRIC_NAMES = [
  "started",
  "live",
  "running",
  "suspended",
  "completed",
  "failed",
  "interrupted",
  "boundaryCalls",
  "batchesEmitted",
  "eventsEmitted",
  "eventsPerBoundaryCall",
  "maxEventsPerBoundaryCall",
  "binaryPrograms",
  "jsonPrograms",
  "binaryPatches",
  "jsonPatches",
  "zeroCopyPrograms",
  "zeroCopyPatches",
  "zeroCopyEventBatches",
  "fiberSlabLive",
  "fiberSlabCapacity",
  "fiberSlabReused",
  "fiberSlabReleased",
  "fiberSlabStaleReads",
] as const;

export class WasmPackFiberBridge implements WasmBridge {
  readonly kind = "wasm" as const;
  readonly supportsBinary: boolean;
  readonly supportsZeroCopy: boolean;
  readonly supportsNoJsonMetrics: boolean;
  private readonly vm: WasmVm;

  private jsonEventCalls = 0;
  private binaryEventCalls = 0;
  private zeroCopyEventCalls = 0;
  private eventsReceived = 0;
  private maxEventsPerCall = 0;
  private jsonPrograms = 0;
  private binaryPrograms = 0;
  private zeroCopyPrograms = 0;
  private jsonPatches = 0;
  private binaryPatches = 0;
  private zeroCopyPatches = 0;

  constructor(modulePath?: string) {
    const mod = loadWasmModule(modulePath) as WasmVmModule;
    this.vm = new mod.BrassWasmVm();
    this.supportsBinary = typeof this.vm.create_fiber_bin === "function" &&
      typeof this.vm.drive_batch_bin === "function" &&
      typeof this.vm.provide_value_bin === "function" &&
      typeof this.vm.provide_error_bin === "function" &&
      typeof this.vm.provide_effect_bin === "function" &&
      typeof this.vm.interrupt_bin === "function";
    this.supportsZeroCopy = typeof this.vm.memory === "function" &&
      typeof this.vm.prepare_program_words === "function" &&
      typeof this.vm.prepare_patch_words === "function" &&
      typeof this.vm.create_fiber_from_program_words === "function" &&
      typeof this.vm.drive_batch_ptr === "function" &&
      typeof this.vm.event_batch_len === "function" &&
      typeof this.vm.provide_value_ptr === "function" &&
      typeof this.vm.provide_error_ptr === "function" &&
      typeof this.vm.provide_effect_from_words === "function" &&
      typeof this.vm.interrupt_ptr === "function";
    this.supportsNoJsonMetrics = typeof this.vm.metrics_snapshot_ptr === "function" &&
      typeof this.vm.metrics_snapshot_len === "function" &&
      typeof this.vm.memory === "function";

    this.assertStrictWasmHotPath();
  }

  createFiber(program: OpcodeProgram): FiberId {
    const words = encodeOpcodeProgram(program);
    this.writeWords(this.vm.prepare_program_words!(words.length), words);
    this.zeroCopyPrograms += 1;
    return this.vm.create_fiber_from_program_words!(words.length);
  }

  poll(fiberId: FiberId): EngineEvent {
    return this.driveBatch(fiberId, 1)[0] ?? { kind: "Continue", fiberId };
  }

  driveBatch(fiberId: FiberId, budget: number): readonly EngineEvent[] {
    return this.decodeZeroCopy(this.vm.drive_batch_ptr!(fiberId, budget));
  }

  provideValue(fiberId: FiberId, valueRef: RefId): EngineEvent {
    return this.provideValueBatch(fiberId, valueRef, 1)[0] ?? { kind: "Continue", fiberId };
  }

  provideValueBatch(fiberId: FiberId, valueRef: RefId, budget: number): readonly EngineEvent[] {
    return this.decodeZeroCopy(this.vm.provide_value_ptr!(fiberId, valueRef, budget));
  }

  provideError(fiberId: FiberId, errorRef: RefId): EngineEvent {
    return this.provideErrorBatch(fiberId, errorRef, 1)[0] ?? { kind: "Continue", fiberId };
  }

  provideErrorBatch(fiberId: FiberId, errorRef: RefId, budget: number): readonly EngineEvent[] {
    return this.decodeZeroCopy(this.vm.provide_error_ptr!(fiberId, errorRef, budget));
  }

  provideEffect(fiberId: FiberId, root: NodeId, nodes: OpcodeNode[]): EngineEvent {
    return this.provideEffectBatch(fiberId, root, nodes, 1)[0] ?? { kind: "Continue", fiberId };
  }

  provideEffectBatch(fiberId: FiberId, root: NodeId, nodes: OpcodeNode[], budget: number): readonly EngineEvent[] {
    const words = encodeOpcodeNodes(nodes);
    this.writeWords(this.vm.prepare_patch_words!(words.length), words);
    this.zeroCopyPatches += 1;
    return this.decodeZeroCopy(this.vm.provide_effect_from_words!(fiberId, root, words.length, budget));
  }

  interrupt(fiberId: FiberId, reasonRef: RefId): EngineEvent {
    return this.interruptBatch(fiberId, reasonRef, 1)[0] ?? { kind: "Interrupted", fiberId, reasonRef };
  }

  interruptBatch(fiberId: FiberId, reasonRef: RefId, budget: number): readonly EngineEvent[] {
    return this.decodeZeroCopy(this.vm.interrupt_ptr!(fiberId, reasonRef, budget));
  }

  dropFiber(fiberId: FiberId): void {
    this.vm.drop_fiber(fiberId);
  }

  stats(): unknown {
    const wasmStats = this.readMetricsSnapshot();
    const eventCalls = this.binaryEventCalls + this.jsonEventCalls + this.zeroCopyEventCalls;
    return {
      ...wasmStats,
      bridge: {
        supportsBinary: this.supportsBinary,
        supportsZeroCopy: this.supportsZeroCopy,
        supportsNoJsonMetrics: this.supportsNoJsonMetrics,
        zeroCopyEventCalls: this.zeroCopyEventCalls,
        binaryEventCalls: this.binaryEventCalls,
        jsonEventCalls: this.jsonEventCalls,
        eventsReceived: this.eventsReceived,
        eventsPerCall: eventCalls === 0 ? 0 : this.eventsReceived / eventCalls,
        maxEventsPerCall: this.maxEventsPerCall,
        zeroCopyPrograms: this.zeroCopyPrograms,
        binaryPrograms: this.binaryPrograms,
        jsonPrograms: this.jsonPrograms,
        zeroCopyPatches: this.zeroCopyPatches,
        binaryPatches: this.binaryPatches,
        jsonPatches: this.jsonPatches,
      },
    };
  }


  private assertStrictWasmHotPath(): void {
    const missing: string[] = [];
    const required = [
      "memory",
      "prepare_program_words",
      "prepare_patch_words",
      "create_fiber_from_program_words",
      "drive_batch_ptr",
      "event_batch_len",
      "provide_value_ptr",
      "provide_error_ptr",
      "provide_effect_from_words",
      "interrupt_ptr",
      "metrics_snapshot_ptr",
      "metrics_snapshot_len",
    ] as const;

    for (const name of required) {
      if (typeof this.vm[name] !== "function") missing.push(name);
    }

    if (missing.length > 0) {
      throw new Error([
        "engine='wasm' requires the strict Rust/WASM hot path; TS/JSON/binary fallbacks are disabled.",
        "Run `npm run build:wasm` from the phase-4+ Rust sources and make sure wasm/pkg is current.",
        `Missing WASM exports: ${missing.join(", ")}`,
      ].join("\n"));
    }
  }

  private decodeZeroCopy(ptr: number): EngineEvent[] {
    this.zeroCopyEventCalls += 1;
    const len = this.vm.event_batch_len?.() ?? 0;
    const words = this.readU32(ptr, len);
    const events = decodeEventBatch(words);
    this.eventsReceived += events.length;
    this.maxEventsPerCall = Math.max(this.maxEventsPerCall, events.length);
    return events;
  }

  private memory(): WasmMemoryLike {
    const memory = this.vm.memory?.();
    if (!memory?.buffer) throw new Error("brass-runtime WASM memory is not available");
    return memory;
  }

  private readU32(ptr: number, len: number): Uint32Array {
    if (ptr === 0 || len === 0) return new Uint32Array(0);
    return new Uint32Array(this.memory().buffer, ptr, len);
  }

  private readF64(ptr: number, len: number): Float64Array {
    if (ptr === 0 || len === 0) return new Float64Array(0);
    return new Float64Array(this.memory().buffer, ptr, len);
  }

  private writeWords(ptr: number, words: Uint32Array): void {
    if (ptr === 0 && words.length > 0) throw new Error("brass-runtime WASM returned a null word pointer");
    new Uint32Array(this.memory().buffer, ptr, words.length).set(words);
  }

  private readMetricsSnapshot(): Record<string, number> {
    const ptr = this.vm.metrics_snapshot_ptr?.() ?? 0;
    const len = this.vm.metrics_snapshot_len?.() ?? 0;
    const view = this.readF64(ptr, len);
    const out: Record<string, number> = {};
    for (let i = 0; i < Math.min(view.length, VM_METRIC_NAMES.length); i++) {
      out[VM_METRIC_NAMES[i]] = view[i];
    }
    return out;
  }
}

function loadWasmModule(modulePath?: string): unknown {
  const mod = resolveWasmModule({ modulePath });
  if (mod) return mod;

  const errors = wasmModuleResolutionErrors();
  throw new Error([
    "engine='wasm' could not load wasm/pkg/brass_runtime_wasm_engine.js.",
    "Run `npm run build:wasm` first and make sure wasm/pkg is present in the package.",
    "For Node 18 + webpack, keep brass-runtime's wasm/pkg files available at runtime or externalize brass-runtime.",
    ...errors.map((error) => `- ${error}`),
  ].join("\n"));
}
