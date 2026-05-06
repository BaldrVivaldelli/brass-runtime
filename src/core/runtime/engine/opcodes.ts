import type { Async } from "../../types/asyncEffect";
import type { HostAction, HostActionResult } from "../hostAction";

export type NodeId = number;
export type RefId = number;
export type FiberId = number;

export type OpcodeNode =
  | { readonly tag: "Succeed"; readonly valueRef: RefId }
  | { readonly tag: "Fail"; readonly errorRef: RefId }
  | { readonly tag: "Sync"; readonly fnRef: RefId }
  | { readonly tag: "Async"; readonly registerRef: RefId }
  | { readonly tag: "FlatMap"; readonly first: NodeId; readonly fnRef: RefId }
  | { readonly tag: "Fold"; readonly first: NodeId; readonly onFailureRef: RefId; readonly onSuccessRef: RefId }
  | { readonly tag: "Fork"; readonly effectRef: RefId; readonly scopeId?: number }
  | { readonly tag: "HostAction"; readonly actionRef: RefId; readonly decodeRef?: RefId };

export type OpcodeProgram = {
  readonly version: 1;
  readonly root: NodeId;
  readonly nodes: OpcodeNode[];
};

export type ProgramPatch = {
  readonly root: NodeId;
  readonly nodes: OpcodeNode[];
};

export type SyncRef<R = unknown> = (env: R) => unknown;
export type AsyncRegisterRef<R = unknown> = (env: R, cb: (exit: unknown) => void) => void | (() => void);
export type FlatMapRef<R = unknown> = (value: unknown) => Async<R, unknown, unknown>;
export type FoldFailureRef<R = unknown> = (error: unknown) => Async<R, unknown, unknown>;
export type FoldSuccessRef<R = unknown> = (value: unknown) => Async<R, unknown, unknown>;
export type DecodeRef = (result: HostActionResult) => unknown;

export type HostRegistryStats = {
  readonly live: number;
  readonly capacity: number;
  readonly allocated: number;
  readonly released: number;
  readonly reused: number;
  readonly staleReads: number;
};

type HostSlot = {
  value: unknown;
  generation: number;
  occupied: boolean;
};

const REF_INDEX_BITS = 20;
const REF_INDEX_MASK = (1 << REF_INDEX_BITS) - 1;
const REF_GENERATION_SHIFT = REF_INDEX_BITS;
const REF_GENERATION_MASK = (1 << (32 - REF_INDEX_BITS)) - 1;

function encodeRef(index: number, generation: number): RefId {
  return (((generation & REF_GENERATION_MASK) << REF_GENERATION_SHIFT) | (index & REF_INDEX_MASK)) >>> 0;
}

function decodeRef(ref: RefId): { index: number; generation: number } {
  return {
    index: ref & REF_INDEX_MASK,
    generation: (ref >>> REF_GENERATION_SHIFT) & REF_GENERATION_MASK,
  };
}

/**
 * Slab-backed registry for JS values referenced by the WASM VM.
 *
 * Refs are generational u32 handles: stale refs fail fast after a slot is
 * released/reused. clear() releases all live slots, which is called when a
 * fiber completes so callbacks, errors, decoders and intermediate values do not
 * stay retained by the engine.
 */
export class HostRegistry {
  private readonly slots: HostSlot[] = [{ value: undefined, generation: 0, occupied: false }];
  private readonly free: number[] = [];
  private live = 0;
  private allocated = 0;
  private released = 0;
  private reused = 0;
  private staleReads = 0;

  register<T>(value: T): RefId {
    const index = this.free.pop() ?? this.slots.length;
    let slot = this.slots[index];
    if (slot) {
      this.reused += 1;
      slot.value = value;
      slot.occupied = true;
      slot.generation = ((slot.generation + 1) & REF_GENERATION_MASK) || 1;
    } else {
      slot = { value, generation: 1, occupied: true };
      this.slots[index] = slot;
    }
    this.live += 1;
    this.allocated += 1;
    return encodeRef(index, slot.generation);
  }

