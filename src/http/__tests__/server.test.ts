import { describe, expect, it } from "vitest";
import { request as nodeRequest } from "node:http";

import { makeMetrics } from "../../core/runtime/metrics";
import { RuntimeRegistry } from "../../core/runtime/registry";
import { Runtime } from "../../core/runtime/runtime";
import { asyncSucceed } from "../../core/types/asyncEffect";
import {
  formatPrometheusMetrics,
  makeObservability,
} from "../../observability";
import {
  empty,
  json,
  makeHttpRouter,
  makeRuntimeHealthRoute,
  makeRuntimeReadinessRoute,
  makeNodeHttpServerResource,
  makeNodeHttpServer,
  route,
  s,
  text,
  withResponseHeader,
} from "../index";

const runtime = new Runtime({ env: {} });
const flushEvents = () => new Promise((resolve) => setTimeout(resolve, 0));
const rawNodeGet = (baseUrl: string, path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const url = new URL(baseUrl);
  const req = nodeRequest({
    host: url.hostname,
    port: url.port,
    method: "GET",
    path,
  }, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
  });
  req.on("error", reject);
  req.end();
});

const request = (overrides: {
  readonly method?: string;
  readonly path?: string;
  readonly query?: Record<string, string>;
  readonly bodyText?: string;
} = {}) => ({
  method: overrides.method ?? "GET",
  url: `http://localhost${overrides.path ?? "/"}`,
  path: overrides.path ?? "/",
  target: overrides.path ?? "/",
  headers: {},
  query: overrides.query ?? {},
  params: {},
  bodyText: overrides.bodyText ?? "",
});

