import { describe, expect, it } from "vitest";

import { asyncFlatMap, asyncSucceed } from "../../core/types/asyncEffect";
import { Layer, RuntimeService } from "../../core";
import { Runtime, fromPromiseAbortable } from "../../core/runtime/runtime";
import type { HttpTransport } from "../../http/transport";
import { HttpClientService } from "../../http/layer";
import {
  makeObservabilityLayer,
  makeObservedRuntimeLayer,
  makeObservedHttpClientLayer,
  ObservabilityService,
} from "../layer";

const transport: HttpTransport = ({ url }) =>
  asyncSucceed({
    status: 200,
    statusText: "OK",
    headers: {},
    bodyText: url.toString(),
    ms: 1,
  });

describe("Observability Layer integration", () => {
  it("composes observability with an observed default HTTP client", async () => {
    const Config = Layer.tag<{
      readonly serviceName: string;
      readonly baseUrl: string;
    }>("Config");
    const runtime = Runtime.make({});

    const AppLayer = Layer.composeAll(
      Layer.value(Config, {
        serviceName: "orders-api",
        baseUrl: "https://api.example.com",
      }),
      makeObservabilityLayer((ctx) => ({
        serviceName: ctx.unsafeGet(Config).serviceName,
        logs: false,
      })),
      makeObservedRuntimeLayer(),
      makeObservedHttpClientLayer(
        (ctx) => ({
          baseUrl: ctx.unsafeGet(Config).baseUrl,
          preset: "minimal",
          transport,
        }),
        {
          httpObservability: {
            logs: false,
            spans: { name: "http.client" },
          },
        },
      ),
    );

    const result = await runtime.toPromise(
      Layer.provideContext(
        AppLayer,
        Layer.useAll({
          http: HttpClientService,
          observability: ObservabilityService,
          runtime: RuntimeService,
        }, ({ http, observability, runtime: appRuntime }) =>
          asyncFlatMap(asyncSucceed(appRuntime.hasActiveHooks()), (activeHooks) =>
            asyncFlatMap(
              asyncSucceed(appRuntime.env.brass !== undefined),
              (hasTraceEnv) =>
                asyncFlatMap(
                  fromPromiseAbortable(
                    () => appRuntime.toPromise(http.getText("/users/42")),
                    (error) => error,
                  ),
                  (response) =>
                    asyncSucceed({
                      activeHooks,
                      hasTraceEnv,
                      body: response.body,
                      metrics: observability.prometheus.export(),
                      spans: observability.tracer.exportFinished().map((span) => span.name),
                    }),
                ),
            ),
          )
        ),
      ),
    );

    expect(result.body).toBe("https://api.example.com/users/42");
    expect(result.activeHooks).toBe(true);
    expect(result.hasTraceEnv).toBe(true);
    expect(result.metrics).toContain("brass_http_client_requests_total");
    expect(result.metrics).toContain('method="GET"');
    expect(result.metrics).toContain('status="200"');
    expect(result.spans).toContain("http.client");
  });
});
