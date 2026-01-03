// src/hub.ts
import {
    Async,
    asyncSucceed,
    asyncFlatMap,
    asyncTotal,
    asyncSync, acquireRelease, asyncMapError
} from "../types/asyncEffect";
import {bounded, Queue, QueueClosed, Strategy} from "./queue";
import {foreachStream, fromPull, managedStream, unwrapScoped, ZStream} from "./stream";
import {Scope} from "../runtime/scope";
import {Exit} from "../types/effect";
import {none, Option} from "../types/option";

export type HubStrategy = "BackPressure" | "Dropping" | "Sliding";

export type HubClosed = { _tag: "HubClosed" };

export type Subscription<A> = Queue<A> & {
    unsubscribe: () => void;
};

export type Hub<A> = {
    publish: (a: A) => Async<unknown, never, boolean>;
    publishAll: (as: Iterable<A>) => Async<unknown, never, boolean>;
    subscribe: () => Async<unknown, HubClosed, Subscription<A>>;
    shutdown: () => Async<unknown, any, any>;
};

const toQueueStrategy = (s: HubStrategy): Strategy =>
    s === "BackPressure"
        ? "backpressure"
        : s === "Dropping"
            ? "dropping"
            : "sliding";

export function makeHub<A>(
    capacity: number,
    strategy: HubStrategy = "BackPressure"
): Hub<A> {
    const queues = new Set<Queue<A>>();
    let closed = false;

    const publish = (a: A): Async<unknown, never, boolean> => {
        if (closed) return asyncSucceed(false);

        const snapshot = Array.from(queues);

        let eff: Async<unknown, never, boolean> = asyncSucceed(true);
        snapshot.forEach((q) => {
            eff = asyncFlatMap(eff, (okSoFar) =>
                asyncFlatMap(q.offer(a), (ok) => asyncSucceed(okSoFar && ok))
            );
        });

        return eff;
    };


    const publishAll = (as: Iterable<A>): Async<unknown, never, boolean> => {
        let eff: Async<unknown, never, boolean> = asyncSucceed(true);

        const it = as[Symbol.iterator]();
        while (true) {
            const n = it.next();
            if (n.done) break;

            const a = n.value;
            eff = asyncFlatMap(eff, (okSoFar) =>
                asyncFlatMap(publish(a), (ok) => asyncSucceed(okSoFar && ok))
            );
        }

        return eff;
    };


    const subscribe = (): Async<unknown, any, any> => {
        if (closed) {
            return asyncTotal(() => {
                throw { _tag: "HubClosed" } satisfies HubClosed;
            });
        }

        return asyncFlatMap(
            bounded<A>(capacity, toQueueStrategy(strategy)),
            (q) =>
                asyncSync(() => {
                    queues.add(q);

                    return {
                        ...q,
                        unsubscribe: () => {
                            if (!queues.has(q)) return;
                            queues.delete(q);
                            q.shutdown();
                        },
                    } satisfies Subscription<A>;
                })
        );
    };


    const shutdown = (): Async<unknown, any, void> =>
        asyncSync(() => {
            if (closed) return;
            closed = true;

            Array.from(queues).forEach((q) => q.shutdown());

            queues.clear();
        });

    return {
        publish,
        publishAll,
        subscribe,
        shutdown,
    };
}

/* =======================
     * ======================= */

// Alias semántico: broadcast = hub
export const broadcast = makeHub;

/* =======================
 * Stream integration
 * ======================= */

export function broadcastToHub<R, E, A>(
    stream: ZStream<R, E, A>,
    hub: Hub<A>
): Async<R, E, void> {
    return foreachStream(stream, (a) =>
        asyncFlatMap(hub.publish(a), () => asyncSucceed(undefined))
    );
}

export function fromHub<A>(hub: Hub<A>): ZStream<unknown, HubClosed, A> {
    return managedStream(
        asyncFlatMap(hub.subscribe(), (sub) => {
            // stream definido UNA vez, reusando la misma sub
            const loop: ZStream<unknown, HubClosed, A> = fromPull(
                asyncFlatMap(
                    asyncMapError(sub.take(), (_queueClosed) => none as Option<HubClosed>),
                    (a) => asyncSucceed([a, loop] as const)
                )
            );
            return asyncSucceed({
                stream: loop,
                release: (_exit) => asyncSync(() => sub.unsubscribe()),
            });
        })
    );
}

