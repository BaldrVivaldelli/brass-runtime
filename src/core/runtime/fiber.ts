// src/fiber.ts
import { Cause, Exit } from "../types/effect";
import { Async } from "../types/asyncEffect";
import { globalScheduler, laneTag, Scheduler } from "./scheduler";
import { Runtime, unsafeRunAsync } from "./runtime";
import { FiberContext } from "./contex";
import type { RuntimeEvent } from "./events";

export type FiberId = number;
export type FiberStatus = "Running" | "Done" | "Interrupted";

// Public alias used across the codebase/examples.
export type Interrupted = { readonly _tag: "Interrupt" };

type StepDecision = "Continue" | "Suspend" | "Done";
type RunState = "Queued" | "Running" | "Suspended" | "Done";

let _current: RuntimeFiber<any, any, any> | null = null;

const STEP = {
    CONTINUE: "Continue",
    SUSPEND: "Suspend",
    DONE: "Done",
} as const satisfies Record<string, StepDecision>;

const RUN = {
    QUEUED: "Queued",
    RUNNING: "Running",
    SUSPENDED: "Suspended",
    DONE: "Done",
} as const satisfies Record<string, RunState>;

export type Fiber<E, A> = {
    readonly id: FiberId;
    readonly status: () => FiberStatus;
    readonly join: (cb: (exit: Exit<E, A>) => void) => void;
    readonly interrupt: () => void;
    // si querés soportar finalizers Async, cambiá esto a: (exit) => void | Async<...>
    readonly addFinalizer: (f: (exit: Exit<E, A>) => void) => void;
};

let nextId: FiberId = 1;

// cuántos opcodes sync procesa
const DEFAULT_BUDGET = 4096;

/**
 * Override for benchmarking purposes only.
 * When set to a positive number, the fiber uses this value instead of DEFAULT_BUDGET.
 * Call with `undefined` to reset after benchmarking.
 */
let __benchmarkBudget: number | undefined;

export function setBenchmarkBudget(budget: number | undefined): void {
  __benchmarkBudget = budget;
}

export function getBenchmarkBudget(): number | undefined {
  return __benchmarkBudget;
}

// evita que un flatMap "left-associated" empuje N frames antes de correr
function reassociateFlatMap<R, E, A>(cur: Async<R, E, A>): Async<R, E, A> {
    let current: any = cur;

    while (current._tag === "FlatMap" && current.first?._tag === "FlatMap") {
        const inner = current.first;
        const g = current.andThen;

        current = {
            _tag: "FlatMap",
            first: inner.first,
            andThen: (a: any) => ({
                _tag: "FlatMap",
                first: inner.andThen(a),
                andThen: g,
            }),
        };
    }

    return current as any;
}

export class RuntimeFiber<R, E, A> implements Fiber<E, A> {
    readonly id: FiberId;

    // 👇 CLAVE: guardar el runtime en el fiber (para getCurrentRuntime())
    readonly runtime: Runtime<R>;

    private closing: Exit<E, A> | null = null;
    private finishing = false;

    private runState: RunState = RUN.RUNNING;

    private interrupted = false;
    private result: Exit<E, A> | null = null;

    private readonly joiners: Array<(exit: Exit<E, A>) => void> = [];

    // estado de evaluación
    private current: Async<R, E, any>;
    private readonly stack: (
        | { _tag: "SuccessCont"; k: (a: any) => Async<R, E, any> }
        | {
            _tag: "FoldCont";
            onFailure: (e: any) => Async<R, E, any>;
            onSuccess: (a: any) => Async<R, E, any>;
        }
    )[] = [];

    private readonly fiberFinalizers: Array<{ run?: (exit: Exit<E, A>) => any }> = [];
    private finalizersDrained = false;

    fiberContext!: FiberContext;
    name?: string;
    scopeId?: number;
    lane?: string;

    /**
     * Cached closure for the scheduler callback — avoids creating a new
     * closure on every `schedule()` call.  The tag parameter used by the
     * scheduler is only part of the label string, not the callback logic,
     * so a single cached closure is sufficient.
     */
    private readonly boundStep: () => void;

    constructor(runtime: Runtime<R>, effect: Async<R, E, A>) {
        this.id = nextId++;
        this.runtime = runtime;
        this.current = effect;

        this.boundStep = () => {
            withCurrentFiber(this, () => {
                if (this.runState === RUN.DONE) return;
                this.runState = RUN.RUNNING;

                const decision = this.step();

                switch (decision) {
                    case STEP.CONTINUE:
                        this.schedule("continue");
                        return;

                    case STEP.SUSPEND:
                        this.runState = RUN.SUSPENDED;
                        this.emit({ type: "fiber.suspend", fiberId: this.id });
                        return;

                    case STEP.DONE:
                        this.runState = RUN.DONE;
                        return;
                }
            });
        };
    }

