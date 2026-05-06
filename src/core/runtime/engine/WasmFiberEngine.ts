import type { Async } from "../../types/asyncEffect";
import { Cause, Exit, type Exit as ExitType } from "../../types/effect";
import type { Fiber } from "../fiber";
import { withCurrentFiber } from "../fiber";
import { laneTag } from "../scheduler";
import type { HostAction, HostActionResult } from "../hostAction";
import { ProgramBuilder, type AsyncRegisterRef, type DecodeRef, type FiberId, type FlatMapRef, type FoldFailureRef, type FoldSuccessRef, type HostRegistry, type RefId, type SyncRef } from "./opcodes";
import type { EngineEvent, FiberEngine, FiberEngineKind, FiberEngineStats, WasmBridge, WasmEngineRuntime } from "./types";
import { EngineFiberHandle } from "./FiberHandleImpl";
import { WasmPackFiberBridge } from "./bridge/WasmPackFiberBridge";
import { WasmFiberRegistryBridge } from "./bridge/WasmFiberRegistryBridge";
import { makeFiberReadyQueue, type FiberReadyQueue } from "./bridge/WasmFiberReadyQueueBridge";
import { makeWasmTimerWheel, type WasmTimerWheelBridge, type TimerEvent } from "./bridge/WasmTimerWheelBridge";

type WasmFiberState<R, E = unknown, A = unknown> = {
  readonly fiberId: FiberId;
  readonly handle: EngineFiberHandle<R, E, A>;
  readonly builder: ProgramBuilder;
  readonly registry: HostRegistry;
  readonly controller: AbortController;
  readonly startedAt: number;
  completed: boolean;
  status: "running" | "suspended" | "done" | "failed" | "interrupted";
  readonly pendingCleanups: Set<() => void>;
  deadlineTimerId?: number;
  hostActionToken: number;
};

type PendingResume =
  | { readonly kind: "value"; readonly ref: RefId }
  | { readonly kind: "error"; readonly ref: RefId };

export type WasmFiberEngineOptions = {
  readonly bridge?: WasmBridge;
  readonly modulePath?: string;
};

const DEFAULT_BUDGET = 4096;
const TIMER_KIND_HOST_ACTION = 1;

export class WasmFiberEngine<R> implements FiberEngine<R> {
  readonly kind: FiberEngineKind;
  private readonly bridge: WasmBridge;
  private readonly readyQueue: FiberReadyQueue;

  private startedFibers = 0;
  private runningFibers = 0;
  private suspendedFibers = 0;
  private completedFibers = 0;
  private failedFibers = 0;
  private interruptedFibers = 0;
  private pendingHostEffects = 0;
  private readyDrainScheduled = false;
  private readyDraining = false;
  private readonly states = new Map<FiberId, WasmFiberState<R, any, any>>();
  private readonly pendingResumes = new Map<FiberId, PendingResume>();
  private readonly fiberRegistry?: WasmFiberRegistryBridge;
  private readonly timerWheel?: WasmTimerWheelBridge;

  constructor(
    private readonly runtime: WasmEngineRuntime<R> & any,
    options: WasmFiberEngineOptions = {},
  ) {
    this.bridge = options.bridge ?? new WasmPackFiberBridge(options.modulePath);
    if (this.bridge.kind !== "wasm") {
      throw new Error("brass-runtime strict mode requires a real WASM bridge; wasm-reference/TS fallback bridges are not allowed");
    }
    this.kind = this.bridge.kind;
    this.fiberRegistry = new WasmFiberRegistryBridge();
    this.readyQueue = makeFiberReadyQueue({ engine: "wasm" });
    this.timerWheel = makeWasmTimerWheel({ onExpired: (events) => this.onTimerExpired(events) });
  }

