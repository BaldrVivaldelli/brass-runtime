// src/queue.ts
import { async, Async, asyncSync } from "../types/asyncEffect";
import { Exit } from "../types/effect";
import { Canceler } from "../types/cancel";
import { makeBoundedRingBuffer, RingBufferOptions } from "../runtime/boundedRingBuffer";
import { LinkedQueue } from "../runtime/linkedQueue";

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
    stats: () => QueueStats;
    shutdown: () => void;
};

export type QueueStats = {
    readonly strategy: Strategy;
    readonly capacity: number;
    readonly size: number;
    readonly closed: boolean;
    readonly offered: number;
    readonly accepted: number;
    readonly dropped: number;
    readonly slid: number;
    readonly discardedOnShutdown: number;
    readonly takeCalls: number;
    readonly taken: number;
    readonly waitingOffers: number;
    readonly waitingTakers: number;
    readonly maxSize: number;
    readonly maxWaitingOffers: number;
    readonly maxWaitingTakers: number;
    readonly offerWaitCount: number;
    readonly offerWaitMsTotal: number;
    readonly offerWaitMsMax: number;
    readonly takeWaitCount: number;
    readonly takeWaitMsTotal: number;
    readonly takeWaitMsMax: number;
    readonly cancelledOffers: number;
    readonly cancelledTakes: number;
};

