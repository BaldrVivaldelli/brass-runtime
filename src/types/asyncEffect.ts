// src/asyncEffect.ts
import type { Exit } from "./effect";

export type Async<R, E, A> =
    | { _tag: "Succeed"; value: A }
    | { _tag: "Fail"; error: E }
    | { _tag: "Sync"; thunk: (env: R) => A }
    | {
    _tag: "Async";
    register: (env: R, cb: (exit: Exit<E, A>) => void) => void;
}
    | {
    _tag: "FlatMap";
    first: Async<R, E, any>;
    andThen: (a: any) => Async<R, E, A>;
};

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