  fork<E, A>(effect: Async<R, E, A>, scopeId?: number): Fiber<E, A> & { schedule?: (tag?: string) => void } {
    const builder = new ProgramBuilder();
    const compiled = builder.compile(effect as unknown as Async<unknown, unknown, unknown>);
    const fiberId = this.bridge.createFiber(compiled.program);
    const controller = new AbortController();

    const handle = new EngineFiberHandle<R, E, A>(
      fiberId,
      this.runtime,
      (id) => this.driveById(id),
      (id, reason) => this.interruptById(id, reason),
      (id) => this.fiberRegistry?.addJoiner(id),
      (id) => this.fiberRegistry?.markQueued(id),
      (id, label) => this.schedulerDropped(id, label),
      (id, label) => this.enqueueFiberById(id, label),
    );
    if (scopeId !== undefined) handle.scopeId = scopeId;

    const state: WasmFiberState<R, E, A> = {
      fiberId,
      handle,
      builder,
      registry: compiled.registry,
      controller,
      startedAt: Date.now(),
      completed: false,
      status: "running",
      pendingCleanups: new Set(),
      hostActionToken: 0,
    };

    this.states.set(fiberId, state as WasmFiberState<R, any, any>);
    this.fiberRegistry?.registerFiber(fiberId, undefined, scopeId);
    this.startedFibers += 1;
    this.runningFibers += 1;
    return handle;
  }

  stats(): FiberEngineStats {
    let hostRefs = 0;
    let hostCapacity = 0;
    let hostAllocated = 0;
    let hostReleased = 0;
    let hostReused = 0;
    let hostStaleReads = 0;
    for (const state of this.states.values()) {
      const stats = state.registry.stats();
      hostRefs += stats.live;
      hostCapacity += stats.capacity;
      hostAllocated += stats.allocated;
      hostReleased += stats.released;
      hostReused += stats.reused;
      hostStaleReads += stats.staleReads;
    }
    return {
      engine: this.kind,
      startedFibers: this.startedFibers,
      runningFibers: this.runningFibers,
      suspendedFibers: this.suspendedFibers,
      queuedFibers: this.readyQueue.len(),
      completedFibers: this.completedFibers,
      failedFibers: this.failedFibers,
      interruptedFibers: this.interruptedFibers,
      pendingHostEffects: this.pendingHostEffects,
      hostRegistryRefs: hostRefs,
      hostRegistryStats: {
        live: hostRefs,
        capacity: hostCapacity,
        allocated: hostAllocated,
        released: hostReleased,
        reused: hostReused,
        staleReads: hostStaleReads,
      },
      wasm: this.bridge.stats(),
      fiberRegistry: this.fiberRegistry?.stats(),
      readyQueue: this.readyQueue.stats(),
      timerWheel: this.timerWheel?.stats(),
    };
  }

  async shutdown(): Promise<void> {
    for (const state of Array.from(this.states.values())) {
      this.interruptState(state, Cause.interrupt());
    }
    this.readyQueue.clear();
    this.timerWheel?.dispose();
  }

  private scheduleWakeup(fiberId: FiberId): void {
    const state = this.states.get(fiberId);
    if (!state || state.completed) return;

    if (!this.fiberRegistry) {
      this.enqueueFiber(state, "wakeup");
      return;
    }

    if (!this.fiberRegistry.wake(fiberId)) return;
    this.drainWakeups();
  }

  private drainWakeups(): void {
    if (!this.fiberRegistry) return;
    for (const fiberId of this.fiberRegistry.drainWakeups()) {
      this.enqueueFiberById(fiberId, `wasm-fiber#${fiberId}.wakeup`);
    }
  }

  private enqueueFiber(state: WasmFiberState<R, any, any>, label: string): void {
    const result = this.enqueueFiberById(state.fiberId, label);
    if (result === "dropped") {
      this.completeDie(state, new Error(`Brass WASM ready queue dropped ${label} because the lane queue is full`));
    }
  }

  private enqueueFiberById(fiberId: FiberId, label: string): "accepted" | "dropped" {
    const state = this.states.get(fiberId);
    if (!state || state.completed) return "dropped";
    const tag = this.schedulerTag(state, label);
    const policy = this.readyQueue.enqueue(fiberId, tag);
    if (policy === "dropped") return "dropped";
    this.requestReadyDrain(tag);
    return "accepted";
  }

  private requestReadyDrain(tag: string = laneTag("brass:wasm-ready", "drain")): void {
    if (this.readyDrainScheduled || this.readyDraining) return;
    this.readyDrainScheduled = true;
    const result = this.runtime.scheduler.schedule(() => this.drainReadyQueue(), tag);
    if (result === "dropped") {
      this.readyDrainScheduled = false;
      // Fail queued fibers rather than leaving joiners permanently suspended.
      const dropped: FiberId[] = [];
      while (this.readyQueue.len() > 0) {
        const budget = this.readyQueue.beginFlush();
        for (let i = 0; i < budget; i++) {
          const id = this.readyQueue.shift();
          if (id !== undefined) dropped.push(id);
        }
        this.readyQueue.endFlush(budget);
      }
      for (const id of dropped) this.schedulerDropped(id, `wasm-fiber#${id}.ready-drain`);
    }
  }

