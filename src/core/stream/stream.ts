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


export type FromArray<R, E, A> = {
    readonly _tag: "FromArray";
    readonly values: readonly A[];
};


export type ZStream<R, E, A> =
    | Empty<R, E, A>
    | Emit<R, E, A>
    | Concat<R, E, A>
    | FromPull<R, E, A>
    | FromArray<R, E, A>
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

/**
 * Singleton empty stream — avoids creating a new `{ _tag: "Empty" }` object
 * on every call to `emptyStream()` or `uncons` for the Emit case.
 */
const EMPTY_STREAM: ZStream<any, any, any> = { _tag: "Empty" };

export const emptyStream = <R, E, A>(): ZStream<R, E, A> =>
    EMPTY_STREAM as ZStream<R, E, A>;

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
        if (Cause.isInterruptedOnly(exit.cause)) {
            // Propagamos la interrupción (no contamina E)
            return async((_env, cb) => { cb(Exit.failCause(Cause.interrupt())) });
        }

        const failure = Cause.firstFailure(exit.cause);
        if (failure._tag === "None") {
            return async((_env, cb) => { cb(Exit.failCause(exit.cause as any)); });
        }
        const opt = failure.value as Option<E>;


        // End(None): NO cancelamos el otro. Seguimos con el stream del otro lado.
        if (opt._tag === "None") {
            return winnerSide === "L" ? uncons(rightStream) : uncons(leftStream);
        }

        // Error real Some(e)
        return asyncFail(opt);
    };
}

/**
 * makeMergePull — creates a pull that races left and right streams.
 *
 * Scope reuse note: each raceWith call needs its own sub-scope because the
 * losing fiber must be interrupted via scope.close(). The next iteration
 * creates a fresh scope for its new pair of fibers. Reusing a closed scope
 * would break structured concurrency semantics (LIFO finalizer ordering,
 * child interruption guarantees). Instead we apply micro-optimizations:
 * - Build handler functions once per pull (not per iteration)
 * - Inline the scope.close + cb callback to avoid extra closure allocation
 */
