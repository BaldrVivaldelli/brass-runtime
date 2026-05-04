import { Cause, Exit, type Exit as ExitType } from "../../types/effect";
import type { Fiber, FiberId, FiberStatus } from "../fiber";
import type { RuntimeEvent } from "../events";
import type { Joiner, WasmEngineRuntime } from "./types";

export type InternalFiberStatus = "queued" | "running" | "suspended" | "done" | "failed" | "interrupted";

export class EngineFiberHandle<R, E, A> implements Fiber<E, A> {
  readonly id: FiberId;
  readonly runtime: WasmEngineRuntime<R> & any;

  fiberContext: any;
  name?: string;
  scopeId?: number;
  parentFiberId?: number;

  private result: ExitType<E, A> | null = null;
  private readonly joiners: Array<Joiner<E, A>> = [];
  private readonly finalizers: Array<(exit: ExitType<E, A>) => any> = [];
  private finalizersDrained = false;
  private internalStatus: InternalFiberStatus = "running";
  private queued = false;

  constructor(
    id: FiberId,
    runtime: WasmEngineRuntime<R> & any,
    private readonly onScheduledStep: (fiberId: FiberId) => void,
    private readonly onInterrupt: (fiberId: FiberId, reason: unknown) => void,
    private readonly onJoiner?: (fiberId: FiberId) => void,
    private readonly onQueued?: (fiberId: FiberId) => void,
  ) {
    this.id = id;
    this.runtime = runtime;
  }

  status(): FiberStatus {
    if (this.result == null) return "Running";
    if (this.result._tag === "Failure" && this.result.cause._tag === "Interrupt") return "Interrupted";
    return "Done";
  }

  engineStatus(): InternalFiberStatus {
    return this.internalStatus;
  }

  setEngineStatus(status: InternalFiberStatus): void {
    this.internalStatus = status;
  }

  join(cb: (exit: ExitType<E, A>) => void): void {
    if (this.result != null) cb(this.result);
    else {
      this.onJoiner?.(this.id);
      this.joiners.push(cb);
    }
  }

  interrupt(): void {
    if (this.result != null) return;
    this.onInterrupt(this.id, Cause.interrupt());
  }

  addFinalizer(f: (exit: ExitType<E, A>) => void): void {
    this.finalizers.push(f);
  }

  schedule(tag = "step"): void {
    if (this.result != null || this.queued) return;
    this.queued = true;
    this.internalStatus = "queued";
    this.onQueued?.(this.id);
    this.runtime.scheduler.schedule(() => {
      this.queued = false;
      if (this.result != null) return;
      this.onScheduledStep(this.id);
    }, `wasm-fiber#${this.id}.${tag}`);
  }

  emit(ev: RuntimeEvent): void {
    this.runtime.hooks.emit(ev, {
      fiberId: this.id,
      scopeId: this.scopeId,
      traceId: this.fiberContext?.trace?.traceId,
      spanId: this.fiberContext?.trace?.spanId,
    });
  }

  succeed(value: A): void {
    this.complete(Exit.succeed(value));
  }

  fail(error: E): void {
    this.complete(Exit.failCause(Cause.fail(error)));
  }

  die(defect: unknown): void {
    this.complete(Exit.failCause(Cause.die<E>(defect)));
  }

  interrupted(): void {
    this.complete(Exit.failCause(Cause.interrupt()));
  }

  complete(exit: ExitType<E, A>): void {
    if (this.result != null) return;
    this.runFinalizersOnce(exit);
    this.result = exit;
    this.internalStatus = exit._tag === "Success" ? "done" : exit.cause._tag === "Interrupt" ? "interrupted" : "failed";

    const status = exit._tag === "Success" ? "success" : exit.cause._tag === "Interrupt" ? "interrupted" : "failure";
    this.emit({
      type: "fiber.end",
      fiberId: this.id,
      status,
      error: exit._tag === "Failure" ? exit.cause : undefined,
    });

    for (const joiner of this.joiners) joiner(exit);
    this.joiners.length = 0;
  }

  private runFinalizersOnce(exit: ExitType<E, A>): void {
    if (this.finalizersDrained) return;
    this.finalizersDrained = true;
    while (this.finalizers.length > 0) {
      const finalizer = this.finalizers.pop()!;
      try {
        const eff = finalizer(exit);
        if (eff && typeof eff === "object" && "_tag" in eff) {
          this.runtime.fork(eff as any);
        }
      } catch {
        // best effort, like RuntimeFiber
      }
    }
  }
}
