import { async, Async } from "../types/asyncEffect";
import { globalScheduler, Scheduler } from "./scheduler";
import {Fiber, getCurrentFiber, Interrupted, RuntimeFiber} from "./fiber";
import { Exit } from "../types/effect";
import { Canceler } from "../types/cancel";
import type { RuntimeEvent, RuntimeEmitContext, RuntimeHooks } from "./events";
import type { emptyContext ,FiberContext, TraceContext } from "./contex";
import { defaultTracer, type BrassEnv } from "./tracer";
import { makeForkPolicy } from "./forkPolicy";



type NodeCallback<A> = (err: Error | null, result: A) => void;

/**
 * --- Runtime Hooks (por ahora NOOP) ---
 * La idea es que en próximas versiones puedas enchufar EventBus / sinks sin tocar fibers.
 * Por ahora lo dejamos mínimo y sin dependencia a event bus.
 */
/*export type RuntimeEmitContext = {
    // si más adelante querés, podés agregar fiberId/scopeId/traceId/spanId
};*/


const noopHooks: RuntimeHooks = {
    emit() {},
};

/**
 * --- Runtime como objeto único (ZIO-style) ---
 * Un valor que representa "cómo" se ejecutan los efectos: scheduler + environment + hooks.
 */
export class Runtime<R> {
    readonly env: R;
    readonly scheduler: Scheduler;
    readonly hooks: RuntimeHooks;
    readonly forkPolicy

    constructor(args: { env: R; scheduler?: Scheduler; hooks?: RuntimeHooks }) {
        this.env = args.env;
        this.scheduler = args.scheduler ?? globalScheduler;
        this.hooks = args.hooks ?? noopHooks;
        this.forkPolicy = makeForkPolicy(this.env, this.hooks);
    }

    fork<E, A>(effect: Async<R, E, A>): Fiber<E, A> {
        const parent = getCurrentFiber();
        const fiber = new RuntimeFiber(this, effect) as any;

        this.forkPolicy.initChild(fiber, parent as any);

        fiber.schedule("initial-step");
        return fiber;
    }

    unsafeRunAsync<E, A>(
        effect: Async<R, E, A>,
        cb: (exit: Exit<E | Interrupted, A>) => void
    ): void {
        const fiber = this.fork(effect);
        fiber.join(cb);
    }

    toPromise<E, A>(effect: Async<R, E, A>): Promise<A> {
        return new Promise((resolve, reject) => {
            const fiber = this.fork(effect);
            fiber.join((exit: Exit<unknown, unknown>) => {
                const ex = exit as Exit<E, A>;
                if (ex._tag === "Success") resolve(ex.value);
                else reject(ex.error);
            });
        });
    }

    // Si querés un logger del runtime (por ahora solo hook):
    log(level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) {
        /*this.hooks.emit({ type: "log", level, message, fields });*/
        this.emit({ type: "log", level, message, fields });
    }

    withHooks(hooks: RuntimeHooks): Runtime<R> {
        return new Runtime({ env: this.env, scheduler: this.scheduler, hooks });
    }
    emit(ev: RuntimeEvent) {
        const f = getCurrentFiber() as any;

        const ctx: RuntimeEmitContext = {
            fiberId: f?.id,
            scopeId: f?.scope?.id,
            traceId: f?.fiberContext?.trace?.traceId,
            spanId: f?.fiberContext?.trace?.spanId,
        };

        // 👇 CLAVE: siempre pasar ctx (nunca undefined)
        this.hooks.emit(ev, ctx);
    }
    static make<R>(env: R, scheduler: Scheduler = globalScheduler): Runtime<R> {
        return new Runtime({ env, scheduler });
    }
}

/**
 * ---------------------------------------------------------------------------
 * Helpers existentes (los dejo igual) + wrappers que usan Runtime por debajo
 * ---------------------------------------------------------------------------
 */

export function from<A>(f: (cb: NodeCallback<A>) => void): Async<{}, Error, A>;
export function from<A>(thunk: () => Promise<A>): Async<{}, Error, A>;
export function from<A>(x: any): Async<{}, Error, A> {
    return async((env, cb) => {
        let done = false;
        const once = (r: any) => {
            if (!done) {
                done = true;
                cb(r);
            }
        };
        const fail = (e: unknown) =>
            once({ _tag: "Failure", error: e instanceof Error ? e : new Error(String(e)) });
        const ok = (v: A) => once({ _tag: "Success", value: v });

        try {
            // Si la función espera callback (arity >= 1), asumimos callback-style
            if (typeof x === "function" && x.length >= 1) {
                (x as (cb: NodeCallback<A>) => void)((err, result) => (err ? fail(err) : ok(result)));
            } else {
                (x as () => Promise<A>)().then(ok, fail);
            }
        } catch (e) {
            fail(e);
        }
    });
}

export type BrassError = { _tag: "Abort" } | { _tag: "PromiseRejected"; reason: unknown };

