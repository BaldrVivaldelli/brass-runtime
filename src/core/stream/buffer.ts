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

// Singleton for the End signal — always the same object, no allocation per stream end.
const SIGNAL_END: Signal<any, any> = { _tag: "End" };

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
     * Hoisted callbacks for nextSignal's asyncFold — created once per buffer()
     * invocation instead of once per nextSignal() call.  This eliminates two
     * closure allocations on every pull from the upstream.
     */
    const onUpstreamFailure = (opt: Option<E>): Async<{} & R, never, Signal<E, A>> =>
        asyncSucceed(
            opt._tag === "None"
                ? SIGNAL_END as Signal<E, A>
                : { _tag: "Fail", error: opt.value } as Signal<E, A>
        );

    const onUpstreamSuccess = ([a, tail]: [A, ZStream<{} & R, E, A>]): Async<{} & R, never, Signal<E, A>> =>
        asyncSync(() => {
            upstream = tail;
            return { _tag: "Elem", value: a } as Signal<E, A>;
        }) as any;

    /**
     * Convierte `uncons(upstream)` (que falla con Option<E>) en una Signal que NO falla:
     * - Success => Elem(a) y actualiza upstream
     * - Failure(None) => End
     * - Failure(Some(e)) => Fail(e)
     *
     * The onFailure/onSuccess callbacks are hoisted above so each call to
     * nextSignal() only allocates the Fold node itself — no new closures.
     */
    const nextSignal = (): Async<{} & R, never, Signal<E, A>> =>
        asyncFold(
            uncons(upstream),
            onUpstreamFailure,
            onUpstreamSuccess
        ) as any;

    /**
     * Initializes the queue once and forks the producer loop.
     * The queue `q` is created via `bounded` (which is asyncSync, so it
     * resolves in the same tick) and then reused for all subsequent pulls.
     * The producer loop reads from upstream and offers signals into `q`
     * until the stream ends or fails.
     *
     * The loop uses a single hoisted `afterOffer` callback to avoid creating
     * a new closure on every iteration of the producer.
     */
    const start = (env: {} & R): Async<{} & R, any, void> =>
        asyncFlatMap(bounded<Signal<E, A>>(capacity, strategy), (_q) => {
            q = _q;

            // Hoisted callback for the inner FlatMap after q.offer completes.
            // `lastSig` is set by `onSignal` before each offer so the callback
            // can decide whether to stop or continue without capturing `sig`
            // in a per-iteration closure.
            let lastSig: Signal<E, A>;

            const afterOffer = (): Async<{} & R, any, void> => {
                if (lastSig._tag !== "Elem") {
                    return asyncSucceed(undefined);
                }
                return loop();
            };

            const onSignal = (sig: Signal<E, A>): Async<{} & R, any, void> => {
                lastSig = sig;
                return asyncFlatMap(q.offer(sig as any), afterOffer);
            };

            const loop = (): Async<{} & R, any, void> =>
                asyncFlatMap(nextSignal(), onSignal);

            producer = fork(loop() as any, env);

            return asyncSucceed(undefined);
        });

    const pullDown: Async<{} & R, any, [A, ZStream<{} & R, E, A>]> = {
        _tag: "Async",
        register: (env: {} & R, cb: { (exit: any): void; (exit: any): void; }) => {
            const go = () => {
                if (!started) {
                    // Set the flag synchronously *before* forking to prevent
                    // concurrent pulls from starting a second producer.
                    // The queue and producer are created exactly once.
                    started = true;
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
