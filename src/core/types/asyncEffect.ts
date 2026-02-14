// src/asyncEffect.ts
import type { Exit } from "./effect";
import { Canceler } from "./cancel";
import { Scope } from "../runtime/scope";




export type Async<R, E, A> =
    | { readonly _tag: "Succeed"; readonly value: A }
    | { readonly _tag: "Fail"; readonly error: E }
    | { readonly _tag: "Sync"; readonly thunk: (env: R) => A }
    | {
        readonly _tag: "Async";
        readonly register: (env: R, cb: (exit: Exit<E, A>) => void) => void | (() => void);
    }
    | { readonly _tag: "FlatMap"; readonly first: Async<R, E, any>; readonly andThen: (a: any) => Async<R, E, A> }
    | { readonly _tag: "Fold"; readonly first: Async<R, E, any>; readonly onFailure: (e: any) => Async<R, E, A>; readonly onSuccess: (a: any) => Async<R, E, A> }
    | { readonly _tag: "Fork"; readonly effect: Async<R, E, any>; readonly scopeId?: number };

// ✅ VALUE: constructores (esto arregla TS2693)
export const Async = {
    succeed: <R, E, A>(value: A): Async<R, E, A> => ({ _tag: "Succeed", value }),
    fail: <R, E, A = never>(error: E): Async<R, E, A> => ({ _tag: "Fail", error }),
    sync: <R, E, A>(thunk: (env: R) => A): Async<R, E, A> => ({ _tag: "Sync", thunk }),
    async: <R, E, A>(
        register: (env: R, cb: (exit: Exit<E, A>) => void) => void | (() => void)
    ): Async<R, E, A> => ({ _tag: "Async", register }),
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


export const unit = <R>(): Async<R, never, void> =>
    asyncSucceed<void>(undefined) as any;


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



//TODO: Esto lo hago porque me interesa saber el nombre explicito de lo que falla, no solo que falle sino mas bien un detalle

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

export type AsyncWithPromise<R, E, A> = Async<R, E, A> & {
    toPromise: (env: R) => Promise<A>;
    unsafeRunPromise: () => Promise<A>; // atajo para env = {}
};


export const withAsyncPromise =
    <R, E, A>(run: (eff: Async<R, E, A>, env: R) => Promise<A>) =>
        (eff: Async<R, E, A>): AsyncWithPromise<R, E, A> => {
            const anyEff: any = eff;

            //si lo llamo varias veces, no lo re-re escribo
            if (!anyEff.toPromise) {
                anyEff.toPromise = (env: R) => run(eff, env);
                anyEff.unsafeRunPromise = () => run(eff, {} as R);
            }

            return anyEff as AsyncWithPromise<R, E, A>;
        };

export const mapAsync = <R, E, A, B>(fa: Async<R, E, A>, f: (a: A) => B): Async<R, E, B> =>
    asyncFlatMap(fa, (a) => asyncSucceed(f(a)));

export const mapTryAsync = <R, E, A, B>(fa: Async<R, E, A>, f: (a: A) => B): Async<R, E, B> =>
    asyncFlatMap(fa, (a) => asyncSync(() => f(a)) as any);
