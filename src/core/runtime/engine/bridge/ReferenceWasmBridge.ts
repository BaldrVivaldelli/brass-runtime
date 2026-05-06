import type { EngineEvent } from "../types";
import type { FiberId, NodeId, OpcodeNode, OpcodeProgram, RefId } from "../opcodes";

type Frame =
  | { readonly tag: "SuccessCont"; readonly fnRef: RefId }
  | { readonly tag: "FoldCont"; readonly onFailureRef: RefId; readonly onSuccessRef: RefId };

type FiberVm = {
  id: FiberId;
  program: OpcodeProgram;
  current: NodeId | undefined;
  stack: Frame[];
  status: "running" | "suspended" | "done" | "failed" | "interrupted";
  lastEvent: EngineEvent | undefined;
};

export class ReferenceWasmBridge {
  readonly kind = "wasm-reference" as const;

  private nextFiberId = 1;
  private readonly fibers = new Map<FiberId, FiberVm>();
  private started = 0;
  private completed = 0;
  private failed = 0;
  private interrupted = 0;
  private eventCalls = 0;
  private eventsReceived = 0;
  private maxEventsPerCall = 0;

  createFiber(program: OpcodeProgram): FiberId {
    const id = this.nextFiberId++;
    this.started += 1;
    this.fibers.set(id, {
      id,
      program: cloneProgram(program),
      current: program.root,
      stack: [],
      status: "running",
      lastEvent: undefined,
    });
    return id;
  }

  poll(fiberId: FiberId): EngineEvent {
    return this.driveBatch(fiberId, 1)[0] ?? { kind: "Continue", fiberId };
  }

  driveBatch(fiberId: FiberId, _budget: number): readonly EngineEvent[] {
    const fiber = this.mustFiber(fiberId);
    const event = fiber.status === "suspended" && fiber.lastEvent ? fiber.lastEvent : this.step(fiber);
    this.accountBatch(1);
    return [event];
  }

  provideValue(fiberId: FiberId, valueRef: RefId): EngineEvent {
    return this.provideValueBatch(fiberId, valueRef, 1)[0] ?? { kind: "Continue", fiberId };
  }

  provideValueBatch(fiberId: FiberId, valueRef: RefId, _budget: number): readonly EngineEvent[] {
    const fiber = this.mustFiber(fiberId);
    fiber.status = "running";
    fiber.lastEvent = undefined;
    const event = this.success(fiber, valueRef);
    this.accountBatch(1);
    return [event];
  }

  provideError(fiberId: FiberId, errorRef: RefId): EngineEvent {
    return this.provideErrorBatch(fiberId, errorRef, 1)[0] ?? { kind: "Continue", fiberId };
  }

  provideErrorBatch(fiberId: FiberId, errorRef: RefId, _budget: number): readonly EngineEvent[] {
    const fiber = this.mustFiber(fiberId);
    fiber.status = "running";
    fiber.lastEvent = undefined;
    const event = this.failure(fiber, errorRef);
    this.accountBatch(1);
    return [event];
  }

  provideEffect(fiberId: FiberId, root: NodeId, nodes: OpcodeNode[]): EngineEvent {
    return this.provideEffectBatch(fiberId, root, nodes, 1)[0] ?? { kind: "Continue", fiberId };
  }

  provideEffectBatch(fiberId: FiberId, root: NodeId, nodes: OpcodeNode[], _budget: number): readonly EngineEvent[] {
    const fiber = this.mustFiber(fiberId);
    fiber.status = "running";
    fiber.lastEvent = undefined;
    fiber.program.nodes.push(...nodes.map((node) => ({ ...node })) as OpcodeNode[]);
    fiber.current = root;
    const event = this.step(fiber);
    this.accountBatch(1);
    return [event];
  }

  interrupt(fiberId: FiberId, reasonRef: RefId): EngineEvent {
    return this.interruptBatch(fiberId, reasonRef, 1)[0] ?? { kind: "Interrupted", fiberId, reasonRef };
  }

  interruptBatch(fiberId: FiberId, reasonRef: RefId, _budget: number): readonly EngineEvent[] {
    const fiber = this.mustFiber(fiberId);
    fiber.status = "interrupted";
    fiber.current = undefined;
    fiber.stack = [];
    this.interrupted += 1;
    const event: EngineEvent = { kind: "Interrupted", fiberId, reasonRef };
    fiber.lastEvent = event;
    this.accountBatch(1);
    return [event];
  }

  dropFiber(fiberId: FiberId): void {
    this.fibers.delete(fiberId);
  }

  stats(): unknown {
    let running = 0;
    let suspended = 0;
    for (const fiber of this.fibers.values()) {
      if (fiber.status === "running") running += 1;
      if (fiber.status === "suspended") suspended += 1;
    }
    return {
      started: this.started,
      live: this.fibers.size,
      running,
      suspended,
      completed: this.completed,
      failed: this.failed,
      interrupted: this.interrupted,
      bridge: {
        supportsBinary: false,
        eventCalls: this.eventCalls,
        eventsReceived: this.eventsReceived,
        eventsPerCall: this.eventCalls === 0 ? 0 : this.eventsReceived / this.eventCalls,
        maxEventsPerCall: this.maxEventsPerCall,
      },
    };
  }

