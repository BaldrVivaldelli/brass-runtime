import { Cause, Exit, type Exit as ExitType } from "../../types/effect";
import { withCurrentFiber, type Fiber, type FiberId, type FiberStatus } from "../fiber";
import type { RuntimeEvent } from "../events";
import { laneTag } from "../scheduler";
import type { Joiner, WasmEngineRuntime } from "./types";

export type InternalFiberStatus = "queued" | "running" | "suspended" | "done" | "failed" | "interrupted";

export class EngineFiberHandle<R, E, A> implements Fiber<E, A> {
  readonly id: FiberId;
  readonly runtime: WasmEngineRuntime<R> & any;

  fiberContext: any;
  name?: string;
  scopeId?: number;
  parentFiberId?: number;
  lane?: string;

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
    private readonly onScheduleDropped?: (fiberId: FiberId, label: string) => void,
    private readonly onScheduleRequest?: (fiberId: FiberId, label: string) => "accepted" | "dropped",
  ) {
    this.id = id;
    this.runtime = runtime;
  }

  status(): FiberStatus {
    if (this.result == null) return "Running";
    if (this.result._tag === "Failure" && Cause.isInterruptedOnly(this.result.cause)) return "Interrupted";
    return "Done";
  }

  engineStatus(): InternalFiberStatus {
    return this.internalStatus;
  }

  setEngineStatus(status: InternalFiberStatus): void {
    this.internalStatus = status;
  }

  markDequeued(): void {
    this.queued = false;
    if (this.result == null && this.internalStatus === "queued") {
      this.internalStatus = "running";
    }
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
    const label = `wasm-fiber#${this.id}.${tag}`;
    const result = this.onScheduleRequest
      ? this.onScheduleRequest(this.id, label)
      : this.scheduleWithRuntime(label);

    if (result === "dropped") {
      this.queued = false;
      this.onScheduleDropped?.(this.id, label);
    }
  }

  private scheduleWithRuntime(label: string): "accepted" | "dropped" {
    const lane = this.lane ?? this.runtime.lane;
    return this.runtime.scheduler.schedule(() => {
      this.markDequeued();
      if (this.result != null) return;
      this.onScheduledStep(this.id);
    }, lane ? laneTag(lane, label) : label) as "accepted" | "dropped";
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
    this.internalStatus = exit._tag === "Success" ? "done" : Cause.isInterruptedOnly(exit.cause) ? "interrupted" : "failed";

    const status = exit._tag === "Success" ? "success" : Cause.isInterruptedOnly(exit.cause) ? "interrupted" : "failure";
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
    withCurrentFiber(this as any, () => {
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
    });
  }
}
