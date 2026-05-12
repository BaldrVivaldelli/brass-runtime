import { asyncFlatMap } from "../core/types/asyncEffect";
import { makeDefaultHttpClient, promiseHttpTransport } from "../http";
import {
  logEffect,
  makeExpressRequestObservabilityContext,
  makeObservabilityFromEnv,
  makeOtlpOptions,
  withHttpObservability,
  withLogContext,
} from "../observability";
import {
  exampleOtlpFetch,
  installShutdownHandlers,
  loadOptionalPackage,
  portFromEnv,
} from "./observabilityFrameworkHelpers";

async function main() {
  await loadOptionalPackage("reflect-metadata", "npm install --save-dev reflect-metadata");
  await loadOptionalPackage("@nestjs/platform-express", "npm install --save-dev @nestjs/platform-express");
  const core = await loadOptionalPackage<any>("@nestjs/core", "npm install --save-dev @nestjs/core");
  const common = await loadOptionalPackage<any>("@nestjs/common", "npm install --save-dev @nestjs/common rxjs");
  const { NestFactory } = core;
  const { Controller, Get, Module, Req, Res } = common;
  const port = portFromEnv(3002);
  const grafanaAuthorization = process.env.GRAFANA_OTLP_AUTHORIZATION;
  const observability = makeObservabilityFromEnv(process.env, {
    serviceName: "brass-nest-example",
    otlp: makeOtlpOptions({
      endpoint: process.env.GRAFANA_OTLP_ENDPOINT
        ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ?? "http://example-collector.local",
      headers: grafanaAuthorization ? { Authorization: grafanaAuthorization } : undefined,
      fetch: process.env.BRASS_EXAMPLE_REAL_OTLP === "true" ? undefined : exampleOtlpFetch("nest"),
      timeoutMs: 10_000,
      retry: { attempts: 3, initialDelayMs: 100, maxDelayMs: 2_000 },
      pipeline: { maxQueueSize: 10_000, batchSize: 512, dropPolicy: "drop-oldest" },
    }),
    flushIntervalMs: 5_000,
  });
  const usersHttp = makeDefaultHttpClient({
    baseUrl: process.env.USERS_API_BASE_URL ?? "https://users.example.local",
    preset: "production",
    policyPresets: {
      readModel: {
        lane: "read-model",
        priority: 3,
        retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1_000 },
      },
    },
    transport: promiseHttpTransport()
      .requestConfig(({ request, url }) => ({
        url: url.toString(),
        method: request.method,
        headers: request.headers,
        body: request.body,
      }))
      .send(async (config) => ({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        data: {
          id: config.url.split("/").pop() ?? "unknown",
          name: "Katherine Johnson",
          observedSignal: config.signal.aborted ? "aborted" : "linked",
        },
      }))
      .json(
        (response) => response.data,
        (response) => ({
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      ),
    middleware: [withHttpObservability(observability)],
  });

  class AppController {
    async user(req: any) {
      const ctx = makeExpressRequestObservabilityContext(observability, req, {
        route: "/users/:id",
      });

      const user = await ctx.run(
        ctx.withRequestSpan(
          withLogContext(
            { requestId: req.headers["x-request-id"] ?? "missing" },
            asyncFlatMap(
              logEffect("info", "nest.user.lookup", {
                userId: req.params.id,
                authorization: req.headers.authorization,
              }),
              () => usersHttp.getJson(`/users/${req.params.id}`, {
                policy: "readModel",
                timeoutMs: 2_000,
                headers: { "x-request-id": req.headers["x-request-id"] ?? "missing" },
              })
            )
          )
        )
      );

      return { user: user.body, traceId: ctx.trace?.traceId };
    }

    metrics(_req: any, res: any) {
      return res
        .type(observability.prometheus.contentType)
        .send(observability.prometheus.export());
    }
  }

  Controller()(AppController);
  applyRoute(Get("/users/:id"), AppController.prototype, "user");
  Req()(AppController.prototype, "user", 0);
  applyRoute(Get("/metrics"), AppController.prototype, "metrics");
  Req()(AppController.prototype, "metrics", 0);
  Res()(AppController.prototype, "metrics", 1);

  class AppModule {}
  Module({ controllers: [AppController] })(AppModule);

  const app = await NestFactory.create(AppModule, { logger: ["log", "warn", "error"] });
  await app.listen(port);

  console.log(`Nest observability example listening on http://localhost:${port}`);
  console.log(`Try: curl -H 'traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' http://localhost:${port}/users/42`);
  console.log("Set BRASS_EXAMPLE_REAL_OTLP=true with GRAFANA_OTLP_ENDPOINT/GRAFANA_OTLP_AUTHORIZATION to send OTLP traffic to a collector.");

  installShutdownHandlers(observability, async () => {
    await usersHttp.shutdown();
    await app.close();
  });
}

function applyRoute(decorator: MethodDecorator, target: object, key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) throw new Error(`Missing route method '${key}'`);
  decorator(target, key, descriptor);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
