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
    readonly addFinalizer: (f: (exit: Exit<E | Interrupted, A>) => Async<any, any, any>) => void;
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
    private readonly stack: ((a: any) => Async<R, E, any>)[] = [];

    private readonly fiberFinalizers: Array<
        (exit: Exit<E | Interrupted, A>) => Async<R, any, any>
    > = [];

    private scheduled = false;
    private finalizersDrained = false;

    private blockedOnAsync = false;
    private asyncCallbackArmed = false; // evita callback doble (por seguridad)

    constructor(effect: Async<R, E, A>, env: R, private readonly scheduler: Scheduler) {
        this.id = nextId++;
        this.current = effect;
        this.env = env;
    }

    addFinalizer(f: (exit: Exit<E | Interrupted, A>) => Async<R, any, any>): void {
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
        if (this.result != null) return;
        if (this.scheduled) return;

        this.scheduled = true;

        this.scheduler.schedule(() => {
            this.scheduled = false;
            this.step();
        }, `fiber#${this.id}.${tag}`);
    }



    private notify(exit: Exit<E | Interrupted, A>): void {
        // ya terminó
        if (this.result != null) return;

        // ya estamos cerrando (single-shot)
        if (this.closing != null) return;

        // ✅ entramos a modo cierre (tipo ZIO: transición Running -> Done/Finishing ocurre una vez)
        this.finishing = true;
        this.closing = exit;

        // 1) efecto: correr finalizers (exactamente una vez)
        const runFinalizers = this.drainFinalizers(exit);

        // 2) efecto: completar fiber + avisar joiners
        const complete: Async<R, any, void> = {
            _tag: "Sync" as const,
            thunk: (_env: R) => {
                this.statusValue = this.interrupted ? "Interrupted" : "Done";
                this.result = exit;

                for (const j of this.joiners) j(exit);
                this.joiners.length = 0;

                return undefined;
            },
        };

        // ✅ cortar evaluación normal
        this.stack.length = 0;

        // ✅ si estaba suspendida en Async, la “despertamos” para que avance el cierre
        this.blockedOnAsync = false;
        this.asyncCallbackArmed = false;

        // ✅ reemplazamos el programa por "finalizers >> complete"
        this.current = asyncFlatMap(runFinalizers, () => complete as any) as any;

        // ✅ ejecutar el cierre
        this.schedule("notify-step");
    }


    private drainFinalizers(exit: Exit<E | Interrupted, A>): Async<R, any, void> {
        if (this.finalizersDrained) return asyncSucceed(undefined);
        this.finalizersDrained = true;

        const fins = this.fiberFinalizers.splice(0);

        let eff: Async<R, any, void> = asyncSucceed(undefined);
        for (let i = fins.length - 1; i >= 0; i--) {
            const finEff = fins[i](exit) as Async<R, any, any>;
            eff = asyncFlatMap(finEff, () => eff);
        }
        return eff;
    }

    private onSuccess(value: any): void {
        const cont = this.stack.pop();
        if (!cont) {
            this.notify({ _tag: "Success", value } as Exit<E | Interrupted, A>);
            return;
        }
        this.current = cont(value);
        //this.schedule("onSuccess-step");
    }

    private onFailure(error: any): void {
        this.notify({ _tag: "Failure", error } as Exit<E | Interrupted, A>);
    }

    step(): void {
        if (this.result != null) return;

        if (this.blockedOnAsync) return;

        if (this.interrupted && this.closing == null) {
            this.notify({ _tag: "Failure", error: { _tag: "Interrupted" } as any } as any);
            return;
        }

        const current = this.current;

        switch (current._tag) {
            case "Succeed":
                this.onSuccess(current.value);
                return;

            case "Fail":
                this.onFailure(current.error);
                return;

            case "Sync":
                try {
                    const v = current.thunk(this.env);
                    this.onSuccess(v);
                } catch (e) {
                    this.onFailure(e);
                }
                return;

            case "FlatMap":
                this.stack.push(current.andThen);
                this.current = current.first;
                //this.schedule("flatMap-step");
                return;

            case "Async": {
                if (this.closing != null || this.result != null) return;

                if (this.interrupted) {
                    // dejamos que step() (al inicio) haga el notify(Interrupted)
                    // o directamente:
                    this.notify({ _tag: "Failure", error: { _tag: "Interrupted" } as any } as any);
                    return;
                }

                this.blockedOnAsync = true;

                this.asyncCallbackArmed = true;

                const canceler = current.register(this.env, (exit) => {
                    if (!this.asyncCallbackArmed) return;
                    this.asyncCallbackArmed = false;

                    // despertar
                    this.blockedOnAsync = false;

                    // si ya cerramos/terminamos, ignorar callback tardío
                    if (this.result != null || this.closing != null) return;

                    if (this.interrupted) {
                        this.notify({ _tag: "Failure", error: { _tag: "Interrupted" } as any } as any);
                        this.schedule("interrupt-after-async-step");
                        return;
                    }

                    if (exit._tag === "Success") this.onSuccess(exit.value);
                    else this.onFailure(exit.error);

                    this.schedule("async-callback-step");
                });

                if (typeof canceler === "function") {
                    this.addFinalizer((_exit) =>
                        asyncSync((_env) => {
                            try { canceler(); } catch {}
                        })
                    );
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
