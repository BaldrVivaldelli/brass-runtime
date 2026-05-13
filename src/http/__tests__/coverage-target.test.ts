import { afterEach, describe, expect, it, vi } from "vitest";

import { async, asyncFail, asyncFlatMap, asyncFold, asyncSucceed, asyncSync } from "../../core/types/asyncEffect";
import { Cause, Exit } from "../../core/types/effect";
import {
  decodeJsonBody,
  decodeJsonBodyEffect,
  encodeJsonBodyEffect,
  formatHttpError,
  httpErrorStatus,
  httpClientBuilder,
  isAbortHttpError,
  isCircuitBreakerOpen,
  isExternalAbortError,
  isExternalTimeoutError,
  isFetchHttpError,
  isHttpError,
  isKnownHttpError,
  isRetryableHttpError,
  isRetryableHttpStatus,
  isTimeoutHttpError,
  isValidationError,
  makeDefaultHttpClient,
  makeHttpRouter,
  matchHttpError,
  route,
  s,
  toHttpError,
  validatedJsonResponse,
  withCircuitBreaker,
} from "../index";
import type { HttpError } from "../client";
import { registerHttpEffect } from "../effectRunner";
import { withBatch } from "../lifecycle/batch";
import { executeProbe } from "../prewarm/probe";
import { detectPlatform, validateFetchAvailable } from "../prewarm/platform";
import {
  installMockFetch,
  makeFetchResponse,
  makeHttpResponse,
  makeJsonFetchResponse,
  makeJsonHttpResponse,
  makeMockHttpClient,
  makeSequenceHttpClient,
  makeTextHttpResponse,
  runHttpEffect,
  withMockFetch,
} from "../testing";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HTTP coverage target helpers", () => {
  it("covers builder config methods without building the network client", () => {
    const first = (next: any) => next;
    const second = (next: any) => next;

    const builder = httpClientBuilder({
      headers: { accept: "application/json" },
      middleware: [first],
    })
      .baseUrl("https://api.example.test")
      .headers({ authorization: "Bearer token" })
      .header("x-one", "1")
      .timeout(123)
      .timeoutMs(456)
      .preset("minimal")
      .minimal()
      .balanced()
      .defaultPreset()
      .production()
      .dedup({ key: () => "dedup" })
      .noDedup()
      .batch(false)
      .noBatch()
      .cache({ ttlSeconds: 1, maxEntries: 2 })
      .noCache()
      .priority({ concurrency: 2 })
      .noPriority()
      .retry({ maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 })
      .noRetry()
      .prewarm({ urls: ["/health"] })
      .noPrewarm()
      .adaptiveLimiter({ initialLimit: 3 })
      .adaptiveLimiterPreset("balanced", { maxLimit: 10 })
      .conservativeLimiter()
      .balancedLimiter()
      .aggressiveLimiter()
      .noAdaptiveLimiter()
      .pool({ max: 2 })
      .noPool()
      .compression({ request: { enabled: false } })
      .noCompression()
      .middleware(second)
      .use(first)
      .configure({
        baseUrl: "https://merged.example.test",
        headers: { "x-two": "2" },
        middleware: [second],
        preset: "minimal",
      });

    const config = builder.config();
    expect(config).toMatchObject({
      baseUrl: "https://merged.example.test",
      timeoutMs: 456,
      preset: "minimal",
      dedup: false,
      batch: false,
      cache: false,
      priority: false,
      retry: false,
      prewarm: false,
      adaptiveLimiter: false,
      pool: false,
      compression: false,
    });
    expect(config.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer token",
      "x-one": "1",
      "x-two": "2",
    });
    expect(config.middleware).toHaveLength(4);

    const frozen = builder.config();
    (frozen.headers as Record<string, string>).accept = "mutated";
    expect(builder.config().headers?.accept).toBe("application/json");
  });

  it("covers mock HTTP clients, sequences, reset, async handlers, and thrown errors", async () => {
    expect(makeHttpResponse("body", { status: 202, statusText: "Accepted", headers: { a: "b" }, ms: 5 }))
      .toMatchObject({ status: 202, statusText: "Accepted", headers: { a: "b" }, bodyText: "body", ms: 5 });
    expect(makeTextHttpResponse("text").bodyText).toBe("text");
    expect(makeJsonHttpResponse({ ok: true }).headers["content-type"]).toBe("application/json");

    const asyncClient = makeMockHttpClient((req, index) =>
      index === 0
        ? asyncSucceed(makeHttpResponse(req.url))
        : asyncFail({ _tag: "Timeout", timeoutMs: 1, message: "slow" } satisfies HttpError)
    );
    await expect(runHttpEffect(asyncClient({ method: "GET", url: "/one" }))).resolves.toMatchObject({ bodyText: "/one" });
    await expect(runHttpEffect(asyncClient({ method: "GET", url: "/two" }))).rejects.toMatchObject({ _tag: "Timeout" });
    expect(asyncClient.stats().started).toBe(2);
    expect(asyncClient.stats().succeeded).toBe(0);

    const throwing = makeMockHttpClient(() => {
      throw new Error("boom");
    });
    await expect(runHttpEffect(throwing({ method: "GET", url: "/boom" }))).rejects.toMatchObject({
      _tag: "FetchError",
      message: "boom",
    });
    expect(throwing.stats().failed).toBe(1);
    throwing.reset();
    expect(throwing.calledTimes()).toBe(0);
    expect(throwing.stats()).toMatchObject({ started: 0, failed: 0 });

    const tagged = makeMockHttpClient(() => {
      throw { _tag: "PoolClosed", key: "api", message: "closed" };
    });
    await expect(runHttpEffect(tagged({ method: "GET", url: "/closed" }))).rejects.toMatchObject({ _tag: "PoolClosed" });

    const sequence = makeSequenceHttpClient([
      makeHttpResponse("first"),
    ], makeHttpResponse("fallback"));
    await expect(runHttpEffect(sequence({ method: "GET", url: "/a" }))).resolves.toMatchObject({ bodyText: "first" });
    await expect(runHttpEffect(sequence({ method: "GET", url: "/b" }))).resolves.toMatchObject({ bodyText: "fallback" });
  });

  it("covers fetch mock helpers and restore branches", async () => {
    const originalFetch = globalThis.fetch;
    Reflect.deleteProperty(globalThis, "fetch");

    const controller = installMockFetch(async (_input, _init, index) =>
      makeJsonFetchResponse({ index }, { status: 201 })
    );
    const response = await controller.fetch("https://api.example.test", { method: "POST" });
    await expect(response.json()).resolves.toEqual({ index: 0 });
    expect(response.status).toBe(201);
    expect(controller.calledTimes()).toBe(1);
    expect(controller.lastCall()?.init?.method).toBe("POST");
    controller.restore();
    expect("fetch" in globalThis).toBe(false);

    if (originalFetch) globalThis.fetch = originalFetch;

    await withMockFetch(async (_input, _init, index) => makeFetchResponse(String(index)), async (mock) => {
      const res = await fetch("https://api.example.test");
      await expect(res.text()).resolves.toBe("0");
      expect(mock.calls()).toHaveLength(1);
    });
    expect(globalThis.fetch).toBe(originalFetch);

    const ResponseCtor = globalThis.Response;
    vi.stubGlobal("Response", undefined);
    expect(() => makeFetchResponse("nope")).toThrow("global Response");
    vi.stubGlobal("Response", ResponseCtor);
  });

  it("covers validation success, legacy validators, JSON parse failures, and serialization failures", async () => {
    expect(decodeJsonBody("{bad")).toMatchObject({
      success: false,
      error: { phase: "response", schema: undefined },
    });
    expect(decodeJsonBody("{\"ok\":true}", (value): any =>
      typeof value === "object" && value !== null && (value as any).ok === true
        ? { success: true, data: value }
        : { success: false, error: "not ok" }
    )).toMatchObject({ success: true, data: { ok: true } });
    expect(decodeJsonBody("{}", () => ({ success: false, error: "bad legacy" }))).toMatchObject({
      success: false,
      error: { message: "bad legacy" },
    });
    expect(decodeJsonBody("{}", () => ({
      success: false,
      error: "bad legacy",
      issues: [{ path: ["ok"], expected: "true", received: "undefined", message: "missing ok" }],
    }))).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ path: ["ok"] })] },
    });

    await expect(runHttpEffect(decodeJsonBodyEffect("{bad"))).rejects.toMatchObject({ _tag: "ValidationError" });
    await expect(runHttpEffect(encodeJsonBodyEffect({ ok: "" }, s.object({ ok: s.nonEmptyString() })))).rejects.toMatchObject({
      _tag: "ValidationError",
      phase: "request",
    });
    const circular: any = {};
    circular.self = circular;
    await expect(runHttpEffect(encodeJsonBodyEffect(circular))).rejects.toMatchObject({
      _tag: "ValidationError",
      message: expect.stringContaining("could not be serialized"),
    });
    await expect(runHttpEffect(encodeJsonBodyEffect(circular, s.object({ ok: s.boolean() })))).rejects.toMatchObject({
      _tag: "ValidationError",
      body: "[unserializable]",
    });

    const okClient = makeMockHttpClient(() => makeJsonHttpResponse({ ok: true }));
    await expect(runHttpEffect(validatedJsonResponse(okClient, s.object({ ok: s.boolean() }))({
      method: "GET",
      url: "/ok",
    }))).resolves.toMatchObject({
      status: 200,
      body: { ok: true },
    });
    const failClient = makeMockHttpClient(() => asyncFail({ _tag: "Abort" } as HttpError));
    await expect(runHttpEffect(validatedJsonResponse(failClient, s.object({ ok: s.boolean() }))({
      method: "GET",
      url: "/abort",
    }))).rejects.toMatchObject({ _tag: "Abort" });
  });

  it("covers HTTP error formatting branches and unknown tagged objects", () => {
    expect(isHttpError({ _tag: "Nope" })).toBe(false);
    expect(formatHttpError({ _tag: "ValidationError", phase: "request", message: "bad", body: "", issues: [] }))
      .toBe("request validation failed: bad");
    expect(formatHttpError({ _tag: "CircuitBreakerOpen", openSince: 1, failures: 3 }))
      .toBe("Circuit breaker is open after 3 failure(s)");
    expect(formatHttpError(new Error("plain"))).toBe("plain");
    expect(formatHttpError({ _tag: "Abort" })).toBe("HTTP request aborted");
    expect(formatHttpError({ _tag: "BadUrl", message: "bad url" })).toBe("bad url");
    expect(formatHttpError({ _tag: "FetchError", message: "fetch bad" })).toBe("fetch bad");
    expect(formatHttpError({ _tag: "PoolRejected", key: "api", limit: 1, message: "rejected" })).toBe("rejected");
    expect(formatHttpError({ _tag: "PoolTimeout", key: "api", timeoutMs: 1, message: "pool timeout" })).toBe("pool timeout");
    expect(formatHttpError({ _tag: "BatchSplitError", expected: 2, actual: 1, message: "split bad" })).toBe("split bad");
    expect(formatHttpError({ _tag: "Timeout", timeoutMs: 1, message: "timeout" })).toBe("timeout");
  });

  it("covers HTTP error classification, retryability, and external normalization", () => {
    const abort = { _tag: "Abort" } as const;
    const timeout = { _tag: "Timeout", timeoutMs: 10, phase: "request", message: "slow" } as const;
    const poolTimeout = { _tag: "PoolTimeout", key: "api", timeoutMs: 5, message: "queued" } as const;
    const fetchError = { _tag: "FetchError", message: "upstream", status: 503, statusText: "Unavailable" } as const;
    const validation = { _tag: "ValidationError", phase: "response", message: "bad", body: "{}", issues: [] } as const;
    const circuit = { _tag: "CircuitBreakerOpen", openSince: 1, failures: 2 } as const;

    expect(isKnownHttpError(fetchError)).toBe(true);
    expect(isValidationError(validation)).toBe(true);
    expect(isCircuitBreakerOpen(circuit)).toBe(true);
    expect(isAbortHttpError(abort)).toBe(true);
    expect(isAbortHttpError(timeout)).toBe(false);
    expect(isTimeoutHttpError(timeout)).toBe(true);
    expect(isTimeoutHttpError(poolTimeout)).toBe(true);
    expect(isFetchHttpError(fetchError)).toBe(true);
    expect(httpErrorStatus(fetchError)).toBe(503);
    expect(httpErrorStatus({ _tag: "FetchError", message: "bad", status: Number.NaN })).toBeUndefined();
    expect(httpErrorStatus(timeout)).toBeUndefined();

    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(418)).toBe(false);
    expect(isRetryableHttpError(timeout)).toBe(true);
    expect(isRetryableHttpError(poolTimeout)).toBe(true);
    expect(isRetryableHttpError(fetchError)).toBe(true);
    expect(isRetryableHttpError({ _tag: "FetchError", message: "conflict", status: 409 })).toBe(false);
    expect(isRetryableHttpError({ _tag: "FetchError", message: "network" })).toBe(true);
    expect(isRetryableHttpError(fetchError, { retryOnStatus: (status) => status === 599 })).toBe(false);
    expect(isRetryableHttpError(abort)).toBe(false);
    expect(isRetryableHttpError("plain")).toBe(false);

    expect(isExternalAbortError({ name: "AbortError" })).toBe(true);
    expect(isExternalAbortError({ code: "ERR_CANCELED" })).toBe(true);
    expect(isExternalAbortError(null)).toBe(false);
    expect(isExternalTimeoutError({ name: "TimeoutError" })).toBe(true);
    expect(isExternalTimeoutError({ code: "UND_ERR_HEADERS_TIMEOUT" })).toBe(true);
    expect(isExternalTimeoutError("plain")).toBe(false);

    expect(toHttpError(fetchError)).toBe(fetchError);

    const aborted = new AbortController();
    aborted.abort();
    expect(toHttpError(new Error("ignored"), { signal: aborted.signal })).toEqual({ _tag: "Abort" });
    expect(toHttpError({ code: "ERR_CANCELED", message: "cancelled" })).toEqual({ _tag: "Abort" });

    expect(toHttpError({ code: "ETIMEDOUT", message: "timeout" }, { timeoutMs: 123, phase: "retry" }))
      .toEqual({ _tag: "Timeout", timeoutMs: 123, phase: "retry", message: "timeout" });
    expect(toHttpError({ name: "TimeoutError" }, { message: () => "custom timeout" }))
      .toMatchObject({ _tag: "Timeout", message: "custom timeout" });

    const retryAfterDate = new Date(Date.now() + 60_000).toUTCString();
    expect(toHttpError({
      code: "ECONNRESET",
      message: "reset",
      response: {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "2" },
      },
    })).toMatchObject({
      _tag: "FetchError",
      code: "ECONNRESET",
      status: 429,
      statusText: "Too Many Requests",
      retryAfterMs: 2000,
    });
    expect(toHttpError({
      statusCode: 502,
      statusMessage: "Bad Gateway",
      headers: { "Retry-After": retryAfterDate },
      message: "",
    })).toMatchObject({
      _tag: "FetchError",
      status: 502,
      statusText: "Bad Gateway",
      retryAfterMs: expect.any(Number),
    });
    expect(toHttpError({ status: Number.NaN, code: "", message: "plain" }, { message: "override" }))
      .toMatchObject({ _tag: "FetchError", message: "override" });
    expect(toHttpError({ message: "record message" })).toMatchObject({ message: "record message" });
    expect(toHttpError("string error")).toMatchObject({ message: "string error" });

    expect(matchHttpError(fetchError, {
      FetchError: (error) => `fetch:${error.status}`,
    })).toBe("fetch:503");
    expect(matchHttpError(validation, {
      ValidationError: (error) => error.phase,
    })).toBe("response");
    expect(matchHttpError(circuit, {
      CircuitBreakerOpen: (error) => error.failures,
    })).toBe(2);
    expect(matchHttpError("plain", {
      default: (error) => String(error),
    })).toBe("plain");
    expect(matchHttpError("plain", {})).toBeUndefined();

    expect(formatHttpError(fetchError)).toBe("HTTP 503 Unavailable: upstream");
    expect(formatHttpError({ _tag: "FetchError", message: "upstream", status: 500 })).toBe("HTTP 500: upstream");
  });

  it("covers router errors, includeErrorDetails, wildcard routes, invalid JSON, and response encoding", async () => {
    const detailed = makeHttpRouter([
      route("ALL", "/files/*", () => asyncSucceed({ status: 204, body: { ignored: true } })),
      route("POST", "/json", { body: s.object({ ok: s.boolean() }) }, () => asyncSucceed({ ok: true })),
      route("GET", "/throws", () => {
        throw new Error("sync boom");
      }),
      route("GET", "/fails", () => asyncFail("effect boom")),
      route("GET", "/buffer", () => asyncSucceed({ body: new Uint8Array([1, 2, 3]) })),
      route("GET", "/array-buffer", () => asyncSucceed({ body: new Uint8Array([4, 5]).buffer })),
      route("GET", "/text", () => asyncSucceed("plain")),
    ], { includeErrorDetails: true });

    await expect(runHttpEffect(detailed.handle({
      method: "GET",
      url: "http://local/files/a/b",
      path: "/files/a/b",
      target: "/files/a/b",
      headers: {},
      query: {},
      params: {},
      bodyText: "",
    }))).resolves.toMatchObject({ status: 204 });
    await expect(runHttpEffect(detailed.handle({
      method: "POST",
      url: "http://local/json",
      path: "/json",
      target: "/json",
      headers: {},
      query: {},
      params: {},
      bodyText: "{bad",
    }))).resolves.toMatchObject({
      status: 400,
      body: { error: "Request validation failed", schema: "body" },
    });
    await expect(runHttpEffect(detailed.handle({
      method: "GET",
      url: "http://local/throws",
      path: "/throws",
      target: "/throws",
      headers: {},
      query: {},
      params: {},
      bodyText: "",
    }))).resolves.toMatchObject({
      status: 500,
      body: { error: "Internal Server Error", message: "sync boom" },
    });
    await expect(runHttpEffect(detailed.handle({
      method: "GET",
      url: "http://local/fails",
      path: "/fails",
      target: "/fails",
      headers: {},
      query: {},
      params: {},
      bodyText: "",
    }))).resolves.toMatchObject({
      status: 500,
      body: { error: "Internal Server Error", message: "effect boom" },
    });
    await expect(runHttpEffect(detailed.handle({
      method: "GET",
      url: "http://local/text",
      path: "/text",
      target: "/text",
      headers: {},
      query: {},
      params: {},
      bodyText: "",
    }))).resolves.toMatchObject({ status: 200, body: "plain" });
    await expect(runHttpEffect(detailed.handle({
      method: "GET",
      url: "http://local/buffer",
      path: "/buffer",
      target: "/buffer",
      headers: {},
      query: {},
      params: {},
      bodyText: "",
    }))).resolves.toMatchObject({ status: 200, body: new Uint8Array([1, 2, 3]) });
    await expect(runHttpEffect(detailed.handle({
      method: "GET",
      url: "http://local/array-buffer",
      path: "/array-buffer",
      target: "/array-buffer",
      headers: {},
      query: {},
      params: {},
      bodyText: "",
    }))).resolves.toMatchObject({ status: 200 });

    expect(() => route("GET", "/missing", {} as any)).toThrow("Missing handler");
    const slash = makeHttpRouter([route("GET", "", () => asyncSucceed({ ok: true }))]);
    expect(slash.match("GET", "/")).toMatchObject({ _tag: "Match" });
    expect(slash.match("GET", "/x")).toMatchObject({ _tag: "NotFound" });
  });

  it("covers default client helpers, merge branches, and middleware wrapping", async () => {
    const fetchMock = vi.fn(async (_input, init?: RequestInit) =>
      new Response(init?.method === "POST" ? "posted" : JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": init?.method === "POST" ? "text/plain" : "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
      preset: "default",
      headers: { "x-base": "1" },
      cache: { ttlSeconds: 5 },
      retry: { maxRetries: 0 },
      adaptiveLimiter: { maxLimit: 9 },
      compression: false,
    });
    const wrapped = client.with((next) => (req) =>
      next({ ...req, headers: { ...(req.headers ?? {}), "x-wrapped": "1" } })
    );

    await expect(wrapped.request({ method: "GET", url: "/raw" }).unsafeRunPromise()).resolves.toMatchObject({ status: 200 });
    await expect(wrapped.get("/json").unsafeRunPromise()).resolves.toMatchObject({ status: 200 });
    await expect(wrapped.getText("/text").unsafeRunPromise()).resolves.toMatchObject({ body: expect.any(String) });
    await expect(wrapped.post("/post", "hello", { headers: new Headers({ "x-post": "1" }) }).unsafeRunPromise())
      .resolves.toMatchObject({ bodyText: "posted" });

    expect(wrapped.features).toMatchObject({
      cache: true,
      retry: true,
      adaptiveLimiter: true,
      middleware: 1,
      compression: false,
    });
    expect(wrapped.wire.adaptiveLimiter?.stats().limit).toBe(9);
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({
      headers: expect.objectContaining({ "x-base": "1", "x-wrapped": "1", "x-post": "1" }),
    });
    wrapped.cancelAll("test");
    wrapped.shutdown();

    const disabledLimiter = makeDefaultHttpClient({
      preset: "balanced",
      adaptiveLimiter: false,
      priority: false,
      compression: false,
    });
    expect(disabledLimiter.features).toMatchObject({ adaptiveLimiter: false, priority: false });
  });

  it("covers HTTP circuit breaker limiter key resolution and error paths", async () => {
    const marked: string[] = [];
    const limiter = {
      keyResolver: "host" as const,
      markCircuitOpen: (key: string) => marked.push(key),
    };
    let calls = 0;
    const unstable = makeMockHttpClient(() => {
      calls++;
      return calls === 1
        ? asyncFail({ _tag: "FetchError", message: "down" } as HttpError)
        : asyncSucceed(makeHttpResponse("ok"));
    });
    const protectedClient = withCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 60_000,
      adaptiveLimiter: limiter,
    })(unstable);

    await expect(runHttpEffect(protectedClient({ method: "GET", url: "https://api.example.test/a" }))).rejects.toMatchObject({
      _tag: "FetchError",
    });
    await expect(runHttpEffect(protectedClient({ method: "GET", url: "https://api.example.test/a" }))).rejects.toMatchObject({
      _tag: "CircuitBreakerOpen",
    });
    expect(marked).toContain("api.example.test");

    const perOrigin = withCircuitBreaker({
      perOrigin: true,
      failureThreshold: 1,
      adaptiveLimiter: { keyResolver: "global", markCircuitOpen: (key) => marked.push(`global:${key}`) },
      adaptiveLimiterKey: () => "custom-key",
    })(makeMockHttpClient(() => asyncFail({ _tag: "FetchError", message: "bad" } as HttpError)));
    await expect(runHttpEffect(perOrigin({ method: "GET", url: "not a url", poolKey: "pool" }))).rejects.toMatchObject({ _tag: "FetchError" });
    await expect(runHttpEffect(perOrigin({ method: "GET", url: "not a url" }))).rejects.toMatchObject({ _tag: "CircuitBreakerOpen" });
    expect(marked).toContain("global:custom-key");

    const throwingNext = () => {
      throw new Error("sync fail");
    };
    const guarded = withCircuitBreaker()(throwingNext as any);
    await expect(runHttpEffect(guarded({ method: "GET", url: "/sync" }))).rejects.toMatchObject({
      _tag: "FetchError",
      message: "Error: sync fail",
    });
  });

  it("covers prewarm platform checks and probe client paths", async () => {
    expect(detectPlatform()).toBe("node");
    const originalFetch = globalThis.fetch;
    const originalAbort = globalThis.AbortController;

    vi.stubGlobal("fetch", undefined);
    expect(() => validateFetchAvailable()).toThrow("global fetch");
    vi.stubGlobal("fetch", originalFetch);
    vi.stubGlobal("AbortController", undefined);
    expect(() => validateFetchAvailable()).toThrow("AbortController");
    vi.stubGlobal("AbortController", originalAbort);
    expect(() => validateFetchAvailable()).not.toThrow();

    const controller = new AbortController();
    await expect(executeProbe("https://api.example.test", {
      timeoutMs: 1000,
      signal: controller.signal,
      platform: "node",
      client: makeMockHttpClient(() => makeHttpResponse()),
    })).resolves.toMatchObject({ ok: true });

    await expect(executeProbe("https://api.example.test", {
      timeoutMs: 1000,
      signal: new AbortController().signal,
      platform: "node",
      client: makeMockHttpClient(() => asyncFail({ _tag: "FetchError", message: "probe failed" } as HttpError)),
    })).resolves.toMatchObject({ ok: false, error: "probe failed" });

    const aborted = new AbortController();
    aborted.abort();
    await expect(executeProbe("https://api.example.test", {
      timeoutMs: 1000,
      signal: aborted.signal,
      platform: "node",
      client: makeMockHttpClient(() => async((_env, _cb) => () => undefined)),
    })).resolves.toMatchObject({ ok: false, error: "cancelled" });
  });

  it("covers direct HTTP effect runner edge exits and cancellation", async () => {
    const exits: unknown[] = [];
    registerHttpEffect(
      asyncFlatMap(asyncFail("first failed"), () => asyncSucceed("never")),
      {},
      (exit) => exits.push(exit),
    );
    expect(exits).toEqual([{ _tag: "Failure", cause: Cause.fail("first failed") }]);

    exits.length = 0;
    registerHttpEffect(
      asyncFold(
        asyncSync(() => { throw new Error("defect"); }),
        () => asyncSucceed("recovered"),
        asyncSucceed,
      ),
      {},
      (exit) => exits.push(exit),
    );
    expect(exits).toEqual([expect.objectContaining({ _tag: "Failure", cause: expect.objectContaining({ _tag: "Die" }) })]);

    let cancelled = false;
    const cancel = registerHttpEffect(
      async(() => () => { cancelled = true; }),
      {},
      (exit) => exits.push(exit),
    );
    cancel();
    expect(cancelled).toBe(true);
    expect(exits.at(-1)).toMatchObject({ _tag: "Failure", cause: { _tag: "Interrupt" } });
  });

  it("covers lifecycle batch coalesce, split, interrupt, and defect errors", async () => {
    const baseConfig = {
      windowMs: 1,
      maxBatchSize: 2,
      batchKey: () => "batch",
      batch: {
        coalesce: (requests: readonly any[]) => ({ method: "POST", url: "/batch", body: String(requests.length) }),
        split: (response: any, requests: readonly any[]) => requests.map(() => response),
      },
    };

    await expect(runHttpEffect(withBatch({
      ...baseConfig,
      batch: {
        ...baseConfig.batch,
        coalesce: () => { throw new Error("coalesce exploded"); },
      },
    })(makeMockHttpClient(() => makeHttpResponse("never")))({ method: "GET", url: "/a" }))).rejects.toMatchObject({
      _tag: "FetchError",
      message: "Error: coalesce exploded",
    });

    await expect(runHttpEffect(withBatch({
      ...baseConfig,
      batch: {
        ...baseConfig.batch,
        split: () => { throw new Error("split exploded"); },
      },
    })(makeMockHttpClient(() => makeHttpResponse("batch")))({ method: "GET", url: "/b" }))).rejects.toMatchObject({
      _tag: "FetchError",
      message: "Error: split exploded",
    });

    await expect(runHttpEffect(withBatch(baseConfig)(() => async((_env, cb) => {
      cb(Exit.failCause(Cause.interrupt()));
    }))({ method: "GET", url: "/interrupt" }))).rejects.toMatchObject({ _tag: "Abort" });

    await expect(runHttpEffect(withBatch(baseConfig)(() => async((_env, cb) => {
      cb(Exit.failCause(Cause.die(new Error("batch defect"))));
    }))({ method: "GET", url: "/die" }))).rejects.toMatchObject({
      _tag: "FetchError",
      message: "Error: batch defect",
    });
  });
});
