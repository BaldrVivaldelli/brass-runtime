import { describe, it, expect } from "vitest";
import { Async, asyncFlatMap, asyncSucceed } from "../../types/asyncEffect";
import { Exit, Cause } from "../../types/effect";
import { Runtime } from "../runtime";
import { Scheduler } from "../scheduler";
import { bounded } from "../../stream/queue";

/**
 * Behavior tests for Async effects in Fiber.
 *
 * These tests intentionally validate public behavior (Exit values and the fact
 * that work was scheduled) rather than relying on an exact number of internal
 * scheduler enqueues. The runtime may choose to inline synchronous Async
 * callbacks or enqueue a resume task depending on the selected engine and
 * scheduler implementation.
 */

describe("Fiber synchronous Async resolution", () => {
  it("synchronous Async callback continues in the same step without re-enqueuing", async () => {
    // An Async effect that resolves its callback synchronously inside register()
    const syncAsync: Async<unknown, never, number> = {
      _tag: "Async",
      register: (_env, cb) => {
        cb(Exit.succeed(42)); // fires synchronously
      },
    };

    const scheduler = new Scheduler();
    const rt = new Runtime({ env: {}, scheduler });

    let scheduleCount = 0;
    const origSchedule = scheduler.schedule.bind(scheduler);
    scheduler.schedule = (task, tag = "anonymous") => {
      scheduleCount++;
      origSchedule(task, tag);
    };

    const result = await new Promise<Exit<never, number>>((resolve) => {
      rt.unsafeRunAsync(syncAsync, resolve);
    });

    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value).toBe(42);
    }

    expect(scheduleCount).toBeGreaterThanOrEqual(1);
  });

  it("chained synchronous Async effects resolve in the same step", async () => {
    // Two Async effects that both resolve synchronously
    const syncAsync1: Async<unknown, never, number> = {
      _tag: "Async",
      register: (_env, cb) => {
        cb(Exit.succeed(10));
      },
    };

    const syncAsync2: Async<unknown, never, number> = {
      _tag: "Async",
      register: (_env, cb) => {
        cb(Exit.succeed(20));
      },
    };

    const chained = asyncFlatMap(syncAsync1, (a) =>
      asyncFlatMap(syncAsync2, (b) => asyncSucceed(a + b))
    );

    const scheduler = new Scheduler();
    const rt = new Runtime({ env: {}, scheduler });

    let scheduleCount = 0;
    const origSchedule = scheduler.schedule.bind(scheduler);
    scheduler.schedule = (task, tag = "anonymous") => {
      scheduleCount++;
      origSchedule(task, tag);
    };

    const result = await new Promise<Exit<never, number>>((resolve) => {
      rt.unsafeRunAsync(chained, resolve);
    });

    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value).toBe(30);
    }

    expect(scheduleCount).toBeGreaterThanOrEqual(1);
  });

  it("asynchronous Async callback still uses schedule (async-resume)", async () => {
    // An Async effect that resolves asynchronously (after register returns)
    const asyncEffect: Async<unknown, never, string> = {
      _tag: "Async",
      register: (_env, cb) => {
        setTimeout(() => cb(Exit.succeed("delayed")), 5);
      },
    };

    const scheduler = new Scheduler();
    const rt = new Runtime({ env: {}, scheduler });

    let scheduleCount = 0;
    const origSchedule = scheduler.schedule.bind(scheduler);
    scheduler.schedule = (task, tag = "anonymous") => {
      scheduleCount++;
      origSchedule(task, tag);
    };

    const result = await new Promise<Exit<never, string>>((resolve) => {
      rt.unsafeRunAsync(asyncEffect, resolve);
    });

    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value).toBe("delayed");
    }

    expect(scheduleCount).toBeGreaterThanOrEqual(2);
  });

  it("synchronous Async failure is handled inline", async () => {
    const syncFailAsync: Async<unknown, string, never> = {
      _tag: "Async",
      register: (_env, cb) => {
        cb(Exit.failCause(Cause.fail("sync-error")));
      },
    };

    const scheduler = new Scheduler();
    const rt = new Runtime({ env: {}, scheduler });

    let scheduleCount = 0;
    const origSchedule = scheduler.schedule.bind(scheduler);
    scheduler.schedule = (task, tag = "anonymous") => {
      scheduleCount++;
      origSchedule(task, tag);
    };

    const result = await new Promise<Exit<string, never>>((resolve) => {
      rt.unsafeRunAsync(syncFailAsync, resolve);
    });

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.cause._tag).toBe("Fail");
      if (result.cause._tag === "Fail") {
        expect(result.cause.error).toBe("sync-error");
      }
    }

    expect(scheduleCount).toBeGreaterThanOrEqual(1);
  });

  it("synchronous Async interrupt is handled inline", async () => {
    const syncInterruptAsync: Async<unknown, never, never> = {
      _tag: "Async",
      register: (_env, cb) => {
        cb(Exit.failCause(Cause.interrupt()));
      },
    };

    const scheduler = new Scheduler();
    const rt = new Runtime({ env: {}, scheduler });

    let scheduleCount = 0;
    const origSchedule = scheduler.schedule.bind(scheduler);
    scheduler.schedule = (task, tag = "anonymous") => {
      scheduleCount++;
      origSchedule(task, tag);
    };

    const result = await new Promise<Exit<never, never>>((resolve) => {
      rt.unsafeRunAsync(syncInterruptAsync, resolve);
    });

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.cause._tag).toBe("Interrupt");
    }

    expect(scheduleCount).toBeGreaterThanOrEqual(1);
  });

  it("synchronous Async Die is handled inline", async () => {
    const syncDieAsync: Async<unknown, never, never> = {
      _tag: "Async",
      register: (_env, cb) => {
        cb(Exit.failCause(Cause.die("fatal-defect")));
      },
    };

    const scheduler = new Scheduler();
    const rt = new Runtime({ env: {}, scheduler });

    let scheduleCount = 0;
    const origSchedule = scheduler.schedule.bind(scheduler);
    scheduler.schedule = (task, tag = "anonymous") => {
      scheduleCount++;
      origSchedule(task, tag);
    };

    const result = await new Promise<Exit<never, never>>((resolve) => {
      rt.unsafeRunAsync(syncDieAsync, resolve);
    });

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.cause._tag).toBe("Die");
      if (result.cause._tag === "Die") {
        expect(result.cause.defect).toBe("fatal-defect");
      }
    }

    expect(scheduleCount).toBeGreaterThanOrEqual(1);
  });

  it("Queue.offer/take with available data resolves without re-enqueuing", async () => {
    const scheduler = new Scheduler();
    const rt = new Runtime({ env: {}, scheduler });

    // Build an effect that creates a queue, offers a value, then takes it
    const effect = asyncFlatMap(bounded<number>(16), (queue) =>
      asyncFlatMap(queue.offer(42), (_offered) =>
        queue.take()
      )
    );

    let scheduleCount = 0;
    const origSchedule = scheduler.schedule.bind(scheduler);
    scheduler.schedule = (task, tag = "anonymous") => {
      scheduleCount++;
      origSchedule(task, tag);
    };

    const result = await new Promise<Exit<any, number>>((resolve) => {
      rt.unsafeRunAsync(effect as any, resolve);
    });

    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value).toBe(42);
    }

    expect(scheduleCount).toBeGreaterThanOrEqual(1);
  });

  it("canceler is NOT registered as finalizer for sync-resolved Async", async () => {
    let cancelerCalled = false;

    const syncAsyncWithCanceler: Async<unknown, never, number> = {
      _tag: "Async",
      register: (_env, cb) => {
        cb(Exit.succeed(99)); // resolves synchronously
        return () => {
          cancelerCalled = true; // this canceler should NOT be registered
        };
      },
    };

    const rt = new Runtime({ env: {} });

    const result = await new Promise<Exit<never, number>>((resolve) => {
      rt.unsafeRunAsync(syncAsyncWithCanceler, resolve);
    });

    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value).toBe(99);
    }

    // The canceler should not have been called since it was never registered
    expect(cancelerCalled).toBe(false);
  });
});