function makeMergePull<R, E, A>(
    onLeft: ZStream<R, E, A>,
    onRight: ZStream<R, E, A>,
    flip: boolean,
    mergePullId: number
): Async<R, Option<E>, [A, ZStream<R, E, A>]> {
    // Build handlers once for this pull invocation
    const id = ++mergePullId;
    const onLeftHandler = streamToRaceWithHandler("L", onLeft, onRight, flip, id);
    const onRightHandler = streamToRaceWithHandler("R", onLeft, onRight, flip, id);

    return async((_env, cb) => {
        const runtime = unsafeGetCurrentRuntime<R>();
        const scope = new Scope(runtime);

        const handler = raceWith(
            uncons(onLeft),
            uncons(onRight),
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

        case "FromArray": {
            const arr = self.values;
            if (arr.length === 0) return fail<Option<E>>(none);
            const tail: ZStream<R, E, A> = arr.length === 1
                ? (EMPTY_STREAM as ZStream<R, E, A>)
                : { _tag: "FromArray", values: arr.slice(1) } as ZStream<R, E, A>;
            return succeed([arr[0]!, tail]) as any;
        }

        case "Emit":
            return map(
                mapError<R, E, Option<E>, A>(self.value, (e) => some<E>(e)),
                (a: A): [A, ZStream<R, E, A>] => [a, EMPTY_STREAM as ZStream<R, E, A>]
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
                        const failure = Cause.firstFailure(exit.cause);
                        const err = failure._tag === "Some" ? failure.value as any : undefined;
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
                        const failure = Cause.firstFailure(ex.cause);
                        cb(failure._tag === "Some"
                            ? { _tag: "Failure", cause: Cause.fail(some(failure.value as any)) } as any
                            : { _tag: "Failure", cause: ex.cause } as any); // E -> Option<E>
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
                        const failure = Cause.firstFailure(exit.cause);
                        const err = failure._tag === "Some" ? failure.value as any : undefined;
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
                        const failure = Cause.firstFailure(ex.cause);
                        cb(failure._tag === "Some"
                            ? { _tag: "Failure", cause: Cause.fail(some(failure.value as any)) } as any
                            : { _tag: "Failure", cause: ex.cause } as any);
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
                                unsafeRunFoldWithEnv<R, Option<E>, UnconsValue<R, E, A>>(
                                  uncons(s) as any,
                                  env2 as R,
                                    (cause) => {
                                        const ex2 = Exit.failCause<Option<E>, UnconsValue<R, E, A>>(cause);
                                        closeWith(ex2);
                                        cb2(ex2);
                                    },
                                    ([a, tail]) => {
                                        cb2(Exit.succeed([a, wrap(tail)]));
                                    }
                                );
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

        case "FromArray":
            return { _tag: "FromArray", values: self.values.map(f) } as ZStream<R, E, B>;

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
    if (values.length === 0) return emptyStream<unknown, never, A>();
    return { _tag: "FromArray", values } as ZStream<unknown, never, A>;
}

// Consumidor síncrono del stream
export function collectStream<R, E, A>(stream: ZStream<R, E, A>): ZIO<R, E, A[]> {
    // Fast path: if the stream can be drained synchronously (e.g., fromArray or fused result),
    // return the result immediately without going through the effect system.
    // SAFETY: drainStreamSyncFull only succeeds for finite, pure streams (FromArray, Emit(Succeed),
    // Concat chains). It cannot loop infinitely because all recognized node types are finite.
    const syncResult = drainStreamSyncFull<R, E, A>(stream);
    if (syncResult !== null) {
        return asyncSucceed(syncResult) as any;
    }

    const loop = (cur: ZStream<R, E, A>, acc: A[]): ZIO<R, Option<E>, A[]> =>
        asyncFold(
            uncons(cur),
            (opt: Option<E>) => {
                if (opt._tag === "None") return succeed(acc);
                return fail(opt);
            },
            ([a, tail]) => { acc.push(a); return loop(tail, acc); }
        );

    return mapError(loop(stream, []), (opt) => {
        if (opt._tag === "Some") return opt.value;
        throw new Error("unreachable: stream end handled as success");
    });
}

/**
 * Attempts to drain a stream into an array synchronously.
 * Works for streams built from fromArray (Concat chains of Emit(Succeed(...)) nodes).
 * Returns null if the stream contains async/effectful nodes.
 */
function drainStreamSyncFull<R, E, A>(stream: ZStream<R, E, A>): A[] | null {
    const result: A[] = [];
    let cur: ZStream<R, E, A> = stream;

    while (true) {
        switch (cur._tag) {
            case "Empty":
                return result;

            case "FromArray": {
                // O(1) drain — just copy the array
                const arr = cur.values;
                for (let i = 0; i < arr.length; i++) {
                    result.push(arr[i]!);
                }
                return result;
            }

            case "Emit": {
                const zio = cur.value as any;
                if (zio._tag === "Succeed") {
                    result.push(zio.value);
                    return result;
                }
                return null;
            }

            case "Concat": {
                // Drain left recursively, then continue with right
                const leftItems = drainStreamSyncFull<R, E, A>(cur.left);
                if (leftItems === null) return null;
                for (let i = 0; i < leftItems.length; i++) {
                    result.push(leftItems[i]!);
                }
                cur = cur.right;
                break;
            }

            default:
                return null;
        }
    }
}


// Cached AbortError for reuse — avoids allocating a new DOMException per stream abort.
const ABORTED_ERROR: Error = (() => {
    if (typeof DOMException === "function") {
        try {
            return new DOMException("aborted", "AbortError");
        } catch {
            // Fall through
        }
    }
    const e = new Error("aborted");
    e.name = "AbortError";
    return e;
})();

function readerStream<E>(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    normalizeError: Normalize<E>,
    signal?: AbortSignal
): ZStream<unknown, E, Uint8Array> {
    // Hoist signal check — most streams don't have a signal (or have noopSignal).
    const noopSignal = (globalThis as any).__brassNoopSignal;
    const needsSignalListener = signal !== undefined && signal !== noopSignal;

    const pull: ZIO<
        unknown,
        Option<E>,
        [Uint8Array, ZStream<unknown, E, Uint8Array>]
    > =
        async((_, cb) => {
            let done = false;
            let abortFn: (() => void) | undefined;

            const finish = (exit: Exit<Option<E>, [Uint8Array, ZStream<unknown, E, Uint8Array>]>) => {
                if (done) return;
                done = true;
                if (needsSignalListener && abortFn) signal!.removeEventListener("abort", abortFn);
                cb(exit);
            };

            if (needsSignalListener) {
                if (signal!.aborted) {
                    try { reader.cancel(); } catch { /* ignore */ }
                    finish({ _tag: "Failure", cause: { _tag: "Fail", error: some(normalizeError(ABORTED_ERROR)) } });
                    return;
                }

                abortFn = () => {
                    try { reader.cancel(); } catch { /* ignore */ }
                    finish({ _tag: "Failure", cause: { _tag: "Fail", error: some(normalizeError(ABORTED_ERROR)) } });
                };
                signal!.addEventListener("abort", abortFn, { once: true });
            }

            reader.read()
                .then(({ done: readDone, value }) => {
                    if (readDone) {
                        finish({ _tag: "Failure", cause: { _tag: "Fail", error: none } });
                        return;
                    }
                    finish({
                        _tag: "Success",
                        value: [value as Uint8Array, fromPull(pull)]
                    });
                }, (e) => {
                    // Error real => Some(e)
                    finish({ _tag: "Failure", cause: { _tag: "Fail", error: some(normalizeError(e)) } });
                });

            return () => {
                if (done) return;
                done = true;
                if (needsSignalListener && abortFn) signal!.removeEventListener("abort", abortFn);
                try { reader.cancel(); } catch { /* ignore */ }
            };
        }) as any;

    return fromPull(pull);
}

export type ReadableStreamOptions = {
    signal?: AbortSignal;
    onRelease?: () => void;
};

export function streamFromReadableStream<E>(
    body: ReadableStream<Uint8Array> | null | undefined,
    normalizeError: Normalize<E>,
    options: ReadableStreamOptions = {}
): ZStream<unknown, E, Uint8Array> {
    if (!body) return emptyStream<unknown, E, Uint8Array>();

    // Necesitamos que release vea el reader: lo guardamos en un closure.
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    return unwrapScoped(
        // acquire: produce un ZStream
        sync(() => {
            reader = body.getReader();
            return readerStream(reader, normalizeError, options.signal);
        }) as any,
        // release: se corre en fin / error / interrupción
        () =>
            asyncSync(() => {
                try {
                    // cancel() es idempotente-ish; si ya terminó no pasa nada
                    reader?.cancel();
                } catch {
                    // ignorar
                } finally {
                    options.onRelease?.();
                }
            }) as any
    );
}
