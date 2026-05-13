import { describe, expect, it, vi } from "vitest";
import { async, asyncFail, asyncSucceed } from "../../core/types/asyncEffect";
import { Cause, Exit } from "../../core/types/effect";
import { Runtime } from "../../core/runtime/runtime";
import { s } from "../../schema";
import { AdaptiveLimiter } from "../adaptiveLimiter/adaptiveLimiter";
import { withRequestBatching } from "../batching";
import { httpClientBuilder } from "../builder";
import {
  makeHttp,
  normalizeHeadersInit,
  type HttpClientFn,
  type HttpMiddleware,
  type HttpTransport,
  type HttpWireResponse,
} from "../client";
import { makeLifecycleClient } from "../lifecycle/lifecycleClient";
import { HttpConcurrencyPool, resolveHttpPoolKey } from "../pool";
import {
  empty,
  json,
  makeHttpRouter,
  route,
  text,
  withResponseHeader,
  type HttpServerRequest,
} from "../server";

const rt = Runtime.make({});
const response = (status = 200): HttpWireResponse => ({
  status,
  statusText: status === 200 ? "OK" : "ERR",
  headers: {},
  bodyText: "body",
  ms: 1,
});
const serverRequest = (
  method: string,
  path: string,
  overrides: Partial<HttpServerRequest> = {},
): HttpServerRequest => ({
  method,
  url: `http://localhost${path}`,
  path,
  target: path,
  headers: { host: "localhost" },
  query: {},
  params: {},
  bodyText: "",
  ...overrides,
});

