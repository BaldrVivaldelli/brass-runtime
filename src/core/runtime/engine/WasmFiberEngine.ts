import type { Async } from "../../types/asyncEffect";
import { Cause, Exit, type Exit as ExitType } from "../../types/effect";
import type { Fiber } from "../fiber";
import { withCurrentFiber } from "../fiber";
import { laneTag } from "../scheduler";
import type { HostAction, HostActionResult } from "../hostAction";
import { ProgramBuilder, type AsyncRegisterRef, type DecodeRef, type FiberId, type FlatMapRef, type FoldFailureRef, type FoldSuccessRef, type HostRegistry, type RefId, type SyncRef } from "./opcodes";
import type { EngineEvent, FiberEngine, FiberEngineKind, FiberEngineStats, WasmBridge, WasmEngineRuntime } from "./types";
import { EngineFiberHandle } from "./FiberHandleImpl";
import { ReferenceWasmBridge } from "./bridge/ReferenceWasmBridge";
import { WasmPackFiberBridge } from "./bridge/WasmPackFiberBridge";
import { WasmFiberRegistryBridge } from "./bridge/WasmFiberRegistryBridge";

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
};

export type WasmFiberEngineOptions = {
  readonly bridge?: WasmBridge;
  readonly modulePath?: string;
  readonly reference?: boolean;
};

const DEFAULT_BUDGET = 4096;

export class WasmFiberEngine<R> implements FiberEngine<R> {
  readonly kind: FiberEngineKind;
  private readonly bridge: WasmBridge;

  private startedFibers = 0;
  private runningFibers = 0;
  private suspendedFibers = 0;
  private completedFibers = 0;
  private failedFibers = 0;
  private interruptedFibers = 0;
  private pendingHostEffects = 0;
  private readonly states = new Map<FiberId, WasmFiberState<R, any, any>>();
  private readonly fiberRegistry?: WasmFiberRegistryBridge;

  constructor(
    private readonly runtime: WasmEngineRuntime<R> & any,
    options: WasmFiberEngineOptions = {},
  ) {
    this.bridge = options.bridge ?? (options.reference ? new ReferenceWasmBridge() : new WasmPackFiberBridge(options.modulePath));
    this.kind = this.bridge.kind;
    this.fiberRegistry = this.kind === "wasm" ? new WasmFiberRegistryBridge() : undefined;
  }

  fork<E, A>(effect: Async<R, E, A>, scopeId?: number): Fiber<E, A> & { schedule?: (tag?: string) => void } {
    const builder = new ProgramBuilder();
    const compiled = builder.compile(effect as unknown as Async<unknown, unknown, unknown>);
    const fiberId = this.bridge.createFiber(compiled.program);
    const controller = new AbortController();

    const handle = new EngineFiberHandle<R, E, A>(
      fiberId,
      this.runtime,
      (id) => this.scheduleWakeup(id),
      (id, reason) => this.interruptById(id, reason),
      (id) => this.fiberRegistry?.addJoiner(id),
      (id) => this.fiberRegistry?.markQueued(id),
      (id, label) => this.schedulerDropped(id, label),
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
    };

    this.states.set(fiberId, state as WasmFiberState<R, any, any>);
    this.fiberRegistry?.registerFiber(fiberId, undefined, scopeId);
    this.startedFibers += 1;
    this.runningFibers += 1;
    return handle;
  }

  stats(): FiberEngineStats {
    let hostRefs = 0;
    for (const state of this.states.values()) hostRefs += state.registry.size();
    return {
      engine: this.kind,
      startedFibers: this.startedFibers,
      runningFibers: this.runningFibers,
      suspendedFibers: this.suspendedFibers,
      queuedFibers: 0,
      completedFibers: this.completedFibers,
      failedFibers: this.failedFibers,
      interruptedFibers: this.interruptedFibers,
      pendingHostEffects: this.pendingHostEffects,
      hostRegistryRefs: hostRefs,
      wasm: this.bridge.stats(),
      fiberRegistry: this.fiberRegistry?.stats(),
    };
  }

  async shutdown(): Promise<void> {
    for (const state of Array.from(this.states.values())) {
      this.interruptState(state, Cause.interrupt());
    }
  }

  private scheduleWakeup(fiberId: FiberId): void {
    const state = this.states.get(fiberId);
    if (!state || state.completed) return;

    // Rust keeps the compact wakeup queue and coalesces duplicate wakeups.
    // If the registry is unavailable (reference bridge), fall back to the old direct drive.
    if (!this.fiberRegistry) {
      this.driveById(fiberId);
      return;
    }

    if (!this.fiberRegistry.wake(fiberId)) return;
    this.drainWakeups();
  }

  private drainWakeups(): void {
    if (!this.fiberRegistry) return;
    for (const fiberId of this.fiberRegistry.drainWakeups()) {
      this.driveById(fiberId);
    }
  }

  private driveById(fiberId: FiberId): void {
    const state = this.states.get(fiberId);
    if (!state || state.completed) return;
    this.fiberRegistry?.markRunning(fiberId);
    withCurrentFiber(state.handle as any, () => this.drive(state));
  }

