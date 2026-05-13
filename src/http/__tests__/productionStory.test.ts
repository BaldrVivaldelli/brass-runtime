import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../../core/runtime/runtime";
import { s } from "../../schema";
import {
  formatPrometheusMetrics,
  makeObservability,
  type StructuredLogRecord,
  withHttpObservability,
} from "../../observability";
import { makeDefaultHttpClient } from "../defaultClient";
import { defineHttpPolicyPresets, getHttpRequestPolicy } from "../requestPolicy";
import { promiseHttpTransport } from "../transport";
import type { HttpRequest } from "../client";

const flushEvents = () => new Promise((resolve) => setTimeout(resolve, 0));

const User = s.object({
  id: s.int(),
  email: s.email(),
  name: s.nonEmptyString(),
});

describe("HTTP production adoption story", () => {
  it("runs custom transport, policy presets, observability, schema validation, and error mapping together", async () => {
    const logs: StructuredLogRecord[] = [];
    const obs = makeObservability({
      serviceName: "users-bff",
      logs: { write: (record) => logs.push(record) },
    });
    const rt = new Runtime({ env: obs.env, hooks: obs.hooks });
    const capturedRequests: HttpRequest[] = [];

    const transport = promiseHttpTransport()
      .requestConfig(({ request, url }) => {
        capturedRequests.push(request);
        return {
          url: url.toString(),
          method: request.method,
          headers: request.headers,
          data: request.body,
          cache: request.init?.cache,
          responseType: "json" as const,
        };
      })
      .send(vi.fn(async (config: {
        readonly url: string;
        readonly method: string;
        readonly headers?: Record<string, string>;
        readonly cache?: RequestCache;
        readonly responseType: "json";
        readonly signal: AbortSignal;
      }) => {
        expect(config.signal).toBeInstanceOf(AbortSignal);
        if (config.url.endsWith("/fail")) {
          throw Object.assign(new Error("upstream unavailable"), {
            isAxiosError: true,
            response: { status: 503, statusText: "Service Unavailable" },
          });
        }
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          data: { id: 1, email: "ada@example.com", name: "Ada" },
        };
      }))
      .json();

    const policies = defineHttpPolicyPresets({
      readModel: {
        lane: "read-model",
        poolKey: "users-api",
        priority: 2,
        retry: { maxRetries: 2, baseDelayMs: 50 },
      },
    });

    const http = makeDefaultHttpClient({
      preset: "production",
      baseUrl: "https://api.example.test",
      transport,
      policyPresets: policies,
      middleware: [
        withHttpObservability({
          metrics: obs.metrics,
          logs: { requestLevel: "debug", responseLevel: "info", errorLevel: "warn" },
          route: (req) => req.url.includes("fail") ? "/fail" : "/users/:id",
          policy: { labelKeys: ["preset", "lane", "poolKey"] },
        }),
      ],
    });

    await expect(rt.toPromise(http.getJson("/users/1", {
      schema: User,
      policy: { preset: "readModel", dedupKey: "users:1" },
      cache: "no-store",
    }))).resolves.toMatchObject({
      body: { id: 1, email: "ada@example.com", name: "Ada" },
    });

    const successRequest = capturedRequests[0]!;
    expect(getHttpRequestPolicy(successRequest)).toMatchObject({
      preset: "readModel",
      lane: "read-model",
      poolKey: "users-api",
      priority: 2,
      retry: { maxRetries: 2, baseDelayMs: 50 },
      dedupKey: "users:1",
    });
    expect(successRequest.init).toMatchObject({ cache: "no-store" });
    expect(successRequest.init?.signal).toBeInstanceOf(AbortSignal);
    expect((successRequest.init as any).schema).toBeUndefined();
    expect((successRequest.init as any).policy).toBeUndefined();

    await expect(rt.toPromise(http.getJson("/fail", {
      schema: User,
      policy: { preset: "readModel", retry: false },
    }))).rejects.toMatchObject({
      _tag: "FetchError",
      status: 503,
      statusText: "Service Unavailable",
    });

    await flushEvents();

    const metrics = formatPrometheusMetrics(obs.metrics.snapshot());
    expect(metrics).toContain('brass_http_client_requests_total{lane="read-model",method="GET",outcome="success",policy="readModel",pool_key="users-api",route="/users/:id",status="200"} 1');
    expect(metrics).toContain('brass_http_client_requests_total{lane="read-model",method="GET",outcome="fetch_error",policy="readModel",pool_key="users-api",route="/fail",status="503"} 1');

    expect(logs.map((record) => record.message)).toEqual([
      "http.client.request",
      "http.client.request",
    ]);
    expect(logs[0].fields).toMatchObject({
      route: "/users/:id",
      policy: {
        preset: "readModel",
        lane: "read-model",
        poolKey: "users-api",
        dedupKey: "users:1",
      },
    });
    expect(logs[1].fields).toMatchObject({
      route: "/fail",
      policy: {
        preset: "readModel",
        lane: "read-model",
        poolKey: "users-api",
        retry: "disabled",
      },
    });

    const spans = obs.tracer.exportFinished().filter((span) => span.name === "HTTP GET");
    expect(spans[0]?.attrs).toMatchObject({
      "http.request.policy.preset": "readModel",
      "http.request.policy.lane": "read-model",
      "http.request.policy.pool_key": "users-api",
    });
    expect(spans[1]?.attrs).toMatchObject({
      "http.request.policy.preset": "readModel",
      "http.request.policy.lane": "read-model",
      "http.request.policy.pool_key": "users-api",
    });

    await rt.toPromise(http.shutdown());
    await obs.shutdown();
  });

  it("fails production config validation before the first request", () => {
    expect(() =>
      makeDefaultHttpClient({
        preset: "production",
        policyPresets: {
          readModel: { priority: 99 },
        },
      } as any),
    ).toThrowError(expect.objectContaining({
      _tag: "ConfigValidationError",
      configName: "DefaultHttpClientConfig",
    }));
  });
});