describe("HTTP branch coverage edges", () => {
  it("keeps fluent builder config immutable while covering merge defaults", () => {
    const mw: HttpMiddleware = (next) => (req) => next(req);

    const emptyConfigured = httpClientBuilder()
      .configure({ timeoutMs: 10 })
      .baseUrl("https://example.test")
      .config();

    expect(emptyConfigured).toMatchObject({
      baseUrl: "https://example.test",
      timeoutMs: 10,
      headers: {},
      middleware: [],
    });

    const withExisting = httpClientBuilder({ headers: { a: "1" }, middleware: [mw] })
      .header("b", "2")
      .headers({ c: "3" })
      .configure({ headers: { d: "4" }, middleware: [mw], timeoutMs: 20 })
      .timeout(30)
      .transport(() => asyncSucceed(response()))
      .minimal()
      .balanced()
      .defaultPreset()
      .production()
      .dedup()
      .noDedup()
      .batch(false)
      .cache()
      .noCache()
      .priority()
      .noPriority()
      .retry()
      .noRetry()
      .prewarm()
      .noPrewarm()
      .adaptiveLimiter()
      .adaptiveLimiterPreset("conservative")
      .conservativeLimiter()
      .balancedLimiter()
      .aggressiveLimiter()
      .noAdaptiveLimiter()
      .pool()
      .noPool()
      .compression()
      .noCompression()
      .middleware(mw)
      .use(mw)
      .config();

    expect(withExisting.headers).toEqual({ a: "1", b: "2", c: "3", d: "4" });
    expect(withExisting.middleware).toHaveLength(4);
    expect(withExisting.timeoutMs).toBe(30);
    expect(withExisting.preset).toBe("production");
    expect(withExisting.dedup).toBe(false);
    expect(withExisting.retry).toBe(false);
    expect(withExisting.compression).toBe(false);
  });

  it("normalizes header inputs and tracks transport failure stats", async () => {
    expect(normalizeHeadersInit(undefined)).toBeUndefined();
    expect(normalizeHeadersInit(new Headers([["x-a", "1"]]))).toEqual({ "x-a": "1" });
    expect(normalizeHeadersInit([["x-b", "2"]])).toEqual({ "x-b": "2" });
    expect(normalizeHeadersInit({ "x-c": "3" })).toEqual({ "x-c": "3" });
    expect(normalizeHeadersInit("bad")).toBeUndefined();

    const errors = [
      { _tag: "Abort" as const },
      { _tag: "Timeout" as const, timeoutMs: 1, message: "timeout" },
      { _tag: "PoolRejected" as const, key: "k", limit: 1, message: "full" },
      { _tag: "PoolTimeout" as const, key: "k", timeoutMs: 1, message: "queued" },
      { _tag: "FetchError" as const, message: "fetch" },
    ];

    for (const error of errors) {
      const http = makeHttp({
        baseUrl: "https://example.test",
        transport: () => asyncFail(error),
      });
      await expect(rt.toPromise(http({ method: "GET", url: "/" }))).rejects.toMatchObject(error);
      expect(http.stats().started).toBe(1);
    }

    const poolRejected = makeHttp({ baseUrl: "https://example.test", transport: () => asyncFail(errors[2]) });
    await expect(rt.toPromise(poolRejected({ method: "GET", url: "/" }))).rejects.toMatchObject(errors[2]);
    expect(poolRejected.stats()).toMatchObject({ failed: 1, poolRejected: 1 });

    const poolTimedOut = makeHttp({ baseUrl: "https://example.test", transport: () => asyncFail(errors[3]) });
    await expect(rt.toPromise(poolTimedOut({ method: "GET", url: "/" }))).rejects.toMatchObject(errors[3]);
    expect(poolTimedOut.stats()).toMatchObject({ failed: 1, poolTimeouts: 1 });

    const badUrl = makeHttp();
    await expect(rt.toPromise(badUrl({ method: "GET", url: "http://[" }))).rejects.toMatchObject({ _tag: "BadUrl" });
  });

  it("propagates abort and defect exits through custom transports", async () => {
    const abortController = new AbortController();
    abortController.abort(new Error("caller canceled"));
    const observedSignals: boolean[] = [];

    const abortTransport: HttpTransport = ({ signal }) => {
      observedSignals.push(signal.aborted);
      return async((_env, cb) => {
        cb(Exit.failCause(Cause.interrupt()));
      });
    };

    const aborting = makeHttp({ baseUrl: "https://example.test", transport: abortTransport });
    await expect(rt.toPromise(aborting({
      method: "GET",
      url: "/",
      init: { signal: abortController.signal },
    }))).rejects.toMatchObject({ _tag: "Abort" });
    expect(observedSignals).toEqual([]);

    const defectTransport: HttpTransport = () =>
      async((_env, cb) => {
        cb(Exit.failCause(Cause.die(new Error("transport died"))));
      });

    const defective = makeHttp({ baseUrl: "https://example.test", transport: defectTransport });
    await expect(rt.toPromise(defective({ method: "GET", url: "/" }))).rejects.toThrow(/transport died/);
  });

  it("covers adaptive limiter diagnostics, headroom strategies, priority queues, and shutdown edges", async () => {
    const limitChanges: unknown[] = [];
    const limiter = new AdaptiveLimiter({
      initialLimit: 1,
      minLimit: 1,
      maxLimit: 6,
      minSamples: 1,
      warmupRequests: 0,
      probeInterval: 2,
      probeJitterRatio: 0,
      headroomStrategy: { type: "proportional" },
      historySize: 2,
      baselineStrategy: "ema-low",
      windowDecayFactor: 0.5,
      percentile: "p99",
      onLimitChange: (event) => limitChanges.push(event),
    });

    const first = await limiter.acquire("a", new AbortController().signal, { priority: Number.POSITIVE_INFINITY });
    first.release(10);
    const second = await limiter.acquire("b", new AbortController().signal);
    second.release(20, { status: 503 });

    expect(limiter.stats().stateCount).toBe(2);
    expect(limiter.stats("missing")).toMatchObject({ inFlight: 0, queueDepth: 0 });
    expect(limiter.keys().sort()).toEqual(["a", "b"]);
    expect(limiter.snapshot("missing")).toBeUndefined();
    expect(limiter.dump().states).toHaveLength(2);
    expect(limiter.history("missing")).toEqual([]);
    expect(limitChanges.length).toBeGreaterThan(0);

    const fixedDefault = new AdaptiveLimiter({
      initialLimit: 1,
      maxLimit: 3,
      minSamples: 1,
      warmupRequests: 0,
      headroomStrategy: { type: "fixed" },
      historySize: 0,
    });
    const fixedLease = await fixedDefault.acquire("fixed", new AbortController().signal);
    fixedLease.release(10);
    expect(fixedDefault.history()).toEqual([]);

    const invalidHeadroom = new AdaptiveLimiter({
      initialLimit: 1,
      maxLimit: 3,
      minSamples: 1,
      warmupRequests: 0,
      headroomStrategy: () => Number.NaN,
    });
    const invalidLease = await invalidHeadroom.acquire("nan", new AbortController().signal);
    invalidLease.release(10);
    expect(invalidHeadroom.stats("nan").limit).toBeGreaterThanOrEqual(1);

    const priority = new AdaptiveLimiter({
      initialLimit: 1,
      maxQueue: 2,
      queueStrategy: "priority",
      queueTimeoutMs: 1_000,
    });
    const occupied = await priority.acquire("q", new AbortController().signal);
    const lower = priority.acquire("q", new AbortController().signal, { priority: 8 });
    const higher = priority.acquire("q", new AbortController().signal, { priority: 1 });
    occupied.release(1);
    const highLease = await higher;
    highLease.release(1);
    const lowLease = await lower;
    lowLease.release(1);
    expect(priority.snapshot("q")?.acquired).toBe(3);

    const evicting = new AdaptiveLimiter({
      initialLimit: 1,
      maxQueue: 1,
      queueStrategy: "priority",
      queueLoadShedding: "priority-evict",
      rejectionBackoffMs: 50,
      rejectionBackoffThreshold: 1,
    });
    const slot = await evicting.acquire("e", new AbortController().signal);
    const low = evicting.acquire("e", new AbortController().signal, { priority: 9 }).catch((error) => error);
    const high = evicting.acquire("e", new AbortController().signal, { priority: 0 });
    await expect(low).resolves.toMatchObject({ _tag: "PoolRejected", retryAfterMs: 50 });
    slot.release(1);
    const evictedWinner = await high;
    evictedWinner.release(1);
    expect(evicting.snapshot("e")?.evictedWhileQueued).toBe(1);

    const destroyed = new AdaptiveLimiter({ initialLimit: 2, minLimit: 1, historySize: 0 });
    destroyed.destroy();
    destroyed.destroy();
    destroyed.markCircuitOpen("closed");
    await expect(destroyed.acquire("closed", new AbortController().signal)).rejects.toMatchObject({ _tag: "PoolClosed" });
  });

  it("covers adaptive limiter private queue and diagnostic guard branches", () => {
    const limiter = new AdaptiveLimiter({
      initialLimit: 1,
      maxQueue: 4,
      queueStrategy: "priority",
      queueLoadShedding: "priority-evict",
      rejectionBackoffMs: 10,
      rejectionBackoffThreshold: 1,
    });
    const state = (limiter as any).getOrCreateState("private");

    expect((limiter as any).dequeueWaiter(state)).toBeUndefined();
    state.limit = 0;
    expect((limiter as any).stateToStats(state).utilization).toBe(0);

    const signal = new AbortController().signal;
    const waiters = [
      { signal, priority: 5, arrivalOrder: 0, resolve: vi.fn(), reject: vi.fn() },
      { signal, priority: 5, arrivalOrder: 1, resolve: vi.fn(), reject: vi.fn() },
      { signal, priority: 1, arrivalOrder: 2, resolve: vi.fn(), reject: vi.fn() },
    ];
    state.queue.push(...waiters);
    expect((limiter as any).dequeueWaiter(state)).toBe(waiters[2]);
    expect((limiter as any).dequeueWaiter(state)).toBe(waiters[0]);

    const evictState = (limiter as any).getOrCreateState("evict");
    const evicted = { signal, priority: 9, arrivalOrder: 0, resolve: vi.fn(), reject: vi.fn(), abort: vi.fn() };
    const newestWorst = { signal, priority: 9, arrivalOrder: 1, resolve: vi.fn(), reject: vi.fn(), abort: vi.fn() };
    evictState.queue.push(evicted, newestWorst);
    expect((limiter as any).tryEvictLowerPriorityWaiter(evictState, 0)).toBe(true);
    expect(newestWorst.reject).toHaveBeenCalledWith(expect.objectContaining({ _tag: "PoolRejected", retryAfterMs: 10 }));

    const rejectNew = new AdaptiveLimiter({ queueLoadShedding: "reject-new" });
    const rejectState = (rejectNew as any).getOrCreateState("reject");
    rejectState.queue.push({ signal, priority: 1, arrivalOrder: 0, resolve: vi.fn(), reject: vi.fn() });
    expect((rejectNew as any).tryEvictLowerPriorityWaiter(rejectState, 0)).toBe(false);

    expect((limiter as any).removeWaiter(state, { signal })).toBeUndefined();
    expect((limiter as any).cleanupWaiter({ signal })).toBeUndefined();

    const leaseState = (limiter as any).getOrCreateState("lease");
    leaseState.inFlight = 1;
    const lease = (limiter as any).makeLease(leaseState);
    lease.release(Number.NaN);
    lease.release(1);
    expect(leaseState.released).toBe(1);
  });

  it("covers request batching bypass, encode/decode errors, interrupts, and cancellation", async () => {
    const nextCalls: string[] = [];
    const next: HttpClientFn = (req) => {
      nextCalls.push(req.url);
      return asyncSucceed(response(299));
    };
    const encode = (requests: readonly Parameters<HttpClientFn>[0][]) => ({
      method: "POST" as const,
      url: "/batch",
      body: JSON.stringify(requests.map((req) => req.url)),
    });
    const decode = (_res: HttpWireResponse, requests: readonly Parameters<HttpClientFn>[0][]) =>
      requests.map(() => response(200));

    const shouldBypass = withRequestBatching({ shouldBatch: () => false, key: () => "k", encode, decode })(next);
    await expect(rt.toPromise(shouldBypass({ method: "GET", url: "/skip" }))).resolves.toMatchObject({ status: 299 });

    const noKey = withRequestBatching({ key: () => null, encode, decode })(next);
    await expect(rt.toPromise(noKey({ method: "GET", url: "/no-key" }))).resolves.toMatchObject({ status: 299 });

    const throwingKey = withRequestBatching({ key: () => { throw new Error("key"); }, encode, decode })(next);
    await expect(rt.toPromise(throwingKey({ method: "GET", url: "/key-error" }))).resolves.toMatchObject({ status: 299 });
    expect(nextCalls).toEqual(["/skip", "/no-key", "/key-error"]);

    const events: string[] = [];
    const timerFlush = withRequestBatching({
      encode,
      decode,
      onEvent: (event) => {
        events.push(event.type);
        throw new Error("observer");
      },
    })(() => asyncSucceed(response(200)));
    await expect(rt.toPromise(timerFlush({ method: "GET", url: "/timer" }))).resolves.toMatchObject({ status: 200 });
    expect(events).toContain("batch-flush");

    const encodeFailure = withRequestBatching({
      maxBatchSize: 1,
      encode: () => { throw new Error("encode failed"); },
      decode,
    })(next);
    await expect(rt.toPromise(encodeFailure({ method: "GET", url: "/encode" }))).rejects.toMatchObject({
      _tag: "FetchError",
      message: "encode failed",
    });

    const decodeFailure = withRequestBatching({
      maxBatchSize: 1,
      encode,
      decode: () => [],
    })(() => asyncSucceed(response(200)));
    await expect(rt.toPromise(decodeFailure({ method: "GET", url: "/decode" }))).rejects.toMatchObject({
      _tag: "FetchError",
    });

    const interrupted = withRequestBatching({ maxBatchSize: 1, encode, decode })(() =>
      async((_env, cb) => cb(Exit.failCause(Cause.interrupt()))));
    await expect(rt.toPromise(interrupted({ method: "GET", url: "/interrupt" }))).rejects.toMatchObject({ _tag: "Abort" });

    const queued = withRequestBatching({ maxWaitMs: 100, encode, decode })(next);
    const exits: unknown[] = [];
    const cancel = queued({ method: "GET", url: "/cancel" }).register(undefined, (exit) => exits.push(exit));
    cancel?.();
    expect(exits).toMatchObject([{ _tag: "Failure" }]);
  });

  it("covers pool key resolution, queue timeout, aborted waiters, rejection, and release idempotence", async () => {
    const url = new URL("https://api.example.test:8443/users");
    expect(resolveHttpPoolKey(undefined, { method: "GET", url: "/", policy: { poolKey: " custom " } }, url)).toBe("custom");
    expect(resolveHttpPoolKey(() => "   ", { method: "GET", url: "/" }, url)).toBe("global");
    expect(resolveHttpPoolKey("global", { method: "GET", url: "/" }, url)).toBe("global");
    expect(resolveHttpPoolKey("host", { method: "GET", url: "/" }, url)).toBe("api.example.test:8443");
    expect(resolveHttpPoolKey("origin", { method: "GET", url: "/" }, url)).toBe("https://api.example.test:8443");

    const aborted = new AbortController();
    aborted.abort();
    await expect(new HttpConcurrencyPool().acquire("a", aborted.signal)).rejects.toMatchObject({ _tag: "Abort" });

    const full = new HttpConcurrencyPool({ concurrency: 1, maxQueue: 0 });
    const fullLease = await full.acquire("full", new AbortController().signal);
    await expect(full.acquire("full", new AbortController().signal)).rejects.toMatchObject({ _tag: "PoolRejected" });
    fullLease.release();
    fullLease.release();
    expect(full.stats()).toMatchObject({ released: 1, rejected: 1 });

    const pool = new HttpConcurrencyPool({ concurrency: 1, maxQueue: 2, queueTimeoutMs: 0 });
    const lease = await pool.acquire("queued", new AbortController().signal);
    const fakeSignal = {
      aborted: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal & { aborted: boolean };
    const queued = pool.acquire("queued", fakeSignal);
    fakeSignal.aborted = true;
    lease.release();
    await expect(queued).rejects.toMatchObject({ _tag: "Abort" });
    expect(pool.stats()).toMatchObject({ abortedWhileQueued: 1 });

    const timeoutPool = new HttpConcurrencyPool({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 1 });
    const timeoutLease = await timeoutPool.acquire("timeout", new AbortController().signal);
    await expect(timeoutPool.acquire("timeout", new AbortController().signal)).rejects.toMatchObject({ _tag: "PoolTimeout" });
    timeoutLease.release();
    expect(timeoutPool.stats()).toMatchObject({ queueTimeouts: 1 });
  });

  it("covers router validation, path matching, middleware, and server response helpers", async () => {
    const router = makeHttpRouter([
      route("GET", "", () => asyncSucceed(text("root"))),
      route("GET", "users/:id", { params: s.object({ id: s.number() }) }, () => asyncSucceed(json({ ok: true }))),
      route("GET", "/query", { query: s.object({ page: s.number() }) }, () => asyncSucceed(json({ ok: true }))),
      route("POST", "/body", { body: s.object({ name: s.string() }) }, ({ body }) => asyncSucceed(json({ body }))),
      route("GET", "/response", { response: s.object({ ok: s.literal(true) }) }, () => asyncSucceed(json({ ok: false }))),
      route("GET", "/throw", () => {
        throw new Error("handler failed");
      }),
      route("ALL", "/files/*", ({ params }) => asyncSucceed(json(params))),
      route("GET", "/bytes", () => asyncSucceed({ body: new Uint8Array([1, 2]) })),
      route("GET", "/buffer", () => asyncSucceed({ body: new Uint8Array([3, 4]).buffer })),
      route("GET", "/empty", () => asyncSucceed(empty(304))),
    ], {
      includeErrorDetails: true,
      middleware: [withResponseHeader("x-global", "1")],
    });

    await expect(rt.toPromise(router.handle(serverRequest("GET", "/")))).resolves.toMatchObject({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "x-global": "1" },
    });
    await expect(rt.toPromise(router.handle(serverRequest("GET", "/missing")))).resolves.toMatchObject({ status: 404 });
    await expect(rt.toPromise(router.handle(serverRequest("POST", "/query")))).resolves.toMatchObject({
      status: 405,
      headers: { allow: "GET", "content-type": "application/json" },
    });
    await expect(rt.toPromise(router.handle(serverRequest("GET", "/users/abc")))).resolves.toMatchObject({ status: 400 });
    await expect(rt.toPromise(router.handle(serverRequest("GET", "/query", { query: { page: "x" } })))).resolves.toMatchObject({ status: 400 });
    await expect(rt.toPromise(router.handle(serverRequest("POST", "/body", { bodyText: "{" })))).resolves.toMatchObject({ status: 400 });
    await expect(rt.toPromise(router.handle(serverRequest("POST", "/body", { bodyText: JSON.stringify({ name: 1 }) })))).resolves.toMatchObject({ status: 400 });
    await expect(rt.toPromise(router.handle(serverRequest("GET", "/response")))).resolves.toMatchObject({ status: 500 });
    await expect(rt.toPromise(router.handle(serverRequest("GET", "/throw")))).resolves.toMatchObject({
      status: 500,
      body: expect.objectContaining({ message: "handler failed" }),
    });
    await expect(rt.toPromise(router.handle(serverRequest("GET", "/files/%E0%A4%A")))).resolves.toMatchObject({
      body: { "*": "%E0%A4%A" },
    });
    await expect(rt.toPromise(router.handle(serverRequest("GET", "/bytes")))).resolves.toMatchObject({
      body: new Uint8Array([1, 2]),
    });
    await expect(rt.toPromise(router.handle(serverRequest("GET", "/buffer")))).resolves.toMatchObject({
      body: expect.any(ArrayBuffer),
    });
    await expect(rt.toPromise(router.handle(serverRequest("GET", "/empty")))).resolves.toMatchObject({ status: 304 });
  });

  it("tracks lifecycle cancellation and user middleware metadata", async () => {
    const transport: HttpTransport = ({ signal }) =>
      async((_env, cb) => {
        if (signal.aborted) {
          cb(Exit.failCause(Cause.interrupt()));
          return;
        }
        cb({ _tag: "Success", value: response() });
      });

    const previous = new AbortController();
    previous.abort();
    const lifecycle = makeLifecycleClient({ baseUrl: "https://example.test", transport });
    await expect(rt.toPromise(lifecycle({
      method: "GET",
      url: "/",
      init: { signal: previous.signal },
    }))).rejects.toMatchObject({ _tag: "Abort" });
    expect(lifecycle.stats()).toMatchObject({ requestsFailed: 1 });

    const withLimiter = makeLifecycleClient({
      baseUrl: "https://example.test",
      transport,
      adaptiveLimiter: { initialLimit: 1 },
    });
    const seenLimiter: boolean[] = [];
    const wrapped = withLimiter.with((next: HttpClientFn) => {
      seenLimiter.push(Boolean((next as any).adaptiveLimiter));
      return (req) => next(req);
    });

    await expect(rt.toPromise(wrapped({ method: "GET", url: "/" }))).resolves.toMatchObject({ status: 200 });
    expect(seenLimiter).toEqual([true]);
    await rt.toPromise(wrapped.shutdown());
  });
});
