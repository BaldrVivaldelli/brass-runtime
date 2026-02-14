// ----- ADT de Stream -----

import {
    Cause,
    Exit, fail, flatMap, map, mapError, orElseOptional, succeed, sync, ZIO,
} from "../types/effect.js";
import { none, Option, some } from "../types/option.js";
import {
    async,
    Async,
    asyncFail,
    asyncFlatMap,
    asyncFold,
    asyncMapError,
    asyncSucceed,
    asyncSync
} from "../types/asyncEffect";
import { Scope } from "../runtime/scope";
import { raceWith } from "./structuredConcurrency";
import { Fiber, getCurrentFiber, unsafeGetCurrentRuntime } from "../runtime/fiber";
import { unsafeRunFoldWithEnv } from "../runtime/runtime.js";



export type Empty<R, E, A> = { readonly _tag: "Empty" };

export type Emit<R, E, A> = {
    readonly _tag: "Emit";
    readonly value: ZIO<R, E, A>;
};

export type Concat<R, E, A> = {
    readonly _tag: "Concat";
    readonly left: ZStream<R, E, A>;
    readonly right: ZStream<R, E, A>;
};

export type Flatten<R, E, A> = {
    readonly _tag: "Flatten";
    readonly stream: ZStream<R, E, ZStream<R, E, A>>;
};

export type FromPull<R, E, A> = {
    readonly _tag: "FromPull";
    readonly pull: ZIO<R, Option<E>, [A, ZStream<R, E, A>]>;
};

export type Merge<R, E, A> = {
    readonly _tag: "Merge";
    readonly left: ZStream<R, E, A>;
    readonly right: ZStream<R, E, A>;
    readonly flip: boolean;
};

export type Scoped<R, E, A> = {
    readonly _tag: "Scoped";
    readonly acquire: ZIO<R, E, ZStream<R, E, A>>;
    readonly release: (exit: Exit<any, any>) => Async<R, any, void>;
};

export type Managed<R, E, A> = {
    readonly _tag: "Managed";
    readonly acquire: ZIO<R, E, {
        stream: ZStream<R, E, A>;
        release: (exit: Exit<any, any>) => Async<R, any, void>;
    }
    >;
};


export type ZStream<R, E, A> =
    | Empty<R, E, A>
    | Emit<R, E, A>
    | Concat<R, E, A>
    | FromPull<R, E, A>
    | Flatten<R, E, A>
    | Merge<R, E, A>
    | Scoped<R, E, A>
    | Managed<R, E, A>;


export type Normalize<E> = (u: unknown) => E;
export const widenOpt = <E1, E2>(opt: Option<E1>): Option<E1 | E2> =>
    opt._tag === "None" ? none : some(opt.value as any);
export const fromPull = <R, E, A>(
    pull: ZIO<R, Option<E>, [A, ZStream<R, E, A>]>
): ZStream<R, E, A> => ({
    _tag: "FromPull",
    pull,
});

export const unwrapScoped = <R, E, A>(
    acquire: ZIO<R, E, ZStream<R, E, A>>,
    release: (exit: Exit<any, any>) => Async<R, any, void>
): ZStream<R, E, A> => ({
    _tag: "Scoped",
    acquire,
    release,
});

export const managedStream = <R, E, A>(
    acquire: ZIO<R, E, { stream: ZStream<R, E, A>; release: (exit: Exit<any, any>) => Async<R, any, void> }>
): ZStream<R, E, A> => ({
    _tag: "Managed",
    acquire,
});


export const mergeStream = <R, E, A>(
    left: ZStream<R, E, A>,
    right: ZStream<R, E, A>,
    flip = true
): ZStream<R, E, A> => ({
    _tag: "Merge",
    left,
    right,
    flip,
});

export const emptyStream = <R, E, A>(): ZStream<R, E, A> => ({
    _tag: "Empty",
});

export const emitStream = <R, E, A>(value: ZIO<R, E, A>): ZStream<R, E, A> => ({
    _tag: "Emit",
    value,
});

