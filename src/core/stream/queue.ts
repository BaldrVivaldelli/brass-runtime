// src/queue.ts
import { async, Async, asyncSync } from "../types/asyncEffect";
import { Exit } from "../types/effect";
import { Canceler } from "../types/cancel";
import {RingBuffer} from "../runtime/ringBuffer";
import {LinkedQueue} from "../runtime/linkedQueue";

export type Strategy = "backpressure" | "dropping" | "sliding";

export type QueueClosed = { _tag: "QueueClosed" };

export type Queue<A> = {
    offer: (a: A) => Async<unknown, never, boolean>;
    take: () => Async<unknown, QueueClosed, A>;
    size: () => number;
    shutdown: () => void;
};

export function bounded<A>(
    capacity: number,
    strategy: Strategy = "backpressure"
): Async<unknown, unknown, Queue<A>> {
    return asyncSync(() => makeQueue<A>(capacity, strategy));
}

function makeQueue<A>(capacity: number, strategy: Strategy): Queue<A> {
    const items = new RingBuffer<A>(capacity);
    let closed = false;

    const QueueClosedErr: QueueClosed = { _tag: "QueueClosed" };

    type OfferWaiter = { a: A; cb: (ok: boolean) => void };
    type Taker = (exit: Exit<QueueClosed, A>) => void;

    const offerWaiters = new LinkedQueue<OfferWaiter>();
    const takers = new LinkedQueue<Taker>();

    const flush = () => {
        // 1) entregar items a takers
        while (takers.length > 0 && items.length > 0) {
            const t = takers.shift()!;
            const a = items.shift()!;
            t({ _tag: "Success", value: a });
        }

        // 2) si hay espacio, meter offers esperando (solo si no hay takers esperando)
        while (offerWaiters.length > 0 && items.length < capacity && takers.length === 0) {
            const w = offerWaiters.shift()!;
            items.push(w.a);
            w.cb(true);
        }

        // 3) emparejar takers con offerWaiters directo (sin tocar items)
        while (takers.length > 0 && offerWaiters.length > 0) {
            const t = takers.shift()!;
            const w = offerWaiters.shift()!;
            w.cb(true);
            t({ _tag: "Success", value: w.a });
        }
    };

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
                    flush();
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
                    flush();
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
                    flush();
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

                // suspender taker
                const taker: Taker = (exit) => cb(exit);
                const node = takers.push(taker);

                const canceler: Canceler = () => {
                    takers.remove(node);
                };
                return canceler;
            }),
    };
}