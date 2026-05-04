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

export class HostRegistry {
  private nextRef = 1;
  private readonly refs = new Map<RefId, unknown>();

  register<T>(value: T): RefId {
    const ref = this.nextRef++;
    this.refs.set(ref, value);
    return ref;
  }

  get<T>(ref: RefId): T {
    if (!this.refs.has(ref)) {
      throw new Error(`Missing host registry ref ${ref}`);
    }
    return this.refs.get(ref) as T;
  }

  set(ref: RefId, value: unknown): void {
    this.refs.set(ref, value);
  }

  delete(ref: RefId): void {
    this.refs.delete(ref);
  }

  clear(): void {
    this.refs.clear();
  }

  size(): number {
    return this.refs.size;
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
