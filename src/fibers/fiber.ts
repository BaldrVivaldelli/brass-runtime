// src/fiber.ts
import {Exit} from "../types/effect";
import {Async} from "../types/asyncEffect";
import {globalScheduler, Scheduler} from "../scheduler/scheduler";

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

class RuntimeFiber<R, E, A> implements Fiber<E, A> {
    readonly id: FiberId;

    private statusValue: FiberStatus = "Running";
    private interrupted = false;

    private result: Exit<E | Interrupted, A> | null = null;
    private readonly joiners: Array<(exit: Exit<E | Interrupted, A>) => void> =
        [];

    // estado de evaluación
    private current: Async<R, E, any>;
    private readonly env: R;
    private readonly stack: ((a: any) => Async<R, E, any>)[] = [];

    private readonly fiberFinalizers: Array<(exit: Exit<E | Interrupted, A>) => Async<R, any, any>> = [];
    constructor(
        effect: Async<R, E, A>,
        env: R,
        private readonly scheduler: Scheduler
    ) {
        this.id = nextId++;
        this.current = effect;
        this.env = env;
    }

    addFinalizer(
        f: (exit: Exit<E | Interrupted, A>) => Async<R, any, any>
    ): void {
        this.fiberFinalizers.push(f);
    }
    status(): FiberStatus {
        return this.statusValue;
    }

    join(cb: (exit: Exit<E | Interrupted, A>) => void): void {
        if (this.result != null) {
            cb(this.result);
        } else {
            this.joiners.push(cb);
        }
    }

    interrupt(): void {
        this.interrupted = true;
        // cancelación cooperativa: el código async puede chequear flags externos
    }

    private runFiberFinalizers(exit: Exit<E | Interrupted, A>): void {
        while (this.fiberFinalizers.length > 0) {
            const fin = this.fiberFinalizers.pop()!;
            fin(exit); // fire-and-forget (igual que ZIO)
        }
    }

    /** Programa un paso de la fibra en el scheduler */
    schedule(): void {
        this.scheduler.schedule(() => this.step());
    }

    private notify(exit: Exit<E | Interrupted, A>): void {
        if (this.result != null) return;

        // ejecutar finalizers de fibra
        this.runFiberFinalizers(exit);

        // marcar estado final
        this.statusValue = this.interrupted ? "Interrupted" : "Done";
        this.result = exit;

        // notificar joiners
        for (const j of this.joiners) j(exit);
        this.joiners.length = 0;
    }

    private onSuccess(value: any): void {
        const cont = this.stack.pop();
        if (!cont) {
            // terminamos con éxito
            this.notify({ _tag: "Success", value } as Exit<E | Interrupted, A>);
            return;
        }
        this.current = cont(value);
        this.schedule(); // siguiente paso
    }

    private onFailure(error: any): void {
        this.notify({ _tag: "Failure", error } as Exit<E | Interrupted, A>);
    }

    /** Un *paso* de evaluación de la fibra */
    step(): void {
        if (this.result != null) return; // ya terminó

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
                this.schedule(); // reducimos el first en otro paso
                return;

            case "Async":
                current.register(this.env, (exit) => {
                    if (this.interrupted && exit._tag === "Success") {
                        this.onFailure({ _tag: "Interrupted" } as Interrupted);
                    } else if (exit._tag === "Success") {
                        this.onSuccess(exit.value);
                    } else {
                        this.onFailure(exit.error);
                    }
                });
                return;
        }
    }
}

// API pública: fork + helper unsafeRunAsync

export function fork<R, E, A>(
    effect: Async<R, E, A>,
    env: R,
    scheduler: Scheduler = globalScheduler
): Fiber<E, A> {
    const fiber = new RuntimeFiber(effect, env, scheduler);
    fiber.schedule(); // arrancamos la primera reducción
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