  private drainReadyQueue(): void {
    this.readyDrainScheduled = false;
    if (this.readyDraining) return;
    this.readyDraining = true;
    const budget = this.readyQueue.beginFlush();
    let ran = 0;
    try {
      while (ran < budget) {
        const fiberId = this.readyQueue.shift();
        if (fiberId === undefined) break;
        ran += 1;
        this.driveById(fiberId);
      }
    } finally {
      this.readyDraining = false;
      const policy = this.readyQueue.endFlush(ran);
      if (policy === "micro" || policy === "macro") this.requestReadyDrain();
    }
  }

  private driveById(fiberId: FiberId): void {
    const state = this.states.get(fiberId);
    if (!state || state.completed) return;
    state.handle.markDequeued();
    this.fiberRegistry?.markRunning(fiberId);
    const initialEvents = this.consumePendingResume(state);
    withCurrentFiber(state.handle as any, () => this.drive(state, initialEvents));
  }

  private consumePendingResume(state: WasmFiberState<R, any, any>): readonly EngineEvent[] | undefined {
    const pending = this.pendingResumes.get(state.fiberId);
    if (!pending) return undefined;
    this.pendingResumes.delete(state.fiberId);
    if (pending.kind === "value") {
      return this.bridge.provideValueBatch?.(state.fiberId, pending.ref, DEFAULT_BUDGET)
        ?? [this.bridge.provideValue(state.fiberId, pending.ref)];
    }
    return this.bridge.provideErrorBatch?.(state.fiberId, pending.ref, DEFAULT_BUDGET)
      ?? [this.bridge.provideError(state.fiberId, pending.ref)];
  }