  private drive(state: WasmFiberState<R, any, any>, initialEvent?: EngineEvent): void {
    if (state.completed) return;

    let budget = DEFAULT_BUDGET;
    let event = initialEvent ?? this.bridge.poll(state.fiberId);
    state.status = "running";
    state.handle.setEngineStatus("running");

    while (!state.completed && budget-- > 0) {
      try {
        switch (event.kind) {
          case "Continue":
            event = this.bridge.poll(state.fiberId);
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
              event = this.bridge.provideValue(state.fiberId, valueRef);
            } catch (error) {
              event = this.bridge.provideError(state.fiberId, state.registry.register(error));
            }
            continue;
          }

          case "InvokeFlatMap": {
            const fn = state.registry.get<FlatMapRef<R>>(event.fnRef);
            const value = state.registry.get(event.valueRef);
            try {
              const next = fn(value);
              const patch = state.builder.append(next as unknown as Async<unknown, unknown, unknown>);
              event = this.bridge.provideEffect(state.fiberId, patch.root, patch.nodes);
            } catch (error) {
              event = this.bridge.provideError(state.fiberId, state.registry.register(error));
            }
            continue;
          }

          case "InvokeFoldFailure": {
            const fn = state.registry.get<FoldFailureRef<R>>(event.fnRef);
            const errorValue = state.registry.get(event.errorRef);
            try {
              const next = fn(errorValue);
              const patch = state.builder.append(next as unknown as Async<unknown, unknown, unknown>);
              event = this.bridge.provideEffect(state.fiberId, patch.root, patch.nodes);
            } catch (error) {
              event = this.bridge.provideError(state.fiberId, state.registry.register(error));
            }
            continue;
          }

          case "InvokeFoldSuccess": {
            const fn = state.registry.get<FoldSuccessRef<R>>(event.fnRef);
            const value = state.registry.get(event.valueRef);
            try {
              const next = fn(value);
              const patch = state.builder.append(next as unknown as Async<unknown, unknown, unknown>);
              event = this.bridge.provideEffect(state.fiberId, patch.root, patch.nodes);
            } catch (error) {
              event = this.bridge.provideError(state.fiberId, state.registry.register(error));
            }
            continue;
          }

          case "InvokeFork": {
            const effect = state.registry.get<Async<R, unknown, unknown>>(event.effectRef);
            try {
              const child = this.runtime.fork(effect as any, event.scopeId);
              event = this.bridge.provideValue(state.fiberId, state.registry.register(child));
            } catch (error) {
              event = this.bridge.provideError(state.fiberId, state.registry.register(error));
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
        event = this.bridge.provideError(state.fiberId, state.registry.register(error));
      }
    }

    if (!state.completed) state.handle.schedule("budget-yield");
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
    const startedAt = Date.now();

    const cleanup = () => {
      state.pendingCleanups.delete(cleanup);
    };
    state.pendingCleanups.add(cleanup);

    this.runtime.hostExecutor.execute(action, {
      fiberId: state.fiberId,
      env: this.runtime.env,
      signal: state.controller.signal,
      deadlineAt: action.timeoutMs === undefined ? undefined : Date.now() + action.timeoutMs,
    })
      .then((result: HostActionResult) => {
        cleanup();
        if (state.completed) return;
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
        cleanup();
        if (state.completed) return;
        this.pendingHostEffects = Math.max(0, this.pendingHostEffects - 1);
        this.markRunning(state, "host-action-error");
        this.resumeWithError(state, error);
      });
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
    const event = this.bridge.provideValue(state.fiberId, state.registry.register(value));
    const label = `wasm-fiber#${state.fiberId}.resume`;
    this.scheduleOrDrop(
      state,
      () => withCurrentFiber(state.handle as any, () => this.drive(state, event)),
      label,
    );
  }

  private resumeWithError(state: WasmFiberState<R, any, any>, error: unknown): void {
    const event = this.bridge.provideError(state.fiberId, state.registry.register(error));
    const label = `wasm-fiber#${state.fiberId}.resume-error`;
    this.scheduleOrDrop(
      state,
      () => withCurrentFiber(state.handle as any, () => this.drive(state, event)),
      label,
    );
  }

  private scheduleOrDrop(state: WasmFiberState<R, any, any>, task: () => void, label: string): void {
    const result = this.runtime.scheduler.schedule(task, this.schedulerTag(state, label));
    if (result === "dropped") {
      this.completeDie(state, new Error(`Brass scheduler dropped ${label} because the lane queue is full`));
    }
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
    const event = this.bridge.interrupt(state.fiberId, state.registry.register(reason));
    this.drive(state, event);
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
    for (const cleanup of Array.from(state.pendingCleanups)) cleanup();
    state.pendingCleanups.clear();
    this.bridge.dropFiber(state.fiberId);
    this.fiberRegistry?.dropFiber(state.fiberId);
    state.registry.clear();
    this.states.delete(state.fiberId);
  }
}
