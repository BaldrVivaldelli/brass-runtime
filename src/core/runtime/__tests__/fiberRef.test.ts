import { describe, expect, it } from "vitest";

import { async, asyncFlatMap, asyncFold, asyncMap, asyncSucceed, type Async } from "../../types/asyncEffect";
import { Cause, Exit, fail, flatMap, map, succeed } from "../../types/effect";
import { getCurrentFiber } from "../fiber";
import type { Fiber } from "../fiber";
import { makeFiberRef } from "../fiberRef";
import { Runtime } from "../runtime";
import { Scheduler } from "../scheduler";

const forkEffect = <E, A>(effect: Async<unknown, E, A>): Async<unknown, never, Fiber<E, A>> =>
  ({ _tag: "Fork", effect } as Async<unknown, never, Fiber<E, A>>);

const joinFiber = <E, A>(fiber: Fiber<E, A>): Async<unknown, E, A> =>
  async((_env, cb) => fiber.join(cb));

function makeWasmRuntime(): Runtime<{}> | undefined {
  try {
    return Runtime.makeWithEngine({}, "wasm", { scheduler: new Scheduler({ engine: "ts" }) });
  } catch {
    return undefined;
  }
}

describe("FiberRef", () => {
  it("reads initial values and supports set/update/modify", async () => {
    const runtime = Runtime.make({});
    const ref = makeFiberRef(1);

    const effect = asyncFlatMap(ref.get(), (initial) =>
      asyncFlatMap(ref.set(initial + 1), () =>
        asyncFlatMap(ref.update((value) => value + 10), (updated) =>
          asyncMap(ref.modify((value) => [`value:${value}`, value + 1]), (modified) => [initial, updated, modified] as const)
        )
      )
    );

    await expect(runtime.toPromise(effect)).resolves.toEqual([1, 12, "value:12"]);
  });

  it("inherits a snapshot on fork and isolates child mutations", async () => {
    const runtime = Runtime.make({});
    const ref = makeFiberRef("root");

    const childEffect = flatMap(ref.set("child"), () => ref.get());
    const effect = flatMap(ref.set("parent"), () =>
      flatMap(forkEffect(childEffect), (child) =>
        flatMap(joinFiber(child), (childValue) =>
          map(ref.get(), (parentValue) => [childValue, parentValue] as const)
        )
      )
    );

    await expect(runtime.toPromise(effect)).resolves.toEqual(["child", "parent"]);
  });

  it("restores locally scoped values on success and failure", async () => {
    const runtime = Runtime.make({});
    const ref = makeFiberRef("root");

    const success = flatMap(ref.set("outer"), () =>
      flatMap(ref.locally("inner", ref.get()), (inner) =>
        map(ref.get(), (after) => [inner, after] as const)
      )
    );
    await expect(runtime.toPromise(success)).resolves.toEqual(["inner", "outer"]);

    const failure = flatMap(ref.set("outer"), () =>
      asyncFold(
        ref.locally("inner", fail("boom")),
        () => ref.get(),
        () => succeed("unexpected"),
      )
    );
    await expect(runtime.toPromise(failure)).resolves.toBe("outer");
  });

  it("restores locally scoped values in the wasm engine when available", async () => {
    const runtime = makeWasmRuntime();
    if (!runtime) return;
    const ref = makeFiberRef("root");

    try {
      const success = flatMap(ref.set("outer"), () =>
        flatMap(ref.locally("inner", ref.get()), (inner) =>
          map(ref.get(), (after) => [inner, after] as const)
        )
      );
      await expect(runtime.toPromise(success)).resolves.toEqual(["inner", "outer"]);

      const failure = flatMap(ref.set("outer"), () =>
        asyncFold(
          ref.locally("inner", fail("boom")),
          () => ref.get(),
          () => succeed("unexpected"),
        )
      );
      await expect(runtime.toPromise(failure)).resolves.toBe("outer");
    } finally {
      await runtime.shutdown();
    }
  });

  it("supports locallyWith", async () => {
    const runtime = Runtime.make({});
    const ref = makeFiberRef(2);

    const effect = flatMap(ref.set(10), () =>
      flatMap(ref.locallyWith((value) => value * 2, ref.get()), (inner) =>
        map(ref.get(), (after) => [inner, after] as const)
      )
    );

    await expect(runtime.toPromise(effect)).resolves.toEqual([20, 10]);
  });

  it("restores locally scoped values before interruption finalizers run", async () => {
    const runtime = Runtime.make({});
    const ref = makeFiberRef("root");
    let resume: ((exit: Exit<never, never>) => void) | undefined;
    let registeredResolve!: () => void;
    let finalizerValue: string | undefined;
    const registered = new Promise<void>((resolve) => {
      registeredResolve = resolve;
    });

    const effect = flatMap(ref.set("outer"), () =>
      flatMap(asyncSucceed(undefined), () => {
        getCurrentFiber()?.addFinalizer(() => {
          finalizerValue = ref.unsafeGet();
        });
        return ref.locally("inner", async((_env, cb) => {
          resume = cb;
          registeredResolve();
        }));
      })
    );

    const fiber = runtime.fork(effect);
    await registered;
    fiber.interrupt();
    resume?.(Exit.succeed(undefined as never));

    await expect(new Promise((resolve) => fiber.join(resolve))).resolves.toEqual(Exit.failCause(Cause.interrupt()));
    expect(finalizerValue).toBe("outer");
  });

  it("restores wasm-local values before interruption finalizers run when available", async () => {
    const runtime = makeWasmRuntime();
    if (!runtime) return;
    const ref = makeFiberRef("root");
    let registeredResolve!: () => void;
    let finalizerValue: string | undefined;
    const registered = new Promise<void>((resolve) => {
      registeredResolve = resolve;
    });

    try {
      const effect = flatMap(ref.set("outer"), () =>
        flatMap(asyncSucceed(undefined), () => {
          getCurrentFiber()?.addFinalizer(() => {
            finalizerValue = ref.unsafeGet();
          });
          return ref.locally("inner", async(() => {
            registeredResolve();
            return () => undefined;
          }));
        })
      );

      const fiber = runtime.fork(effect);
      await registered;
      fiber.interrupt();

      await expect(new Promise((resolve) => fiber.join(resolve))).resolves.toEqual(Exit.failCause(Cause.interrupt()));
      expect(finalizerValue).toBe("outer");
    } finally {
      await runtime.shutdown();
    }
  });

  it("returns the initial value when read outside a running fiber", () => {
    const ref = makeFiberRef("initial");
    ref.unsafeSet("ignored");
    expect(ref.unsafeGet()).toBe("initial");
  });
});