    // helpers para no tocar el resto del código
    private get env(): R {
        return this.runtime.env;
    }
    private get scheduler(): Scheduler {
        return this.runtime.scheduler ?? globalScheduler;
    }

    private emit(ev: RuntimeEvent): void {
        // Emitimos con ctx del propio fiber (no dependemos de getCurrentFiber en callbacks async)
        this.runtime.hooks.emit(ev, {
            fiberId: this.id,
            scopeId: this.scopeId,
            traceId: this.fiberContext?.trace?.traceId,
            spanId: this.fiberContext?.trace?.spanId,
        });
    }

    addFinalizer(f: (exit: Exit<E, A>) => void): void {
        this.fiberFinalizers.push({ run: f });
    }

    /**
     * Internal finalizers used for suspend cancelers. They are detached as soon
     * as the async operation completes, so completed HTTP/promises do not keep
     * canceler closures alive until the fiber itself finishes.
     */
    private addTransientFinalizer(f: (exit: Exit<E, A>) => void): () => void {
        const rec: { run?: (exit: Exit<E, A>) => any } = { run: f };
        this.fiberFinalizers.push(rec);
        return () => {
            rec.run = undefined;
        };
    }

    status(): FiberStatus {
        if (this.result == null) return "Running";
        if (this.result._tag === "Failure" && this.result.cause._tag === "Interrupt") return "Interrupted";
        return "Done";
    }

    join(cb: (exit: Exit<E, A>) => void): void {
        if (this.result != null) cb(this.result);
        else this.joiners.push(cb);
    }

    interrupt(): void {
        if (this.result != null) return;
        if (this.interrupted) return;
        this.interrupted = true;
        this.schedule("interrupt-step");
    }

    schedule(tag: string = "step"): void {
        // ya terminó o ya está en cola: no hacer nada
        if (this.runState === RUN.DONE || this.runState === RUN.QUEUED) return;

        // ✅ si venía suspendido, esto es un resume
        if (this.runState === RUN.SUSPENDED) {
            this.emit({ type: "fiber.resume", fiberId: this.id });
        }

        // encolamos
        this.runState = RUN.QUEUED;

        const label = `fiber#${this.id}.${tag}`;
        const result = this.scheduler.schedule(
            this.boundStep,
            this.lane ? laneTag(this.lane, label) : label
        );

        if (result === "dropped") {
            this.runState = RUN.DONE;
            this.notify(Exit.failCause(Cause.die<E>(new Error(`Brass scheduler dropped ${label} because the lane queue is full`))));
        }
    }

    private runFinalizersOnce(exit: Exit<E, A>): void {
        if (this.finalizersDrained) return;
        this.finalizersDrained = true;

        while (this.fiberFinalizers.length > 0) {
            const fin = this.fiberFinalizers.pop()!;
            const run = fin.run;
            fin.run = undefined;
            if (!run) continue;
            try {
                const eff = run(exit);

                // Si devolvió un Async (tu ADT), lo ejecutamos.
                if (eff && typeof eff === "object" && "_tag" in eff) {
                    unsafeRunAsync(eff as any, this.env as any, () => { });
                }
            } catch {
                // best-effort: jamás tumbar el runtime por un finalizer
            }
        }
    }

    private notify(exit: Exit<E, A>): void {
        if (this.result != null) return;
        if (this.closing != null) return;

        this.finishing = true;
        this.closing = exit;

        // ejecutar finalizers YA
        this.runFinalizersOnce(exit);

        this.result = exit;

        const status =
            exit._tag === "Success"
                ? "success"
                : exit.cause._tag === "Interrupt"
                    ? "interrupted"
                    : "failure";

        this.emit({
            type: "fiber.end",
            fiberId: this.id,
            status,
            error: exit._tag === "Failure" ? exit.cause : undefined,
        });

        for (const j of this.joiners) j(exit);
        this.joiners.length = 0;
    }

    private onSuccess(value: any): void {
        const frame = this.stack.pop();
        if (!frame) {
            this.notify(Exit.succeed(value));
            return;
        }

        if (frame._tag === "SuccessCont") {
            try {
                this.current = frame.k(value);
            } catch (e) {
                // throw => defecto (no E)
                this.notify(Exit.failCause(Cause.die<E>(e)));
            }
            return;
        }

        // si llega acá, era un FoldCont pero por success
        try {
            this.current = frame.onSuccess(value);
        } catch (e) {
            this.notify(Exit.failCause(Cause.die<E>(e)));
        }
    }

    private onFailure(error: any): void {
        while (this.stack.length > 0) {
            const fr = this.stack.pop()!;
            if (fr._tag === "FoldCont") {
                try {
                    this.current = fr.onFailure(error);
                    return;
                } catch (e) {
                    error = e;
                    continue;
                }
            }
            // SuccessCont se descarta
        }

        // este es “fail” del dominio del effect
        this.notify(Exit.failCause(Cause.fail(error as E)));
    }

    private budget = DEFAULT_BUDGET;

