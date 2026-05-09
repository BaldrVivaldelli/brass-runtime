import { describe, it, expect } from "vitest";
import { makeBudgetSemaphore } from "../budgetSemaphore";

describe("Budget Semaphore Unit Tests", () => {
  it("release frees a slot", async () => {
    const sem = makeBudgetSemaphore(1);
    expect(sem.available()).toBe(1);

    const { release } = await sem.acquire();
    expect(sem.available()).toBe(0);

    release();
    expect(sem.available()).toBe(1);
  });

  it("queued waiters are granted FIFO", async () => {
    const sem = makeBudgetSemaphore(1);
    const order: number[] = [];

    // Acquire the only slot
    const { release: release1 } = await sem.acquire();

    // Queue two waiters
    const p2 = sem.acquire().then(({ release }) => {
      order.push(2);
      release();
    });
    const p3 = sem.acquire().then(({ release }) => {
      order.push(3);
      release();
    });

    expect(sem.queued()).toBe(2);

    // Release the first slot — should grant to waiter 2 first
    release1();
    await p2;
    await p3;

    expect(order).toEqual([2, 3]);
  });

  it("tryAcquire returns undefined when full", () => {
    const sem = makeBudgetSemaphore(1);

    const handle = sem.tryAcquire();
    expect(handle).toBeDefined();
    expect(sem.available()).toBe(0);

    const handle2 = sem.tryAcquire();
    expect(handle2).toBeUndefined();

    handle!.release();
    expect(sem.available()).toBe(1);
  });

  it("tryAcquire returns a handle when slots are available", () => {
    const sem = makeBudgetSemaphore(3);

    const h1 = sem.tryAcquire();
    const h2 = sem.tryAcquire();
    const h3 = sem.tryAcquire();
    const h4 = sem.tryAcquire();

    expect(h1).toBeDefined();
    expect(h2).toBeDefined();
    expect(h3).toBeDefined();
    expect(h4).toBeUndefined();
    expect(sem.available()).toBe(0);

    h1!.release();
    h2!.release();
    h3!.release();
    expect(sem.available()).toBe(3);
  });

  it("throws on invalid capacity", () => {
    expect(() => makeBudgetSemaphore(0)).toThrow();
    expect(() => makeBudgetSemaphore(-1)).toThrow();
    expect(() => makeBudgetSemaphore(NaN)).toThrow();
    expect(() => makeBudgetSemaphore(Infinity)).toThrow();
  });

  it("reports queued count correctly", async () => {
    const sem = makeBudgetSemaphore(2);
    expect(sem.queued()).toBe(0);

    const { release: r1 } = await sem.acquire();
    const { release: r2 } = await sem.acquire();
    expect(sem.queued()).toBe(0);

    // These will queue
    const p3 = sem.acquire();
    const p4 = sem.acquire();
    expect(sem.queued()).toBe(2);

    r1();
    await p3;
    expect(sem.queued()).toBe(1);

    r2();
    await p4;
    expect(sem.queued()).toBe(0);
  });
});
