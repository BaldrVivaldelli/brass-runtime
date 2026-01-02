import {async, Async} from "../types/asyncEffect";
import {globalScheduler, Scheduler} from "./scheduler";
import {Fiber, Interrupted, RuntimeFiber} from "./fiber";
import {Exit} from "../types/effect";
import {Canceler} from "../types/cancel";


type NodeCallback<A> = (err: Error | null, result: A) => void;

export function from<A>(f: (cb: NodeCallback<A>) => void): Async<{}, Error, A>;
export function from<A>(thunk: () => Promise<A>): Async<{}, Error, A>;
export function from<A>(x: any): Async<{}, Error, A> {
    return async((env, cb) => {
        let done = false;
        const once = (r: any) => { if (!done) { done = true; cb(r); } };
        const fail = (e: unknown) =>
            once({ _tag: "Failure", error: e instanceof Error ? e : new Error(String(e)) });
        const ok = (v: A) => once({ _tag: "Success", value: v });

        try {
            // Si la función espera callback (arity >= 1), asumimos callback-style
            if (typeof x === "function" && x.length >= 1) {
                (x as (cb: NodeCallback<A>) => void)((err, result) => err ? fail(err) : ok(result));
            } else {
                (x as () => Promise<A>)().then(ok, fail);
            }
        } catch (e) {
            fail(e);
        }
    });
}

export type BrassError =
    | { _tag: "Abort" }
    | { _tag: "PromiseRejected"; reason: unknown };

export function fork<R, E, A>(
    effect: Async<R, E, A>,
    env: R,
    scheduler: Scheduler = globalScheduler
): Fiber<E, A> {
    const fiber = new RuntimeFiber(effect, env, scheduler);
    fiber.schedule("initial-step");
    return fiber;
}

export function unsafeRunAsync<R, E, A>(
    effect: Async<R, E, A>,
    env: R,
    cb: (exit: Exit<E | Interrupted, A>) => void
): void {
    const fiber = fork(effect, env);
    fiber.join(cb);
}



export function toPromise<R, E, A>(eff: Async<R, E, A>, env: R): Promise<A> {
    return new Promise((resolve, reject) => {
        const fiber = fork(eff as any, env);
        fiber.join((exit: Exit<unknown, unknown>) => {
            const ex = exit as Exit<E, A>;
            if (ex._tag === "Success") resolve(ex.value);
            else reject(ex.error);
        });
    });
}

export function fromPromise <R, E, A>(
    thunk: (env: R) => Promise<A>,
    onError: (e: unknown) => E
):Async<R, E, A> {
    return async((env: R, cb: (exit: Exit<E, A>) => void) => {
        thunk(env)
            .then((value) => cb({_tag: "Success", value}))
            .catch((err) => cb({_tag: "Failure", error: onError(err)}));
    });
}



export function fromCallback<A>(
    f: (cb: NodeCallback<A>) => void
): Async<{}, Error, A> {
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
export function tryPromiseAbortable<A>(
    thunk: (signal: AbortSignal) => Promise<A>
): Async<unknown, BrassError, A>;

export function tryPromiseAbortable<R, A>(
    thunk: (env: R, signal: AbortSignal) => Promise<A>
): Async<R, BrassError, A>;

export function tryPromiseAbortable<R, A>(
    thunk: ((signal: AbortSignal) => Promise<A>) | ((env: R, signal: AbortSignal) => Promise<A>)
): Async<R, BrassError, A> {
    const lifted = (env: R, signal: AbortSignal) =>
        thunk.length === 1
            ? (thunk as (signal: AbortSignal) => Promise<A>)(signal)
            : (thunk as (env: R, signal: AbortSignal) => Promise<A>)(env, signal);

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

            p.then((value) => safeCb({ _tag: "Success", value }))
                .catch((err) => safeCb({ _tag: "Failure", error: onError(err) }));
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
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as any).name === "AbortError";

