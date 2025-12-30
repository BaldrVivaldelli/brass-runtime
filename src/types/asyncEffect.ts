// src/asyncEffect.ts
import type { Exit } from "./effect";
import {Canceler} from "./cancel";
import {BrassError} from "../fibers/fiber";
import {Scope} from "../scheduler/scope";


export type Async<R, E, A> =
    | { _tag: "Succeed"; value: A }
    | { _tag: "Fail"; error: E }
    | { _tag: "Sync"; thunk: (env: R) => A }
    | {
    _tag: "Async";
    register: (env: R, cb: (exit: Exit<E, A>) => void) => void | Canceler;
}
    | {
    _tag: "FlatMap";
    first: Async<R, E, any>;
    andThen: (a: any) => Async<R, E, A>;
};

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
    register: (env: R, cb: (exit: Exit<E, A>) => void) => void
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

//TODO: Esto lo hago porque me interesa saber el nombre explicito de lo que falla, no solo que falle sino mas bien un detalle
const isAbortError = (e: unknown): boolean =>
    typeof e === "object" &&
    e !== null &&
    "name" in e &&
    (e as any).name === "AbortError";

export function tryPromiseAbortable<R = unknown, A = unknown>(
    thunk: (env: R, signal: AbortSignal) => Promise<A>
): Async<R, BrassError, A> {
    return fromPromiseAbortable(thunk, (e): BrassError =>
        isAbortError(e)
            ? { _tag: "Abort" }
            : { _tag: "PromiseRejected", reason: e }
    );
}

export function fromPromiseAbortable<R, E, A>(
    thunk: (env: R, signal: AbortSignal) => Promise<A>,
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
            const p = thunk(env, ac.signal);
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
        // registrar finalizer
        scope.addFinalizer((exit) => release(resource, exit));

        return asyncSucceed(resource);
    });
}

function registerInterruptible<R, E, A>(
    register: (env: R, cb: (exit: Exit<E, A>) => void) => void | Canceler
): Async<R, E, A> {
    return async<R, E, A>((env, cb) => {
        const canceler = register(env, cb);

        return typeof canceler === "function"
            ? asyncSync((_env) => {
                try { canceler(); } catch {}
            })
            : unit();
    });
}