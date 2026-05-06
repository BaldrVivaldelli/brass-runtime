// src/queue.ts
import { async, Async, asyncSync } from "../types/asyncEffect";
import { Exit } from "../types/effect";
import { Canceler } from "../types/cancel";
import { makeBoundedRingBuffer, RingBufferOptions } from "../runtime/boundedRingBuffer";
import {LinkedQueue} from "../runtime/linkedQueue";

export type Strategy = "backpressure" | "dropping" | "sliding";

export type QueueClosed = { _tag: "QueueClosed" };

export type Queue<A> = {
    offer: (a: A) => Async<unknown, never, boolean>;
    take: () => Async<unknown, QueueClosed, A>;
    /** Offer multiple values in a single effect. Returns array of success flags. */
    offerBatch: (values: readonly A[]) => Async<unknown, never, boolean[]>;
    /** Take up to N values in a single effect. Returns available values (may be fewer than N). */
    takeBatch: (n: number) => Async<unknown, QueueClosed, A[]>;
    size: () => number;
    shutdown: () => void;
};

export type QueueOptions = RingBufferOptions;

export function bounded<A>(
    capacity: number,
    strategy: Strategy = "backpressure",
    options: QueueOptions = {}
): Async<unknown, unknown, Queue<A>> {
    return asyncSync(() => makeQueue<A>(capacity, strategy, options));
}

function makeQueue<A>(capacity: number, strategy: Strategy, options: QueueOptions): Queue<A> {
    const items = makeBoundedRingBuffer<A>(capacity, capacity, options);
    let closed = false;

    const QueueClosedErr: QueueClosed = { _tag: "QueueClosed" };

    type OfferWaiter = { a: A; cb: (ok: boolean) => void };
    type Taker = (exit: Exit<QueueClosed, A>) => void;

    const offerWaiters = new LinkedQueue<OfferWaiter>();
    const takers = new LinkedQueue<Taker>();

    const shutdown = () => {
        if (closed) return;
        closed = true;

        // fallar todos los takers suspendidos
        while (takers.length > 0) {
            const t = takers.shift()!;
            t({ _tag: "Failure", cause: { _tag: "Fail", error: QueueClosedErr } });
        }

        // liberar offers suspendidos
        while (offerWaiters.length > 0) {
            const w = offerWaiters.shift()!;
            w.cb(false);
        }

        items.clear();
    };

    return {
        size: () => items.length,

        shutdown,

        offer: (a) =>
            async((_env, cb) => {
                if (closed) {
                    cb({ _tag: "Success", value: false });
                    return;
                }

                // si hay taker esperando, entrego directo
                if (takers.length > 0) {
                    const t = takers.shift()!;
                    t({ _tag: "Success", value: a });
                    cb({ _tag: "Success", value: true });
                    return;
                }

                // hay espacio
                if (items.length < capacity) {
                    items.push(a);
                    cb({ _tag: "Success", value: true });
                    // No flush needed: takers.length === 0 (checked above),
                    // so flush would be a no-op.
                    return;
                }

                // lleno: estrategia
                if (strategy === "dropping") {
                    cb({ _tag: "Success", value: false });
                    return;
                }

                if (strategy === "sliding") {
                    // drop oldest, keep newest
                    items.shift(); // O(1) amortizado en RingBuffer
                    items.push(a);
                    cb({ _tag: "Success", value: true });
                    // No flush needed: takers.length === 0 (checked above),
                    // and buffer occupancy is unchanged (shift+push).
                    return;
                }

                // backpressure: suspender offer
                const node = offerWaiters.push({
                    a,
                    cb: (ok) => cb({ _tag: "Success", value: ok }),
                });

                const canceler: Canceler = () => {
                    offerWaiters.remove(node);
                };
                return canceler;
            }),

        take: () =>
            async((_env, cb) => {
                if (items.length > 0) {
                    const a = items.shift()!;
                    cb({ _tag: "Success", value: a });
                    // After shifting one item, at most one backpressure-suspended
                    // offerer can fill the freed slot.  A full flush() is
                    // unnecessary because takers.length === 0 at this point
                    // (the current taker was already served via cb above),
                    // making flush steps 1 and 3 no-ops.
                    if (offerWaiters.length > 0 && items.length < capacity) {
                        const w = offerWaiters.shift()!;
                        items.push(w.a);
                        w.cb(true);
                    }
                    return;
                }

                // si hay offers esperando, consumimos directo
                if (offerWaiters.length > 0) {
                    const w = offerWaiters.shift()!;
                    w.cb(true);
                    cb({ _tag: "Success", value: w.a });
                    return;
                }

                if (closed) {
                    cb({ _tag: "Failure", cause: { _tag: "Fail", error: QueueClosedErr } });
                    return;
                }

                // suspender taker — use cb directly to avoid an extra closure allocation
                const node = takers.push(cb);

                const canceler: Canceler = () => {
                    takers.remove(node);
                };
                return canceler;
            }),

        offerBatch: (values: readonly A[]) =>
            asyncSync(() => {
                const results: boolean[] = [];
                for (let i = 0; i < values.length; i++) {
                    if (closed) {
                        results.push(false);
                        continue;
                    }

                    const a = values[i]!;

                    // Direct delivery to waiting taker
                    if (takers.length > 0) {
                        const t = takers.shift()!;
                        t({ _tag: "Success", value: a });
                        results.push(true);
                        continue;
                    }

                    // Buffer has space
                    if (items.length < capacity) {
                        items.push(a);
                        results.push(true);
                        continue;
                    }

                    // Full: apply strategy
                    if (strategy === "dropping") {
                        results.push(false);
                    } else if (strategy === "sliding") {
                        items.shift();
                        items.push(a);
                        results.push(true);
                    } else {
                        // backpressure: can't batch-offer when full (would need to suspend)
                        // Just push what we can and stop
                        results.push(false);
                    }
                }
                return results;
            }) as Async<unknown, never, boolean[]>,

        takeBatch: (n: number) =>
            asyncSync(() => {
                const results: A[] = [];
                const count = Math.min(n, items.length + offerWaiters.length);

                for (let i = 0; i < count; i++) {
                    if (items.length > 0) {
                        results.push(items.shift()!);
                        // Admit a waiting offerer if there's one
                        if (offerWaiters.length > 0 && items.length < capacity) {
                            const w = offerWaiters.shift()!;
                            items.push(w.a);
                            w.cb(true);
                        }
                    } else if (offerWaiters.length > 0) {
                        const w = offerWaiters.shift()!;
                        w.cb(true);
                        results.push(w.a);
                    } else {
                        break;
                    }
                }

                if (results.length === 0 && closed) {
                    throw QueueClosedErr;
                }
                return results;
            }) as Async<unknown, QueueClosed, A[]>,
    };
}