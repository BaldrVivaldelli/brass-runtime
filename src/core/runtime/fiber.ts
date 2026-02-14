// src/fiber.ts
import { Exit } from "../types/effect";
import { Async } from "../types/asyncEffect";
import { globalScheduler, Scheduler } from "./scheduler";
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
    readonly addFinalizer: (f: (exit: Exit<E, A>) => void) => void;
};

let nextId: FiberId = 1;

// cuántos opcodes sync procesa
const DEFAULT_BUDGET = 1024;

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

    private readonly fiberFinalizers: Array<(exit: Exit<E, A>) => void> = [];
    private finalizersDrained = false;

    fiberContext!: FiberContext;
    name?: string;
    scopeId?: number;

    constructor(runtime: Runtime<R>, effect: Async<R, E, A>) {
        this.id = nextId++;
        this.runtime = runtime;
        this.current = effect;
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
        this.fiberFinalizers.push(f);
    }

    status(): FiberStatus {
        if (this.result == null) return "Running";
        // si terminó por interrupción
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

        this.scheduler.schedule(
            () => {
                // 👇 CLAVE: setear current fiber mientras se ejecuta el step
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

                            // ✅ suspend cuando devolvemos SUSPEND (i.e. entramos a Async)
                            this.emit({ type: "fiber.suspend", fiberId: this.id });

                            return;

                        case STEP.DONE:
                            this.runState = RUN.DONE;
                            return;
                    }
                });
            },
            `fiber#${this.id}.${tag}`
        );
    }

    private runFinalizersOnce(exit: Exit<E, A>): void {
        if (this.finalizersDrained) return;
        this.finalizersDrained = true;

        while (this.fiberFinalizers.length > 0) {
            const fin = this.fiberFinalizers.pop()!;
            try {
                const eff = fin(exit) as any;

                // Si devolvió un Async (tu ADT), lo ejecutamos.
                if (eff && typeof eff === "object" && "_tag" in eff) {
                    unsafeRunAsync(eff, this.env as any, () => { });
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

        // ✅ fiber.end (exactly once)
        const status =
            exit._tag === "Success"
                ? "success"
                : (exit.cause as any)?._tag === "Interrupted"
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
            this.notify({ _tag: "Success", value });
            return;
        }

        if (frame._tag === "SuccessCont") {
            try {
                this.current = frame.k(value);
            } catch (e) {
                this.notify({ _tag: "Failure", cause: e as any });
            }
            return;
        }

        // si llega acá, era un FoldCont pero por success
        try {
            this.current = frame.onSuccess(value);
        } catch (e) {
            this.notify({ _tag: "Failure", cause: e as any });
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

        this.notify({ _tag: "Failure", cause: { _tag: "Fail", error } });
    }

    private budget = DEFAULT_BUDGET;

    private step(): StepDecision {
        if (this.result != null) return STEP.DONE;

        // interrupción cooperativa
        if (this.interrupted) {
            this.notify({ _tag: "Failure", cause: { _tag: "Interrupt" } });
            return STEP.DONE;
        }

        // budget cooperativo
        this.budget = DEFAULT_BUDGET;

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

                    const cb = (exit: Exit<any, any>) => {
                        if (done) return;
                        done = true;

                        if (this.result != null || this.closing != null) return;

                        if (exit._tag === "Success") {
                            this.current = ({ _tag: "Succeed", value: exit.value } as any);
                            this.schedule("async-resume");
                            return;
                        }

                        // Failure
                        if (exit.cause._tag === "Interrupt") {
                            this.notify({ _tag: "Failure", cause: { _tag: "Interrupt" } } as any);
                            return;
                        }

                        this.current = ({ _tag: "Fail", error: (exit.cause as any).error } as any);
                        this.schedule("async-resume");
                    };

                    // ✅ TU Async usa register, no run
                    const canceler = current.register(this.env, cb);

                    if (typeof canceler === "function") {
                        this.addFinalizer(() => {
                            done = true;
                            try {
                                canceler();
                            } catch { }
                        });
                    }

                    return STEP.SUSPEND;
                }

                case "Fork": {
                    // tu lógica existente (si la tenés)
                    const child = this.runtime.fork(current.effect, current.scopeId);
                    this.onSuccess(child as any);
                    break;
                }
                case "Sync": {
                    try {
                        const a = (current as any).thunk(this.env);
                        this.onSuccess(a);
                    } catch (e) {
                        // Si falla una Sync, lo tratamos como Fail con el error capturado
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

