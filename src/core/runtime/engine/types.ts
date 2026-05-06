import type { Async } from "../../types/asyncEffect";
import type { Exit } from "../../types/effect";
import type { Fiber } from "../fiber";
import type { HostExecutor } from "../hostAction";
import type { FiberId, NodeId, OpcodeNode, OpcodeProgram, RefId } from "./opcodes";

export type FiberEngineKind = "ts" | "wasm";
export type RuntimeEngineMode = FiberEngineKind;

export type FiberEngineStats = {
  readonly engine: string;
  readonly startedFibers: number;
  readonly runningFibers: number;
  readonly suspendedFibers: number;
  readonly queuedFibers: number;
  readonly completedFibers: number;
  readonly failedFibers: number;
  readonly interruptedFibers: number;
  readonly pendingHostEffects: number;
  readonly hostRegistryRefs?: number;
  readonly hostRegistryStats?: unknown;
  readonly wasm?: unknown;
  readonly fiberRegistry?: unknown;
  readonly readyQueue?: unknown;
  readonly timerWheel?: unknown;
};

export interface FiberEngine<R = unknown> {
  readonly kind: FiberEngineKind;
  fork<E, A>(effect: Async<R, E, A>, scopeId?: number): Fiber<E, A> & { schedule?: (tag?: string) => void };
  stats(): FiberEngineStats;
  shutdown?(): Promise<void> | void;
}

export type WasmEngineRuntime<R = unknown> = {
  readonly env: R;
  readonly hostExecutor: HostExecutor<R>;
  readonly scheduler: { schedule(task: () => void, label?: string): unknown };
  readonly hooks: { emit(ev: any, ctx: any): void };
  fork<E, A>(effect: Async<R, E, A>, scopeId?: number): Fiber<E, A>;
};

export type EngineEvent =
  | { readonly kind: "Continue"; readonly fiberId: FiberId }
  | { readonly kind: "Done"; readonly fiberId: FiberId; readonly valueRef: RefId }
  | { readonly kind: "Failed"; readonly fiberId: FiberId; readonly errorRef: RefId }
  | { readonly kind: "Interrupted"; readonly fiberId: FiberId; readonly reasonRef: RefId }
  | { readonly kind: "InvokeSync"; readonly fiberId: FiberId; readonly fnRef: RefId }
  | { readonly kind: "InvokeAsync"; readonly fiberId: FiberId; readonly registerRef: RefId }
  | { readonly kind: "InvokeFlatMap"; readonly fiberId: FiberId; readonly fnRef: RefId; readonly valueRef: RefId }
  | { readonly kind: "InvokeFoldFailure"; readonly fiberId: FiberId; readonly fnRef: RefId; readonly errorRef: RefId }
  | { readonly kind: "InvokeFoldSuccess"; readonly fiberId: FiberId; readonly fnRef: RefId; readonly valueRef: RefId }
  | { readonly kind: "InvokeFork"; readonly fiberId: FiberId; readonly effectRef: RefId; readonly scopeId?: number }
  | { readonly kind: "InvokeHostAction"; readonly fiberId: FiberId; readonly actionRef: RefId; readonly decodeRef?: RefId };

export interface WasmBridge {
  readonly kind: "wasm";
  readonly supportsBinary?: boolean;
  readonly supportsZeroCopy?: boolean;
  readonly supportsNoJsonMetrics?: boolean;
  createFiber(program: OpcodeProgram): FiberId;
  poll(fiberId: FiberId): EngineEvent;
  driveBatch?(fiberId: FiberId, budget: number): readonly EngineEvent[];
  provideValue(fiberId: FiberId, valueRef: RefId): EngineEvent;
  provideValueBatch?(fiberId: FiberId, valueRef: RefId, budget: number): readonly EngineEvent[];
  provideError(fiberId: FiberId, errorRef: RefId): EngineEvent;
  provideErrorBatch?(fiberId: FiberId, errorRef: RefId, budget: number): readonly EngineEvent[];
  provideEffect(fiberId: FiberId, root: NodeId, nodes: OpcodeNode[]): EngineEvent;
  provideEffectBatch?(fiberId: FiberId, root: NodeId, nodes: OpcodeNode[], budget: number): readonly EngineEvent[];
  interrupt(fiberId: FiberId, reasonRef: RefId): EngineEvent;
  interruptBatch?(fiberId: FiberId, reasonRef: RefId, budget: number): readonly EngineEvent[];
  dropFiber(fiberId: FiberId): void;
  stats(): unknown;
}

export type Joiner<E, A> = (exit: Exit<E, A>) => void;
