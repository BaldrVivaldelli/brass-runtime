import { async, Async } from "../types/asyncEffect";
import { globalScheduler, Scheduler } from "./scheduler";
import { Fiber, getCurrentFiber, RuntimeFiber } from "./fiber";
import { Cause, Exit } from "../types/effect";
import type { RuntimeEvent, RuntimeEmitContext, RuntimeHooks } from "./events";
import { makeForkPolicy } from "./forkPolicy";
import { RuntimeRegistry } from "./registry";

// fallback hooks (no-op)
const NoopHooks: RuntimeHooks = {
    emit() { },
};

/**
 * --- Runtime como objeto único (ZIO-style) ---
 * Un valor que representa "cómo" se ejecutan los efectos: scheduler + environment + hooks.
 */
export class Runtime<R> {
    readonly env: R;
    readonly scheduler: Scheduler;
    readonly hooks: RuntimeHooks;
    readonly forkPolicy;

    // opcional: registry para observabilidad
    registry?: RuntimeRegistry;

    constructor(args: { env: R; scheduler?: Scheduler; hooks?: RuntimeHooks }) {
        this.env = args.env;
        this.scheduler = args.scheduler ?? globalScheduler;
        this.hooks = args.hooks ?? NoopHooks;
        this.forkPolicy = makeForkPolicy(this.env as any, this.hooks);
    }

    /** Deriva un runtime con env extendido (estilo provide/locally) */
    provide<R2>(env: R2): Runtime<R & R2> {
        return new Runtime({ env: Object.assign({}, this.env, env) as any, scheduler: this.scheduler, hooks: this.hooks });
    }

    emit(ev: RuntimeEvent) {
        const f = getCurrentFiber() as any;

        const ctx: RuntimeEmitContext = {
            fiberId: f?.id,
            scopeId: f?.scopeId, // ✅ FIX: era f?.scope
            traceId: f?.fiberContext?.trace?.traceId,
            spanId: f?.fiberContext?.trace?.spanId,
        };

        // 👇 CLAVE: siempre pasar ctx (nunca undefined)
        this.hooks.emit(ev, ctx);
    }

    /**
     * ✅ CAMBIO: fork(effect, scopeId?) y pasa scopeId a forkPolicy
     */
    fork<E, A>(effect: Async<R, E, A>, scopeId?: number): Fiber<E, A> {
        const parent = getCurrentFiber();
        const fiber = new RuntimeFiber(this, effect) as any;

        // Si el caller provee scopeId (p.ej. Scope.fork), lo seteamos antes de initChild
        if (scopeId !== undefined) fiber.scopeId = scopeId;

        this.forkPolicy.initChild(fiber, parent as any, scopeId);
        fiber.schedule("initial-step");
        return fiber;
    }

    unsafeRunAsync<E, A>(
        effect: Async<R, E, A>,
        cb: (exit: Exit<E, A>) => void
    ): void {
        const fiber = this.fork(effect);
        fiber.join(cb);
    }

    toPromise<E, A>(effect: Async<R, E, A>): Promise<A> {
        return new Promise((resolve, reject) => {
            const fiber = this.fork(effect);
            fiber.join((exit) => {
                if (exit._tag === "Success") resolve(exit.value);
                else {
                    const c: any = (exit as any).cause;
                    if (c?._tag === "Fail") reject(c.error);
                    else reject(new Error("Interrupted"));
                }
            });
        });
    }

    // helper: correr un efecto y “tirar” el resultado
    unsafeRun<E, A>(effect: Async<R, E, A>): void {
        this.unsafeRunAsync(effect, () => { });
    }

    delay<E, A>(ms: number, eff: Async<R, E, A>): Async<R, E, A> {
        return async((_env, cb) => {
            const handle = setTimeout(() => {
                this.unsafeRunAsync(eff, cb);
            }, ms);

            // Canceler
            return () => clearTimeout(handle);
        });
    }

    // util para crear runtime default
    static make<R>(env: R, scheduler: Scheduler = globalScheduler): Runtime<R> {
        return new Runtime({ env, scheduler });
    }

    /** Convenience logger: emits a RuntimeEvent of type "log". */
    log(level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void {
        this.emit({ type: "log", level, message, fields });
    }
}

// -----------------------------------------------------------------------------
// Top-level helpers (used by examples)
// -----------------------------------------------------------------------------

/** Create a runtime from `env` and fork the given effect. */
export function fork<R, E, A>(effect: Async<R, E, A>, env?: R): Fiber<E, A> {
    return Runtime.make((env ?? ({} as any)) as R).fork(effect);
}

/** Run an effect with `env` and invoke `cb` with the final Exit. */
export function unsafeRunAsync<R, E, A>(
    effect: Async<R, E, A>,
    env: R | undefined,
    cb: (exit: Exit<E, A>) => void
): void {
    Runtime.make((env ?? ({} as any)) as R).unsafeRunAsync(effect, cb);
}

/** Run an effect with `env` and return a Promise of its success value. */
export function toPromise<R, E, A>(effect: Async<R, E, A>, env?: R): Promise<A> {
    return Runtime.make((env ?? ({} as any)) as R).toPromise(effect);
}

/**
 * Create an Async from an abortable Promise.
 * Type params are ordered as `<E, A, R = unknown>` to match call-sites.
 */
export function fromPromiseAbortable<E, A, R = unknown>(
    make: (signal: AbortSignal, env: R) => Promise<A>,
    onReject: (u: unknown) => E
): Async<R, E, A> {
    return {
        _tag: "Async",
        register: (env: R, cb: (exit: Exit<E, A>) => void) => {
            const controller = new AbortController();
            let done = false;

            make(controller.signal, env)
                .then((value) => {
                    if (done) return;
                    done = true;
                    cb({ _tag: "Success", value });
                })
                .catch((err) => {
                    if (done) return;
                    done = true;
                    cb({ _tag: "Failure", cause: { _tag: "Fail", error: onReject(err) } });
                });

            return () => {
                if (done) return;
                done = true;
                controller.abort();
                cb({ _tag: "Failure", cause: { _tag: "Interrupt" } });
            };
        },
    };
}

export function unsafeRunFoldWithEnv<R, E, A>(
  eff: Async<R, E, A>,
  env: R,
  onFailure: (cause: Cause<E>) => void,
  onSuccess: (value: A) => void
): void {
  unsafeRunAsync(eff, env, (ex: any) => {
    if (ex._tag === "Failure") onFailure(ex.cause);
    else onSuccess(ex.value);
  });
}