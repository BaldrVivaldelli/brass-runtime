// src/fiber.ts
import { Exit } from "../types/effect";
import { Async } from "../types/asyncEffect";
import { globalScheduler, Scheduler } from "./scheduler";

export type FiberId = number;
export type Interrupted = { readonly _tag: "Interrupted" };

export type FiberStatus = "Running" | "Done" | "Interrupted";

type StepDecision = "Continue" | "Suspend" | "Done";

type RunState = "Queued" | "Running" | "Suspended" | "Done";

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
    readonly join: (cb: (exit: Exit<E | Interrupted, A>) => void) => void;
    readonly interrupt: () => void;
    readonly addFinalizer: (f: (exit: Exit<E | Interrupted, A>) => void) => void;
};

let nextId: FiberId = 1;



export class RuntimeFiber<R, E, A> implements Fiber<E, A> {
    readonly id: FiberId;

    private closing: Exit<E | Interrupted, A> | null = null;
    private finishing = false;

    private runState: RunState = RUN.RUNNING;

    private interrupted = false;
    private result: Exit<E | Interrupted, A> | null = null;

    private readonly joiners: Array<(exit: Exit<E | Interrupted, A>) => void> = [];

    // estado de evaluación
    private current: Async<R, E, any>;
    private readonly env: R;
    private readonly stack: (
        | { _tag: "SuccessCont"; k: (a: any) => Async<R, E, any> }
        | {
        _tag: "FoldCont";
        onFailure: (e: any) => Async<R, E, any>;
        onSuccess: (a: any) => Async<R, E, any>;
    }
        )[] = [];

    private readonly fiberFinalizers: Array<(exit: Exit<E | Interrupted, A>) => void> = [];
    private finalizersDrained = false;

    constructor(effect: Async<R, E, A>, env: R, private readonly scheduler: Scheduler) {
        this.id = nextId++;
        this.current = effect;
        this.env = env;
    }

    addFinalizer(f: (exit: Exit<E | Interrupted, A>) => void): void {
        this.fiberFinalizers.push(f);
    }

    status(): FiberStatus {
        if (this.result == null) return "Running";
        return this.interrupted ? "Interrupted" : "Done";
    }

    join(cb: (exit: Exit<E | Interrupted, A>) => void): void {
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
        console.log("[fiber.schedule]", {
            fiber: this.id,
            tag,
            runState: this.runState,
            schedulerCtor: this.scheduler?.constructor?.name,
            schedulerScheduleType: typeof (this.scheduler as any)?.schedule,
        });

        // ya terminó o ya está en cola: no hacer nada
        if (this.runState === RUN.DONE || this.runState === RUN.QUEUED) return;

        // encolamos
        this.runState = RUN.QUEUED;

        this.scheduler.schedule(() => {
            console.log("[fiber.task] running", this.id);

            if (this.runState === RUN.DONE) return;
            this.runState = RUN.RUNNING;

            const decision = this.step();

            switch (decision) {
                case STEP.CONTINUE:
                    // seguir cooperativamente
                    this.schedule("continue");
                    return;

                case STEP.SUSPEND:
                    // queda esperando async; el callback re-encola con schedule("async-resume")
                    this.runState = RUN.SUSPENDED;
                    return;

                case STEP.DONE:
                    this.runState = RUN.DONE;
                    return;
            }
        }, `fiber#${this.id}.${tag}`);
    }

    private runFinalizersOnce(exit: Exit<E | Interrupted, A>): void {
        if (this.finalizersDrained) return;
        this.finalizersDrained = true;

        while (this.fiberFinalizers.length > 0) {
            const fin = this.fiberFinalizers.pop()!;
            try {
                fin(exit);
            } catch {}
        }
    }

    private notify(exit: Exit<E | Interrupted, A>): void {
        if (this.result != null) return;
        if (this.closing != null) return;

        this.finishing = true;
        this.closing = exit;

        // ejecutar finalizers YA
        this.runFinalizersOnce(exit);

        this.result = exit;

        for (const j of this.joiners) j(exit);
        this.joiners.length = 0;
    }

