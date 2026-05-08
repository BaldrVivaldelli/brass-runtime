import { describe, it, expect } from "vitest";
import { broadcastToHub, fromHub, makeHub, Hub, HubClosed } from "../hub";
import { Runtime } from "../../runtime/runtime";
import { asyncFlatMap, asyncSucceed, asyncSync } from "../../types/asyncEffect";
import { collectStream, fromArray } from "../stream";
import { take } from "../operators";

/**
 * Verification tests for Hub after optimizations (Task 6.1.3).
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4
 *
 * Verifies that publish, publishAll, subscribe, and shutdown
 * still work correctly after the optimizations in tasks 6.1.1 and 6.1.2:
 * - 6.1.1: Fast-path in publish for 0 and 1 subscribers
 * - 6.1.2: Direct Set iteration instead of Array.from(queues)
 */

const rt = Runtime.make({});

function run<A>(effect: any): Promise<A> {
    return rt.toPromise(effect);
}

const wait = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// 1. publish — fast-path: 0 subscribers
// ---------------------------------------------------------------------------
describe("Hub publish with 0 subscribers", () => {
    it("returns true when no subscribers are registered", async () => {
        const hub = makeHub<number>(4);
        const result = await run<boolean>(hub.publish(42));
        expect(result).toBe(true);
    });

    it("publishAll returns true when no subscribers are registered", async () => {
        const hub = makeHub<number>(4);
        const result = await run<boolean>(hub.publishAll([1, 2, 3]));
        expect(result).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 2. publish — fast-path: 1 subscriber
// ---------------------------------------------------------------------------
describe("Hub publish with 1 subscriber", () => {
    it("delivers a single message to one subscriber", async () => {
        const hub = makeHub<number>(4);

        const result = await run<number>(
            asyncFlatMap(hub.subscribe(), (sub) =>
                asyncFlatMap(hub.publish(42), () =>
                    asyncFlatMap(sub.take(), (val) => {
                        sub.unsubscribe();
                        return asyncSucceed(val);
                    })
                )
            )
        );
        expect(result).toBe(42);
    });

    it("delivers multiple messages in FIFO order to one subscriber", async () => {
        const hub = makeHub<number>(4);

        const result = await run<number[]>(
            asyncFlatMap(hub.subscribe(), (sub) =>
                asyncFlatMap(hub.publish(1), () =>
                    asyncFlatMap(hub.publish(2), () =>
                        asyncFlatMap(hub.publish(3), () =>
                            asyncFlatMap(sub.take(), (a) =>
                                asyncFlatMap(sub.take(), (b) =>
                                    asyncFlatMap(sub.take(), (c) => {
                                        sub.unsubscribe();
                                        return asyncSucceed([a, b, c]);
                                    })
                                )
                            )
                        )
                    )
                )
            )
        );
        expect(result).toEqual([1, 2, 3]);
    });
});

// ---------------------------------------------------------------------------
// 3. publish — multiple subscribers
// ---------------------------------------------------------------------------
describe("Hub publish with multiple subscribers", () => {
    it("delivers message to all subscribers", async () => {
        const hub = makeHub<number>(4);

        const result = await run<number[]>(
            asyncFlatMap(hub.subscribe(), (sub1) =>
                asyncFlatMap(hub.subscribe(), (sub2) =>
                    asyncFlatMap(hub.publish(99), () =>
                        asyncFlatMap(sub1.take(), (a) =>
                            asyncFlatMap(sub2.take(), (b) => {
                                sub1.unsubscribe();
                                sub2.unsubscribe();
                                return asyncSucceed([a, b]);
                            })
                        )
                    )
                )
            )
        );
        expect(result).toEqual([99, 99]);
    });

    it("delivers multiple messages to all subscribers in order", async () => {
        const hub = makeHub<number>(4);

        const result = await run<number[][]>(
            asyncFlatMap(hub.subscribe(), (sub1) =>
                asyncFlatMap(hub.subscribe(), (sub2) =>
                    asyncFlatMap(hub.publish(10), () =>
                        asyncFlatMap(hub.publish(20), () =>
                            asyncFlatMap(sub1.take(), (a1) =>
                                asyncFlatMap(sub1.take(), (a2) =>
                                    asyncFlatMap(sub2.take(), (b1) =>
                                        asyncFlatMap(sub2.take(), (b2) => {
                                            sub1.unsubscribe();
                                            sub2.unsubscribe();
                                            return asyncSucceed([
                                                [a1, a2],
                                                [b1, b2],
                                            ]);
                                        })
                                    )
                                )
                            )
                        )
                    )
                )
            )
        );
        expect(result).toEqual([
            [10, 20],
            [10, 20],
        ]);
    });
});

// ---------------------------------------------------------------------------
// 4. publishAll
// ---------------------------------------------------------------------------
describe("Hub publishAll", () => {
    it("delivers all items to a single subscriber", async () => {
        const hub = makeHub<number>(8);

        const result = await run<number[]>(
            asyncFlatMap(hub.subscribe(), (sub) =>
                asyncFlatMap(hub.publishAll([10, 20, 30]), () =>
                    asyncFlatMap(sub.take(), (a) =>
                        asyncFlatMap(sub.take(), (b) =>
                            asyncFlatMap(sub.take(), (c) => {
                                sub.unsubscribe();
                                return asyncSucceed([a, b, c]);
                            })
                        )
                    )
                )
            )
        );
        expect(result).toEqual([10, 20, 30]);
    });

    it("delivers all items to multiple subscribers", async () => {
        const hub = makeHub<number>(8);

        const result = await run<number[][]>(
            asyncFlatMap(hub.subscribe(), (sub1) =>
                asyncFlatMap(hub.subscribe(), (sub2) =>
                    asyncFlatMap(hub.publishAll([1, 2]), () =>
                        asyncFlatMap(sub1.take(), (a1) =>
                            asyncFlatMap(sub1.take(), (a2) =>
                                asyncFlatMap(sub2.take(), (b1) =>
                                    asyncFlatMap(sub2.take(), (b2) => {
                                        sub1.unsubscribe();
                                        sub2.unsubscribe();
                                        return asyncSucceed([
                                            [a1, a2],
                                            [b1, b2],
                                        ]);
                                    })
                                )
                            )
                        )
                    )
                )
            )
        );
        expect(result).toEqual([
            [1, 2],
            [1, 2],
        ]);
    });
});

// ---------------------------------------------------------------------------
// 5. subscribe
// ---------------------------------------------------------------------------
describe("Hub subscribe", () => {
    it("new subscriber does not receive messages published before subscribing", async () => {
        const hub = makeHub<number>(4);

        // Publish before subscribing
        await run(hub.publish(1));

        // Subscribe after publish
        const sub = await run<any>(hub.subscribe());

        // Publish after subscribing
        await run(hub.publish(2));

        const val = await run<number>(sub.take());
        sub.unsubscribe();
        expect(val).toBe(2);
    });

    it("subscribe on a closed hub throws HubClosed", async () => {
        const hub = makeHub<number>(4);
        await run(hub.shutdown());

        await expect(run(hub.subscribe())).rejects.toMatchObject({
            _tag: "HubClosed",
        });
    });
});

// ---------------------------------------------------------------------------
// 6. unsubscribe
// ---------------------------------------------------------------------------
describe("Hub unsubscribe", () => {
    it("unsubscribed subscriber does not receive further messages", async () => {
        const hub = makeHub<number>(4);

        const sub1 = await run<any>(hub.subscribe());
        const sub2 = await run<any>(hub.subscribe());

        // Publish to both
        await run(hub.publish(1));

        // Unsubscribe sub1
        sub1.unsubscribe();

        // Publish again — only sub2 should receive
        await run(hub.publish(2));

        const val1 = await run<number>(sub2.take());
        const val2 = await run<number>(sub2.take());
        sub2.unsubscribe();

        expect([val1, val2]).toEqual([1, 2]);
    });

    it("double unsubscribe is a no-op", async () => {
        const hub = makeHub<number>(4);
        const sub = await run<any>(hub.subscribe());

        sub.unsubscribe();
        // Should not throw
        sub.unsubscribe();
    });
});

// ---------------------------------------------------------------------------
// 7. shutdown
// ---------------------------------------------------------------------------
describe("Hub shutdown", () => {
    it("publish returns false after shutdown", async () => {
        const hub = makeHub<number>(4);
        await run(hub.shutdown());

        const result = await run<boolean>(hub.publish(42));
        expect(result).toBe(false);
    });

    it("publishAll returns false after shutdown", async () => {
        const hub = makeHub<number>(4);
        await run(hub.shutdown());

        const result = await run<boolean>(hub.publishAll([1, 2, 3]));
        // publishAll chains publish calls; if hub is closed, each publish returns false
        expect(result).toBe(false);
    });

    it("shutdown is idempotent", async () => {
        const hub = makeHub<number>(4);
        await run(hub.shutdown());
        // Second shutdown should not throw
        await run(hub.shutdown());
    });

    it("shutdown closes all subscriber queues", async () => {
        const hub = makeHub<number>(4);
        const sub = await run<any>(hub.subscribe());

        await run(hub.shutdown());

        // take on a closed queue should fail with QueueClosed
        await expect(run(sub.take())).rejects.toMatchObject({
            _tag: "QueueClosed",
        });
    });
});

// ---------------------------------------------------------------------------
// 8. Hub strategies
// ---------------------------------------------------------------------------
describe("Hub with Dropping strategy", () => {
    it("drops messages when subscriber buffer is full", async () => {
        const hub = makeHub<number>(2, "Dropping");
        const sub = await run<any>(hub.subscribe());

        // Fill the subscriber's buffer (capacity 2)
        await run(hub.publish(1));
        await run(hub.publish(2));

        // This should be dropped by the subscriber's queue
        const result = await run<boolean>(hub.publish(3));
        expect(result).toBe(false);

        const a = await run<number>(sub.take());
        const b = await run<number>(sub.take());
        sub.unsubscribe();
        expect([a, b]).toEqual([1, 2]);
    });
});

describe("Hub with Sliding strategy", () => {
    it("slides oldest message when subscriber buffer is full", async () => {
        const hub = makeHub<number>(2, "Sliding");
        const sub = await run<any>(hub.subscribe());

        // Fill the subscriber's buffer (capacity 2)
        await run(hub.publish(1));
        await run(hub.publish(2));

        // This should slide: drop 1, keep [2, 3]
        await run(hub.publish(3));

        const a = await run<number>(sub.take());
        const b = await run<number>(sub.take());
        sub.unsubscribe();
        expect([a, b]).toEqual([2, 3]);
    });
});

describe("Hub stream integration", () => {
    it("broadcasts a finite stream into the hub", async () => {
        const hub = makeHub<number>(4);
        const sub = await run<any>(hub.subscribe());

        await run(broadcastToHub(fromArray([1, 2, 3]), hub));

        await expect(run(sub.take())).resolves.toBe(1);
        await expect(run(sub.take())).resolves.toBe(2);
        await expect(run(sub.take())).resolves.toBe(3);
        sub.unsubscribe();
    });

    it("reads from a hub as a stream and releases the subscription", async () => {
        const hub = makeHub<number>(4);
        const stream = take(fromHub(hub), 2);
        const fiber = rt.fork(collectStream(stream));

        await wait();
        await run(hub.publishAll([10, 20, 30]));

        const result = await new Promise<number[]>((resolve, reject) => {
            fiber.join((exit) => {
                if (exit._tag === "Success") resolve(exit.value);
                else reject(exit.cause);
            });
        });

        expect(result).toEqual([10, 20]);
        expect(await run(hub.publish(40))).toBe(true);
    });

    it("ends the stream when the hub shuts down", async () => {
        const hub = makeHub<number>(4);
        const fiber = rt.fork(collectStream(fromHub(hub)));

        await wait();
        await run(hub.publish(1));
        await run(hub.shutdown());

        const result = await new Promise<number[]>((resolve, reject) => {
            fiber.join((exit) => {
                if (exit._tag === "Success") resolve(exit.value);
                else reject(exit.cause);
            });
        });

        expect(result).toEqual([1]);
    });
});
