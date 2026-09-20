import { describe, expect, it, vi } from "vitest";
import { async, asyncFlatMap, asyncFold, asyncSucceed, asyncSync, type Async } from "../../types/asyncEffect";
import { Cause, Exit, uninterruptible, type Exit as EffectExit } from "../../types/effect";
import { registerEffectDirect } from "../directEffectRunner";
import { makeFiberRef } from "../fiberRef";

describe("registerEffectDirect", () => {
  it("keeps ownership of the newest canceler after synchronous re-entry", () => {
    const firstCancel = vi.fn();
    const secondCancel = vi.fn();
    const exits: EffectExit<never, string>[] = [];
    const effect = asyncFlatMap(
      async<unknown, never, number>((_env, cb) => {
        cb(Exit.succeed(1));
        return firstCancel;
      }),
      () => async<unknown, never, string>(() => secondCancel),
    );

    const cancel = registerEffectDirect(effect, undefined, (exit) => exits.push(exit));
    cancel();

    expect(firstCancel).not.toHaveBeenCalled();
    expect(secondCancel).toHaveBeenCalledOnce();
    expect(exits).toEqual([Exit.failCause(Cause.interrupt())]);
  });

  it("accepts only the first callback from an Async registration", () => {
    const exits: EffectExit<never, number>[] = [];
    const effect = async<unknown, never, number>((_env, cb) => {
      cb(Exit.succeed(1));
      cb(Exit.succeed(2));
    });

    registerEffectDirect(effect, undefined, (exit) => exits.push(exit));

    expect(exits).toEqual([Exit.succeed(1)]);
  });

  it("turns registration and mask-body throws into defects", () => {
    const registrationError = new Error("registration failed");
    const maskError = new Error("mask failed");
    const registrationExits: EffectExit<never, never>[] = [];
    const maskExits: EffectExit<never, never>[] = [];

    registerEffectDirect(
      async(() => {
        throw registrationError;
      }),
      undefined,
      (exit) => registrationExits.push(exit),
    );
    const masked = {
      _tag: "InterruptibilityMask",
      body: () => {
        throw maskError;
      },
    } satisfies Async<unknown, never, never>;
    registerEffectDirect(masked, undefined, (exit) => maskExits.push(exit));

    expect(registrationExits).toEqual([Exit.failCause(Cause.die(registrationError))]);
    expect(maskExits).toEqual([Exit.failCause(Cause.die(maskError))]);
  });

  it("routes Sync throws through the recoverable failure channel", () => {
    const effect = asyncFold(
      asyncSync(() => {
        throw new Error("sync failed");
      }),
      (error) => asyncSucceed(error instanceof Error ? error.message : String(error)),
      () => asyncSucceed("unexpected"),
    );
    const exits: EffectExit<never, string>[] = [];

    registerEffectDirect(effect, undefined, (exit) => exits.push(exit as EffectExit<never, string>));

    expect(exits).toEqual([Exit.succeed("sync failed")]);
  });

  it("reports interruption once even when the owned canceler throws", () => {
    const exits: EffectExit<never, never>[] = [];
    const cancel = registerEffectDirect(
      async(() => () => {
        throw new Error("cancel failed");
      }),
      undefined,
      (exit) => exits.push(exit),
    );

    expect(() => cancel()).not.toThrow();
    cancel();

    expect(exits).toEqual([Exit.failCause(Cause.interrupt())]);
  });

  it("runs deep synchronous FlatMap chains without overflowing the stack", async () => {
    let effect: Async<unknown, never, number> = asyncSucceed(0);
    for (let index = 0; index < 20_000; index++) {
      effect = asyncFlatMap(effect, (value) => asyncSucceed(value + 1));
    }

    const exit = await new Promise<EffectExit<never, number>>((resolve) => {
      registerEffectDirect(effect, undefined, resolve);
    });

    expect(exit).toEqual(Exit.succeed(20_000));
  });

  it("delegates runtime-owned Fork and FiberRef nodes without erasing their semantics", async () => {
    const ref = makeFiberRef(0);
    const localExit = await new Promise<EffectExit<never, number>>((resolve) => {
      registerEffectDirect(ref.locally(7, ref.get()), undefined, resolve);
    });

    expect(localExit).toEqual(Exit.succeed(7));
    expect(ref.unsafeGet()).toBe(0);

    const forkEffect = {
      _tag: "Fork",
      effect: asyncSucceed("child"),
    } as Async<unknown, never, { join(cb: (exit: EffectExit<never, string>) => void): void }>;
    const forkExit = await new Promise<
      EffectExit<never, { join(cb: (exit: EffectExit<never, string>) => void): void }>
    >((resolve) => registerEffectDirect(forkEffect, undefined, resolve));

    expect(forkExit._tag).toBe("Success");
    if (forkExit._tag === "Success") {
      const childExit = await new Promise<EffectExit<never, string>>((resolve) => forkExit.value.join(resolve));
      expect(childExit).toEqual(Exit.succeed("child"));
    }
  });

  it("preserves uninterruptible cancellation until the protected region completes", async () => {
    let resume!: (exit: EffectExit<never, number>) => void;
    const innerCancel = vi.fn();
    const effect = uninterruptible(async<unknown, never, number>((_env, cb) => {
      resume = cb;
      return innerCancel;
    }));
    let resolveExit!: (exit: EffectExit<never, number>) => void;
    const exitPromise = new Promise<EffectExit<never, number>>((resolve) => {
      resolveExit = resolve;
    });
    const cancel = registerEffectDirect(effect, undefined, resolveExit);

    await new Promise((resolve) => setTimeout(resolve, 0));
    cancel();

    expect(innerCancel).not.toHaveBeenCalled();
    resume(Exit.succeed(1));
    await expect(exitPromise).resolves.toEqual(Exit.failCause(Cause.interrupt()));
  });
});