    private onSuccess(value: any): void {
        const frame = this.stack.pop();
        if (!frame) {
            this.notify({ _tag: "Success", value } as any);
            return;
        }
        this.current = frame._tag === "SuccessCont" ? frame.k(value) : frame.onSuccess(value);
    }

    private onFailure(error: any): void {
        while (this.stack.length > 0) {
            const frame = this.stack.pop()!;
            if (frame._tag === "FoldCont") {
                this.current = frame.onFailure(error);
                return;
            }
        }
        this.notify({ _tag: "Failure", error } as any);
    }

    step(): StepDecision {
        console.log("[fiber.step] enter", {
            fiber: this.id,
            current: this.current?._tag,
            result: this.result != null,
            interrupted: this.interrupted,
            closing: this.closing != null,
            finishing: this.finishing,
            stack: this.stack.length,
        });

        let decision: StepDecision = STEP.CONTINUE;

        // ya terminó
        if (this.result != null) {
            decision = STEP.DONE;
            return decision;
        }

        // interrupción gana si no estamos cerrando
        if (this.interrupted && this.closing == null) {
            console.log("[fiber.step] interrupted: failing now", { fiber: this.id });
            this.notify({ _tag: "Failure", error: { _tag: "Interrupted" } as any } as any);
            decision = STEP.DONE;
            return decision;
        }

        const current = this.current;

        switch (current._tag) {
            case "Succeed": {
                console.log("[fiber.step] Succeed", { fiber: this.id });
                this.onSuccess(current.value);
                break;
            }

            case "Fail": {
                console.log("[fiber.step] Fail", { fiber: this.id });
                this.onFailure(current.error);
                break;
            }

            case "Sync": {
                console.log("[fiber.step] Sync", { fiber: this.id });
                try {
                    const v = current.thunk(this.env);
                    console.log("[fiber.step] Sync success", { fiber: this.id });
                    this.onSuccess(v);
                } catch (e) {
                    console.log("[fiber.step] Sync threw", { fiber: this.id, e });
                    this.onFailure(e);
                }
                break;
            }

            case "FlatMap": {
                console.log("[fiber.step] FlatMap push cont", { fiber: this.id });
                this.stack.push({ _tag: "SuccessCont", k: current.andThen });
                this.current = current.first;
                break;
            }

            case "Fold": {
                console.log("[fiber.step] Fold push cont", { fiber: this.id });
                this.stack.push({
                    _tag: "FoldCont",
                    onFailure: current.onFailure,
                    onSuccess: current.onSuccess,
                });
                this.current = current.first;
                break;
            }

            case "Async": {
                // si estás “finishing”, no queremos realmente suspender (tu lógica original)
                if (this.finishing) {
                    break;
                }

                let done = false;

                const resume = (exit: Exit<any, any>) => {
                    // Si ya terminó o está cerrando, ignorar
                    if (this.result != null || this.closing != null) return;

                    // Si fue interrumpido, gana interrupción
                    if (this.interrupted) {
                        this.onFailure({ _tag: "Interrupted" } as Interrupted);
                        return;
                    }

                    exit._tag === "Success" ? this.onSuccess(exit.value) : this.onFailure(exit.error);

                    // seguir el loop
                    this.schedule("async-resume");
                };

                const cb = (exit: Exit<any, any>) => {
                    if (done) return;
                    done = true;

                    // siempre reanudar vía scheduler (async boundary)
                    this.scheduler.schedule(() => resume(exit), `fiber#${this.id}.async-resume`);
                };

                const canceler = current.register(this.env, cb);

                if (typeof canceler === "function") {
                    this.addFinalizer(() => {
                        done = true;
                        try {
                            canceler();
                        } catch {}
                    });
                }

                decision = STEP.SUSPEND;
                break;
            }
        }

        // post-check final
        if (this.result != null) decision = STEP.DONE;

        return decision;
    }
}