  get<T>(ref: RefId): T {
    const { index, generation } = decodeRef(ref);
    const slot = this.slots[index];
    if (!slot || !slot.occupied || slot.generation !== generation) {
      this.staleReads += 1;
      throw new Error(`Missing or stale host registry ref ${ref}`);
    }
    return slot.value as T;
  }

  set(ref: RefId, value: unknown): void {
    const { index, generation } = decodeRef(ref);
    const slot = this.slots[index];
    if (!slot || !slot.occupied || slot.generation !== generation) {
      this.staleReads += 1;
      throw new Error(`Missing or stale host registry ref ${ref}`);
    }
    slot.value = value;
  }

  delete(ref: RefId): void {
    const { index, generation } = decodeRef(ref);
    const slot = this.slots[index];
    if (!slot || !slot.occupied || slot.generation !== generation) return;
    slot.value = undefined;
    slot.occupied = false;
    this.live = Math.max(0, this.live - 1);
    this.released += 1;
    this.free.push(index);
  }

  clear(): void {
    for (let index = 1; index < this.slots.length; index++) {
      const slot = this.slots[index];
      if (!slot?.occupied) continue;
      slot.value = undefined;
      slot.occupied = false;
      this.free.push(index);
      this.released += 1;
    }
    this.live = 0;
  }

  size(): number {
    return this.live;
  }

  stats(): HostRegistryStats {
    return {
      live: this.live,
      capacity: Math.max(0, this.slots.length - 1),
      allocated: this.allocated,
      released: this.released,
      reused: this.reused,
      staleReads: this.staleReads,
    };
  }
}

export type CompiledProgram = {
  readonly program: OpcodeProgram;
  readonly registry: HostRegistry;
};

export class ProgramBuilder {
  private readonly nodes: OpcodeNode[] = [];
  private readonly registry = new HostRegistry();

  compile(effect: Async<unknown, unknown, unknown>): CompiledProgram {
    const root = this.visit(effect);
    return {
      program: {
        version: 1,
        root,
        nodes: this.nodes,
      },
      registry: this.registry,
    };
  }

  append(effect: Async<unknown, unknown, unknown>): ProgramPatch {
    const previousNodes = this.nodes.length;
    const root = this.visit(effect);
    return {
      root,
      nodes: this.nodes.slice(previousNodes),
    };
  }

  private add(node: OpcodeNode): NodeId {
    const id = this.nodes.length;
    this.nodes.push(node);
    return id;
  }

  private visit(effect: Async<unknown, unknown, unknown>): NodeId {
    const current = effect as any;
    switch (current._tag) {
      case "Succeed":
        return this.add({ tag: "Succeed", valueRef: this.registry.register(current.value) });

      case "Fail":
        return this.add({ tag: "Fail", errorRef: this.registry.register(current.error) });

      case "Sync":
        return this.add({ tag: "Sync", fnRef: this.registry.register(current.thunk as SyncRef) });

      case "Async":
        return this.add({ tag: "Async", registerRef: this.registry.register(current.register as AsyncRegisterRef) });

      case "FlatMap":
        return this.add({
          tag: "FlatMap",
          first: this.visit(current.first),
          fnRef: this.registry.register(current.andThen as FlatMapRef),
        });

      case "Fold":
        return this.add({
          tag: "Fold",
          first: this.visit(current.first),
          onFailureRef: this.registry.register(current.onFailure as FoldFailureRef),
          onSuccessRef: this.registry.register(current.onSuccess as FoldSuccessRef),
        });

      case "Fork": {
        const base = {
          tag: "Fork" as const,
          effectRef: this.registry.register(current.effect as Async<unknown, unknown, unknown>),
        };
        return this.add(current.scopeId === undefined ? base : { ...base, scopeId: current.scopeId });
      }

      case "HostAction": {
        const base = {
          tag: "HostAction" as const,
          actionRef: this.registry.register(current.action as HostAction),
        };
        return this.add(current.decode === undefined ? base : { ...base, decodeRef: this.registry.register(current.decode as DecodeRef) });
      }

      default:
        return this.add({ tag: "Fail", errorRef: this.registry.register(new Error(`Unknown Async opcode: ${current?._tag}`)) });
    }
  }
}
