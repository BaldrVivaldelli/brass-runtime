import { describe, expect, it, vi } from "vitest";
import {
  async,
  asyncFail,
  asyncFlatMap,
  asyncFold,
  asyncSucceed,
  asyncSync,
} from "../../core/types/asyncEffect";
import type { Exit } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";
import { withCircuitBreaker } from "../circuitBreaker";
import type { HttpClientFn, HttpError, HttpRequest, HttpWireResponse } from "../client";
import { registerHttpEffect } from "../effectRunner";
import { HttpConcurrencyPool, resolveHttpPoolKey } from "../pool";

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

const req: HttpRequest = { method: "GET", url: "https://example.test/path" };
const ok: HttpWireResponse = { status: 200, statusText: "OK", headers: {}, bodyText: "ok", ms: 1 };

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("registerHttpEffect", () => {
  const runRegistered = <E, A>(effect: any, env: unknown = {}): Promise<Exit<E, A>> =>
    new Promise((resolve) => {
      registerHttpEffect(effect, env, resolve);
    });

  it("runs succeed, fail, sync success, sync die, flatMap, fold, and fork variants", async () => {
    await expect(runRegistered(asyncSucceed(1))).resolves.toEqual({ _tag: "Success", value: 1 });
    await expect(runRegistered(asyncFail("no"))).resolves.toEqual({
      _tag: "Failure",
      cause: { _tag: "Fail", error: "no" },
    });
    await expect(runRegistered(asyncSync((env: { n: number }) => env.n + 1), { n: 2 })).resolves.toEqual({
      _tag: "Success",
      value: 3,
    });
    const syncDie = await runRegistered(asyncSync(() => { throw new Error("boom"); }));
    expect(syncDie._tag).toBe("Failure");
    expect(syncDie._tag === "Failure" ? syncDie.cause._tag : "").toBe("Die");

    await expect(runRegistered(asyncFlatMap(asyncSucceed(2), (n) => asyncSucceed(n * 4)))).resolves.toEqual({
      _tag: "Success",
      value: 8,
    });
    await expect(runRegistered(asyncFold(asyncFail("x"), (e) => asyncSucceed(`handled:${e}`), asyncSucceed))).resolves.toEqual({
      _tag: "Success",
      value: "handled:x",
    });
    await expect(runRegistered({ _tag: "Fork", effect: asyncSucceed("child") })).resolves.toEqual({
      _tag: "Success",
      value: undefined,
    });
  });

  it("turns thrown flatMap/fold continuations into Die and preserves interrupt failures", async () => {
    const flatMapDie = await runRegistered(asyncFlatMap(asyncSucceed(1), () => { throw new Error("bad cont"); }));
    expect(flatMapDie._tag).toBe("Failure");
    expect(flatMapDie._tag === "Failure" ? flatMapDie.cause._tag : "").toBe("Die");

    const foldDie = await runRegistered(asyncFold(asyncSucceed(1), asyncSucceed, () => { throw new Error("bad fold"); }));
    expect(foldDie._tag).toBe("Failure");
    expect(foldDie._tag === "Failure" ? foldDie.cause._tag : "").toBe("Die");

    const interrupted = await runRegistered(
      async((_env, cb) => cb({ _tag: "Failure", cause: { _tag: "Interrupt" } })),
    );
    expect(interrupted).toEqual({ _tag: "Failure", cause: { _tag: "Interrupt" } });
  });

  it("cancels active async effects once and ignores late callbacks", async () => {
    let cancelCount = 0;
    let callback: ((exit: Exit<string, number>) => void) | undefined;
    const exits: Exit<string, number>[] = [];
    const cancel = registerHttpEffect(
      async((_env, cb) => {
        callback = cb;
        return () => { cancelCount++; };
      }),
      {},
      (exit) => exits.push(exit),
    );

    cancel();
    cancel();
    callback?.({ _tag: "Success", value: 1 });

    expect(cancelCount).toBe(1);
    expect(exits).toEqual([{ _tag: "Failure", cause: { _tag: "Interrupt" } }]);
  });
});

