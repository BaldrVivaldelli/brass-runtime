import { describe, expect, it, vi } from "vitest";
import { gen } from "../gen";
import { pipe, dual } from "../pipe";
import { as, catchAllWith, fail, succeed, suspend, tap } from "../effect";
import { asyncFlatMap, async as asyncEffect, type Async } from "../asyncEffect";
import { runExit, runPromise } from "../../runtime/dx";
import { Runtime } from "../../runtime/runtime";
import { sleep } from "../../runtime/combinators";

describe("gen", () => {
  it("composes steps as straight-line code", async () => {
    const program = gen(function* ($) {
      const left = yield* $(succeed(20));
      const right = yield* $(succeed(22));
      return left + right;
    });

    await expect(runPromise(program)).resolves.toBe(42);
  });

  it("does not run the generator body at construction time", () => {
    const entered = vi.fn();

    gen(function* ($) {
      entered();
      return yield* $(succeed(1));
    });

    expect(entered).not.toHaveBeenCalled();
  });

  it("gives each execution a fresh iterator, so the effect is reusable", async () => {
    const seen: number[] = [];
    let counter = 0;

    const program = gen(function* ($) {
      const next = yield* $(succeed((counter += 1)));
      seen.push(next);
      return next;
    });

    await expect(runPromise(program)).resolves.toBe(1);
    await expect(runPromise(program)).resolves.toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  it("short-circuits on the first failure and skips later steps", async () => {
    const afterFailure = vi.fn();

    const program = gen(function* ($) {
      yield* $(succeed("ok"));
      yield* $(fail("boom"));
      afterFailure();
      return "unreachable";
    });

    const exit = await runExit(program);
    expect(exit._tag).toBe("Failure");
    expect(afterFailure).not.toHaveBeenCalled();
  });

  it("threads the environment through every step", async () => {
    const program = gen(function* ($) {
      const base = yield* $({ _tag: "Sync", thunk: (env: { base: number }) => env.base } as Async<
        { base: number },
        never,
        number
      >);
      return base * 2;
    });

    await expect(runPromise(program, { base: 21 })).resolves.toBe(42);
  });

  it("remains interruptible between steps", async () => {
    const reachedSecondStep = vi.fn();

    const program = gen(function* ($) {
      yield* $(sleep(50));
      reachedSecondStep();
      return "done";
    });

    const runtime = new Runtime({ env: {} });
    const fiber = runtime.fork(program);
    const exit = await new Promise<{ _tag: string }>((resolve) => {
      fiber.join(resolve);
      queueMicrotask(() => fiber.interrupt());
    });

    expect(exit._tag).toBe("Failure");
    expect(reachedSecondStep).not.toHaveBeenCalled();
  });

  it("propagates a throw from the generator body as a defect", async () => {
    const program = gen(function* ($) {
      yield* $(succeed(1));
      throw new Error("generator exploded");
    });

    const exit = await runExit(program);
    expect(exit._tag).toBe("Failure");
  });
});

describe("pipe", () => {
  it("applies steps left to right", () => {
    expect(pipe(2, (n) => n + 3, (n) => n * 4)).toBe(20);
  });

  it("returns the source unchanged with no steps", () => {
    const source = { untouched: true };
    expect(pipe(source)).toBe(source);
  });

  it("composes effect combinators data-last", async () => {
    const mapDual = dual<
      <R, E, A, B>(fa: Async<R, E, A>, f: (a: A) => B) => Async<R, E, B>,
      <A, B>(f: (a: A) => B) => <R, E>(fa: Async<R, E, A>) => Async<R, E, B>
    >(2, (fa, f) => asyncFlatMap(fa, (a) => succeed(f(a))));

    const program = pipe(
      succeed(20),
      mapDual((n: number) => n + 22),
    );

    await expect(runPromise(program)).resolves.toBe(42);
  });
});

describe("dual", () => {
  const add = dual<(a: number, b: number) => number, (b: number) => (a: number) => number>(
    2,
    (a: number, b: number) => a + b,
  );

  it("accepts the data-first arity", () => {
    expect(add(1, 2)).toBe(3);
  });

  it("accepts the data-last arity", () => {
    expect(add(2)(1)).toBe(3);
  });

  it("supports a guard when trailing parameters are optional", () => {
    const scale = dual<
      (value: number, factor?: number) => number,
      (factor?: number) => (value: number) => number
    >(
      (args) => typeof args[0] === "number",
      (value: number, factor = 2) => value * factor,
    );

    expect(scale(21)).toBe(42);
    expect(scale(21, 3)).toBe(63);
    expect(scale()(21)).toBe(42);
  });
});

describe("suspend / tap / as / catchAllWith", () => {
  it("suspend defers construction until interpretation", async () => {
    const build = vi.fn(() => succeed("built"));
    const program = suspend(build);

    expect(build).not.toHaveBeenCalled();
    await expect(runPromise(program)).resolves.toBe("built");
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("tap keeps the original value", async () => {
    const observed: string[] = [];
    const program = tap(succeed("value"), (a) => succeed(observed.push(a)));

    await expect(runPromise(program)).resolves.toBe("value");
    expect(observed).toEqual(["value"]);
  });

  it("as replaces the success value", async () => {
    await expect(runPromise(as(succeed("ignored"), 42))).resolves.toBe(42);
  });

  it("catchAllWith recovers with a plain value", async () => {
    await expect(runPromise(catchAllWith(fail("boom"), (e) => `recovered:${e}`))).resolves.toBe(
      "recovered:boom",
    );
  });
});