  private drive(state: WasmFiberState<R, any, any>, initialEvents?: readonly EngineEvent[]): void {
    if (state.completed) return;

    let budget = DEFAULT_BUDGET;
    const events: EngineEvent[] = initialEvents ? [...initialEvents] : [];
    state.status = "running";
    state.handle.setEngineStatus("running");

    while (!state.completed && budget-- > 0) {
      try {
        if (events.length === 0) {
          const next = this.bridge.driveBatch?.(state.fiberId, budget + 1) ?? [this.bridge.poll(state.fiberId)];
          events.push(...next);
          if (events.length === 0) events.push({ kind: "Continue", fiberId: state.fiberId });
        }

        const event = events.shift()!;
        switch (event.kind) {
          case "Continue":
            continue;

          case "Done": {
            const value = state.registry.get(event.valueRef);
            this.completeSuccess(state, value);
            return;
          }

          case "Failed": {
            const error = event.errorRef === 0 ? new Error("WASM fiber failed") : state.registry.get(event.errorRef);
            this.completeFailure(state, error);
            return;
          }

          case "Interrupted": {
            this.completeInterrupted(state);
            return;
          }

          case "InvokeSync": {
            const fn = state.registry.get<SyncRef<R>>(event.fnRef);
            try {
              const valueRef = state.registry.register(fn(this.runtime.env));
              events.unshift(...(this.bridge.provideValueBatch?.(state.fiberId, valueRef, budget + 1) ?? [this.bridge.provideValue(state.fiberId, valueRef)]));
            } catch (error) {
              events.unshift(...(this.bridge.provideErrorBatch?.(state.fiberId, state.registry.register(error), budget + 1) ?? [this.bridge.provideError(state.fiberId, state.registry.register(error))]));
            }
            continue;
          }

          case "InvokeFlatMap": {
            const fn = state.registry.get<FlatMapRef<R>>(event.fnRef);
            const value = state.registry.get(event.valueRef);
            try {
              const next = fn(value);
              const patch = state.builder.append(next as unknown as Async<unknown, unknown, unknown>);
              events.unshift(...(this.bridge.provideEffectBatch?.(state.fiberId, patch.root, patch.nodes, budget + 1) ?? [this.bridge.provideEffect(state.fiberId, patch.root, patch.nodes)]));
            } catch (error) {
              events.unshift(...(this.bridge.provideErrorBatch?.(state.fiberId, state.registry.register(error), budget + 1) ?? [this.bridge.provideError(state.fiberId, state.registry.register(error))]));
            }
            continue;
          }

          case "InvokeFoldFailure": {
            const fn = state.registry.get<FoldFailureRef<R>>(event.fnRef);
            const errorValue = state.registry.get(event.errorRef);
            try {
              const next = fn(errorValue);
              const patch = state.builder.append(next as unknown as Async<unknown, unknown, unknown>);
              events.unshift(...(this.bridge.provideEffectBatch?.(state.fiberId, patch.root, patch.nodes, budget + 1) ?? [this.bridge.provideEffect(state.fiberId, patch.root, patch.nodes)]));
            } catch (error) {
              events.unshift(...(this.bridge.provideErrorBatch?.(state.fiberId, state.registry.register(error), budget + 1) ?? [this.bridge.provideError(state.fiberId, state.registry.register(error))]));
            }
            continue;
          }

          case "InvokeFoldSuccess": {
            const fn = state.registry.get<FoldSuccessRef<R>>(event.fnRef);
            const value = state.registry.get(event.valueRef);
            try {
              const next = fn(value);
              const patch = state.builder.append(next as unknown as Async<unknown, unknown, unknown>);
              events.unshift(...(this.bridge.provideEffectBatch?.(state.fiberId, patch.root, patch.nodes, budget + 1) ?? [this.bridge.provideEffect(state.fiberId, patch.root, patch.nodes)]));
            } catch (error) {
              events.unshift(...(this.bridge.provideErrorBatch?.(state.fiberId, state.registry.register(error), budget + 1) ?? [this.bridge.provideError(state.fiberId, state.registry.register(error))]));
            }
            continue;
          }

          case "InvokeFork": {
            const effect = state.registry.get<Async<R, unknown, unknown>>(event.effectRef);
            try {
              const child = this.runtime.fork(effect as any, event.scopeId);
              events.unshift(...(this.bridge.provideValueBatch?.(state.fiberId, state.registry.register(child), budget + 1) ?? [this.bridge.provideValue(state.fiberId, state.registry.register(child))]));
            } catch (error) {
              events.unshift(...(this.bridge.provideErrorBatch?.(state.fiberId, state.registry.register(error), budget + 1) ?? [this.bridge.provideError(state.fiberId, state.registry.register(error))]));
            }
            continue;
          }

          case "InvokeAsync": {
            this.scheduleAsync(state, event.registerRef);
            return;
          }

          case "InvokeHostAction": {
            this.scheduleHostAction(state, event.actionRef, event.decodeRef);
            return;
          }
        }
      } catch (error) {
        events.unshift(...(this.bridge.provideErrorBatch?.(state.fiberId, state.registry.register(error), budget + 1) ?? [this.bridge.provideError(state.fiberId, state.registry.register(error))]));
      }
    }

    if (!state.completed) this.enqueueFiber(state, "budget-yield");
  }

  private scheduleAsync(state: WasmFiberState<R, any, any>, registerRef: RefId): void {
    this.markSuspended(state, "async");
    this.pendingHostEffects += 1;

    const register = state.registry.get<AsyncRegisterRef<R>>(registerRef);
    let done = false;
    let asyncRegistered = false;
    let syncExit: ExitType<any, any> | null = null;

    let cancelCleanup: (() => void) | undefined;

    const cleanup = () => {
      done = true;
      state.pendingCleanups.delete(cleanup);
      if (cancelCleanup) {
        state.pendingCleanups.delete(cancelCleanup);
        cancelCleanup = undefined;
      }
    };

    const cb = (exitLike: unknown) => {
      if (done) return;
      const exit = exitLike as ExitType<any, any>;

      if (!asyncRegistered) {
        syncExit = exit;
        return;
      }

      cleanup();
      this.pendingHostEffects = Math.max(0, this.pendingHostEffects - 1);
      this.markRunning(state, "async");
      this.resumeWithExit(state, exit);
    };

    try {
      const canceler = register(this.runtime.env, cb);
      asyncRegistered = true;

      if (syncExit) {
        cleanup();
        this.pendingHostEffects = Math.max(0, this.pendingHostEffects - 1);
        this.markRunning(state, "async-sync");
        this.resumeWithExit(state, syncExit);
        return;
      }

      if (typeof canceler === "function") {
        cancelCleanup = () => {
          if (done) return;
          done = true;
          state.pendingCleanups.delete(cleanup);
          if (cancelCleanup) state.pendingCleanups.delete(cancelCleanup);
          cancelCleanup = undefined;
          try { canceler(); } catch { /* ignore */ }
        };
        state.pendingCleanups.add(cancelCleanup);
        state.handle.addFinalizer(() => cancelCleanup?.());
      }
    } catch (error) {
      cleanup();
      this.pendingHostEffects = Math.max(0, this.pendingHostEffects - 1);
      this.markRunning(state, "async-register-error");
      this.resumeWithError(state, error);
    }
  }

