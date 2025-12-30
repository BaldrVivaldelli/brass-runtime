// src/effect.ts
// Resultado de ejecutar un efecto

import {Option} from "./option";

export type Exit<E, A> =
    | { readonly _tag: "Success"; readonly value: A }
    | { readonly _tag: "Failure"; readonly error: E };

// Un efecto es simplemente una función pura: env -> Exit
export type Effect<R, E, A> = (env: R) => Exit<E, A>;

// Alias estilo ZIO
export type ZIO<R, E, A> = Effect<R, E, A>;
export type EffectScope = {}; // placeholder por ahora

// ---------- Constructores básicos ----------

export const succeed = <A, R = {}>(value: A): Effect<R, never, A> =>
    (_: R) => ({ _tag: "Success", value });


export const fail = <E>(error: E): Effect<unknown, E, never> =>
    () => ({ _tag: "Failure", error });

export const sync = <R, A>(thunk: (env: R) => A): Effect<R, unknown, A> =>
    (env: R) => {
        try {
            return { _tag: "Success", value: thunk(env) };
        } catch (e) {
            return { _tag: "Failure", error: e as unknown };
        }
    };

export const fromThunk = <A>(thunk: () => A): Effect<unknown, unknown, A> =>
    sync(() => thunk());

// ---------- Combinadores de valor ----------

export function map<R, E, A, B>(
    eff: Effect<R, E, A>,
    f: (a: A) => B
): Effect<R, E, B> {
    return (env: R) => {
        const exit = eff(env);
        if (exit._tag === "Success") {
            return { _tag: "Success", value: f(exit.value) };
        }
        return exit as any;
    };
}

export function flatMap<R, E, A, R2, E2, B>(
    eff: Effect<R, E, A>,
    f: (a: A) => Effect<R2, E2, B>
): Effect<R & R2, E | E2, B> {
    return (env: R & R2) => {
        const exit1 = eff(env);
        if (exit1._tag === "Failure") {
            return exit1 as any;
        }
        return f(exit1.value)(env) as any;
    };
}

export function mapError<R, E, E2, A>(
    eff: Effect<R, E, A>,
    f: (e: E) => E2
): Effect<R, E2, A> {
    return (env: R) => {
        const exit = eff(env);
        if (exit._tag === "Failure") {
            return { _tag: "Failure", error: f(exit.error) };
        }
        return exit as any;
    };
}

export function catchAll<R, E, A, R2, E2, B>(
    eff: Effect<R, E, A>,
    handler: (e: E) => Effect<R2, E2, B>
): Effect<R & R2, E2, A | B> {
    return (env: R & R2) => {
        const exit = eff(env);
        if (exit._tag === "Failure") {
            return handler(exit.error)(env) as any;
        }
        return exit as any;
    };
}

/**
 * Versión estilo ZIO.orElseOptional:
 * eff: Effect<R, Option<E>, A>
 * - Failure(Some(e))  => se propaga
 * - Failure(None)     => se ejecuta `that`
 */
export function orElseOptional<R, E, R2, A, A2>(
    eff: Effect<R, Option<E>, A>,
    that: () => Effect<R2, Option<E>, A2>
): Effect<R & R2, Option<E>, A | A2> {
    return (env: R & R2) => {
        const exit1 = eff(env as any);
        if (exit1._tag === "Success") return exit1 as any;

        const opt = exit1.error;
        if (opt._tag === "Some") return exit1 as any; // error real

        return that()(env as any) as any; // None => probamos alternativa
    };
}

// ---------- Más combinadores ----------

export function zip<R1, E1, A, R2, E2, B>(
    fa: Effect<R1, E1, A>,
    fb: Effect<R2, E2, B>
): Effect<R1 & R2, E1 | E2, [A, B]> {
    return (env: R1 & R2) => {
        const ea = fa(env);
        if (ea._tag === "Failure") return ea as any;
        const eb = fb(env);
        if (eb._tag === "Failure") return eb as any;
        return { _tag: "Success", value: [ea.value, eb.value] as [A, B] };
    };
}

export function tap<R, E, A, R2, E2>(
    eff: Effect<R, E, A>,
    f: (a: A) => Effect<R2, E2, unknown>
): Effect<R & R2, E | E2, A> {
    return (env: R & R2) => {
        const ea = eff(env);
        if (ea._tag === "Failure") return ea as any;
        const eb = f(ea.value)(env);
        if (eb._tag === "Failure") return eb as any;
        return ea as any;
    };
}

export function as<R, E, A, B>(
    eff: Effect<R, E, A>,
    value: B
): Effect<R, E, B> {
    return map(eff, () => value);
}

export function asUnit<R, E, A>(
    eff: Effect<R, E, A>
): Effect<R, E, void> {
    return as(eff, undefined);
}

export function foreach<R, E, A, R2, E2, B>(
    items: Iterable<A>,
    f: (a: A) => Effect<R2, E2, B>
): Effect<R & R2, E | E2, B[]> {
    return (env: R & R2) => {
        const out: B[] = [];
        for (const a of items) {
            const exit = f(a)(env);
            if (exit._tag === "Failure") return exit as any;
            out.push(exit.value);
        }
        return { _tag: "Success", value: out };
    };
}

export function collectAll<R, E, A>(
    effects: Iterable<Effect<R, E, A>>
): Effect<R, E, A[]> {
    return foreach(effects, (e) => e);
}
