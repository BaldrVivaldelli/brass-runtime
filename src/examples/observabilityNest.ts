import { asyncFlatMap, asyncSucceed } from "../core/types/asyncEffect";
import {
  logEffect,
  makeExpressRequestObservabilityContext,
  makeObservabilityFromEnv,
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
  const observability = makeObservabilityFromEnv(process.env, {
    serviceName: "brass-nest-example",
    otlp: {
      metricsUrl: "http://example-collector.local/v1/metrics",
      tracesUrl: "http://example-collector.local/v1/traces",
      fetch: exampleOtlpFetch("nest"),
    },
    flushIntervalMs: 5_000,
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
              () => asyncSucceed({ id: req.params.id, name: "Katherine Johnson" })
            )
          )
        )
      );

      return { user, traceId: ctx.trace?.traceId };
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

  installShutdownHandlers(observability, () => app.close());
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
