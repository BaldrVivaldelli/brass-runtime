import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decorate,
  makeHttp,
  makeHttpStream,
  normalizeHeadersInit,
  withRetryStream,
  withMiddleware,
} from "../client";
import type { HttpClientFn, HttpClientStream, HttpError, HttpRequest, HttpWireResponse, HttpWireResponseStream } from "../client";
import { httpClient, httpClientStream, httpClientWithMeta } from "../httpClient";
import { Lens } from "../optics/lens";
import { atKey } from "../optics/record";
import {
  mergeHeaders,
  mergeHeadersUnder,
  removeHeader,
  Request,
  setHeader,
  setHeaderIfMissing,
} from "../optics/request";
import { withRetry } from "../retry/retry";
import { sleepMs } from "../sleep";
import { Runtime } from "../../core/runtime/runtime";
import { collectStream } from "../../core/stream/stream";
import { asyncFail, asyncSucceed } from "../../core/types/asyncEffect";

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    headers: { "content-type": "application/json", ...(init?.headers as Record<string, string> | undefined) },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HTTP optics and header normalization", () => {
  it("normalizes Headers, tuples, records and empty values", () => {
    expect(normalizeHeadersInit(undefined)).toBeUndefined();
    expect(normalizeHeadersInit(null)).toBeUndefined();
    expect(normalizeHeadersInit("bad")).toBeUndefined();
    expect(normalizeHeadersInit(new Headers({ a: "1" }))).toEqual({ a: "1" });
    expect(normalizeHeadersInit([["b", "2"]])).toEqual({ b: "2" });
    expect(normalizeHeadersInit({ c: "3" })).toEqual({ c: "3" });
  });

  it("updates request headers through lenses", () => {
    const req: HttpRequest = { method: "GET", url: "/x", headers: { keep: "1" } };

    expect(Request.headers.get({ method: "GET", url: "/x" })).toEqual({});
    expect(setHeader("a", "b")(req).headers).toEqual({ keep: "1", a: "b" });
    expect(removeHeader("keep")(req).headers).toEqual({});
    expect(mergeHeaders({ a: "2" })(req).headers).toEqual({ keep: "1", a: "2" });
    expect(mergeHeadersUnder({ keep: "0", under: "u" })(req).headers).toEqual({ keep: "1", under: "u" });
    expect(setHeaderIfMissing("keep", "9")(req).headers).toEqual({ keep: "1" });
    expect(setHeaderIfMissing("missing", "9")(req).headers).toEqual({ keep: "1", missing: "9" });
  });

  it("record and generic lenses get, set and over", () => {
    const lens = atKey("n");
    expect(lens.get({ n: "1" })).toBe("1");
    expect(lens.set("2")({ n: "1", x: "3" })).toEqual({ n: "2", x: "3" });
    expect(Lens.over(lens, (n) => `${n ?? "0"}!`)({})).toEqual({ n: "0!" });
  });
});