export const concatStream = <R, E, A>(
    left: ZStream<R, E, A>,
    right: ZStream<R, E, A>
): ZStream<R, E, A> => ({
    _tag: "Concat",
    left,
    right,
});

export const flattenStream = <R, E, A>(
    stream: ZStream<R, E, ZStream<R, E, A>>
): ZStream<R, E, A> => ({
    _tag: "Flatten",
    stream,
});

type UnconsValue<R, E, A> = [A, ZStream<R, E, A>];
type Pull<R, E, A> = Async<R, Option<E>, UnconsValue<R, E, A>>;



function streamToRaceWithHandler<R, E, A>(
    winnerSide: "L" | "R",
    leftStream: ZStream<R, E, A>,
    rightStream: ZStream<R, E, A>,
    flip: boolean,
    id: number
): (
    exit: Exit<Option<E>, [A, ZStream<R, E, A>]>,
    otherFiber: Fiber<Option<E>, [A, ZStream<R, E, A>]>,
    scope: Scope<R>
) => Async<R, Option<E>, [A, ZStream<R, E, A>]> {
    return (exit, otherFiber, scope) => {
        if (exit._tag === "Failure") {
            /*console.log(`[mergePull#${id}] failure error=`, (exit.cause as any).error);*/
        }

        if (exit._tag === "Success") {
            /*console.log(`[mergePull#${id}] success -> interrupt other`);*/
        }
        if (exit._tag === "Success") {
            const [a, tailWin] = exit.value;

            // ganador dio valor => cancelamos perdedor
            otherFiber.interrupt();

            // reconstruimos el merge actualizando el lado ganador
            const next =
                winnerSide === "L"
                    ? fromPull(makeMergePull(tailWin, rightStream, !flip, id))
                    : fromPull(makeMergePull(leftStream, tailWin, !flip, id));

            return asyncSucceed([a, next]);
        }

        // failure: Option<E> o Interrupt
        if (exit.cause._tag === "Interrupt") {
            // Propagamos la interrupción (no contamina E)
            return async((_env, cb) => { cb(Exit.failCause(Cause.interrupt())) });
        }

        const opt = (exit.cause as any).error as Option<E>;


        // End(None): NO cancelamos el otro. Seguimos con el stream del otro lado.
        if (opt._tag === "None") {
            return winnerSide === "L" ? uncons(rightStream) : uncons(leftStream);
        }

        // Error real Some(e)
        return asyncFail(opt);
    };
}

function makeMergePull<R, E, A>(
    onLeft: ZStream<R, E, A>,
    onRight: ZStream<R, E, A>,
    flip: boolean,
    mergePullId: number
): Async<R, Option<E>, [A, ZStream<R, E, A>]> {
    return async((env, cb) => {
        const id = ++mergePullId;
        const runtime = unsafeGetCurrentRuntime<R>()
        const scope = new Scope(runtime);

        const leftPull = uncons(onLeft);
        const rightPull = uncons(onRight);

        const onLeftHandler = streamToRaceWithHandler("L", onLeft, onRight, flip, id);
        const onRightHandler = streamToRaceWithHandler("R", onLeft, onRight, flip, id);
        const handler = raceWith(
            leftPull,
            rightPull,
            scope,
            onLeftHandler,
            onRightHandler
        );
        scope.fork(handler).join((ex) => {
            scope.close(ex as any);
            cb(ex as any);
        });
    });

}


export function merge<R, E, A>(
    left: ZStream<R, E, A>,
    right: ZStream<R, E, A>
): ZStream<R, E, A> {
    return fromPull(makeMergePull(left, right, true, 0));
}