/**
 * --- Wrappers legacy (mantienen tu API actual) ---
 * Internamente crean un Runtime ad-hoc con env + scheduler.
 */

export function fork<R, E, A>(
    effect: Async<R, E, A>,
    env: R,
    scheduler: Scheduler = globalScheduler
): Fiber<E, A> {
    return new Runtime({ env, scheduler }).fork(effect);
}

export function unsafeRunAsync<R, E, A>(
    effect: Async<R, E, A>,
    env: R,
    cb: (exit: Exit<E | Interrupted, A>) => void
): void {
    return new Runtime({ env }).unsafeRunAsync(effect, cb);
}

export function toPromise<R, E, A>(eff: Async<R, E, A>, env: R): Promise<A> {
    return new Runtime({ env }).toPromise(eff);
}

export function fromPromise<R, E, A>(
    thunk: (env: R) => Promise<A>,
    onError: (e: unknown) => E
): Async<R, E, A> {
    return async((env: R, cb: (exit: Exit<E, A>) => void) => {
        thunk(env)
            .then((value) => cb({ _tag: "Success", value }))
            .catch((err) => cb({ _tag: "Failure", error: onError(err) }));
    });
}

export function fromCallback<A>(f: (cb: NodeCallback<A>) => void): Async<{}, Error, A> {
    return async((env, cb) => {
        let done = false;
        const once = (x: { _tag: "Failure"; error: Error } | { _tag: "Success"; value: A }) => {
            if (done) return;
            done = true;
            cb(x);
        };

        try {
            f((err, result) => {
                if (err) once({ _tag: "Failure", error: err });
                else once({ _tag: "Success", value: result });
            });
        } catch (e) {
            once({ _tag: "Failure", error: e instanceof Error ? e : new Error(String(e)) });
        }
    });
}

export function tryPromiseAbortable<A>(thunk: (signal: AbortSignal) => Promise<A>): Async<unknown, BrassError, A>;
export function tryPromiseAbortable<R, A>(
    thunk: (env: R, signal: AbortSignal) => Promise<A>
): Async<R, BrassError, A>;
export function tryPromiseAbortable<R, A>(
    thunk: ((signal: AbortSignal) => Promise<A>) | ((env: R, signal: AbortSignal) => Promise<A>)
): Async<R, BrassError, A> {
    const lifted = (env: R, signal: AbortSignal) =>
        thunk.length === 1 ? (thunk as (signal: AbortSignal) => Promise<A>)(signal) : (thunk as (env: R, signal: AbortSignal) => Promise<A>)(env, signal);

    return fromPromiseAbortable(lifted, (e): BrassError =>
        isAbortError(e) ? { _tag: "Abort" } : { _tag: "PromiseRejected", reason: e }
    );
}

// 1) Overload: thunk usa SOLO signal (env = unknown)
export function fromPromiseAbortable<E, A>(
    thunk: (signal: AbortSignal) => Promise<A>,
    onError: (e: unknown) => E
): Async<unknown, E, A>;

// 2) Overload: thunk usa env + signal (tu firma actual)
export function fromPromiseAbortable<R, E, A>(
    thunk: (env: R, signal: AbortSignal) => Promise<A>,
    onError: (e: unknown) => E
): Async<R, E, A>;

// 3) Implementación (usa `any` internamente para unificar)
export function fromPromiseAbortable<R, E, A>(
    thunk: ((signal: AbortSignal) => Promise<A>) | ((env: R, signal: AbortSignal) => Promise<A>),
    onError: (e: unknown) => E
): Async<R, E, A> {
    return async((env: R, cb: (exit: Exit<E, A>) => void): void | Canceler => {
        const ac = new AbortController();
        let done = false;

        const safeCb = (exit: Exit<E, A>) => {
            if (done) return;
            done = true;
            cb(exit);
        };

        try {
            // Si thunk declara 1 parámetro, asumimos (signal) => Promise<A>
            const p =
                thunk.length === 1
                    ? (thunk as (signal: AbortSignal) => Promise<A>)(ac.signal)
                    : (thunk as (env: R, signal: AbortSignal) => Promise<A>)(env, ac.signal);

            p.then((value) => safeCb({ _tag: "Success", value })).catch((err) => safeCb({ _tag: "Failure", error: onError(err) }));
        } catch (e) {
            safeCb({ _tag: "Failure", error: onError(e) });
        }

        return () => {
            done = true;
            ac.abort();
        };
    });
}

const isAbortError = (e: unknown): boolean =>
    typeof e === "object" && e !== null && "name" in e && (e as any).name === "AbortError";

export function getCurrentRuntime<R>(): Runtime<R> {
    const f = getCurrentFiber();
    if (!f) {
        throw new Error("No current runtime: estás llamando esto fuera de un fiber (fuera del runtime).");
    }
    return (f as any).runtime as Runtime<R>;
}