describe("HTTP server router", () => {
  it("routes requests through effect middleware and schema validation", async () => {
    const paramsSchema = s.object({ id: s.nonEmptyString() });
    const querySchema = s.object({ verbose: s.enum(["true", "false"] as const).optional() });
    const bodySchema = s.object({ name: s.nonEmptyString() });
    const responseSchema = s.object({ ok: s.boolean(), id: s.string() });
    const router = makeHttpRouter([
      route(
        "POST",
        "/users/:id",
        {
          params: paramsSchema,
          query: querySchema,
          body: bodySchema,
          response: responseSchema,
          middleware: [withResponseHeader("x-runtime", "brass")],
        },
        (ctx) => {
          const id: string = ctx.params.id;
          const name: string = ctx.body.name;
          return asyncSucceed(json({
            ok: ctx.query.verbose === "true",
            id,
            name,
          }, { status: 201 }));
        },
      ),
    ]);

    const response = await runtime.toPromise(router.handle(request({
      method: "POST",
      path: "/users/42",
      query: { verbose: "true" },
      bodyText: JSON.stringify({ name: "Ada" }),
    })));

    expect(response).toMatchObject({
      status: 201,
      headers: {
        "content-type": "application/json",
        "x-runtime": "brass",
      },
      body: {
        ok: true,
        id: "42",
        name: "Ada",
      },
    });
  });

  it("returns request and response validation failures as HTTP responses", async () => {
    const router = makeHttpRouter([
      route(
        "POST",
        "/users/:id",
        {
          params: s.object({ id: s.nonEmptyString() }),
          body: s.object({ name: s.nonEmptyString() }),
          response: s.object({ ok: s.boolean() }),
        },
        () => asyncSucceed(json({ nope: true })),
      ),
    ]);

    const badRequest = await runtime.toPromise(router.handle(request({
      method: "POST",
      path: "/users/42",
      bodyText: JSON.stringify({ name: "" }),
    })));
    expect(badRequest.status).toBe(400);
    expect(badRequest.body).toMatchObject({
      error: "Request validation failed",
      phase: "request",
      schema: "body",
    });

    const badResponse = await runtime.toPromise(router.handle(request({
      method: "POST",
      path: "/users/42",
      bodyText: JSON.stringify({ name: "Ada" }),
    })));
    expect(badResponse.status).toBe(500);
    expect(badResponse.body).toMatchObject({
      error: "Response validation failed",
      phase: "response",
      schema: "response",
    });
  });

  it("reports 404 and 405 without touching route handlers", async () => {
    let handled = false;
    const router = makeHttpRouter([
      route("POST", "/users/:id", () => {
        handled = true;
        return asyncSucceed(json({ ok: true }));
      }),
    ]);

    const notFound = await runtime.toPromise(router.handle(request({ path: "/missing" })));
    const methodNotAllowed = await runtime.toPromise(router.handle(request({ method: "GET", path: "/users/1" })));

    expect(notFound.status).toBe(404);
    expect(methodNotAllowed).toMatchObject({
      status: 405,
      headers: { allow: "POST" },
    });
    expect(handled).toBe(false);
  });

  it("mounts runtime health and readiness probes as HTTP routes", async () => {
    const registry = new RuntimeRegistry();
    registry.emit({ type: "fiber.start", fiberId: 1, name: "probe" }, {});
    registry.emit({ type: "fiber.suspend", fiberId: 1, reason: "awaiting-io" }, {});
    registry.emit({ type: "scope.open", scopeId: 10 }, { fiberId: 1 });
    registry.emit({ type: "scope.close", scopeId: 10, status: "success" }, {});

    const metrics = makeMetrics();
    metrics.gauge("brass_runtime_fibers_active").set(1);
    metrics.gauge("brass_runtime_scopes_active").set(0);
    metrics.gauge("brass_runtime_spans_active").set(2);

    const fakeRuntime = {
      stats: () => ({ engine: "ts", fallbackUsed: false, data: { activeFibers: 1 } }),
      scheduler: {
        stats: () => ({ engine: "ts", fallbackUsed: false, data: { len: 0, droppedTasks: 1 } }),
      },
    } as any;

    const router = makeHttpRouter([
      makeRuntimeHealthRoute({
        runtime: fakeRuntime,
        registry,
        metrics,
        clock: () => 0,
      }),
      makeRuntimeReadinessRoute({
        adaptiveLimiters: {
          api: {
            stats: () => ({
              limit: 2,
              inFlight: 0,
              queueDepth: 0,
              gradient: undefined,
              latencyGradient: undefined,
              errorRate: 0,
              smoothedLatency: undefined,
              minLatency: undefined,
              baselineLatency: undefined,
              p5: undefined,
              p50: undefined,
              p99: undefined,
              probeCount: 0,
              windowSize: 0,
              rejectionRate: 0.75,
            }),
          },
        },
        clock: () => 0,
      }),
    ]);

    const health = await runtime.toPromise(router.handle(request({ path: "/health" })));
    expect(health.status).toBe(200);
    expect(health.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(health.body))).toMatchObject({
      status: "degraded",
      ready: true,
      checkedAt: "1970-01-01T00:00:00.000Z",
      fibers: { active: 1, suspended: 1, done: 0 },
      scopes: { open: 0, closed: 1 },
      metrics: { gauges: 3, activeFibers: 1, activeScopes: 0, activeSpans: 2 },
      runtime: {
        engine: "ts",
        fiberStats: { activeFibers: 1 },
        scheduler: { data: { droppedTasks: 1 } },
      },
    });

    const readiness = await runtime.toPromise(router.handle(request({ path: "/ready" })));
    expect(readiness.status).toBe(503);
    expect(JSON.parse(String(readiness.body))).toMatchObject({
      status: "down",
      ready: false,
      adaptiveLimiters: {
        api: { status: "down", rejectionRate: 0.75 },
      },
    });
  });
});