export function uncons<R, E, A>(
    self: ZStream<R, E, A>
): ZIO<R, Option<E>, [A, ZStream<R, E, A>]> {
    switch (self._tag) {
        case "Empty":
            return fail<Option<E>>(none);

        case "Emit":
            return map(
                mapError<R, E, Option<E>, A>(self.value, (e) => some<E>(e)),
                (a: A): [A, ZStream<R, E, A>] => [a, emptyStream<R, E, A>()]
            );

        case "FromPull":
            return self.pull;

        case "Concat":
            return orElseOptional(
                map(
                    uncons(self.left),
                    ([a, tail]): [A, ZStream<R, E, A>] => [a, concatStream<R, E, A>(tail, self.right)]
                ),
                () => uncons(self.right)
            );

        case "Flatten":
            return flatMap(uncons(self.stream), ([head, tail]) =>
                orElseOptional(
                    map(
                        uncons(head),
                        ([a, as]): [A, ZStream<R, E, A>] => [
                            a,
                            concatStream<R, E, A>(as, flattenStream<R, E, A>(tail)),
                        ]
                    ),
                    () => uncons(flattenStream<R, E, A>(tail))
                )
            )
        case "Merge":
            return makeMergePull(self.left, self.right, self.flip, 0);
        case "Scoped":
            return async((env, cb) => {
                const runtime = unsafeGetCurrentRuntime<R>();
                const scope = new Scope(runtime);

                // 👇 Si el consumidor corta (ej: takeP) igual cerramos el scope al finalizar el fiber.
                const fiber = getCurrentFiber();
                fiber?.addFinalizer((exit) => {
                    try {
                        scope.close(exit as any);
                    } catch { }
                });

                const closeWith = (exit: Exit<any, any>) => {
                    // End-of-stream = Failure(None) => para finalizers suele ser más útil tratarlo como Success
                    if (exit._tag === "Failure") {
                        const err = (exit.cause as any).error as any;
                        if (err && typeof err === "object" && err._tag === "None") {
                            scope.close({ _tag: "Success", value: undefined });
                            return;
                        }
                    }
                    scope.close(exit);
                };

                // Wrap del stream para cerrar el scope SOLO cuando termina/falla (no en cada elemento).
                const wrap = (s: ZStream<R, E, A>): ZStream<R, E, A> =>
                    fromPull(
                        async((env2, cb2) => {
                            const pull = uncons(s) as unknown as Pull<R, E, A>;

                            unsafeRunFoldWithEnv<R, Option<E>, UnconsValue<R, E, A>>(
                                pull,
                                env2,
                                (cause) => {
                                    const ex = Exit.failCause<Option<E>, UnconsValue<R, E, A>>(cause);
                                    closeWith(ex);
                                    cb2(ex);
                                },
                                ([a, tail]) => {
                                    cb2(Exit.succeed<Option<E>, UnconsValue<R, E, A>>([a, wrap(tail)]));
                                }
                            );
                        })
                    );


                // Acquire en scope
                scope.fork(self.acquire as any).join((ex) => {
                    if (ex._tag === "Failure") {
                        // 👇 IMPORTANTE: NO registramos finalizer si acquire falló
                        closeWith(ex as any);
                        cb({ _tag: "Failure", cause: { _tag: "Fail", error: some(((ex.cause as any).error) as any) } } as any); // E -> Option<E>
                        return;
                    }

                    // 👇 Registrar release SOLO si acquire tuvo éxito
                    scope.addFinalizer((exit) => self.release(exit));

                    const inner = ex.value as ZStream<R, E, A>;
                    unsafeGetCurrentRuntime<R>().fork(uncons(wrap(inner)) as any).join(cb as any);
                });
            });
        case "Managed":
            return async((env, cb) => {
                const runtime = unsafeGetCurrentRuntime<R>();
                const scope = new Scope(runtime);

                // Si el consumidor corta (take/interrupt), igual cerramos el scope.
                getCurrentFiber()?.addFinalizer((exit) => {
                    try { scope.close(exit as any); } catch { }
                });

                const closeWith = (exit: Exit<any, any>) => {
                    // End-of-stream = Failure(None) => para finalizers suele ser más útil tratarlo como Success
                    if (exit._tag === "Failure") {
                        const err = (exit.cause as any).error as any;
                        if (err && typeof err === "object" && err._tag === "None") {
                            scope.close({ _tag: "Success", value: undefined });
                            return;
                        }
                    }
                    scope.close(exit);
                };

                scope.fork(self.acquire as any).join((ex) => {
                    if (ex._tag === "Failure") {
                        scope.close(ex as any);
                        cb({ _tag: "Failure", cause: { _tag: "Fail", error: some(((ex.cause as any).error) as any) } } as any);
                        return;
                    }

                    const { stream: inner, release } = ex.value as {
                        stream: ZStream<R, E, A>;
                        release: (exit: Exit<any, any>) => Async<R, any, void>;
                    };

                    // Release correcto (del mismo acquire)
                    scope.addFinalizer((exit) => release(exit));

                    // Mantener el scope vivo hasta que el stream termine o falle
                    const wrap = (s: ZStream<R, E, A>): ZStream<R, E, A> =>
                        fromPull(
                            async((env2, cb2) => {
                                (uncons(s) as any)(env2, (ex2: any) => {
                                    if (ex2._tag === "Failure") {
                                        closeWith(ex2);
                                        cb2(ex2);
                                        return;
                                    }
                                    const [a, tail] = ex2.value as [A, ZStream<R, E, A>];
                                    cb2(Exit.succeed([a, wrap(tail)]));
                                });
                            }) as any
                        );

                    unsafeGetCurrentRuntime<R>().fork(uncons(wrap(inner)) as any).join(cb as any);
                });
            });
    }
}






