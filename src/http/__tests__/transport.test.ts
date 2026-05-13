import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Runtime, abortablePromiseStats, resetAbortablePromiseStats } from "../../core/runtime/runtime";
import { async, asyncFail, asyncSucceed } from "../../core/types/asyncEffect";
import { makeDefaultHttpClient } from "../defaultClient";
import { makeLifecycleClient } from "../lifecycle/lifecycleClient";
import { makeHttp } from "../client";
import {
  abortErrorForSignal,
  linkAbortSignals,
  makeFetchStreamTransport,
  makeFetchTransport,
  makePromiseHttpTransport,
  normalizeHttpHeaders,
  promiseHttpTransport,
  type HttpTransport,
} from "../transport";
import { makeNodeHttpProxyClient, makeNodeHttpTransport } from "../nodeTransport";

const rt = Runtime.make({});
const run = <A>(eff: any) => rt.toPromise(eff) as Promise<A>;
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const closeServer = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close((error) => {
    if (error) reject(error);
    else resolve();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetAbortablePromiseStats();
});

describe("HTTP effect transports", () => {
  it("normalizes transport headers from host-client shapes", () => {
    expect(normalizeHttpHeaders(undefined)).toEqual({});
    expect(normalizeHttpHeaders("not headers")).toEqual({});

    const headers = new Headers({ "x-one": "1" });
    expect(normalizeHttpHeaders(headers)).toEqual({ "x-one": "1" });

    expect(normalizeHttpHeaders([
      ["x-scalar", 1],
      ["x-array", ["a", "b"]],
      ["x-empty"],
      ["x-null", null],
      ["x-undefined", undefined],
    ])).toEqual({ "x-scalar": "1", "x-array": "a, b" });

    expect(normalizeHttpHeaders({
      toJSON: () => ({ "x-json": 1, "x-list": ["a", "b"] }),
    })).toEqual({ "x-json": "1", "x-list": "a, b" });

    expect(normalizeHttpHeaders({
      "x-list": ["a", "b"],
      "x-null": null,
      "x-undefined": undefined,
    })).toEqual({ "x-list": "a, b" });
  });

  it("supports a fluent promise transport for common axios/fetch-shaped responses", async () => {
    const request = vi.fn(async ({ request, url, signal }) => {
      expect(signal.aborted).toBe(false);
      return {
        status: 203,
        statusText: "Non-Authoritative Information",
        headers: { "x-client": "axiosish" },
        data: { method: request.method, url: url.toString() },
      };
    });
    const transport = promiseHttpTransport()
      .request(request)
      .json();
    const client = makeHttp({
      baseUrl: "https://api.example.test",
      transport,
    });

    const response = await run(client({ method: "GET", url: "/fluent" }));

    expect(response).toMatchObject({
      status: 203,
      statusText: "Non-Authoritative Information",
      headers: { "x-client": "axiosish" },
      bodyText: JSON.stringify({
        method: "GET",
        url: "https://api.example.test/fluent",
      }),
      ms: expect.any(Number),
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("injects AbortSignal into fluent request configs without exposing it to config mappers", async () => {
    let mapperSawSignal = false;
    let sentSignal: AbortSignal | undefined;
    const requestConfig = vi.fn((ctx: any) => {
      mapperSawSignal = "signal" in ctx;
      const { request, url } = ctx;
      return {
        url: url.toString(),
        method: request.method,
        headers: request.headers,
        responseType: "json" as const,
      };
    });
    const send = vi.fn(async (config: {
      url: string;
      method: string;
      headers?: Record<string, string>;
      responseType: "json";
      signal: AbortSignal;
    }) => {
      sentSignal = config.signal;
      return {
        status: 200,
        statusText: "OK",
        headers: { "x-client": "axiosish" },
        data: { url: config.url, aborted: config.signal.aborted },
      };
    });
    const transport = promiseHttpTransport()
      .requestConfig(requestConfig)
      .send(send)
      .json();
    const client = makeHttp({
      baseUrl: "https://api.example.test",
      transport,
    });

    const response = await run(client({ method: "GET", url: "/hidden-signal" }));

    expect(mapperSawSignal).toBe(false);
    expect(sentSignal).toBeInstanceOf(AbortSignal);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      signal: sentSignal,
      url: "https://api.example.test/hidden-signal",
    }));
    expect(response.bodyText).toBe(JSON.stringify({
      url: "https://api.example.test/hidden-signal",
      aborted: false,
    }));
  });

  it("lets fluent transports override response metadata", async () => {
    const raw = {
      status: 201,
      statusText: "Created",
      headers: { "x-raw": "1" },
      payload: { ok: true },
    };
    const transport = promiseHttpTransport()
      .request(async () => raw)
      .json((response) => response.payload, (response) => ({
        headers: { ...response.headers, "x-mapped": "yes" },
        transportMeta: { source: "custom", status: response.status },
      }));
    const client = makeHttp({
      baseUrl: "https://api.example.test",
      transport,
    });

    const response = await run(client({ method: "POST", url: "/mapped" }));

    expect(response).toMatchObject({
      status: 201,
      statusText: "Created",
      headers: { "x-raw": "1", "x-mapped": "yes" },
      bodyText: JSON.stringify({ ok: true }),
      transportMeta: { source: "custom", status: 201 },
    });
  });

  it("infers fluent promise bodies from Response, bodyText, body, and primitive values", async () => {
    const jsonResponseTransport = promiseHttpTransport()
      .request(async () => new Response(JSON.stringify({ ok: true }), {
        status: 202,
        statusText: "Accepted",
        headers: { "x-response": "json" },
      }))
      .json();
    const textResponseTransport = promiseHttpTransport()
      .request(async () => new Response("plain", {
        status: 206,
        statusText: "Partial Content",
      }))
      .text();
    const bodyTextTransport = promiseHttpTransport()
      .request(async () => ({ statusCode: 209, statusMessage: "Custom", bodyText: "from-body-text" }))
      .text();
    const bodyTransport = promiseHttpTransport()
      .request(async () => ({ headers: { "x-body": "1" }, body: { nested: true } }))
      .json();
    const primitiveTransport = promiseHttpTransport()
      .request(async () => "raw")
      .json();
    const emptyJsonTransport = promiseHttpTransport()
      .request(async () => ({ status: 200 }))
      .json(() => undefined);
    const emptyTextTransport = promiseHttpTransport()
      .request(async () => ({ status: 200 }))
      .text(() => null);
    const defaultInfoTransport = promiseHttpTransport()
      .request(async () => ({ data: "defaults", ms: 99 }))
      .text(undefined, () => ({ status: undefined, statusText: undefined, ms: 12 }));

    await expect(run(makeHttp({ baseUrl: "https://api.example.test", transport: jsonResponseTransport })({ method: "GET", url: "/json" })))
      .resolves.toMatchObject({
        status: 202,
        statusText: "Accepted",
        headers: { "x-response": "json" },
        bodyText: JSON.stringify({ ok: true }),
      });
    await expect(run(makeHttp({ baseUrl: "https://api.example.test", transport: textResponseTransport })({ method: "GET", url: "/text" })))
      .resolves.toMatchObject({
        status: 206,
        statusText: "Partial Content",
        bodyText: "plain",
      });
    await expect(run(makeHttp({ baseUrl: "https://api.example.test", transport: bodyTextTransport })({ method: "GET", url: "/body-text" })))
      .resolves.toMatchObject({
        status: 209,
        statusText: "Custom",
        bodyText: "from-body-text",
      });
    await expect(run(makeHttp({ baseUrl: "https://api.example.test", transport: bodyTransport })({ method: "GET", url: "/body" })))
      .resolves.toMatchObject({
        status: 200,
        headers: { "x-body": "1" },
        bodyText: JSON.stringify({ nested: true }),
      });
    await expect(run(makeHttp({ baseUrl: "https://api.example.test", transport: primitiveTransport })({ method: "GET", url: "/raw" })))
      .resolves.toMatchObject({ status: 200, bodyText: JSON.stringify("raw") });
    await expect(run(makeHttp({ baseUrl: "https://api.example.test", transport: emptyJsonTransport })({ method: "GET", url: "/empty-json" })))
      .resolves.toMatchObject({ bodyText: "" });
    await expect(run(makeHttp({ baseUrl: "https://api.example.test", transport: emptyTextTransport })({ method: "GET", url: "/empty-text" })))
      .resolves.toMatchObject({ bodyText: "" });
    await expect(run(makeHttp({ baseUrl: "https://api.example.test", transport: defaultInfoTransport })({ method: "GET", url: "/default-info" })))
      .resolves.toMatchObject({
        status: 200,
        statusText: "",
        bodyText: "defaults",
        ms: 12,
      });
  });

  it("supports fluent fromJson/fromText response builders and local error mapping", async () => {
    const jsonTransport = promiseHttpTransport()
      .request(async () => ({ status: 200, body: { ok: true } }))
      .fromJson((response) => response.body)
      .response((response) => ({ status: response.status + 1, headers: { "x-mode": "json" } }));
    const textTransport = promiseHttpTransport()
      .request(async () => ({ status: 200, bodyText: "hello" }))
      .fromText((response) => response.bodyText)
      .response(() => ({ status: 202, headers: { "x-mode": "text" } }));
    const failingTransport = promiseHttpTransport()
      .request(async () => {
        throw new Error("mapped");
      })
      .fromJson()
      .error((error) => ({
        _tag: "FetchError",
        message: error instanceof Error ? error.message : String(error),
        code: "LOCAL",
      }))
      .response();

    await expect(run(makeHttp({ baseUrl: "https://api.example.test", transport: jsonTransport })({ method: "GET", url: "/json" })))
      .resolves.toMatchObject({
        status: 201,
        headers: { "x-mode": "json" },
        bodyText: JSON.stringify({ ok: true }),
      });
    await expect(run(makeHttp({ baseUrl: "https://api.example.test", transport: textTransport })({ method: "GET", url: "/text" })))
      .resolves.toMatchObject({
        status: 202,
        headers: { "x-mode": "text" },
        bodyText: "hello",
      });
    await expect(run(makeHttp({ baseUrl: "https://api.example.test", transport: failingTransport })({ method: "GET", url: "/fail" })))
      .rejects.toMatchObject({
        _tag: "FetchError",
        message: "mapped",
        code: "LOCAL",
      });
  });

  it("links abort signals and preserves tagged timeout reasons", () => {
    const empty = linkAbortSignals();
    expect(empty.signal.aborted).toBe(false);
    empty.cleanup();

    const tagged = new AbortController();
    const timeout = { _tag: "Timeout", timeoutMs: 10, phase: "request", message: "slow" } as const;
    tagged.abort(timeout);
    const preAborted = linkAbortSignals(tagged.signal);
    expect(preAborted.signal.aborted).toBe(true);
    expect(abortErrorForSignal(preAborted.signal)).toBe(timeout);
    preAborted.cleanup();

    const source = new AbortController();
    const linked = linkAbortSignals(source.signal);
    source.abort();
    expect(linked.signal.aborted).toBe(true);
    expect(abortErrorForSignal(linked.signal)).toEqual({ _tag: "Abort" });
    linked.cleanup();
  });

  it("settles promise transports on pre-aborted and in-flight abort signals", async () => {
    const timeout = { _tag: "Timeout", timeoutMs: 5, phase: "request", message: "already slow" } as const;
    const preAborted = new AbortController();
    preAborted.abort(timeout);
    const request = vi.fn(async () => ({ status: 200 }));
    const transport = makePromiseHttpTransport({
      request,
      response: () => ({ status: 200, statusText: "OK", headers: {}, bodyText: "" }),
    });
    const context = {
      request: { method: "GET", url: "/aborted" },
      url: new URL("https://api.example.test/aborted"),
      signal: preAborted.signal,
    } as any;

    await expect(run(transport(context))).rejects.toBe(timeout);
    expect(request).not.toHaveBeenCalled();

    const controller = new AbortController();
    const never = makePromiseHttpTransport({
      request: () => new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), 50)),
      response: () => ({ status: 200, statusText: "OK", headers: {}, bodyText: "" }),
    });
    const promise = run(never({
      request: { method: "GET", url: "/abort-running" },
      url: new URL("https://api.example.test/abort-running"),
      signal: controller.signal,
    } as any));

    controller.abort();

    await expect(promise).rejects.toEqual({ _tag: "Abort" });
    await wait(60);
  });

  it("covers non-object request configs, Date timing fallback, and direct cancel cleanup", async () => {
    const originalPerformance = globalThis.performance;
    vi.stubGlobal("performance", undefined);
    try {
      const transport = promiseHttpTransport()
        .requestConfig(() => "opaque-config")
        .send(async (config) => ({ status: 200, data: { config } }))
        .json();
      const exit = await new Promise<any>((resolve) => transport({
        request: { method: "GET", url: "/opaque", headers: {} },
        url: new URL("https://api.example.test/opaque"),
        signal: new AbortController().signal,
      } as any).register({}, resolve));

      expect(exit).toMatchObject({
        _tag: "Success",
        value: {
          bodyText: JSON.stringify({ config: "opaque-config" }),
          ms: expect.any(Number),
        },
      });
    } finally {
      vi.stubGlobal("performance", originalPerformance);
    }

    const controller = new AbortController();
    const transport = makePromiseHttpTransport({
      request: () => new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), 20)),
      response: () => ({ status: 200, statusText: "OK", headers: {}, bodyText: "" }),
    });
    const exits: unknown[] = [];
    const cancel = transport({
      request: { method: "GET", url: "/cancel" },
      url: new URL("https://api.example.test/cancel"),
      signal: controller.signal,
    } as any).register({}, (exit) => exits.push(exit));

    cancel?.();
    cancel?.();
    await wait(30);
    expect(exits).toEqual([]);
  });

  it("adapts promise-based clients without manual Async/Cause plumbing", async () => {
    const request = vi.fn(async ({ request, signal }) => {
      expect(signal.aborted).toBe(false);
      return {
        status: 202,
        statusText: "Accepted",
        headers: { "x-array": ["a", "b"], "x-id": 1 },
        data: { method: request.method, body: request.body },
      };
    });
    const transport = makePromiseHttpTransport({
      request,
      response: (response) => ({
        status: response.status,
        statusText: response.statusText,
        headers: normalizeHttpHeaders(response.headers),
        bodyText: JSON.stringify(response.data),
      }),
    });
    const client = makeHttp({
      baseUrl: "https://api.example.test",
      transport,
    });

    const response = await run(client({
      method: "POST",
      url: "/promise",
      body: "payload",
    }));

    expect(response).toMatchObject({
      status: 202,
      statusText: "Accepted",
      headers: { "x-array": "a, b", "x-id": "1" },
      bodyText: JSON.stringify({ method: "POST", body: "payload" }),
      ms: expect.any(Number),
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(client.stats()).toMatchObject({ started: 1, succeeded: 1 });
  });

  it("lets promise transport callers customize error mapping", async () => {
    const transport = makePromiseHttpTransport({
      request: async () => {
        throw Object.assign(new Error("gateway timeout"), { response: { status: 504 } });
      },
      response: () => ({
        status: 200,
        statusText: "OK",
        headers: {},
        bodyText: "",
      }),
      error: (error) => ({
        _tag: "Timeout",
        timeoutMs: 1000,
        phase: "request",
        message: error instanceof Error ? error.message : String(error),
      }),
    });
    const client = makeHttp({
      baseUrl: "https://api.example.test",
      transport,
    });

    await expect(run(client({ method: "GET", url: "/timeout" }))).rejects.toMatchObject({
      _tag: "Timeout",
      message: "gateway timeout",
    });
    expect(client.stats()).toMatchObject({ started: 1, timedOut: 1 });
  });

  it("normalizes Axios-like promise transport failures by default", async () => {
    const transport = promiseHttpTransport()
      .requestConfig(({ url }) => ({ url: url.toString(), method: "GET" }))
      .send(async () => {
        throw Object.assign(new Error("Request failed with status code 404"), {
          isAxiosError: true,
          response: { status: 404, statusText: "Not Found" },
        });
      })
      .json();
    const client = makeHttp({
      baseUrl: "https://api.example.test",
      transport,
    });

    await expect(run(client({ method: "GET", url: "/missing" }))).rejects.toMatchObject({
      _tag: "FetchError",
      message: "Request failed with status code 404",
      status: 404,
      statusText: "Not Found",
    });
    expect(client.stats()).toMatchObject({ started: 1, failed: 1 });
  });

  it("runs makeHttp over a custom Async transport instead of global fetch", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);

    const seen: Array<{ url: string; headers: Record<string, string>; aborted: boolean }> = [];
    const transport: HttpTransport = ({ request, url, signal }) => {
      seen.push({
        url: url.toString(),
        headers: request.headers ?? {},
        aborted: signal.aborted,
      });
      return asyncSucceed({
        status: 201,
        statusText: "Created",
        headers: { "x-transport": "custom" },
        bodyText: `${request.headers?.["x-default"]}:${request.headers?.["x-init"]}`,
        ms: 7,
      });
    };

    const client = makeHttp({
      baseUrl: "https://api.example.test/root/",
      headers: { "x-default": "1" },
      transport,
    });

    const response = await run(client({
      method: "GET",
      url: "users",
      init: { headers: { "x-init": "2" } } as any,
    }));

    expect(response).toMatchObject({
      status: 201,
      bodyText: "1:2",
      headers: { "x-transport": "custom" },
    });
    expect(seen).toEqual([{
      url: "https://api.example.test/root/users",
      headers: { "x-default": "1", "x-init": "2" },
      aborted: false,
    }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.stats()).toMatchObject({ started: 1, succeeded: 1, failed: 0 });
  });

  it("keeps timeout and abortable diagnostics around custom transports", async () => {
    let cancelled = false;
    let observedSignal: AbortSignal | undefined;
    const transport: HttpTransport = ({ signal }) => {
      observedSignal = signal;
      return async(() => {
        return () => {
          cancelled = true;
        };
      });
    };

    const client = makeHttp({
      baseUrl: "https://api.example.test",
      timeoutMs: 5,
      transport,
    });

    await expect(run(client({ method: "GET", url: "/slow" }))).rejects.toMatchObject({
      _tag: "Timeout",
      timeoutMs: 5,
    });

    expect(cancelled).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    expect(client.stats()).toMatchObject({ inFlight: 0, started: 1, timedOut: 1 });
    expect(abortablePromiseStats()).toMatchObject({ active: 0, started: 1, timedOut: 1 });
  });

  it("records custom transport failures as HTTP failures", async () => {
    const transport: HttpTransport = () =>
      asyncFail({ _tag: "FetchError", message: "axios boom" });
    const client = makeHttp({
      baseUrl: "https://api.example.test",
      transport,
    });

    await expect(run(client({ method: "GET", url: "/fail" }))).rejects.toEqual({
      _tag: "FetchError",
      message: "axios boom",
    });
    expect(client.stats()).toMatchObject({ started: 1, failed: 1 });
  });

  it("does not require global fetch when lifecycle/default clients receive a transport", async () => {
    const originalFetch = globalThis.fetch;
    const transport: HttpTransport = ({ url }) =>
      asyncSucceed({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        bodyText: JSON.stringify({ url: url.toString() }),
        ms: 1,
      });

    try {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(globalThis, "fetch");

      const lifecycle = makeLifecycleClient({
        baseUrl: "https://api.example.test",
        transport,
      });
      await expect(run(lifecycle({ method: "GET", url: "/wire" }))).resolves.toMatchObject({
        bodyText: JSON.stringify({ url: "https://api.example.test/wire" }),
      });

      const client = makeDefaultHttpClient({
        baseUrl: "https://api.example.test",
        preset: "minimal",
        transport,
      });
      await expect(client.getJson<{ url: string }>("/json").unsafeRunPromise()).resolves.toMatchObject({
        body: { url: "https://api.example.test/json" },
      });
    } finally {
      if (originalFetch) globalThis.fetch = originalFetch;
      else Reflect.deleteProperty(globalThis, "fetch");
    }
  });

  it("reports unavailable fetch for default transports", async () => {
    const originalFetch = globalThis.fetch;
    try {
      Reflect.deleteProperty(globalThis, "fetch");
      const context = {
        request: { method: "GET", url: "/missing-fetch", headers: {} },
        url: new URL("https://api.example.test/missing-fetch"),
        signal: new AbortController().signal,
      } as any;

      await expect(run(makeFetchTransport()(context))).rejects.toMatchObject({
        _tag: "FetchError",
        message: expect.stringContaining("global `fetch` is not available"),
      });
      await expect(run(makeFetchStreamTransport()(context))).rejects.toMatchObject({
        _tag: "FetchError",
        message: expect.stringContaining("global `fetch` is not available"),
      });
    } finally {
      if (originalFetch) globalThis.fetch = originalFetch;
    }
  });

  it("normalizes pre-aborted linked signals in fetch transports", async () => {
    const fetchMock = vi.fn(async () => new Response("never"));
    vi.stubGlobal("fetch", fetchMock);
    const requestSignal = new AbortController();
    requestSignal.abort();
    const context = {
      request: { method: "GET", url: "/pre-aborted", headers: {}, init: { signal: requestSignal.signal } },
      url: new URL("https://api.example.test/pre-aborted"),
      signal: new AbortController().signal,
    } as any;

    await expect(run(makeFetchTransport()(context))).rejects.toEqual({ _tag: "Abort" });
    await expect(run(makeFetchStreamTransport()(context))).rejects.toEqual({ _tag: "Abort" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts default fetch transports through their direct cancelers", async () => {
    const fetchMock = vi.fn((_input, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const context = {
      request: { method: "GET", url: "/cancel-fetch", headers: {} },
      url: new URL("https://api.example.test/cancel-fetch"),
      signal: new AbortController().signal,
    } as any;
    const exits: unknown[] = [];
    const cancel = makeFetchTransport()(context).register({}, (exit) => exits.push(exit));

    cancel?.();
    cancel?.();
    await wait();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(exits).toHaveLength(1);
  });

  it("handles fetch stream responses without a body", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 204,
      statusText: "No Content",
      headers: { "x-empty": "1" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await run(makeFetchStreamTransport()({
      request: { method: "GET", url: "/stream", headers: {} },
      url: new URL("https://api.example.test/stream"),
      signal: new AbortController().signal,
    } as any));

    expect(response).toMatchObject({
      status: 204,
      statusText: "No Content",
      headers: { "x-empty": "1" },
      ms: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.example.test/stream"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("runs the node HTTP transport with request body and headers", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(201, {
          "content-type": "text/plain",
          "x-received-header": String(req.headers["x-test"] ?? ""),
          "x-received-body": body,
        });
        res.end("created");
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    const transport = makeNodeHttpTransport({ maxSockets: 1, maxFreeSockets: 1 });

    try {
      const response = await run<unknown>(transport({
        request: {
          method: "POST",
          url: "/node",
          headers: { "x-test": "brass" },
          body: "payload",
        },
        url: new URL(`http://127.0.0.1:${address.port}/node`),
        signal: new AbortController().signal,
      } as any));

      expect(response).toMatchObject({
        status: 201,
        statusText: "Created",
        headers: {
          "content-type": "text/plain",
          "x-received-body": "payload",
          "x-received-header": "brass",
        },
        bodyText: "created",
      });
    } finally {
      transport.destroy();
      await closeServer(server);
    }
  });

  it("destroys node transport agents through default client shutdown", async () => {
    const transport = makeNodeHttpTransport();
    const destroy = vi.spyOn(transport, "destroy");
    const client = makeDefaultHttpClient({
      preset: "proxy",
      transport,
    });

    await run(client.shutdown());

    expect(destroy).toHaveBeenCalledOnce();
  });

  it("creates a Node proxy client with the high-throughput preset", async () => {
    const server = createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    const client = makeNodeHttpProxyClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      nodeTransport: {
        maxSockets: 16,
        maxFreeSockets: 16,
      },
    });

    try {
      const response = await client.getJson<{ ok: boolean; url: string }>("/node-proxy").unsafeRunPromise();

      expect(response.body).toEqual({ ok: true, url: "/node-proxy" });
      expect(client.preset).toBe("highThroughputProxy");
      expect(client.features).toEqual({
        dedup: false,
        batch: false,
        cache: false,
        priority: false,
        retry: false,
        prewarm: false,
        adaptiveLimiter: false,
        compression: false,
        middleware: 0,
      });
    } finally {
      await run(client.shutdown());
      await closeServer(server);
    }
  });
});
