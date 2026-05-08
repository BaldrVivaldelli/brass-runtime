import { describe, expect, it, vi } from "vitest";
import { async, asyncFail, asyncFlatMap, asyncFold, asyncSucceed } from "../../types/asyncEffect";
import { Cause, Exit } from "../../types/effect";
import { Runtime } from "../runtime";

const wait = () => new Promise((resolve) => setImmediate(resolve));

describe("RuntimeFiber edge coverage", () => {
  it("handles sync async exits, double callbacks, failures, defects, and detached cancelers", async () => {
    const rt = Runtime.make({});
    let calls = 0;
    await expect(rt.toPromise(async((_env, cb) => {
      cb(Exit.succeed("first"));
      cb(Exit.succeed("second"));
      calls++;
    }))).resolves.toBe("first");
    expect(calls).toBe(1);

    await expect(rt.toPromise(async((_env, cb) => {
      cb(Exit.failCause(Cause.fail("sync-fail")));
    }))).rejects.toBe("sync-fail");

    await expect(rt.toPromise(async((_env, cb) => {
      cb(Exit.failCause(Cause.die(new Error("sync-die"))));
    }))).rejects.toThrow("sync-die");

    let canceled = false;
    const fiber = rt.fork(async(() => () => { canceled = true; }));
    await wait();
    fiber.interrupt();
    await new Promise<void>((resolve) => fiber.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Interrupt" } });
      resolve();
    }));
    expect(canceled).toBe(true);
  });

  it("maps thrown continuations and unknown opcodes through failure channels", async () => {
    const rt = Runtime.make({});

    await expect(rt.toPromise(asyncFlatMap(asyncSucceed(1), () => {
      throw new Error("flatmap-boom");
    }))).rejects.toThrow("flatmap-boom");

    await expect(rt.toPromise(asyncFold(
      asyncFail("bad"),
      () => { throw new Error("fold-boom"); },
      asyncSucceed,
    ))).rejects.toThrow("fold-boom");

    await expect(rt.toPromise({ _tag: "UnknownOpcode" } as any)).rejects.toThrow("Unknown opcode");
  });

  it("runs finalizers once, swallows finalizer throws, executes Async finalizers, and supports late joins", async () => {
    const rt = Runtime.make({});
    const order: string[] = [];
    const fiber = rt.fork(asyncSucceed("ok"));

    fiber.addFinalizer(() => {
      order.push("throwing");
      throw new Error("ignored");
    });
    fiber.addFinalizer(() => async((_env, cb) => {
      order.push("async");
      cb(Exit.succeed(undefined));
    }) as any);
    fiber.addFinalizer(() => {
      order.push("plain");
    });

    await new Promise<void>((resolve) => fiber.join((exit) => {
      expect(exit).toEqual(Exit.succeed("ok"));
      resolve();
    }));
    await wait();
    fiber.interrupt();
    fiber.addFinalizer(() => order.push("late-not-run"));

    await new Promise<void>((resolve) => fiber.join((exit) => {
      expect(exit).toEqual(Exit.succeed("ok"));
      resolve();
    }));
    expect(order).toEqual(["plain", "throwing", "async"]);
  });

  it("reports scheduler drops as defects and returns child fibers from Fork", async () => {
    const droppedRt = new Runtime({
      env: {},
      scheduler: { schedule: () => "dropped" } as any,
    });
    const dropped = droppedRt.fork(asyncSucceed("never"));
    await new Promise<void>((resolve) => dropped.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Die" } });
      resolve();
    }));

    const rt = Runtime.make({});
    const child = await rt.toPromise({ _tag: "Fork", effect: asyncSucceed(1), scopeId: 99 } as any);
    expect(child).toMatchObject({ scopeId: 99 });
  });

  it("emits lifecycle events with scope and trace context", async () => {
    const events: unknown[] = [];
    const rt = new Runtime({
      env: {},
      hooks: { emit: (ev, ctx) => events.push({ ev, ctx }) },
    });
    const fiber = rt.fork(async((_env, cb) => {
      setImmediate(() => cb(Exit.succeed("ok")));
    }));
    (fiber as any).fiberContext = { trace: { traceId: "t", spanId: "s" } };
    (fiber as any).scopeId = 123;

    await new Promise<void>((resolve) => fiber.join(() => resolve()));
    expect(events.some((entry: any) => entry.ev.type === "fiber.suspend")).toBe(true);
    expect(events.some((entry: any) => entry.ev.type === "fiber.resume")).toBe(true);
    expect(events.some((entry: any) => entry.ev.type === "fiber.end" && entry.ctx.scopeId === 123)).toBe(true);
  });

  it("coalesces queued schedules and lets interrupts win before the queued step runs", async () => {
    const queued: Array<() => void> = [];
    const scheduler = {
      schedule: vi.fn((task: () => void) => {
        queued.push(task);
        return "accepted";
      }),
    };
    const rt = new Runtime({ env: {}, scheduler: scheduler as any });
    const fiber = rt.fork(asyncSucceed("too-late"));

    fiber.interrupt();
    fiber.interrupt();
    expect(scheduler.schedule).toHaveBeenCalledTimes(1);

    queued.shift()?.();

    await new Promise<void>((resolve) => fiber.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Interrupt" } });
      resolve();
    }));
    expect(fiber.status()).toBe("Interrupted");
  });
});