  private scheduleHostAction(state: WasmFiberState<R, any, any>, actionRef: RefId, decodeRef?: RefId): void {
    this.markSuspended(state, "host-action");
    this.pendingHostEffects += 1;
    const action = state.registry.get<HostAction>(actionRef);
    const token = ++state.hostActionToken;
    const deadlineAt = action.timeoutMs === undefined ? undefined : Date.now() + action.timeoutMs;

    const cleanup = () => {
      state.pendingCleanups.delete(cleanup);
      this.timerWheel?.cancel(state.deadlineTimerId);
      if (state.hostActionToken === token) state.deadlineTimerId = undefined;
    };
    state.pendingCleanups.add(cleanup);

    if (deadlineAt !== undefined && this.timerWheel) {
      state.deadlineTimerId = this.timerWheel.schedule(state.fiberId, TIMER_KIND_HOST_ACTION, deadlineAt);
    }

    this.runtime.hostExecutor.execute(action, {
      fiberId: state.fiberId,
      env: this.runtime.env,
      signal: state.controller.signal,
      deadlineAt,
    })
      .then((result: HostActionResult) => {
        if (state.completed || state.hostActionToken !== token) return;
        cleanup();
        this.pendingHostEffects = Math.max(0, this.pendingHostEffects - 1);
        this.markRunning(state, "host-action");

        try {
          if (decodeRef !== undefined) {
            const decode = state.registry.get<DecodeRef>(decodeRef);
            this.resumeWithValue(state, decode(result));
            return;
          }
          if (result.kind === "error") {
            this.resumeWithError(state, result.error);
            return;
          }
          this.resumeWithValue(state, result.value);
        } catch (error) {
          this.resumeWithError(state, error);
        }
      })
      .catch((error: unknown) => {
        if (state.completed || state.hostActionToken !== token) return;
        cleanup();
        this.pendingHostEffects = Math.max(0, this.pendingHostEffects - 1);
        this.markRunning(state, "host-action-error");
        this.resumeWithError(state, error);
      });
  }


  private onTimerExpired(events: readonly TimerEvent[]): void {
    for (const event of events) {
      if (event.kind !== TIMER_KIND_HOST_ACTION) continue;
      const state = this.states.get(event.subjectId as FiberId);
      if (!state || state.completed || state.deadlineTimerId !== event.timerId) continue;
      state.deadlineTimerId = undefined;
      state.hostActionToken += 1;
      if (!state.controller.signal.aborted) {
        state.controller.abort(new Error(`Brass host action timed out at ${event.deadlineMs}ms deadline`));
      }
      this.pendingHostEffects = Math.max(0, this.pendingHostEffects - 1);
      this.markRunning(state, "host-action-timeout");
      this.resumeWithError(state, new Error(`Brass host action timed out at ${event.deadlineMs}ms deadline`));
    }
  }

  private resumeWithExit(state: WasmFiberState<R, any, any>, exit: ExitType<any, any>): void {
    if (state.completed) return;
    if (exit._tag === "Success") {
      this.resumeWithValue(state, exit.value);
      return;
    }
    const cause = exit.cause;
    if (cause._tag === "Interrupt") {
      this.interruptState(state, cause);
      return;
    }
    if (cause._tag === "Fail") {
      this.resumeWithError(state, cause.error);
      return;
    }
    this.completeDie(state, cause.defect);
  }

  private resumeWithValue(state: WasmFiberState<R, any, any>, value: unknown): void {
    this.pendingResumes.set(state.fiberId, { kind: "value", ref: state.registry.register(value) });
    this.enqueueFiber(state, `wasm-fiber#${state.fiberId}.resume`);
  }