    private step(): StepDecision {
        if (this.result != null) return STEP.DONE;

        // interrupción cooperativa
        if (this.interrupted) {
            this.notify(Exit.failCause(Cause.interrupt()));
            return STEP.DONE;
        }

        // budget cooperativo — use benchmark override if set
        this.budget = __benchmarkBudget ?? DEFAULT_BUDGET;

        while (this.budget-- > 0) {
            this.current = reassociateFlatMap(this.current);

            const current: any = this.current;

            switch (current._tag) {
                case "Succeed": {
                    this.onSuccess(current.value);
                    break;
                }

                case "Fail": {
                    this.onFailure(current.error);
                    break;
                }

                case "FlatMap": {
                    this.stack.push({ _tag: "SuccessCont", k: current.andThen });
                    this.current = current.first;
                    break;
                }

                case "Fold": {
                    this.stack.push({
                        _tag: "FoldCont",
                        onFailure: current.onFailure,
                        onSuccess: current.onSuccess,
                    });
                    this.current = current.first;
                    break;
                }

                case "Async": {
                    if (this.finishing) {
                        return this.result != null ? STEP.DONE : STEP.CONTINUE;
                    }

                    let done = false;
                    let asyncRegistered = false;
                    let syncResolved = false;
                    let syncExit: Exit<E, any> | null = null;

                    let detachCanceler: (() => void) | undefined;

                    const cb = (exit: Exit<E, any>) => {
                        if (done) return;
                        done = true;
                        detachCanceler?.();
                        detachCanceler = undefined;

                        if (this.result != null || this.closing != null) return;

                        // If we're still inside register(), mark as synchronous
                        if (!asyncRegistered) {
                            syncResolved = true;
                            syncExit = exit;
                            return;
                        }

                        // Async path (callback fired after register returned)
                        if (exit._tag === "Success") {
                            this.current = Async.succeed(exit.value);
                            this.schedule("async-resume");
                            return;
                        }

                        const cause = exit.cause;

                        if (cause._tag === "Interrupt") {
                            this.notify(Exit.failCause(Cause.interrupt()));
                            return;
                        }

                        if (cause._tag === "Fail") {
                            this.current = Async.fail(cause.error);
                            this.schedule("async-resume");
                            return;
                        }

                        // Die => defecto fatal, NO es un E
                        this.notify(Exit.failCause(Cause.die<E>(cause.defect)));
                    };

                    const canceler = current.register(this.env, cb);
                    asyncRegistered = true;

                    // Synchronous resolution: continue in the same step without re-enqueuing
                    if (syncResolved && syncExit) {
                        const resolvedExit = syncExit as Exit<E, any>;
                        if (resolvedExit._tag === "Success") {
                            this.onSuccess(resolvedExit.value);
                        } else {
                            const cause = resolvedExit.cause;

                            if (cause._tag === "Interrupt") {
                                this.notify(Exit.failCause(Cause.interrupt()));
                            } else if (cause._tag === "Fail") {
                                this.onFailure(cause.error);
                            } else {
                                // Die => defecto fatal
                                this.notify(Exit.failCause(Cause.die<E>(cause.defect)));
                            }
                        }
                        break; // continue the while loop
                    }

                    // Async path: register canceler as finalizer only when we actually suspend.
                    // Detach it on normal completion so long async chains do not retain old
                    // canceler closures/fetch signals until the fiber finally ends.
                    if (typeof canceler === "function") {
                        detachCanceler = this.addTransientFinalizer(() => {
                            if (done) return;
                            done = true;
                            detachCanceler = undefined;
                            try {
                                canceler();
                            } catch {
                                // ignore
                            }
                        });
                    }

                    return STEP.SUSPEND;
                }


                case "Fork": {
                    const child = this.runtime.fork(current.effect, current.scopeId);
                    this.onSuccess(child as any);
                    break;
                }

                case "Sync": {
                    try {
                        const a = (current as any).thunk(this.env);
                        this.onSuccess(a);
                    } catch (e) {
                        this.onFailure(e);
                    }
                    break;
                }

                default: {
                    this.onFailure(new Error(`Unknown opcode: ${current._tag}`));
                    return STEP.CONTINUE;
                }
            }

            if (this.result != null) return STEP.DONE;
        }

        return STEP.CONTINUE;
    }
}

export function getCurrentFiber() {
    return _current;
}

/**
 * Unsafe (but convenient) access to the runtime that is currently executing.
 * Throws if called outside of a running fiber.
 */
export function unsafeGetCurrentRuntime<R>(): Runtime<R> {
    const f = getCurrentFiber() as any;
    if (!f?.runtime) {
        throw new Error("unsafeGetCurrentRuntime: no current fiber/runtime");
    }
    return f.runtime as Runtime<R>;
}

export function withCurrentFiber<T>(fiber: RuntimeFiber<any, any, any>, f: () => T): T {
    const prev = _current;
    _current = fiber;
    try {
        return f();
    } finally {
        _current = prev;
    }
}
