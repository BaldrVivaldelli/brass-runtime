import type { EngineEvent, WasmBridge } from "../types";
import type { FiberId, NodeId, OpcodeNode, OpcodeProgram, RefId } from "../opcodes";
import { resolveWasmModule, wasmModuleResolutionErrors } from "../../wasmModule";

type WasmVmModule = {
  BrassWasmVm: new () => {
    create_fiber(programJson: string): number;
    poll(fiberId: number): string;
    provide_value(fiberId: number, valueRef: number): string;
    provide_error(fiberId: number, errorRef: number): string;
    provide_effect(fiberId: number, root: number, nodesJson: string): string;
    interrupt(fiberId: number, reasonRef: number): string;
    drop_fiber(fiberId: number): void;
    stats_json(): string;
  };
};

export class WasmPackFiberBridge implements WasmBridge {
  readonly kind = "wasm" as const;
  private readonly vm: InstanceType<WasmVmModule["BrassWasmVm"]>;

  constructor(modulePath?: string) {
    const mod = loadWasmModule(modulePath) as WasmVmModule;
    this.vm = new mod.BrassWasmVm();
  }

  createFiber(program: OpcodeProgram): FiberId {
    return this.vm.create_fiber(JSON.stringify(program));
  }

  poll(fiberId: FiberId): EngineEvent {
    return JSON.parse(this.vm.poll(fiberId)) as EngineEvent;
  }

  provideValue(fiberId: FiberId, valueRef: RefId): EngineEvent {
    return JSON.parse(this.vm.provide_value(fiberId, valueRef)) as EngineEvent;
  }

  provideError(fiberId: FiberId, errorRef: RefId): EngineEvent {
    return JSON.parse(this.vm.provide_error(fiberId, errorRef)) as EngineEvent;
  }

  provideEffect(fiberId: FiberId, root: NodeId, nodes: OpcodeNode[]): EngineEvent {
    return JSON.parse(this.vm.provide_effect(fiberId, root, JSON.stringify(nodes))) as EngineEvent;
  }

  interrupt(fiberId: FiberId, reasonRef: RefId): EngineEvent {
    return JSON.parse(this.vm.interrupt(fiberId, reasonRef)) as EngineEvent;
  }

  dropFiber(fiberId: FiberId): void {
    this.vm.drop_fiber(fiberId);
  }

  stats(): unknown {
    return JSON.parse(this.vm.stats_json()) as unknown;
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
