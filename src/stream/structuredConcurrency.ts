// src/structuredConcurrency.ts

import { Exit } from "../types/effect";
import { async, Async } from "../types/asyncEffect";
import { Scope } from "../runtime/scope";
import { Interrupted } from "../runtime/fiber";

type AnyFiber<R, E, A> = ReturnType<Scope<R>["fork"]>;

/**
 * race(A, B):
 *   - corre A y B en paralelo
 *   - el primero que termine gana
 *   - el otro es cancelado
 */
export function race<R, E, A>(
    left: Async<R, E, A>,
    right: Async<R, E, A>,
    parentScope: Scope<R>
): Async<R, E | Interrupted, A> {
    return async((env, cb) => {
        // cada carrera tiene su propio scope interno
        const scope = parentScope.subScope();

        let done = false;

        const onResult = (exit: Exit<E | Interrupted, A>) => {
            if (done) return;
            done = true;

            // cerrar todo (esto cancela la otra fibra)
            scope.close(exit);

            cb(exit);
        };

        const fiberLeft = scope.fork(left, env);
        const fiberRight = scope.fork(right, env);

        fiberLeft.join(onResult);
        fiberRight.join(onResult);
    });
}

/**
 * zipPar(A, B):
 *   - corre A y B en paralelo
 *   - si ambas terminan bien → éxito con (A, B)
 *   - si una falla → cancelar todo y devolver fallo
 */
export function zipPar<R, E, A, B>(
    left: Async<R, E, A>,
    right: Async<R, E, B>,
    parentScope: Scope<R>
): Async<R, E | Interrupted, [A, B]> {
    return async((env, cb) => {
        const scope = parentScope.subScope();

        let leftExit: Exit<E | Interrupted, A> | null = null;
        let rightExit: Exit<E | Interrupted, B> | null = null;
        let done = false;

        const checkDone = () => {
            // si todavía no tenemos ambos resultados, no hacemos nada
            if (!leftExit || !rightExit || done) return;

            done = true;

            if (leftExit._tag === "Success" && rightExit._tag === "Success") {
                // ambos ok
                scope.close({ _tag: "Success", value: undefined });
                cb({
                    _tag: "Success",
                    value: [leftExit.value, rightExit.value],
                });
                return;
            }

            // algún error, cancelar todo
            let cause: E | Interrupted;

            if (leftExit._tag === "Failure") {
                cause = leftExit.error;
            } else if (rightExit._tag === "Failure") {
                cause = rightExit.error;
            } else {
                // Esto es lógicamente imposible, pero lo ponemos
                // para mantener feliz a TypeScript.
                throw new Error("zipPar: unreachable state (no Failure exit)");
            }

            const errExit: Exit<E | Interrupted, [A, B]> = {
                _tag: "Failure",
                error: cause,
            };

            scope.close(errExit);
            cb(errExit);
        };

        const f1 = scope.fork(left, env);
        const f2 = scope.fork(right, env);

        f1.join((exit) => {
            leftExit = exit;
            checkDone();
        });

        f2.join((exit) => {
            rightExit = exit;
            checkDone();
        });
    });
}



/**
 * collectAllPar:
 *   - corre todos en paralelo
 *   - si uno falla → cancela todos
 *   - si todos terminan bien → devuelve array de resultados
 */
export function collectAllPar<R, E, A>(
    effects: ReadonlyArray<Async<R, E, A>>,
    parentScope: Scope<R>
): Async<R, E | Interrupted, A[]> {
    return async((env, cb) => {
        const scope = parentScope.subScope();
        const results: A[] = new Array(effects.length);

        let completed = 0;
        let done = false;

        effects.forEach((eff, i) => {
            const f = scope.fork(eff, env);

            f.join((exit) => {
                if (done) return;

                if (exit._tag === "Failure") {
                    done = true;

                    const errExit: Exit<E | Interrupted, A[]> = {
                        _tag: "Failure",
                        error: exit.error,
                    };

                    scope.close(errExit);
                    cb(errExit);
                    return;
                }

                results[i] = exit.value;
                completed++;

                if (completed === effects.length) {
                    done = true;
                    const successExit: Exit<E | Interrupted, A[]> = {
                        _tag: "Success",
                        value: results,
                    };
                    scope.close({ _tag: "Success", value: undefined });
                    cb(successExit);
                }
            });
        });
    });
}

export function raceWith<R, E, A, B, C>(
    left: Async<R, E, A>,
    right: Async<R, E, B>,
    parentScope: Scope<R>,
    onLeft: (
        exit: Exit<E | Interrupted, A>,
        rightFiber: AnyFiber<R, E | Interrupted, B>,
        scope: Scope<R>
    ) => Async<R, E | Interrupted, C>,
    onRight: (
        exit: Exit<E | Interrupted, B>,
        leftFiber: AnyFiber<R, E | Interrupted, A>,
        scope: Scope<R>
    ) => Async<R, E | Interrupted, C>
): Async<R, E | Interrupted, C> {
    return async((env, cb) => {
        const scope = parentScope.subScope();
        let done = false;

        const fiberLeft = scope.fork(left, env);
        const fiberRight = scope.fork(right, env);

        const finish = (
            next: Async<R, E | Interrupted, C>
        ) => {
            // Corremos el handler dentro del MISMO scope, así puede interrumpir/join del perdedor.
            scope.fork(next, env).join((exitNext) => {
                // Cerramos el scope al final (esto asegura limpieza si el handler no cerró explícitamente)
                scope.close(exitNext);
                cb(exitNext);
            });
        };

        fiberLeft.join((exitL) => {
            if (done) return;
            done = true;
            finish(onLeft(exitL, fiberRight as AnyFiber<R, E | Interrupted, B>, scope));
        });

        fiberRight.join((exitR) => {
            if (done) return;
            done = true;
            finish(onRight(exitR, fiberLeft as AnyFiber<R, E | Interrupted, A>, scope));
        });
    });
}