describe("Node HTTP server adapter", () => {
  it("serves routes and records server observability", async () => {
    const obs = makeObservability({ logs: false });
    const router = makeHttpRouter([
      route("GET", "/health", () => asyncSucceed(json({ ok: true }))),
    ]);
    const handle = await runtime.toPromise(makeNodeHttpServer({
      router,
      observability: obs,
      observabilityOptions: { logs: false },
      host: "127.0.0.1",
    }));

    try {
      const response = await fetch(`${handle.url()}/health`, {
        headers: {
          traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await handle.close();
    }
    await flushEvents();

    const metrics = formatPrometheusMetrics(obs.metrics.snapshot());
    expect(metrics).toContain('brass_http_server_requests_total{method="GET",outcome="success",route="/health",status="200"} 1');
    const span = obs.tracer.exportFinished().find((item) => item.name === "GET /health");
    expect(span).toMatchObject({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parentSpanId: "bbbbbbbbbbbbbbbb",
      attrs: expect.objectContaining({
        "span.kind": "server",
        "http.route": "/health",
      }),
    });
  });

  it("serves Node requests without observability and encodes response helper bodies", async () => {
    const router = makeHttpRouter([
      route("GET", "/query", (ctx) => asyncSucceed(json({ query: ctx.query }))),
      route("GET", "/text", () => asyncSucceed(text("hello"))),
      route("GET", "/empty", () => asyncSucceed(empty())),
      route("GET", "/bytes", () => asyncSucceed({ body: new Uint8Array([1, 2, 3]) })),
      route("GET", "/array-buffer", () => asyncSucceed({ body: new Uint8Array([4, 5]).buffer })),
    ]);
    const handle = await runtime.toPromise(makeNodeHttpServer({
      router,
      host: "127.0.0.1",
      env: {},
      runtimeOptions: { inferLane: false },
    }));

    try {
      await expect(fetch(`${handle.url()}/query?a=1&a=2&b=3`).then((res) => res.json()))
        .resolves
        .toEqual({ query: { a: ["1", "2"], b: "3" } });
      await expect(fetch(`${handle.url()}/query?a=1&a=2&a=3`).then((res) => res.json()))
        .resolves
        .toEqual({ query: { a: ["1", "2", "3"] } });

      const textResponse = await fetch(`${handle.url()}/text`);
      expect(textResponse.headers.get("content-type")).toContain("text/plain");
      await expect(textResponse.text()).resolves.toBe("hello");

      const emptyResponse = await fetch(`${handle.url()}/empty`);
      expect(emptyResponse.status).toBe(204);
      await expect(emptyResponse.text()).resolves.toBe("");

      await expect(fetch(`${handle.url()}/bytes`).then((res) => res.arrayBuffer()).then((buf) => [...new Uint8Array(buf)]))
        .resolves
        .toEqual([1, 2, 3]);
      await expect(fetch(`${handle.url()}/array-buffer`).then((res) => res.arrayBuffer()).then((buf) => [...new Uint8Array(buf)]))
        .resolves
        .toEqual([4, 5]);
    } finally {
      await handle.close();
    }
  });

  it("reports request read errors and keeps serving malformed path segments conservatively", async () => {
    const errors: unknown[] = [];
    const circular: any = {};
    circular.self = circular;
    const router = makeHttpRouter([
      route("POST", "/limited", () => asyncSucceed(json({ ok: true }))),
      route("GET", "/bad/:id", (ctx) => asyncSucceed(json({ id: ctx.params.id }))),
      route(
        "GET",
        "/circular",
        { response: s.object({ ok: s.boolean() }) },
        () => asyncSucceed(circular),
      ),
    ]);
    const handle = await runtime.toPromise(makeNodeHttpServer({
      router,
      host: "127.0.0.1",
      maxBodyBytes: 2,
      onError: (error) => errors.push(error),
    }));

    try {
      await fetch(`${handle.url()}/limited`, { method: "POST", body: "too large" }).catch((error) => {
        errors.push(error);
        return undefined;
      });
      expect(errors.some((error) => String((error as any)?.message ?? error).includes("exceeded 2 bytes"))).toBe(true);

      const malformed = await rawNodeGet(handle.url()!, "/bad/%E0%A4%A");
      expect(malformed.status).toBe(200);
      expect(JSON.parse(malformed.body)).toEqual({ id: "%E0%A4%A" });

      const badResponse = await fetch(`${handle.url()}/circular`);
      expect(badResponse.status).toBe(500);
      await expect(badResponse.json()).resolves.toMatchObject({
        error: "Response validation failed",
        phase: "response",
      });
    } finally {
      await handle.close();
    }
  });

  it("closes Node servers through Resource release and reports listen errors", async () => {
    const router = makeHttpRouter([
      route("GET", "/health", () => asyncSucceed(json({ ok: true }))),
    ]);
    const url = await runtime.toPromise(
      router.listen({ host: "127.0.0.1" })
        .use((handle) => asyncSucceed(handle.url())),
    );
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);

    const resourceUrl = await runtime.toPromise(
      makeNodeHttpServerResource({ router, host: "127.0.0.1" })
        .use((handle) => asyncSucceed(handle.url())),
    );
    expect(resourceUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);

    const first = await runtime.toPromise(makeNodeHttpServer({
      router,
      host: "127.0.0.1",
      port: 0,
    }));
    const address = first.address();
    expect(typeof address).toBe("object");

    try {
      await expect(runtime.toPromise(makeNodeHttpServer({
        router,
        host: "127.0.0.1",
        port: typeof address === "object" && address ? address.port : 0,
      }))).rejects.toMatchObject({
        _tag: "ListenError",
      });
    } finally {
      await first.close();
    }
  });
});
