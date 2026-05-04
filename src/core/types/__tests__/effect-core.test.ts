import { describe, expect, it } from "vitest";
import {
  Async,
  acquireRelease,
  async,
  asyncCatchAll,
  asyncFail,
  asyncFlatMap,
  asyncFold,
  asyncInterruptible,
  asyncMap,
  asyncMapError,
  asyncSucceed,
  asyncSync,
  asyncTotal,
  mapAsync,
  mapTryAsync,
  unit,
  withAsyncPromise,
} from "../asyncEffect";
import {
  Cause,
  Exit,
  catchAll,
  end,
  fail,
  flatMap,
  map,
  mapError,
  orElseOptional,
  succeed,
  sync,
} from "../effect";
import { none, some } from "../option";
import { Runtime } from "../../runtime/runtime";
import { Scope } from "../../runtime/scope";

const rt = Runtime.make({ factor: 2 });
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

describe("Async core constructors and combinators", () => {
  it("constructs the low-level Async ADT variants", () => {
    expect(Async.succeed<unknown, never, number>(1)).toEqual({ _tag: "Succeed", value: 1 });
    expect(Async.fail<unknown, string>("e")).toEqual({ _tag: "Fail", error: "e" });
    expect(Async.sync((env: { n: number }) => env.n)._tag).toBe("Sync");
    expect(Async.async((_env, cb) => cb(Exit.succeed("ok")))._tag).toBe("Async");
  });

  it("reuses common succeed singletons", () => {
    expect(asyncSucceed(undefined)).toBe(asyncSucceed(undefined));
    expect(asyncSucceed(true)).toBe(asyncSucceed(true));
    expect(asyncSucceed(false)).toBe(asyncSucceed(false));
    expect(asyncSucceed(null)).toBe(asyncSucceed(null));
    expect(unit()).toBe(unit());
  });

  it("maps, flatMaps, folds and catches failures", async () => {
    await expect(run(asyncMap(asyncSucceed(2), (n) => n + 1))).resolves.toBe(3);
    await expect(run(asyncFlatMap(asyncSucceed(2), (n) => asyncSucceed(n * 3)))).resolves.toBe(6);

    await expect(
      run(asyncFold(asyncFail("bad"), (e) => asyncSucceed(`recovered:${e}`), () => asyncSucceed("nope")))
    ).resolves.toBe("recovered:bad");

    await expect(run(asyncCatchAll(asyncFail("x"), (e) => asyncSucceed(e.length)))).resolves.toBe(1);
    await expect(run(asyncMapError(asyncFail("x"), (e) => e.toUpperCase()))).rejects.toBe("X");
  });

  it("runs sync, total, async and interruptible effects", async () => {
    await expect(run(asyncSync((env: { factor: number }) => env.factor + 1))).resolves.toBe(3);
    await expect(run(asyncTotal(() => "value"))).resolves.toBe("value");
    await expect(run(async((_env, cb) => cb(Exit.succeed(9))))).resolves.toBe(9);
    await expect(run(asyncInterruptible((_env, cb) => cb(Exit.succeed("i"))))).resolves.toBe("i");
  });

  it("mapAsync and mapTryAsync preserve success and turn thrown errors into failures", async () => {
    await expect(run(mapAsync(asyncSucceed(4), (n) => n * 2))).resolves.toBe(8);
    await expect(run(mapTryAsync(asyncSucceed(1), () => { throw "thrown"; }))).rejects.toBe("thrown");
  });

  it("withAsyncPromise attaches promise helpers only once", async () => {
    const runner = withAsyncPromise<unknown, never, number>((eff, env) => Runtime.make(env).toPromise(eff));
    const eff = runner(asyncSucceed(123));
    const same = runner(eff);

    expect(same).toBe(eff);
    await expect(eff.toPromise({})).resolves.toBe(123);
    await expect(eff.unsafeRunPromise()).resolves.toBe(123);
  });

  it("acquireRelease registers release finalizers with the supplied scope", async () => {
    const releases: string[] = [];
    const scope = new Scope(rt as any);
    const acquired = acquireRelease(
      asyncSucceed("resource"),
      (res, exit) => asyncSync(() => releases.push(`${res}:${exit._tag}`)),
      scope as any
    );

    await expect(run(acquired)).resolves.toBe("resource");
    await run(scope.closeAsync(Exit.succeed(undefined)));
    expect(releases).toContain("resource:Success");
  });
});

describe("Effect facade", () => {
  it("creates Cause and Exit values", () => {
    expect(Cause.fail("e")).toEqual({ _tag: "Fail", error: "e" });
    expect(Cause.interrupt()).toEqual({ _tag: "Interrupt" });
    expect(Cause.die("defect")).toEqual({ _tag: "Die", defect: "defect" });
    expect(Exit.succeed(1)).toEqual({ _tag: "Success", value: 1 });
    expect(Exit.failCause(Cause.fail("e"))).toEqual({ _tag: "Failure", cause: { _tag: "Fail", error: "e" } });
  });

  it("runs succeed, fail, sync, map, flatMap, mapError and catchAll", async () => {
    await expect(run(succeed(1))).resolves.toBe(1);
    await expect(run(fail("no"))).rejects.toBe("no");
    await expect(run(sync((env: { factor: number }) => env.factor))).resolves.toBe(2);
    await expect(run(map(succeed(2), (n) => n + 3))).resolves.toBe(5);
    await expect(run(flatMap(succeed(2), (n) => succeed(n * 4)))).resolves.toBe(8);
    await expect(run(mapError(fail("x"), (e) => `${e}!`))).rejects.toBe("x!");
    await expect(run(catchAll(fail("x"), (e) => succeed(`ok:${e}`)))).resolves.toBe("ok:x");
  });

  it("orElseOptional falls back on None, preserves Some failures and end fails with None", async () => {
    await expect(run(orElseOptional(fail(none), () => succeed("fallback")))).resolves.toBe("fallback");
    await expect(run(orElseOptional(fail(some("real")), () => succeed("fallback")))).rejects.toEqual(some("real"));
    await expect(run(end())).rejects.toEqual(none);
  });
});
