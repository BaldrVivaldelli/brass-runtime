import {fromPull, ZStream} from "./stream";
import { uncons,  } from "./stream";

import {Async, asyncFold} from "../types/asyncEffect";
import { asyncFlatMap, asyncSucceed, asyncSync } from "../types/asyncEffect";

import {none, Option, some} from "../types/option";
import { bounded } from "./queue";
import { fork } from "../runtime/runtime";
import { unsafeGetCurrentRuntime } from "../runtime/fiber";

type Signal<E, A> =
    | { _tag: "Elem"; value: A }
    | { _tag: "End" }
    | { _tag: "Fail"; error: E };

export function buffer<R, E, A>(
    stream: ZStream<{} & R, E, A>,
    capacity: number,
    strategy: "backpressure" | "dropping" | "sliding" = "backpressure"
): ZStream<{} & R, E, A> {
    let started = false;
    let q: any = null;
    let producer: any = null;

    // vamos actualizando el upstream a medida que consumimos
    let upstream: ZStream<{} & R, E, A> = stream;

    /**
     * Convierte `uncons(upstream)` (que falla con Option<E>) en una Signal que NO falla:
     * - Success => Elem(a) y actualiza upstream
     * - Failure(None) => End
     * - Failure(Some(e)) => Fail(e)
     */
    const nextSignal = (): Async<R, never, Signal<E, A>> =>
        asyncFold(
            uncons(upstream),
            (opt: Option<E>) =>
                asyncSucceed(
                    opt._tag === "None"
                        ? ({ _tag: "End" } as Signal<E, A>)
                        : ({ _tag: "Fail", error: opt.value } as Signal<E, A>)
                ),
            ([a, tail]) =>
                asyncSync(() => {
                    upstream = tail;
                    return { _tag: "Elem", value: a } as Signal<E, A>;
                }) as any
        ) as any;

    const start = (env: {} & R): Async<{} & R, any, void> =>
        asyncFlatMap(bounded<Signal<E, A>>(capacity, strategy), (_q) => {
            q = _q;

            const loop = (): Async<{} & R, any, void> =>
                asyncFlatMap(nextSignal(), (sig) =>
                    asyncFlatMap(q.offer(sig as any), () => {
                        // si llega End/Fail, cortamos el productor
                        if (sig._tag === "End" || sig._tag === "Fail") {
                            return asyncSucceed(undefined);
                        }
                        return loop();
                    })
                );

            producer = fork(loop() as any, env);
            started = true;

            return asyncSucceed(undefined);
        });

    const pullDown: Async<{} & R, any, [A, ZStream<{} & R, E, A>]> = {
        _tag: "Async",
        register: (env: {} & R, cb: { (exit: any): void; (exit: any): void; }) => {
            const go = () => {
                if (!started) {
                    unsafeGetCurrentRuntime<{} & R>().fork(start(env) as any).join(() => {
                        pullFromQueue(env, cb);
                    });
                    return;
                }
                pullFromQueue(env, cb);
            };
            go();
        },
    } as any;

    function pullFromQueue(env: {} & R, cb: (exit: any) => void) {
        const takeEff: Async<{} & R, never, Signal<E, A>> = q.take();

        unsafeGetCurrentRuntime<{} & R>().fork(takeEff as any).join((ex: any) => {
            if (ex._tag !== "Success") return; // take no debería fallar

            const sig = ex.value as Signal<E, A>;

            switch (sig._tag) {
                case "Elem":
                    cb({ _tag: "Success", value: [sig.value, fromPull(pullDown as any)] });
                    return;

                case "End":
                    producer?.interrupt?.();
                    cb({ _tag: "Failure", cause: { _tag: "Fail", error: none } });
                    return;

                case "Fail":
                    producer?.interrupt?.();
                    cb({ _tag: "Failure", cause: { _tag: "Fail", error: some(sig.error) } });
                    return;
            }
        });
    }

    return fromPull(pullDown as any);
}