  private accountBatch(count: number): void {
    this.eventCalls += 1;
    this.eventsReceived += count;
    this.maxEventsPerCall = Math.max(this.maxEventsPerCall, count);
  }

  private mustFiber(fiberId: FiberId): FiberVm {
    const fiber = this.fibers.get(fiberId);
    if (!fiber) throw new Error(`Fiber ${fiberId} not found`);
    return fiber;
  }

  private step(fiber: FiberVm): EngineEvent {
    while (true) {
      if (fiber.status === "interrupted") {
        const event = fiber.lastEvent ?? { kind: "Interrupted" as const, fiberId: fiber.id, reasonRef: 0 };
        fiber.lastEvent = event;
        return event;
      }

      if (fiber.current === undefined) return this.markFailed(fiber, 0);
      const node = fiber.program.nodes[fiber.current];
      if (!node) return this.markFailed(fiber, 0);

      switch (node.tag) {
        case "Succeed":
          fiber.current = undefined;
          return this.success(fiber, node.valueRef);

        case "Fail":
          fiber.current = undefined;
          return this.failure(fiber, node.errorRef);

        case "Sync":
          return this.suspend(fiber, { kind: "InvokeSync", fiberId: fiber.id, fnRef: node.fnRef });

        case "Async":
          return this.suspend(fiber, { kind: "InvokeAsync", fiberId: fiber.id, registerRef: node.registerRef });

        case "FlatMap":
          fiber.stack.push({ tag: "SuccessCont", fnRef: node.fnRef });
          fiber.current = node.first;
          continue;

        case "Fold":
          fiber.stack.push({ tag: "FoldCont", onFailureRef: node.onFailureRef, onSuccessRef: node.onSuccessRef });
          fiber.current = node.first;
          continue;

        case "Fork": {
          const event: EngineEvent = node.scopeId === undefined
            ? { kind: "InvokeFork", fiberId: fiber.id, effectRef: node.effectRef }
            : { kind: "InvokeFork", fiberId: fiber.id, effectRef: node.effectRef, scopeId: node.scopeId };
          return this.suspend(fiber, event);
        }

        case "HostAction": {
          const event: EngineEvent = node.decodeRef === undefined
            ? { kind: "InvokeHostAction", fiberId: fiber.id, actionRef: node.actionRef }
            : { kind: "InvokeHostAction", fiberId: fiber.id, actionRef: node.actionRef, decodeRef: node.decodeRef };
          return this.suspend(fiber, event);
        }
      }
    }
  }

  private success(fiber: FiberVm, valueRef: RefId): EngineEvent {
    const frame = fiber.stack.pop();
    if (!frame) return this.markDone(fiber, valueRef);

    if (frame.tag === "SuccessCont") {
      return this.suspend(fiber, { kind: "InvokeFlatMap", fiberId: fiber.id, fnRef: frame.fnRef, valueRef });
    }

    return this.suspend(fiber, { kind: "InvokeFoldSuccess", fiberId: fiber.id, fnRef: frame.onSuccessRef, valueRef });
  }

  private failure(fiber: FiberVm, errorRef: RefId): EngineEvent {
    while (fiber.stack.length > 0) {
      const frame = fiber.stack.pop()!;
      if (frame.tag === "FoldCont") {
        return this.suspend(fiber, { kind: "InvokeFoldFailure", fiberId: fiber.id, fnRef: frame.onFailureRef, errorRef });
      }
      // SuccessCont frames are discarded on failure.
    }
    return this.markFailed(fiber, errorRef);
  }

  private suspend(fiber: FiberVm, event: EngineEvent): EngineEvent {
    fiber.status = "suspended";
    fiber.lastEvent = event;
    return event;
  }

  private markDone(fiber: FiberVm, valueRef: RefId): EngineEvent {
    fiber.status = "done";
    fiber.current = undefined;
    this.completed += 1;
    const event: EngineEvent = { kind: "Done", fiberId: fiber.id, valueRef };
    fiber.lastEvent = event;
    return event;
  }

  private markFailed(fiber: FiberVm, errorRef: RefId): EngineEvent {
    fiber.status = "failed";
    fiber.current = undefined;
    this.failed += 1;
    const event: EngineEvent = { kind: "Failed", fiberId: fiber.id, errorRef };
    fiber.lastEvent = event;
    return event;
  }
}

function cloneProgram(program: OpcodeProgram): OpcodeProgram {
  return {
    version: program.version,
    root: program.root,
    nodes: program.nodes.map((node) => ({ ...node })) as OpcodeNode[],
  };
}