describe("makeHttp and decorators", () => {
  it("performs a request with baseUrl, defaults, init headers and explicit headers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }, { headers: { server: "test" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = makeHttp({ baseUrl: "https://example.test/api/", headers: { token: "default", keep: "default" } });
    const res = await run<HttpWireResponse>(client({
      method: "POST",
      url: "users",
      headers: { token: "explicit" },
      body: "payload",
      init: { headers: new Headers({ initOnly: "yes", keep: "init" }) } as any,
    }));

    expect(res.status).toBe(200);
    expect(res.bodyText).toBe(JSON.stringify({ ok: true }));
    expect(res.headers).toMatchObject({ server: "test" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [input, init] = fetchMock.mock.calls[0];
    expect(String(input)).toBe("https://example.test/api/users");
    expect(init).toMatchObject({ method: "POST", body: "payload" });
    // Headers normalizes names to lowercase. HTTP header names are
    // case-insensitive, so the wire shape intentionally preserves that
    // normalized representation instead of the original camelCase key.
    expect(init?.headers).toMatchObject({ token: "explicit", keep: "default", initonly: "yes" });
  });

  it("maps invalid urls and fetch errors into HttpError", async () => {
    const client = makeHttp({ baseUrl: "%%%" });
    await expect(run(client({ method: "GET", url: "%%%" }))).rejects.toMatchObject({ _tag: "BadUrl" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const client2 = makeHttp({ baseUrl: "https://example.test" });
    await expect(run(client2({ method: "GET", url: "/x" }))).rejects.toMatchObject({ _tag: "FetchError", message: "network" });
  });

  it("decorates clients and composes middleware", async () => {
    const base: HttpClientFn = (req) => asyncSucceed({ status: 200, statusText: "OK", headers: {}, bodyText: req.url, ms: 1 });
    const client = decorate(base);
    const mw = (next: HttpClientFn): HttpClientFn => (req) => next({ ...req, url: `${req.url}?mw=1` });

    await expect(run(client.with(mw)({ method: "GET", url: "/a" }))).resolves.toMatchObject({ bodyText: "/a?mw=1" });
    await expect(run(withMiddleware(mw)(client)({ method: "GET", url: "/b" }))).resolves.toMatchObject({ bodyText: "/b?mw=1" });
  });

  it("records pool rejection, queue timeout, request timeout, and adaptive cleanup stats", async () => {
    let releaseFetch!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      releaseFetch = () => resolve(new Response("ok", { status: 200 }));
    })));

    const rejectedClient = makeHttp({
      baseUrl: "https://example.test",
      pool: { concurrency: 1, maxQueue: 0, key: "global" },
    });
    const first = run<HttpWireResponse>(rejectedClient({ method: "GET", url: "/slow" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(run(rejectedClient({ method: "GET", url: "/rejected" }))).rejects.toMatchObject({
      _tag: "PoolRejected",
      key: "global",
    });
    expect(rejectedClient.stats()).toMatchObject({ poolRejected: 1, failed: 1 });
    releaseFetch();
    await expect(first).resolves.toMatchObject({ bodyText: "ok" });

    let releaseTimeoutHolder!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      releaseTimeoutHolder = () => resolve(new Response("done", { status: 200 }));
    })));
    const timeoutPoolClient = makeHttp({
      baseUrl: "https://example.test",
      pool: { concurrency: 1, maxQueue: 1, queueTimeoutMs: 1, key: "global" },
    });
    const holder = run<HttpWireResponse>(timeoutPoolClient({ method: "GET", url: "/holder" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(run(timeoutPoolClient({ method: "GET", url: "/queued" }))).rejects.toMatchObject({
      _tag: "PoolTimeout",
      key: "global",
    });
    expect(timeoutPoolClient.stats()).toMatchObject({ poolTimeouts: 1, failed: 1 });
    releaseTimeoutHolder();
    await holder;

    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const requestTimeoutClient = makeHttp({ baseUrl: "https://example.test", timeoutMs: 1 });
    await expect(run(requestTimeoutClient({ method: "GET", url: "/timeout" }))).rejects.toMatchObject({
      _tag: "Timeout",
      phase: "request",
      message: expect.stringContaining("timed out after 1ms"),
    });
    expect(requestTimeoutClient.stats()).toMatchObject({ timedOut: 1 });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw { _tag: "Timeout", timeoutMs: 3, message: "upstream timeout" } satisfies HttpError;
    }));
    const adaptiveClient = makeHttp({
      baseUrl: "https://example.test",
      adaptiveLimiter: { initialLimit: 1, minLimit: 1, maxLimit: 1 },
    });
    await expect(run(adaptiveClient({ method: "GET", url: "/adaptive-error" }))).rejects.toMatchObject({
      _tag: "Timeout",
    });
    expect(adaptiveClient.stats()).toMatchObject({ timedOut: 1, adaptiveLimiter: expect.any(Object) });
    adaptiveClient.destroy?.();
    adaptiveClient.shutdown?.();
  });

  it("falls back when aborting a linked request signal with a reason is unsupported", async () => {
    const requestController = new AbortController();
    const originalAbort = AbortController.prototype.abort;
    vi.spyOn(AbortController.prototype, "abort").mockImplementation(function (this: AbortController, reason?: unknown) {
      if (this !== requestController && reason instanceof Error && reason.message === "legacy abort reason") {
        throw new Error("abort reason unsupported");
      }
      return originalAbort.call(this, reason);
    });
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestController.abort(new Error("legacy abort reason"));
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("unexpected", { status: 200 });
    }));

    const client = makeHttp({ baseUrl: "https://example.test" });
    await expect(run(client({
      method: "GET",
      url: "/abort-reason",
      init: { signal: requestController.signal } as any,
    }))).rejects.toEqual({ _tag: "Abort" });
  });
});

