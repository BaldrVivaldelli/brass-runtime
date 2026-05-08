import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "../../runtime/runtime";
import { collectStream, fromArray } from "../stream";
import { debounce, drop, take, throttle } from "../operators";
import { bounded } from "../queue";

const rt = Runtime.make({});
const run = <A>(effect: any) => rt.toPromise(effect) as Promise<A>;
const wait = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stream operators edge coverage", () => {
  it("throttles by dropping elements inside the interval", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(15)
      .mockReturnValueOnce(25);

    await expect(run(collectStream(throttle(fromArray([1, 2, 3]), 10)))).resolves.toEqual([1, 3]);
  });

  it("handles negative take/drop counts as empty/original streams", async () => {
    await expect(run(collectStream(take(fromArray([1, 2]), -1)))).resolves.toEqual([]);
    await expect(run(collectStream(drop(fromArray([1, 2]), -1)))).resolves.toEqual([1, 2]);
  });

  it("debounces synchronous streams to the last value and handles empty streams", async () => {
    await expect(run(collectStream(debounce(fromArray([1, 2, 3]), 1)))).resolves.toEqual([3]);
    await expect(run(collectStream(debounce(fromArray<number>([]), 1)))).resolves.toEqual([]);
  });
});

describe("Queue coverage", () => {
  it("delivers directly to suspended takers and shuts them down", async () => {
    const queue = await run<any>(bounded<number>(2));
    const taker = rt.fork(queue.take());
    await wait();

    await expect(run(queue.offer(1))).resolves.toBe(true);
    await new Promise<void>((resolve) => taker.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Success", value: 1 });
      resolve();
    }));

    const pending = rt.fork(queue.take());
    await wait();
    queue.shutdown();
    await new Promise<void>((resolve) => pending.join((exit) => {
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: { _tag: "Fail", error: { _tag: "QueueClosed" } },
      });
      resolve();
    }));
    await expect(run(queue.offer(2))).resolves.toBe(false);
    expect(queue.size()).toBe(0);
  });

  it("handles backpressure offers, cancellation, and shutdown of offer waiters", async () => {
    const queue = await run<any>(bounded<number>(1, "backpressure"));
    await expect(run(queue.offer(1))).resolves.toBe(true);
    const offered = rt.fork(queue.offer(2));
    await wait();

    await expect(run(queue.take())).resolves.toBe(1);
    await new Promise<void>((resolve) => offered.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Success", value: true });
      resolve();
    }));
    expect(queue.size()).toBe(1);
    await expect(run(queue.take())).resolves.toBe(2);

    await run(queue.offer(3));
    const canceled = rt.fork(queue.offer(4));
    await wait();
    canceled.interrupt();
    await wait();
    await expect(run(queue.take())).resolves.toBe(3);
    expect(queue.size()).toBe(0);

    await run(queue.offer(5));
    const waitingOffer = rt.fork(queue.offer(6));
    await wait();
    queue.shutdown();
    await new Promise<void>((resolve) => waitingOffer.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Success", value: false });
      resolve();
    }));
  });

  it("applies dropping/sliding strategies and batch operations", async () => {
    const dropping = await run<any>(bounded<number>(2, "dropping"));
    await expect(run(dropping.offerBatch([1, 2, 3]))).resolves.toEqual([true, true, false]);
    await expect(run(dropping.takeBatch(5))).resolves.toEqual([1, 2]);
    dropping.shutdown();
    await expect(run(dropping.offerBatch([4, 5]))).resolves.toEqual([false, false]);
    await expect(run(dropping.takeBatch(1))).rejects.toThrow();

    const sliding = await run<any>(bounded<number>(2, "sliding"));
    await expect(run(sliding.offer(1))).resolves.toBe(true);
    await expect(run(sliding.offer(2))).resolves.toBe(true);
    await expect(run(sliding.offer(3))).resolves.toBe(true);
    await expect(run(sliding.takeBatch(2))).resolves.toEqual([2, 3]);

    const backpressure = await run<any>(bounded<number>(1, "backpressure"));
    await expect(run(backpressure.offerBatch([1, 2]))).resolves.toEqual([true, false]);
  });

  it("covers batch direct delivery, waiting offer admission, and canceled takers", async () => {
    const direct = await run<any>(bounded<number>(2));
    const taker = rt.fork(direct.take());
    await wait();
    await expect(run(direct.offerBatch([10]))).resolves.toEqual([true]);
    await new Promise<void>((resolve) => taker.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Success", value: 10 });
      resolve();
    }));

    const backpressure = await run<any>(bounded<number>(1, "backpressure"));
    await run(backpressure.offer(1));
    const waitingOffer = rt.fork(backpressure.offer(2));
    await wait();
    await expect(run(backpressure.takeBatch(1))).resolves.toEqual([1]);
    await new Promise<void>((resolve) => waitingOffer.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Success", value: true });
      resolve();
    }));
    await expect(run(backpressure.take())).resolves.toBe(2);

    const canceledTakeQueue = await run<any>(bounded<number>(1));
    const canceledTake = rt.fork(canceledTakeQueue.take());
    await wait();
    canceledTake.interrupt();
    await wait();
    await expect(run(canceledTakeQueue.offer(3))).resolves.toBe(true);
    await expect(run(canceledTakeQueue.take())).resolves.toBe(3);
  });

  it("covers sliding batch replacement and zero-capacity direct handoff", async () => {
    const sliding = await run<any>(bounded<number>(2, "sliding"));
    await expect(run(sliding.offerBatch([1, 2, 3]))).resolves.toEqual([true, true, true]);
    await expect(run(sliding.takeBatch(2))).resolves.toEqual([2, 3]);

    const zero = await run<any>(bounded<number>(0, "backpressure"));
    const offered = rt.fork(zero.offer(9));
    await wait();
    await expect(run(zero.take())).resolves.toBe(9);
    await new Promise<void>((resolve) => offered.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Success", value: true });
      resolve();
    }));
  });
});
