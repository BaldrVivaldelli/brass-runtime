import { afterEach, describe, expect, it, vi } from "vitest";

import type { HttpMiddleware } from "../client";
import {
  makeDefaultHttpClient,
} from "../defaultClient";
import {
  abortablePromiseStats,
  resetAbortablePromiseStats,
} from "../../core/runtime/runtime";
import { getHttpRequestPolicy } from "../requestPolicy";
import {
  formatPrometheusMetrics,
  makeObservability,
  withHttpObservability,
} from "../../observability";

describe("makeDefaultHttpClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes the three operational profiles and their effective redaction-safe config", () => {
    vi.stubGlobal("fetch", vi.fn());

    const editor = makeDefaultHttpClient({ preset: "editor" });
    const service = makeDefaultHttpClient({
      preset: "service",
      priority: { concurrency: 40 },
      onEvent: () => undefined,
      middleware: [(next) => next],
      policyPresets: { read: { priority: 2 } },
    });
    const proxy = makeDefaultHttpClient({ preset: "highThroughputProxy" });

    expect(editor.profile).toBe("editor");
    expect(editor.effectiveConfig()).toMatchObject({
      version: 1,
      profile: "editor",
      preset: "editor",
      timeoutMs: 15_000,
      priority: { enabled: true, concurrency: 8, queueTimeoutMs: 5_000 },
      retry: { enabled: true, maxRetries: 1, maxElapsedMs: 1_500 },
      cache: { enabled: true, ttlSeconds: 15, maxEntries: 256 },
      adaptiveLimiter: { enabled: true, initialLimit: 8, minLimit: 2, maxLimit: 64 },
      observability: { lifecycleEvents: false, middlewareCount: 0, policyPresetCount: 0 },
    });

    expect(service.profile).toBe("service");
    expect(service.effectiveConfig()).toMatchObject({
      profile: "service",
      priority: { concurrency: 40 },
      retry: { maxRetries: 3 },
      cache: { enabled: true, ttlSeconds: 60 },
      observability: { lifecycleEvents: true, middlewareCount: 1, policyPresetCount: 1 },
    });
    expect(Object.isFrozen(service.effectiveConfig())).toBe(true);
    expect(Object.isFrozen(service.effectiveConfig().retry)).toBe(true);

    expect(proxy.profile).toBe("proxy");
    expect(proxy.effectiveConfig()).toMatchObject({
      profile: "proxy",
      timeoutMs: null,
      priority: { enabled: false },
      retry: { enabled: false, maxRetries: 0 },
      cache: { enabled: false },
      adaptiveLimiter: { enabled: false },
    });
  });

  it("updates the effective middleware count on immutable with composition", () => {
    vi.stubGlobal("fetch", vi.fn());
    const base = makeDefaultHttpClient({ preset: "editor" });
    const wrapped = base.with((next) => next);

    expect(base.effectiveConfig().observability.middlewareCount).toBe(0);
    expect(wrapped.effectiveConfig().observability.middlewareCount).toBe(1);
  });

  it("creates a batteries-included client with JSON helpers and default features", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
    });

    const response = await client.getJson<{ ok: boolean }>("/users/1").unsafeRunPromise();

    expect(response.body).toEqual({ ok: true });
    expect(client.preset).toBe("default");
    expect(client.features).toMatchObject({
      dedup: true,
      cache: true,
      priority: true,
      retry: true,
      adaptiveLimiter: true,
      compression: true,
    });
    expect(client.compression?.stats()).toBeDefined();
    expect(client.stats().requestsCompleted).toBe(1);
    expect(client.wire.adaptiveLimiter?.stats().limit).toBe(32);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the default safe-method cache", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ cached: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
      compression: false,
    });

    await client.getJson<{ cached: boolean }>("/cacheable").unsafeRunPromise();
    await client.getJson<{ cached: boolean }>("/cacheable").unsafeRunPromise();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.stats()).toMatchObject({
      cacheHits: 1,
      cacheMisses: 1,
      requestsCompleted: 2,
    });
  });

  it("does not cache default responses that opt out via cache-control", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ cached: false }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
      compression: false,
    });

    await client.getJson<{ cached: boolean }>("/no-store").unsafeRunPromise();
    await client.getJson<{ cached: boolean }>("/no-store").unsafeRunPromise();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.stats()).toMatchObject({
      cacheHits: 0,
      cacheMisses: 2,
      requestsCompleted: 2,
    });
  });

  it("keeps minimal preset cheap unless features are explicitly enabled", () => {
    vi.stubGlobal("fetch", vi.fn());

    const client = makeDefaultHttpClient({
      preset: "minimal",
      compression: false,
    });

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
    expect(client.compression).toBeUndefined();
  });

  it("keeps proxy preset on the low-latency path by default", async () => {
    resetAbortablePromiseStats();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
      preset: "proxy",
    });

    const response = await client.getJson<{ ok: boolean }>("/users/1").unsafeRunPromise();

    expect(response.body).toEqual({ ok: true });
    expect(client.preset).toBe("proxy");
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
    expect(client.compression).toBeUndefined();
    expect(client.wire.adaptiveLimiter).toBeUndefined();
    expect(client.stats()).toMatchObject({
      queueDepth: 0,
      requestsCompleted: 1,
    });
    expect(abortablePromiseStats()).toMatchObject({ started: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exposes highThroughputProxy as the explicit hot proxy preset", async () => {
    resetAbortablePromiseStats();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
      preset: "highThroughputProxy",
    });

    const response = await client.getJson<{ ok: boolean }>("/users/1").unsafeRunPromise();

    expect(response.body).toEqual({ ok: true });
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
    expect(client.compression).toBeUndefined();
    expect(abortablePromiseStats()).toMatchObject({ started: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets adaptive limiter presets replace default preset internals cleanly", () => {
    vi.stubGlobal("fetch", vi.fn());

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
      compression: false,
      adaptiveLimiter: { preset: "conservative" },
    });

    expect(client.features.adaptiveLimiter).toBe(true);
    expect(client.wire.adaptiveLimiter?.stats()).toMatchObject({
      limit: 8,
      stateCount: 0,
    });
  });

  it("supports production as an explicit alias for the full default preset", () => {
    vi.stubGlobal("fetch", vi.fn());

    const client = makeDefaultHttpClient({
      preset: "production",
      compression: false,
    });

    expect(client.preset).toBe("production");
    expect(client.features).toMatchObject({
      dedup: true,
      cache: true,
      priority: true,
      retry: true,
      adaptiveLimiter: true,
    });
    expect(client.wire.adaptiveLimiter?.stats().limit).toBe(32);
  });

  it("applies caller middleware outermost for observability/auth style extensions", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const addHeader: HttpMiddleware = (next) => (req) =>
      next({
        ...req,
        headers: {
          ...(req.headers ?? {}),
          "x-observed": "1",
        },
      });

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
      preset: "balanced",
      compression: false,
      middleware: [addHeader],
    });

    const response = await client.getText("/health").unsafeRunPromise();

    expect(response.body).toBe("ok");
    expect(client.features.middleware).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ "x-observed": "1" }),
    });
  });

  it("resolves named policy presets before user middleware and lifecycle layers", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const captured: unknown[] = [];

    const capture: HttpMiddleware = (next) => (req) => {
      captured.push(req);
      return next(req);
    };

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
      preset: "balanced",
      compression: false,
      policyPresets: {
        readModel: {
          lane: "read-model",
          poolKey: "users-api",
          priority: 1,
          retry: { maxRetries: 1 },
        },
      },
      middleware: [capture],
    });

    await expect(client.getText("/users/1", {
      policy: { preset: "readModel", dedupKey: "users:1" },
    }).unsafeRunPromise()).resolves.toMatchObject({ body: "ok" });

    expect(captured).toHaveLength(1);
    expect(getHttpRequestPolicy(captured[0] as any)).toEqual({
      preset: "readModel",
      lane: "read-model",
      poolKey: "users-api",
      priority: 1,
      retry: { maxRetries: 1 },
      dedupKey: "users:1",
    });
    expect((captured[0] as any).poolKey).toBe("users-api");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves adaptive limiter metadata for observability middleware", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const obs = makeObservability();

    const client = makeDefaultHttpClient({
      baseUrl: "https://api.example.test",
      compression: false,
      middleware: [
        withHttpObservability({
          metrics: obs.metrics,
          spans: false,
          route: "/health",
        }),
      ],
    });

    await client.getText("/health").unsafeRunPromise();

    const metrics = formatPrometheusMetrics(obs.metrics.snapshot());
    expect(metrics).toContain('brass_http_adaptive_limiter_limit{method="GET",route="/health"} 32');
    expect(metrics).toContain('brass_http_adaptive_limiter_state_count{method="GET",route="/health"} 1');
  });
});
