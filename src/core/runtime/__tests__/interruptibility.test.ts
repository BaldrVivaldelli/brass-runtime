import { describe, expect, it } from "vitest";

import { async } from "../../types/asyncEffect";
import { Cause, Exit, interruptible, succeed, uninterruptible, uninterruptibleMask } from "../../types/effect";
import { Runtime } from "../runtime";

const joinExit = <E, A>(fiber: { join: (cb: (exit: Exit<E, A>) => void) => void }) =>
  new Promise<Exit<E, A>>((resolve) => fiber.join(resolve));

describe("interruptibility", () => {
  it("completes an uninterruptible region with a pending interrupt after the region exits", async () => {
    const runtime = Runtime.make({});
    let resume: ((exit: Exit<never, string>) => void) | undefined;
    let canceled = false;
    let registeredResolve!: () => void;
    const registered = new Promise<void>((resolve) => {
      registeredResolve = resolve;
    });

    const fiber = runtime.fork(uninterruptible(async((_env, cb) => {
      resume = cb;
      registeredResolve();
      return () => {
        canceled = true;
      };
    })));

    await registered;
    fiber.interrupt();
    expect(canceled).toBe(false);
    resume!(Exit.succeed("ok"));

    await expect(joinExit(fiber)).resolves.toEqual(Exit.failCause(Cause.interrupt()));
    expect(canceled).toBe(false);
  });

  it("restores interruptibility inside uninterruptibleMask", async () => {
    const runtime = Runtime.make({});
    let canceled = false;
    let registeredResolve!: () => void;
    const registered = new Promise<void>((resolve) => {
      registeredResolve = resolve;
    });

    const fiber = runtime.fork(uninterruptibleMask((restore) =>
      restore(async((_env, _cb) => {
        registeredResolve();
        return () => {
          canceled = true;
        };
      })),
    ));

    await registered;
    fiber.interrupt();

    await expect(joinExit(fiber)).resolves.toEqual(Exit.failCause(Cause.interrupt()));
    expect(canceled).toBe(true);
  });

  it("combines failures with a pending deferred interrupt", async () => {
    const runtime = Runtime.make({});
    let resume: ((exit: Exit<string, never>) => void) | undefined;
    let registeredResolve!: () => void;
    const registered = new Promise<void>((resolve) => {
      registeredResolve = resolve;
    });

    const fiber = runtime.fork(uninterruptible(async((_env, cb) => {
      resume = cb;
      registeredResolve();
    })));

    await registered;
    fiber.interrupt();
    resume!(Exit.failCause(Cause.fail("boom")));

    await expect(joinExit(fiber)).resolves.toEqual(
      Exit.failCause(Cause.then(Cause.fail("boom"), Cause.interrupt())),
    );
  });

  it("runs normally when no interrupt is requested", async () => {
    const runtime = Runtime.make({});
    await expect(runtime.toPromise(uninterruptibleMask((restore) =>
      restore(interruptible(succeed("ok"))),
    ))).resolves.toBe("ok");
  });
});