export type QueueOptions = RingBufferOptions & {
    /** Monotonic clock override for deterministic diagnostics tests. */
    readonly now?: () => number;
};

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
    const now = options.now ?? (() => typeof performance !== "undefined" ? performance.now() : Date.now());
    let offered = 0;
    let accepted = 0;
    let dropped = 0;
    let slid = 0;
    let discardedOnShutdown = 0;
    let takeCalls = 0;
    let taken = 0;
    let maxSize = 0;
    let maxWaitingOffers = 0;
    let maxWaitingTakers = 0;
    let offerWaitCount = 0;
    let offerWaitMsTotal = 0;
    let offerWaitMsMax = 0;
    let takeWaitCount = 0;
    let takeWaitMsTotal = 0;
    let takeWaitMsMax = 0;
    let cancelledOffers = 0;
    let cancelledTakes = 0;

    const QueueClosedErr: QueueClosed = { _tag: "QueueClosed" };

    type OfferWaiter = { a: A; startedAt: number; cb: (ok: boolean) => void };
    type Taker = { startedAt: number; cb: (exit: Exit<QueueClosed, A>) => void };

    const offerWaiters = new LinkedQueue<OfferWaiter>();
    const takers = new LinkedQueue<Taker>();

    const recordOfferWait = (startedAt: number) => {
        const duration = Math.max(0, now() - startedAt);
        offerWaitCount += 1;
        offerWaitMsTotal += duration;
        offerWaitMsMax = Math.max(offerWaitMsMax, duration);
    };
    const recordTakeWait = (startedAt: number) => {
        const duration = Math.max(0, now() - startedAt);
        takeWaitCount += 1;
        takeWaitMsTotal += duration;
        takeWaitMsMax = Math.max(takeWaitMsMax, duration);
    };
    const pushItem = (value: A) => {
        items.push(value);
        maxSize = Math.max(maxSize, items.length);
    };

    const shutdown = () => {
        if (closed) return;
        closed = true;

        // fallar todos los takers suspendidos
        while (takers.length > 0) {
            const t = takers.shift()!;
            recordTakeWait(t.startedAt);
            t.cb({ _tag: "Failure", cause: { _tag: "Fail", error: QueueClosedErr } });
        }

        // liberar offers suspendidos
        while (offerWaiters.length > 0) {
            const w = offerWaiters.shift()!;
            recordOfferWait(w.startedAt);
            dropped += 1;
            w.cb(false);
        }

        discardedOnShutdown += items.length;
        items.clear();
    };

    return {
        size: () => items.length,

        stats: () => Object.freeze({
            strategy,
            capacity,
            size: items.length,
            closed,
            offered,
            accepted,
            dropped,
            slid,
            discardedOnShutdown,
            takeCalls,
            taken,
            waitingOffers: offerWaiters.length,
            waitingTakers: takers.length,
            maxSize,
            maxWaitingOffers,
            maxWaitingTakers,
            offerWaitCount,
            offerWaitMsTotal,
            offerWaitMsMax,
            takeWaitCount,
            takeWaitMsTotal,
            takeWaitMsMax,
            cancelledOffers,
            cancelledTakes,
        }),

        shutdown,

        offer: (a) =>
            async((_env, cb) => {
                offered += 1;
                if (closed) {
                    dropped += 1;
                    cb({ _tag: "Success", value: false });
                    return;
                }

                // si hay taker esperando, entrego directo
                if (takers.length > 0) {
                    const t = takers.shift()!;
                    recordTakeWait(t.startedAt);
                    taken += 1;
                    accepted += 1;
                    t.cb({ _tag: "Success", value: a });
                    cb({ _tag: "Success", value: true });
                    return;
                }

                // hay espacio
                if (items.length < capacity) {
                    pushItem(a);
                    accepted += 1;
                    cb({ _tag: "Success", value: true });
                    // No flush needed: takers.length === 0 (checked above),
                    // so flush would be a no-op.
                    return;
                }

                // lleno: estrategia
                if (strategy === "dropping") {
                    dropped += 1;
                    cb({ _tag: "Success", value: false });
                    return;
                }

                if (strategy === "sliding") {
                    // drop oldest, keep newest
                    items.shift(); // O(1) amortizado en RingBuffer
                    pushItem(a);
                    accepted += 1;
                    slid += 1;
                    cb({ _tag: "Success", value: true });
                    // No flush needed: takers.length === 0 (checked above),
                    // and buffer occupancy is unchanged (shift+push).
                    return;
                }

                // backpressure: suspender offer
                const node = offerWaiters.push({
                    a,
                    startedAt: now(),
                    cb: (ok) => cb({ _tag: "Success", value: ok }),
                });
                maxWaitingOffers = Math.max(maxWaitingOffers, offerWaiters.length);

                const canceler: Canceler = () => {
                    if (!node.removed) {
                        recordOfferWait(node.value.startedAt);
                        cancelledOffers += 1;
                    }
                    offerWaiters.remove(node);
                };
                return canceler;
            }),

        take: () =>
            async((_env, cb) => {
                takeCalls += 1;
                if (items.length > 0) {
                    const a = items.shift()!;
                    taken += 1;
                    cb({ _tag: "Success", value: a });
                    // After shifting one item, at most one backpressure-suspended
                    // offerer can fill the freed slot.  A full flush() is
                    // unnecessary because takers.length === 0 at this point
                    // (the current taker was already served via cb above),
                    // making flush steps 1 and 3 no-ops.
                    if (offerWaiters.length > 0 && items.length < capacity) {
                        const w = offerWaiters.shift()!;
                        recordOfferWait(w.startedAt);
                        accepted += 1;
                        pushItem(w.a);
                        w.cb(true);
                    }
                    return;
                }

                // si hay offers esperando, consumimos directo
                if (offerWaiters.length > 0) {
                    const w = offerWaiters.shift()!;
                    recordOfferWait(w.startedAt);
                    accepted += 1;
                    taken += 1;
                    w.cb(true);
                    cb({ _tag: "Success", value: w.a });
                    return;
                }

                if (closed) {
                    cb({ _tag: "Failure", cause: { _tag: "Fail", error: QueueClosedErr } });
                    return;
                }

                // suspender taker — use cb directly to avoid an extra closure allocation
                const node = takers.push({ cb, startedAt: now() });
                maxWaitingTakers = Math.max(maxWaitingTakers, takers.length);

                const canceler: Canceler = () => {
                    if (!node.removed) {
                        recordTakeWait(node.value.startedAt);
                        cancelledTakes += 1;
                    }
                    takers.remove(node);
                };
                return canceler;
            }),

        offerBatch: (values: readonly A[]) =>
            asyncSync(() => {
                const results: boolean[] = [];
                offered += values.length;
                for (let i = 0; i < values.length; i++) {
                    if (closed) {
                        dropped += 1;
                        results.push(false);
                        continue;
                    }

                    const a = values[i]!;

                    // Direct delivery to waiting taker
                    if (takers.length > 0) {
                        const t = takers.shift()!;
                        recordTakeWait(t.startedAt);
                        taken += 1;
                        accepted += 1;
                        t.cb({ _tag: "Success", value: a });
                        results.push(true);
                        continue;
                    }

                    // Buffer has space
                    if (items.length < capacity) {
                        pushItem(a);
                        accepted += 1;
                        results.push(true);
                        continue;
                    }

                    // Full: apply strategy
                    if (strategy === "dropping") {
                        dropped += 1;
                        results.push(false);
                    } else if (strategy === "sliding") {
                        items.shift();
                        pushItem(a);
                        accepted += 1;
                        slid += 1;
                        results.push(true);
                    } else {
                        // backpressure: can't batch-offer when full (would need to suspend)
                        // Just push what we can and stop
                        dropped += 1;
                        results.push(false);
                    }
                }
                return results;
            }) as Async<unknown, never, boolean[]>,

        takeBatch: (n: number) =>
            asyncSync(() => {
                const results: A[] = [];
                takeCalls += 1;
                const count = Math.min(n, items.length + offerWaiters.length);

                for (let i = 0; i < count; i++) {
                    if (items.length > 0) {
                        results.push(items.shift()!);
                        taken += 1;
                        // Admit a waiting offerer if there's one
                        if (offerWaiters.length > 0 && items.length < capacity) {
                            const w = offerWaiters.shift()!;
                            recordOfferWait(w.startedAt);
                            accepted += 1;
                            pushItem(w.a);
                            w.cb(true);
                        }
                    } else if (offerWaiters.length > 0) {
                        const w = offerWaiters.shift()!;
                        recordOfferWait(w.startedAt);
                        accepted += 1;
                        taken += 1;
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