describe("withCircuitBreaker", () => {
  it("opens on retryable HTTP failures and fails fast until reset timeout passes", async () => {
    const transitions: string[] = [];
    let calls = 0;
    const downstream: HttpClientFn = () => {
      calls++;
      return calls < 2 ? asyncFail({ _tag: "FetchError", message: "down" } as HttpError) : asyncSucceed(ok);
    };
    const client = withCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 20,
      onStateChange: (from, to) => transitions.push(`${from}->${to}`),
    })(downstream);

    await expect(run(client(req))).rejects.toMatchObject({ _tag: "FetchError" });
    await expect(run(client(req))).rejects.toMatchObject({ _tag: "CircuitBreakerOpen" });
    expect(calls).toBe(1);

    await wait(25);
    await expect(run(client(req))).resolves.toMatchObject({ status: 200 });
    expect(transitions).toEqual(["closed->open", "open->half-open", "half-open->closed"]);
  });

  it("does not count Abort or BadUrl as global breaker failures", async () => {
    const errors: HttpError[] = [{ _tag: "Abort" }, { _tag: "BadUrl", message: "bad" }];
    let calls = 0;
    const downstream: HttpClientFn = () => asyncFail(errors[calls++]!);
    const client = withCircuitBreaker({ failureThreshold: 1 })(downstream);

    await expect(run(client(req))).rejects.toMatchObject({ _tag: "Abort" });
    await expect(run(client(req))).rejects.toMatchObject({ _tag: "BadUrl" });
    expect(calls).toBe(2);
  });

  it("keeps per-origin breakers isolated and falls back to global for invalid URLs", async () => {
    const downstream: HttpClientFn = (request) =>
      request.url.includes("bad-origin") || request.url === "not a url"
        ? asyncFail({ _tag: "FetchError", message: request.url } as HttpError)
        : asyncSucceed(ok);
    const client = withCircuitBreaker({ perOrigin: true, failureThreshold: 1 })(downstream);

    await expect(run(client({ ...req, url: "https://bad-origin.test/a" }))).rejects.toMatchObject({ _tag: "FetchError" });
    await expect(run(client({ ...req, url: "https://bad-origin.test/b" }))).rejects.toMatchObject({ _tag: "CircuitBreakerOpen" });
    await expect(run(client({ ...req, url: "https://other-origin.test/a" }))).resolves.toEqual(ok);

    await expect(run(client({ ...req, url: "not a url" }))).rejects.toMatchObject({ _tag: "FetchError" });
    await expect(run(client({ ...req, url: "not a url" }))).rejects.toMatchObject({ _tag: "CircuitBreakerOpen" });
  });
});

describe("HttpConcurrencyPool", () => {
  it("resolves keys from custom request key, resolver, global, host, and origin", () => {
    const url = new URL("https://example.test:8443/a");

    expect(resolveHttpPoolKey("origin", req, url)).toBe("https://example.test:8443");
    expect(resolveHttpPoolKey("host", req, url)).toBe("example.test:8443");
    expect(resolveHttpPoolKey("global", req, url)).toBe("global");
    expect(resolveHttpPoolKey(() => " custom ", req, url)).toBe("custom");
    expect(resolveHttpPoolKey(() => "   ", req, url)).toBe("global");
    expect(resolveHttpPoolKey("origin", { ...req, poolKey: " forced " }, url)).toBe("forced");
  });

  it("queues, grants, times out, aborts, and reports JS pool stats", async () => {
    const pool = new HttpConcurrencyPool({ concurrency: 1, maxQueue: 2, queueTimeoutMs: 5 });
    const firstController = new AbortController();
    const first = await pool.acquire("api", firstController.signal);

    const secondController = new AbortController();
    const second = pool.acquire("api", secondController.signal);
    const thirdController = new AbortController();
    const third = pool.acquire("api", thirdController.signal);

    thirdController.abort();
    await expect(third).rejects.toEqual({ _tag: "Abort" });

    first.release();
    const secondLease = await second;
    secondLease.release();

    const timeoutPool = new HttpConcurrencyPool({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 1 });
    const held = await timeoutPool.acquire("slow", new AbortController().signal);
    await expect(timeoutPool.acquire("slow", new AbortController().signal)).rejects.toMatchObject({ _tag: "PoolTimeout" });
    held.release();

    const stats = pool.stats();
    expect(stats).toMatchObject({ running: 0, queued: 0, acquired: 2, released: 2, abortedWhileQueued: 1 });
    expect(stats.keys[0]).toMatchObject({ key: "api", concurrency: 1, maxQueue: 2 });
  });

  it("rejects immediately for already-aborted signals and full queues", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const pool = new HttpConcurrencyPool({ concurrency: 1, maxQueue: 0 });

    await expect(pool.acquire("api", aborted.signal)).rejects.toEqual({ _tag: "Abort" });
    const lease = await pool.acquire("api", new AbortController().signal);
    await expect(pool.acquire("api", new AbortController().signal)).rejects.toMatchObject({ _tag: "PoolRejected" });
    lease.release();
    lease.release();
  });
});