describe("retry middleware", () => {
  it("retries retryable status codes and then succeeds", async () => {
    const calls: number[] = [];
    const next: HttpClientFn = () => {
      calls.push(Date.now());
      return asyncSucceed(calls.length === 1
        ? { status: 503, statusText: "Unavailable", headers: {}, bodyText: "no", ms: 1 }
        : { status: 200, statusText: "OK", headers: {}, bodyText: "ok", ms: 1 });
    };

    const retried = withRetry({ maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 })(next);
    await expect(run(retried({ method: "GET", url: "/retry" }))).resolves.toMatchObject({ status: 200, bodyText: "ok" });
    expect(calls).toHaveLength(2);
  });

  it("does not retry non-retryable methods, Abort or BadUrl", async () => {
    const nextStatus: HttpClientFn = vi.fn(() => asyncSucceed({ status: 503, statusText: "Unavailable", headers: {}, bodyText: "no", ms: 1 }));
    const retriedStatus = withRetry({ maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 })(nextStatus);
    await expect(run(retriedStatus({ method: "POST", url: "/no" }))).resolves.toMatchObject({ status: 503 });
    expect(nextStatus).toHaveBeenCalledTimes(1);

    const nextAbort: HttpClientFn = vi.fn(() => asyncFail({ _tag: "Abort" } satisfies HttpError));
    const retriedAbort = withRetry({ maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 })(nextAbort);
    await expect(run(retriedAbort({ method: "GET", url: "/abort" }))).rejects.toEqual({ _tag: "Abort" });
    expect(nextAbort).toHaveBeenCalledTimes(1);
  });

  it("retries streaming failures and stops immediately for non-retryable streaming errors", async () => {
    const emptyStats = {
      inFlight: 0,
      started: 0,
      succeeded: 0,
      failed: 0,
      aborted: 0,
      timedOut: 0,
      poolRejected: 0,
      poolTimeouts: 0,
    };
    const retriedNext = Object.assign(
      vi.fn(() => retriedNext.mock.calls.length === 1
        ? asyncFail({ _tag: "FetchError", message: "temporary" } satisfies HttpError)
        : asyncSucceed({
          status: 200,
          statusText: "OK",
          headers: {},
          body: { _tag: "Empty" },
          ms: 1,
        } as HttpWireResponseStream)),
      { stats: () => emptyStats },
    ) as HttpClientStream;
    const onRetry = vi.fn();
    const retried = withRetryStream({ maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, onRetry })(retriedNext);

    await expect(run(retried({ method: "GET", url: "/stream-error" }))).resolves.toMatchObject({ status: 200 });
    expect(retriedNext).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ error: { _tag: "FetchError", message: "temporary" } }));

    const closedNext = Object.assign(
      vi.fn(() => asyncFail({ _tag: "PoolClosed", key: "api", message: "closed" } satisfies HttpError)),
      { stats: () => emptyStats },
    ) as HttpClientStream;
    const closed = withRetryStream({ maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 })(closedNext);
    await expect(run(closed({ method: "GET", url: "/closed" }))).rejects.toMatchObject({ _tag: "PoolClosed" });
    expect(closedNext).toHaveBeenCalledTimes(1);
  });

  it("respects retry-after headers", async () => {
    const next: HttpClientFn = vi.fn(() => asyncSucceed({ status: 429, statusText: "Too Many", headers: { "Retry-After": "0" }, bodyText: "wait", ms: 1 }));
    const retried = withRetry({ maxRetries: 1, baseDelayMs: 10, maxDelayMs: 10 })(next);
    await expect(run(retried({ method: "GET", url: "/ra" }))).resolves.toMatchObject({ status: 429 });
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe("DX http clients", () => {
  it("httpClient parses text/json and applies JSON headers", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ created: true });
      return new Response(String(_input).endsWith("/text") ? "hello" : JSON.stringify({ value: 1 }), { status: 200, statusText: "OK" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = httpClient({ baseUrl: "https://example.test" });

    await expect(client.getText("/text").unsafeRunPromise()).resolves.toMatchObject({ body: "hello", status: 200 });
    await expect(client.getJson<{ value: number }>("/json").unsafeRunPromise()).resolves.toMatchObject({ body: { value: 1 } });
    await expect(client.postJson<{ created: boolean }>("/json", { x: 1 }).unsafeRunPromise()).resolves.toMatchObject({ body: { created: true } });

    const postCall = fetchMock.mock.calls.find((call: any[]) => call[1]?.method === "POST");
    expect(postCall?.[1]?.headers).toMatchObject({ accept: "application/json", "content-type": "application/json" });
  });

  it("httpClient with middleware and retry keeps the fluent API", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = httpClient({ baseUrl: "https://example.test" })
      .with((next) => (req) => next(setHeader("x-mw", "1")(req)))
      .withRetry({ maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 });

    await expect(client.get("/x").unsafeRunPromise()).resolves.toMatchObject({ status: 200 });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "x-mw": "1" });
  });

  it("httpClient exposes raw request/post helpers, stats, init splitting, and stream stats", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(init?.method === "POST" ? "posted" : "raw", { status: 202, statusText: "Accepted" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = httpClient({ baseUrl: "https://example.test", headers: { "x-default": "1" } });

    await expect(client.request({ method: "GET", url: "/raw", init: { headers: { "x-init": "2" } } as any }).unsafeRunPromise())
      .resolves.toMatchObject({ status: 202, bodyText: "raw" });
    await expect(client.post("/post", "", {
      headers: new Headers([["x-post", "3"]]),
      timeoutMs: 0,
      poolKey: 123 as any,
      cache: "no-store",
    }).unsafeRunPromise()).resolves.toMatchObject({ bodyText: "posted" });

    expect(client.stats()).toMatchObject({ started: 2, succeeded: 2 });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: { "x-default": "1", "x-post": "3" },
    });
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBeUndefined();

    const streamClient = httpClientStream({ baseUrl: "https://example.test" });
    await expect(streamClient.get("/stream").unsafeRunPromise()).resolves.toMatchObject({ status: 202 });
    expect(streamClient.stats()).toMatchObject({ started: 1, succeeded: 1 });
  });

  it("httpClientWithMeta returns metadata and resolved final url", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    const client = httpClientWithMeta({ baseUrl: "https://example.test/root/" });

    const text = await client.getText("child").unsafeRunPromise();
    expect(text.response.body).toBe(JSON.stringify({ ok: true }));
    expect(text.meta.urlFinal).toBe("https://example.test/root/child");
    expect(text.meta.durationMs).toBeTypeOf("number");

    const json = await client.getJson<{ ok: boolean }>("child").unsafeRunPromise();
    expect(json.response.body).toEqual({ ok: true });

    const post = await client.postJson<{ ok: boolean }>("child", { x: 1 }).unsafeRunPromise();
    expect(post.response.body).toEqual({ ok: true });
  });

  it("httpClientWithMeta exposes raw request/get/post helpers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK" })));
    const client = httpClientWithMeta({ baseUrl: "https://base.test/" });

    const raw = await client.request({ method: "GET", url: "https://example.test/raw" }).unsafeRunPromise();
    expect(raw.meta.urlFinal).toBe("https://example.test/raw");

    const got = await client.get("https://example.test/got", { headers: [["x-a", "1"]] as any }).unsafeRunPromise();
    expect(got.meta.request.headers).toEqual({ "x-a": "1" });

    const posted = await client.post("https://example.test/post", "", { timeoutMs: 10 }).unsafeRunPromise();
    expect(posted.meta.request).toMatchObject({ method: "POST", timeoutMs: 10 });
    expect(posted.meta.request.body).toBeUndefined();
  });
});