export function assertNever(x: never, msg?: string): never {
    throw new Error(msg ?? `Unexpected value: ${String(x)}`);
}
// ---------- combinadores extra opcionales ----------

export function mapStream<R, E, A, B>(
    self: ZStream<R, E, A>,
    f: (a: A) => B
): ZStream<R, E, B> {
    switch (self._tag) {
        case "Empty":
            return emptyStream<R, E, B>();

        case "Emit":
            return emitStream<R, E, B>(map(self.value, f));

        case "FromPull":
            return fromPull(
                map(self.pull, ([a, tail]): [B, ZStream<R, E, B>] => [f(a), mapStream(tail, f)])
            );

        case "Concat":
            return concatStream<R, E, B>(mapStream(self.left, f), mapStream(self.right, f));

        case "Flatten": {
            const mappedOuter: ZStream<R, E, ZStream<R, E, B>> = mapStream(
                self.stream,
                (inner) => mapStream(inner, f)
            );
            return flattenStream<R, E, B>(mappedOuter);
        }

        case "Merge":
            return mergeStream<R, E, B>(
                mapStream(self.left, f),
                mapStream(self.right, f),
                self.flip
            );

        case "Scoped":
            return unwrapScoped<R, E, B>(
                map(self.acquire, (s) => mapStream(s, f)),
                self.release
            );
        case "Managed":
            return managedStream<R, E, B>(
                map(self.acquire, ({ stream, release }) => ({
                    stream: mapStream(stream, f),
                    release,
                }))
            );
        default:
            return assertNever(self);
    }
}


export function rangeStream(start: number, end: number): ZStream<unknown, never, number> {
    const go = (i: number): ZStream<unknown, never, number> =>
        fromPull(
            i > end
                ? asyncFail(none)
                : asyncSucceed([i, go(i + 1)])
        );

    return go(start);
}



export function zip<R, E1, A, E2, B>(
    left: ZStream<R, E1, A>,
    right: ZStream<R, E2, B>
): ZStream<R, E1 | E2, [A, B]> {
    const pull: Async<
        R,
        Option<E1 | E2>,
        [[A, B], ZStream<R, E1 | E2, [A, B]>]
    > = asyncFold(
        asyncMapError(uncons(left), (opt: Option<E1>) => widenOpt<E1, E2>(opt)),
        // si left termina o falla, el zip termina/falla igual
        (opt: Option<E1 | E2>) => asyncFail(opt),
        ([a, tailL]) =>
            asyncFold(
                asyncMapError(uncons(right), (opt: Option<E2>) => widenOpt<E2, E1>(opt)),
                (opt: Option<E1 | E2>) => asyncFail(opt),
                ([b, tailR]) =>
                    asyncSucceed([
                        [a, b] as [A, B],
                        zip(tailL as any, tailR as any),
                    ] as [[A, B], ZStream<R, E1 | E2, [A, B]>])
            )
    );

    return fromPull(pull);
}