  private resumeWithError(state: WasmFiberState<R, any, any>, error: unknown): void {
    this.pendingResumes.set(state.fiberId, { kind: "error", ref: state.registry.register(error) });
    this.enqueueFiber(state, `wasm-fiber#${state.fiberId}.resume-error`);
  }

  private schedulerTag(state: WasmFiberState<R, any, any>, label: string): string {
    const lane = (state.handle as any).lane ?? this.runtime.lane;
    return lane ? laneTag(lane, label) : label;
  }

  private schedulerDropped(fiberId: FiberId, label: string): void {
    const state = this.states.get(fiberId);
    if (!state || state.completed) return;
    this.completeDie(state, new Error(`Brass scheduler dropped ${label} because the lane queue is full`));
  }

  private interruptById(fiberId: FiberId, reason: unknown): void {
    const state = this.states.get(fiberId);
    if (!state) return;
    this.interruptState(state, reason);
  }

  private interruptState(state: WasmFiberState<R, any, any>, reason: unknown): void {
    if (state.completed) return;
    if (!state.controller.signal.aborted) state.controller.abort(reason);
    for (const cleanup of Array.from(state.pendingCleanups)) cleanup();
    const events = this.bridge.interruptBatch?.(state.fiberId, state.registry.register(reason), DEFAULT_BUDGET)
      ?? [this.bridge.interrupt(state.fiberId, state.registry.register(reason))];
    this.drive(state, events);
  }

  private markSuspended(state: WasmFiberState<R, any, any>, reason: string): void {
    if (state.status !== "suspended") {
      this.suspendedFibers += 1;
      state.status = "suspended";
      this.fiberRegistry?.markSuspended(state.fiberId);
      state.handle.setEngineStatus("suspended");
      state.handle.emit({ type: "fiber.suspend", fiberId: state.fiberId, reason });
    }
  }

  private markRunning(state: WasmFiberState<R, any, any>, _reason: string): void {
    if (state.status === "suspended") {
      this.suspendedFibers = Math.max(0, this.suspendedFibers - 1);
      state.status = "running";
      this.fiberRegistry?.markRunning(state.fiberId);
      state.handle.setEngineStatus("running");
      state.handle.emit({ type: "fiber.resume", fiberId: state.fiberId });
    }
  }

  private completeSuccess(state: WasmFiberState<R, any, any>, value: unknown): void {
    if (state.completed) return;
    state.completed = true;
    state.status = "done";
    this.fiberRegistry?.markDone(state.fiberId, "done");
    this.completedFibers += 1;
    this.cleanupState(state);
    state.handle.succeed(value);
  }

  private completeFailure(state: WasmFiberState<R, any, any>, error: unknown): void {
    if (state.completed) return;
    state.completed = true;
    state.status = "failed";
    this.fiberRegistry?.markDone(state.fiberId, "failed");
    this.failedFibers += 1;
    this.cleanupState(state);
    state.handle.fail(error);
  }

  private completeDie(state: WasmFiberState<R, any, any>, defect: unknown): void {
    if (state.completed) return;
    state.completed = true;
    state.status = "failed";
    this.fiberRegistry?.markDone(state.fiberId, "failed");
    this.failedFibers += 1;
    this.cleanupState(state);
    state.handle.die(defect);
  }

  private completeInterrupted(state: WasmFiberState<R, any, any>): void {
    if (state.completed) return;
    state.completed = true;
    state.status = "interrupted";
    this.fiberRegistry?.markDone(state.fiberId, "interrupted");
    this.interruptedFibers += 1;
    this.cleanupState(state);
    state.handle.interrupted();
  }

  private cleanupState(state: WasmFiberState<R, any, any>): void {
    this.runningFibers = Math.max(0, this.runningFibers - 1);
    if (state.status === "suspended") this.suspendedFibers = Math.max(0, this.suspendedFibers - 1);
    this.timerWheel?.cancel(state.deadlineTimerId);
    state.deadlineTimerId = undefined;
    for (const cleanup of Array.from(state.pendingCleanups)) cleanup();
    state.pendingCleanups.clear();
    this.pendingResumes.delete(state.fiberId);
    this.bridge.dropFiber(state.fiberId);
    this.fiberRegistry?.dropFiber(state.fiberId);
    state.registry.clear();
    this.states.delete(state.fiberId);
  }
}
