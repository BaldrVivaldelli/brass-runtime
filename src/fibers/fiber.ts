// src/fiber.ts
import {Exit} from "../types/effect";
import {Async, asyncSync} from "../types/asyncEffect";
import {globalScheduler, Scheduler} from "../scheduler/scheduler";
import { asyncSucceed, asyncFlatMap } from "../types/asyncEffect";

export type FiberId = number;
export type FiberStatus = "Running" | "Done" | "Interrupted";
export type Interrupted = { readonly _tag: "Interrupted" };

export type Fiber<E, A> = {
    readonly id: FiberId;
    readonly status: () => FiberStatus;
    readonly join: (cb: (exit: Exit<E | Interrupted, A>) => void) => void;
    readonly interrupt: () => void;
    readonly addFinalizer: (f: (exit: Exit<E | Interrupted, A>) => void) => void;
};



let nextId: FiberId = 1;

export type BrassError =
    | { _tag: "Abort" }
    | { _tag: "PromiseRejected"; reason: unknown };


class RuntimeFiber<R, E, A> implements Fiber<E, A> {
    readonly id: FiberId;

    private closing: Exit<E | Interrupted, A> | null = null;
    private finishing = false;
    private statusValue: FiberStatus = "Running";
    private interrupted = false;

    private result: Exit<E | Interrupted, A> | null = null;
    private readonly joiners: Array<(exit: Exit<E | Interrupted, A>) => void> = [];

    // estado de evaluación
    private current: Async<R, E, any>;
    private readonly env: R;
    private readonly stack: (
        | { _tag: "SuccessCont"; k: (a: any) => Async<R, E, any> }
        | { _tag: "FoldCont"; onFailure: (e: any) => Async<R, E, any>; onSuccess: (a: any) => Async<R, E, any> }
        )[] = [];

    private readonly fiberFinalizers: Array<(exit: Exit<E | Interrupted, A>) => void> = [];


    private scheduled = false;
    private finalizersDrained = false;

    private blockedOnAsync = false;

    constructor(effect: Async<R, E, A>, env: R, private readonly scheduler: Scheduler) {
        this.id = nextId++;
        this.current = effect;
        this.env = env;
    }

    addFinalizer(f: (exit: Exit<E | Interrupted, A>) => void): void {
        this.fiberFinalizers.push(f);
    }



    status(): FiberStatus {
        return this.statusValue;
    }

    join(cb: (exit: Exit<E | Interrupted, A>) => void): void {
        if (this.result != null) cb(this.result);
        else this.joiners.push(cb);
    }

    interrupt(): void {
        if (this.result != null) return;
        if (this.interrupted) return;
        this.interrupted = true;
        this.blockedOnAsync = false;
        this.schedule("interrupt-step");
    }


    schedule(tag: string = "step"): void {
        console.log("[fiber.schedule]", {
            fiber: this.id,
            tag,
            schedulerCtor: this.scheduler?.constructor?.name,
            schedulerScheduleType: typeof (this.scheduler as any)?.schedule
        });
        if (this.result != null) return;
        if (this.scheduled) return;

        this.scheduled = true;

        this.scheduler.schedule(() => {
            console.log("[fiber.task] running", this.id);
            this.scheduled = false;
            this.step();
        }, `fiber#${this.id}.${tag}`);
    }

    private runFinalizersOnce(exit: Exit<E | Interrupted, A>): void {
        if (this.finalizersDrained) return;
        this.finalizersDrained = true;

        while (this.fiberFinalizers.length > 0) {
            const fin = this.fiberFinalizers.pop()!;
            try { fin(exit); } catch {}
        }
    }


    private notify(exit: Exit<E | Interrupted, A>): void {
        if (this.result != null) return;
        if (this.closing != null) return;

        this.finishing = true;
        this.closing = exit;

        // ✅ ejecutar finalizers YA (garantiza clearInterval)
        this.runFinalizersOnce(exit);

        // completar
        this.statusValue = this.interrupted ? "Interrupted" : "Done";
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

    step(): void {
        console.log("[fiber.step] enter", {
            fiber: this.id,
            current: this.current?._tag,
            result: this.result != null,
            blockedOnAsync: this.blockedOnAsync,
            interrupted: this.interrupted,
            closing: this.closing != null,
            finishing: this.finishing,
            stack: this.stack.length,
        });

        if (this.result != null) {
            console.log("[fiber.step] early-exit: already has result", { fiber: this.id });
            return;
        }

        if (this.blockedOnAsync) {
            console.log("[fiber.step] early-exit: blockedOnAsync", { fiber: this.id });
            return;
        }

        if (this.interrupted && this.closing == null) {
            console.log("[fiber.step] interrupted: failing now", { fiber: this.id });
            this.notify({ _tag: "Failure", error: { _tag: "Interrupted" } as any } as any);
            return;
        }

        const current = this.current;

        switch (current._tag) {
            case "Succeed": {
                console.log("[fiber.step] Succeed", { fiber: this.id });
                this.onSuccess(current.value);
                return;
            }

            case "Fail": {
                console.log("[fiber.step] Fail", { fiber: this.id });
                this.onFailure(current.error);
                return;
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
                return;
            }

            case "FlatMap": {
                console.log("[fiber.step] FlatMap push cont", { fiber: this.id });
                this.stack.push({ _tag: "SuccessCont", k: current.andThen });
                this.current = current.first;
                return;
            }

            case "Fold": {
                console.log("[fiber.step] Fold push cont", { fiber: this.id });
                this.stack.push({
                    _tag: "FoldCont",
                    onFailure: current.onFailure,
                    onSuccess: current.onSuccess,
                });
                this.current = current.first;
                return;
            }

            case "Async": {
                if (this.finishing) return;

                this.blockedOnAsync = true;
                let done = false;

                const resume = (exit: Exit<any, any>) => {
                    // corre siempre dentro del scheduler
                    this.blockedOnAsync = false;

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
                    this.scheduler.schedule(
                        () => resume(exit),
                        `fiber#${this.id}.async-resume`
                    );
                };

                const canceler = current.register(this.env, cb);

                if (typeof canceler === "function") {
                    this.addFinalizer(() => {
                        // importante: si cancelás, evitás que un callback tardío haga resume
                        done = true;
                        try { canceler(); } catch {}
                    });
                }

                return;
            }
        }
    }

}



export function fork<R, E, A>(
    effect: Async<R, E, A>,
    env: R,
    scheduler: Scheduler = globalScheduler
): Fiber<E, A> {
    const fiber = new RuntimeFiber(effect, env, scheduler);
    fiber.schedule("initial-step");
    return fiber;
}


// “correr” un Async como antes, pero apoyado en fibras + scheduler
export function unsafeRunAsync<R, E, A>(
    effect: Async<R, E, A>,
    env: R,
    cb: (exit: Exit<E | Interrupted, A>) => void
): void {
    const fiber = fork(effect, env);
    fiber.join(cb);
}
