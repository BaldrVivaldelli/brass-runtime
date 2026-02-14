import type { Async } from "./asyncEffect";
import { asyncFail, asyncFlatMap, asyncFold, asyncMap, asyncMapError, asyncSucceed, asyncSync } from "./asyncEffect";
import type { Option } from "./option";
import { none } from "./option";

export type Cause<E> =
    | { readonly _tag: "Fail"; readonly error: E }
    | { readonly _tag: "Interrupt" }
    | { readonly _tag: "Die"; readonly defect: unknown };


export const Cause = {
    fail: <E>(error: E): Cause<E> => ({ _tag: "Fail", error }),
    interrupt: <E = never>(): Cause<E> => ({ _tag: "Interrupt" }),
    die: <E = never>(defect: unknown): Cause<E> => ({ _tag: "Die", defect }),
};

export type Exit<E, A> =
    | { _tag: "Success"; value: A }
    | { _tag: "Failure"; cause: Cause<E> };


export const Exit = {
    succeed: <E = never, A = never>(value: A): Exit<E, A> => ({
        _tag: "Success",
        value,
    }),

    failCause: <E = never, A = never>(cause: Cause<E>): Exit<E, A> => ({
        _tag: "Failure",
        cause,
    }),
};
export type ZIO<R, E, A> = Async<R, E, A>;

export const succeed = <A>(value: A): ZIO<unknown, never, A> => asyncSucceed(value);
export const fail = <E>(error: E): ZIO<unknown, E, never> => asyncFail(error);

export const sync = <R, A>(thunk: (env: R) => A): ZIO<R, unknown, A> =>
    asyncSync((env) => thunk(env));

export const map = <R, E, A, B>(fa: ZIO<R, E, A>, f: (a: A) => B) => asyncMap(fa, f);

export const flatMap = <R, E, A, R2, E2, B>(
    fa: ZIO<R, E, A>,
    f: (a: A) => ZIO<R2, E2, B>
): ZIO<R & R2, E | E2, B> =>
    asyncFlatMap(fa as any, (a: A) => f(a) as any) as any;

export const mapError = <R, E, E2, A>(fa: ZIO<R, E, A>, f: (e: E) => E2) => asyncMapError(fa as any, f as any) as any;

export const catchAll = <R, E, A, R2, E2, B>(
    fa: ZIO<R, E, A>,
    handler: (e: E) => ZIO<R2, E2, B>
): ZIO<R & R2, E2, A | B> =>
    asyncFold(
        fa as any,
        (e: E) => handler(e) as any,
        (a: A) => asyncSucceed(a) as any
    ) as any;

export function orElseOptional<R, E, A, R2, A2>(
    fa: ZIO<R, Option<E>, A>,
    that: () => ZIO<R2, Option<E>, A2>
): ZIO<R & R2, Option<E>, A | A2> {
    return asyncFold(
        fa as any,
        (opt: Option<E>) => (opt._tag === "Some" ? asyncFail(opt) : (that() as any)),
        (a: A) => asyncSucceed(a) as any
    ) as any;
}

export const end = <E>(): ZIO<unknown, Option<E>, never> => fail(none as Option<E>);
