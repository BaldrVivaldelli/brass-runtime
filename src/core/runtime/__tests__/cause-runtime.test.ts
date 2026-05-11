import { describe, expect, it } from "vitest";

import { async } from "../../types/asyncEffect";
import { Cause, Exit, catchAll, succeed } from "../../types/effect";
import { Runtime } from "../runtime";

describe("runtime Cause integration", () => {
  it("preserves unhandled composite causes from async callbacks", async () => {
    const runtime = Runtime.make({});
    const cause = Cause.both(Cause.fail("left"), Cause.fail("right"));

    const exit = await new Promise((resolve) => {
      runtime.unsafeRunAsync(
        async((_env, cb) => cb(Exit.failCause(cause))),
        resolve as any,
      );
    });

    expect(exit).toEqual(Exit.failCause(cause));
  });

  it("lets catchAll handle pure failure causes by their first failure", async () => {
    const runtime = Runtime.make({});
    const effect = catchAll(
      async((_env, cb) => cb(Exit.failCause(Cause.then(Cause.fail("first"), Cause.fail("second"))))),
      (error) => succeed(`caught:${error}`),
    );

    await expect(runtime.toPromise(effect)).resolves.toBe("caught:first");
  });

  it("does not treat mixed defects and failures as recoverable typed errors", async () => {
    const runtime = Runtime.make({});
    const defect = new Error("boom");
    const cause = Cause.both(Cause.fail("domain"), Cause.die(defect));
    const effect = catchAll(
      async((_env, cb) => cb(Exit.failCause(cause))),
      () => succeed("caught"),
    );

    const exit = await new Promise((resolve) => {
      runtime.unsafeRunAsync(effect, resolve as any);
    });

    expect(exit).toEqual(Exit.failCause(cause));
  });
});