describe("HTTP streaming and sleep", () => {
  it("makeHttpStream exposes the response body as a stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 201, statusText: "Created" })));
    const streamClient = makeHttpStream({ baseUrl: "https://example.test" });
    const response = await run<HttpWireResponseStream>(streamClient({ method: "GET", url: "/bytes" }));
    const chunks = await run<Uint8Array[]>(collectStream(response.body));

    expect(response.status).toBe(201);
    expect(Array.from(chunks[0])).toEqual([1, 2, 3]);
  });

  it("makeHttpStream maps bad urls, pre-aborted request signals, and releases pool slots for empty bodies", async () => {
    const badUrlClient = makeHttpStream({ baseUrl: "%%%" });
    await expect(run(badUrlClient({ method: "GET", url: "%%%" }))).rejects.toMatchObject({ _tag: "BadUrl" });
    expect(badUrlClient.stats()).toMatchObject({ started: 0, failed: 0 });

    const aborted = new AbortController();
    aborted.abort(new Error("already aborted"));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response(null, { status: 204, statusText: "No Content" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const streamClient = makeHttpStream({
      baseUrl: "https://example.test",
      pool: { concurrency: 1, maxQueue: 0, key: "global" },
    });
    await expect(run(streamClient({ method: "GET", url: "/aborted", init: { signal: aborted.signal } as any })))
      .rejects.toEqual({ _tag: "Abort" });
    expect(streamClient.stats()).toMatchObject({ started: 1, aborted: 1 });

    const response = await run<HttpWireResponseStream>(streamClient({ method: "GET", url: "/empty" }));
    expect(response.status).toBe(204);
    await expect(run<Uint8Array[]>(collectStream(response.body))).resolves.toEqual([]);
    expect(streamClient.stats()).toMatchObject({
      started: 2,
      succeeded: 1,
      aborted: 1,
      pool: expect.objectContaining({ acquired: 1, released: 1, running: 0 }),
    });
  });

  it("makeHttpStream propagates AbortSignal while the body stream is being read", async () => {
    let cancelCalled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Keep reads pending until the request signal aborts.
      },
      cancel() {
        cancelCalled = true;
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, statusText: "OK" })));

    const controller = new AbortController();
    const streamClient = makeHttpStream({ baseUrl: "https://example.test" });
    const response = await run<HttpWireResponseStream>(
      streamClient({ method: "GET", url: "/slow-bytes", init: { signal: controller.signal } as any })
    );

    const pending = run<Uint8Array[]>(collectStream(response.body));
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ _tag: "Abort" });
    expect(cancelCalled).toBe(true);
  });

  it("makeHttpStream covers adaptive limiter, pool cleanup on fetch errors, and request timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([9]), { status: 200, statusText: "OK" })));
    const adaptiveStream = makeHttpStream({
      baseUrl: "https://example.test",
      adaptiveLimiter: { initialLimit: 1, minLimit: 1, maxLimit: 1 },
    });
    const response = await run<HttpWireResponseStream>(adaptiveStream({ method: "GET", url: "/adaptive-stream" }));
    await expect(run<Uint8Array[]>(collectStream(response.body))).resolves.toHaveLength(1);
    expect(adaptiveStream.stats().adaptiveLimiter).toMatchObject({ limit: 1 });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("stream failed");
    }));
    const adaptiveFailure = makeHttpStream({
      baseUrl: "https://example.test",
      adaptiveLimiter: { initialLimit: 1, minLimit: 1, maxLimit: 1 },
    });
    await expect(run(adaptiveFailure({ method: "GET", url: "/adaptive-failure" }))).rejects.toMatchObject({
      _tag: "FetchError",
      message: "stream failed",
    });
    expect(adaptiveFailure.stats()).toMatchObject({ failed: 1, adaptiveLimiter: expect.any(Object) });

    const pooledFailure = makeHttpStream({
      baseUrl: "https://example.test",
      pool: { concurrency: 1, maxQueue: 0, key: "global" },
    });
    await expect(run(pooledFailure({ method: "GET", url: "/pooled-failure" }))).rejects.toMatchObject({
      _tag: "FetchError",
    });
    expect(pooledFailure.stats().pool).toMatchObject({ acquired: 1, released: 1, running: 0 });

    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const timedOut = makeHttpStream({ baseUrl: "https://example.test", timeoutMs: 1 });
    await expect(run(timedOut({ method: "GET", url: "/stream-timeout" }))).rejects.toMatchObject({
      _tag: "Timeout",
      phase: "request",
      message: expect.stringContaining("timed out after 1ms"),
    });
    expect(timedOut.stats()).toMatchObject({ timedOut: 1 });
  });

  it("httpClientStream supports middleware, retry and default get alias", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([4]), { status: 200, statusText: "OK" })));
    const client = httpClientStream({ baseUrl: "https://example.test" })
      .with((next) => (req) => next(setHeader("x-stream", "1")(req)))
      .withRetry({ maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 });

    const response = await client.get("/s").unsafeRunPromise();
    const chunks = await run<Uint8Array[]>(collectStream(response.body));
    expect(Array.from(chunks[0])).toEqual([4]);
  });

  it("withRetryStream stops retrying when the fiber is interrupted during retry sleep", async () => {
    const emptyStats = {
      inFlight: 0,
      started: 0,
      succeeded: 0,
      failed: 0,
      aborted: 0,
      timedOut: 0,
      poolRejected: 0,
      poolTimeouts: 0,
    };
    const next = Object.assign(
      vi.fn(() => asyncSucceed({
        status: 503,
        statusText: "Unavailable",
        headers: { "retry-after": "5" },
        body: { _tag: "Empty" },
        ms: 1,
      } as HttpWireResponseStream)),
      { stats: () => emptyStats },
    ) as HttpClientStream;
    const client = withRetryStream({ maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 5000 })(next);
    const fiber = rt.fork(client({ method: "GET", url: "https://example.test/retry-stream" }));

    await new Promise((r) => setTimeout(r, 0));
    fiber.interrupt();

    const exit = await new Promise<any>((resolve) => fiber.join(resolve));
    expect(exit._tag).toBe("Failure");
    expect(exit._tag === "Failure" ? exit.cause._tag : "").toBe("Interrupt");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("sleepMs resolves and maps interruption to Abort", async () => {
    await expect(run(sleepMs(0))).resolves.toBeUndefined();

    const fiber = rt.fork(sleepMs(50));
    fiber.interrupt();
    await new Promise<void>((resolve) => fiber.join((exit) => {
      expect(exit._tag).toBe("Failure");
      expect(exit._tag === "Failure" ? exit.cause._tag : "").toBe("Interrupt");
      resolve();
    }));
  });
});