export function foreachStream<R, E, A, R2, E2>(
    stream: ZStream<R, E, A>,
    f: (a: A) => Async<R2, E2, void>
): Async<R & R2, E | E2, void> {
    // loop falla con Option<E|E2> (fin = None, error real = Some(e))
    const loop = (cur: ZStream<R, E, A>): Async<R & R2, Option<E | E2>, void> =>
        asyncFold(
            // uncons: Option<E> -> Option<E|E2>
            asyncMapError(uncons(cur), (opt: Option<E>) => widenOpt<E, E2>(opt)),
            (opt: Option<E | E2>) => {
                // None => fin
                if (opt._tag === "None") return asyncSucceed(undefined);
                // Some(e) => mantener Option en el loop
                return asyncFail(opt);
            },
            ([a, tail]) =>
                asyncFlatMap(
                    // f(a): E2 -> Option<E|E2>
                    asyncMapError(f(a), (e2: E2) => some(e2 as E | E2)),
                    () => loop(tail)
                )
        );

    // salida final: Option<E|E2> -> E|E2 (None no debería llegar como failure)
    return asyncFold(
        loop(stream),
        (opt: Option<E | E2>) => {
            if (opt._tag === "None") return asyncSucceed(undefined) as any;
            return asyncFail(opt.value);
        },
        () => asyncSucceed(undefined)
    ) as Async<R & R2, E | E2, void>;
}

export function fromArray<A>(values: readonly A[]): ZStream<unknown, never, A> {
    let s: ZStream<unknown, never, A> = emptyStream<unknown, never, A>();

    for (let i = values.length - 1; i >= 0; i--) {
        const head = emitStream<unknown, never, A>(succeed(values[i]!));
        s = concatStream<unknown, never, A>(head, s);
    }

    return s;
}

// Consumidor síncrono del stream
export function collectStream<R, E, A>(stream: ZStream<R, E, A>): ZIO<R, E, A[]> {
    const loop = (cur: ZStream<R, E, A>, acc: A[]): ZIO<R, Option<E>, A[]> =>
        asyncFold(
            uncons(cur),
            (opt: Option<E>) => {
                if (opt._tag === "None") return succeed(acc);
                return fail(opt);
            },
            ([a, tail]) => loop(tail, [...acc, a])
        );

    return mapError(loop(stream, []), (opt) => {
        if (opt._tag === "Some") return opt.value;
        throw new Error("unreachable: stream end handled as success");
    });
}


function readerStream<E>(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    normalizeError: Normalize<E>
): ZStream<unknown, E, Uint8Array> {
    const pull: ZIO<
        unknown,
        Option<E>,
        [Uint8Array, ZStream<unknown, E, Uint8Array>]
    > =
        async((_, cb) => {
            reader.read()
                .then(({ done, value }) => {
                    if (done) {
                        cb({ _tag: "Failure", cause: { _tag: "Fail", error: none } }); // fin normal
                        return;
                    }
                    cb({
                        _tag: "Success",
                        value: [value as Uint8Array, fromPull(pull)]
                    });
                })
                .catch((e) => {
                    // Error real => Some(e)
                    cb({ _tag: "Failure", cause: { _tag: "Fail", error: some(normalizeError(e)) } });
                });
        }) as any;

    return fromPull(pull);
}

export function streamFromReadableStream<E>(
    body: ReadableStream<Uint8Array> | null | undefined,
    normalizeError: Normalize<E>
): ZStream<unknown, E, Uint8Array> {
    if (!body) return emptyStream<unknown, E, Uint8Array>();

    // Necesitamos que release vea el reader: lo guardamos en un closure.
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    return unwrapScoped(
        // acquire: produce un ZStream
        sync(() => {
            reader = body.getReader();
            return readerStream(reader, normalizeError);
        }) as any,
        // release: se corre en fin / error / interrupción
        () =>
            asyncSync(() => {
                try {
                    // cancel() es idempotente-ish; si ya terminó no pasa nada
                    reader?.cancel();
                } catch {
                    // ignorar
                }
            }) as any
    );
}