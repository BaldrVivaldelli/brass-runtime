import { describe, expect, it } from "vitest";
import type { Exit } from "../../types/effect";
import { Runtime } from "../../runtime/runtime";
import { bounded, type Queue, type QueueClosed } from "../queue";

const runtime = Runtime.make({});

function run<A>(effect: unknown): Promise<A> {
  return runtime.toPromise(effect as never);
}

function register<E, A>(
  effect: { readonly _tag: string; readonly register?: (env: unknown, cb: (exit: Exit<E, A>) => void) => void | (() => void) },
  cb: (exit: Exit<E, A>) => void = () => undefined,
): () => void {
  expect(effect._tag).toBe("Async");
  return effect.register?.({}, cb) ?? (() => undefined);
}

describe("Queue diagnostics", () => {
  it("reports deterministic occupancy and backpressure wait time", async () => {
    let clock = 0;
    const queue = await run<Queue<number>>(bounded(1, "backpressure", { now: () => clock }));

    await run(queue.offer(1));
    clock = 10;
    let resumed = false;
    register(queue.offer(2), (exit) => {
      resumed = exit._tag === "Success" && exit.value;
    });

    expect(queue.stats()).toMatchObject({
      size: 1,
      offered: 2,
      accepted: 1,
      waitingOffers: 1,
      maxSize: 1,
      maxWaitingOffers: 1,
      offerWaitCount: 0,
    });

    clock = 17;
    await expect(run(queue.take())).resolves.toBe(1);
    expect(resumed).toBe(true);
    await expect(run(queue.take())).resolves.toBe(2);

    expect(queue.stats()).toMatchObject({
      size: 0,
      offered: 2,
      accepted: 2,
      dropped: 0,
      takeCalls: 2,
      taken: 2,
      waitingOffers: 0,
      offerWaitCount: 1,
      offerWaitMsTotal: 7,
      offerWaitMsMax: 7,
    });
  });

  it("distinguishes dropping, sliding, and shutdown discards", async () => {
    const dropping = await run<Queue<number>>(bounded(1, "dropping"));
    await expect(run(dropping.offerBatch([1, 2]))).resolves.toEqual([true, false]);
    expect(dropping.stats()).toMatchObject({ accepted: 1, dropped: 1, slid: 0 });

    const sliding = await run<Queue<number>>(bounded(1, "sliding"));
    await expect(run(sliding.offerBatch([1, 2]))).resolves.toEqual([true, true]);
    expect(sliding.stats()).toMatchObject({ accepted: 2, dropped: 0, slid: 1 });
    sliding.shutdown();
    expect(sliding.stats()).toMatchObject({
      closed: true,
      size: 0,
      discardedOnShutdown: 1,
    });
  });

  it("accounts for cancellation and simultaneous shutdown without orphan waiters", async () => {
    let clock = 100;
    const waitingTake = await run<Queue<number>>(bounded(1, "backpressure", { now: () => clock }));
    let cancelledTakeCalled = false;
    const cancelTake = register(waitingTake.take(), () => {
      cancelledTakeCalled = true;
    });
    clock = 104;
    cancelTake();
    waitingTake.shutdown();

    expect(cancelledTakeCalled).toBe(false);
    expect(waitingTake.stats()).toMatchObject({
      closed: true,
      waitingTakers: 0,
      maxWaitingTakers: 1,
      cancelledTakes: 1,
      takeWaitCount: 1,
      takeWaitMsTotal: 4,
    });

    const waitingOffer = await run<Queue<number>>(bounded(1, "backpressure", { now: () => clock }));
    await run(waitingOffer.offer(1));
    let shutdownExit: Exit<never, boolean> | undefined;
    register(waitingOffer.offer(2), (exit) => {
      shutdownExit = exit;
    });
    clock = 110;
    waitingOffer.shutdown();
    waitingOffer.shutdown();

    expect(shutdownExit).toEqual({ _tag: "Success", value: false });
    expect(waitingOffer.stats()).toMatchObject({
      closed: true,
      waitingOffers: 0,
      dropped: 1,
      discardedOnShutdown: 1,
      offerWaitCount: 1,
      offerWaitMsTotal: 6,
      cancelledOffers: 0,
    });

    let closedTake: Exit<QueueClosed, number> | undefined;
    register(waitingOffer.take(), (exit) => {
      closedTake = exit;
    });
    expect(closedTake?._tag).toBe("Failure");
  });
});
