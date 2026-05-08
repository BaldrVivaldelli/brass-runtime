import { describe, it, expect } from "vitest";
import { makeSemaphore } from "../semaphore";
import { async, asyncFlatMap, asyncSucceed } from "../../types/asyncEffect";
import { Runtime } from "../runtime";
import { sleep } from "../combinators";

const rt = Runtime.make({});
function run<A>(effect: any): Promise<A> { return rt.toPromise(effect); }
const wait = () => new Promise((resolve) => setImmediate(resolve));

describe("Semaphore", () => {
  it("allows up to N concurrent effects", async () => {
    const sem = makeSemaphore(2);
    expect(sem.available()).toBe(2);
    expect(sem.capacity).toBe(2);
  });

  it("acquire decrements available, release increments", async () => {
    const sem = makeSemaphore(3);
    await run(sem.acquire());
    expect(sem.available()).toBe(2);
    await run(sem.acquire());
    expect(sem.available()).toBe(1);
    sem.release();
    expect(sem.available()).toBe(2);
    sem.release();
    expect(sem.available()).toBe(3);
  });

  it("withPermit acquires and releases automatically", async () => {
    const sem = makeSemaphore(1);
    const result = await run<number>(sem.withPermit(asyncSucceed(42)));
    expect(result).toBe(42);
    expect(sem.available()).toBe(1); // released
  });

  it("withPermit releases on failure", async () => {
    const sem = makeSemaphore(1);
    try {
      await run(sem.withPermit(async((_e, cb) => {
        cb({ _tag: "Failure", cause: { _tag: "Fail", error: "oops" } });
      })));
    } catch { }
    expect(sem.available()).toBe(1); // released despite failure
  });

  it("queues waiters when no permits available", async () => {
    const sem = makeSemaphore(1);

    // Acquire the only permit
    await run(sem.acquire());
    expect(sem.available()).toBe(0);

    // Start a waiter (will block)
    let waiterResolved = false;
    rt.unsafeRunAsync(sem.acquire() as any, () => { waiterResolved = true; });

    // Give the fiber a tick to process and suspend
    await new Promise(r => setTimeout(r, 10));

    expect(sem.waiting()).toBe(1);
    expect(waiterResolved).toBe(false);

    // Release — should unblock the waiter
    sem.release();
    await new Promise(r => setTimeout(r, 10));
    expect(waiterResolved).toBe(true);
    expect(sem.waiting()).toBe(0);
  });

  it("removes canceled acquire waiters", async () => {
    const sem = makeSemaphore(1);
    await run(sem.acquire());

    const waiter = rt.fork(sem.acquire());
    await wait();
    expect(sem.waiting()).toBe(1);

    waiter.interrupt();
    await wait();

    expect(sem.waiting()).toBe(0);
    sem.release();
    expect(sem.available()).toBe(1);
  });

  it("interrupts an in-flight withPermit effect and releases the permit", async () => {
    const sem = makeSemaphore(1);
    let canceled = false;
    const fiber = rt.fork(sem.withPermit(async(() => () => {
      canceled = true;
    })));

    await wait();
    expect(sem.available()).toBe(0);

    fiber.interrupt();
    await wait();

    expect(canceled).toBe(true);
    expect(sem.available()).toBe(1);
  });

  it("limits concurrency with withPermit", async () => {
    const sem = makeSemaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = sem.withPermit(
      async((_env, cb) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        setTimeout(() => {
          concurrent--;
          cb({ _tag: "Success", value: undefined });
        }, 10);
      })
    );

    // Run 5 tasks concurrently
    await Promise.all([
      run(task), run(task), run(task), run(task), run(task)
    ]);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(sem.available()).toBe(2);
  });
});
