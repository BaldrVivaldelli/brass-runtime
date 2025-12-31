// src/asyncEffect.ts
import type { Exit } from "./effect";
import {Canceler} from "./cancel";
import {BrassError, fork} from "../fibers/fiber";
import {Scope} from "../scheduler/scope";


type NodeCallback<A> = (err: Error | null, result: A) => void;
export type Async<R, E, A> =
    | { _tag: "Succeed"; value: A }
    | { _tag: "Fail"; error: E }
    | { _tag: "Sync"; thunk: (env: R) => A }
    | { _tag: "Async"; register: (env: R, cb: (exit: Exit<E, A>) => void) => void | Canceler }
    | { _tag: "FlatMap"; first: Async<R, E, any>; andThen: (a: any) => Async<R, E, A> }
    | {
    _tag: "Fold";
    first: Async<R, E, any>;
    onFailure: (e: any) => Async<R, E, A>;
    onSuccess: (a: any) => Async<R, E, A>;
};



export function asyncFold<R, E, A, B>(
    fa: Async<R, E, A>,
    onFailure: (e: E) => Async<R, E, B>,
    onSuccess: (a: A) => Async<R, E, B>
): Async<R, E, B> {
    return { _tag: "Fold", first: fa, onFailure, onSuccess };
}

export function asyncCatchAll<R, E, A, R2, E2, B>(
    fa: Async<R, E, A>,
    handler: (e: E) => Async<R2, E2, B>
): Async<R & R2, E2, A | B> {
    return asyncFold(
        fa as any,
        (e: E) => handler(e) as any,
        (a: A) => asyncSucceed(a) as any
    ) as any;
}


export function asyncMapError<R, E, E2, A>(
    fa: Async<R, E, A>,
    f: (e: E) => E2
): Async<R, E2, A> {
    return asyncFold(
        fa as any,
        (e: E) => asyncFail(f(e)) as any,
        (a: A) => asyncSucceed(a) as any
    ) as any;
}

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
export function unit(): Async<unknown, unknown, undefined> {
    return asyncSync(() => undefined);
}

export const asyncSucceed = <A>(value: A): Async<unknown, never, A> => ({
    _tag: "Succeed",
    value,
});

export const asyncFail = <E>(error: E): Async<unknown, E, never> => ({
    _tag: "Fail",
    error,
});

export const asyncSync = <R, A>(
    thunk: (env: R) => A
): Async<R, unknown, A> => ({
    _tag: "Sync",
    thunk,
});

export const asyncTotal = <A>(thunk: () => A): Async<unknown, unknown, A> =>
    asyncSync(() => thunk());

export const async = <R, E, A>(
    register: (env: R, cb: (exit: Exit<E, A>) => void) => void | Canceler
): Async<R, E, A> => ({
    _tag: "Async",
    register,
});

export function asyncMap<R, E, A, B>(
    fa: Async<R, E, A>,
    f: (a: A) => B
): Async<R, E, B> {
    return asyncFlatMap(fa, (a) => asyncSucceed(f(a)));
}

export function asyncFlatMap<R, E, A, B>(
    fa: Async<R, E, A>,
    f: (a: A) => Async<R, E, B>
): Async<R, E, B> {
    return {
        _tag: "FlatMap",
        first: fa,
        andThen: f,
    };
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

//TODO: Esto lo hago porque me interesa saber el nombre explicito de lo que falla, no solo que falle sino mas bien un detalle
const isAbortError = (e: unknown): boolean =>
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as any).name === "AbortError";

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

export function acquireRelease<R, E, A>(
    acquire: Async<R, E, A>,
    release: (res: A, exit: Exit<E, any>) => Async<R, any, any>,
    scope: Scope<R>
): Async<R, E, A> {
    return asyncFlatMap(acquire, (resource) => {
        scope.addFinalizer((exit) => release(resource, exit));

        return asyncSucceed(resource);
    });
}

export function asyncInterruptible<R, E, A>(
    register: (env: R, cb: (exit: Exit<E, A>) => void) => void | Canceler
): Async<R, E, A> {
    return async(register);
}