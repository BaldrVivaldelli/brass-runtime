import { asyncFlatMap, asyncSucceed } from "../core/types/asyncEffect";
import {
  logEffect,
  makeFastifyRequestObservabilityContext,
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
  const fastifyModule = await loadOptionalPackage<any>("fastify", "npm install --save-dev fastify");
  const fastify = fastifyModule.default ?? fastifyModule;
  const app = fastify({ logger: true });
  const port = portFromEnv(3001);
  const observability = makeObservabilityFromEnv(process.env, {
    serviceName: "brass-fastify-example",
    otlp: {
      metricsUrl: "http://example-collector.local/v1/metrics",
      tracesUrl: "http://example-collector.local/v1/traces",
      fetch: exampleOtlpFetch("fastify"),
    },
    flushIntervalMs: 5_000,
  });

  app.get("/users/:id", async (request: any, reply: any) => {
    const params = request.params as { id: string };
    const ctx = makeFastifyRequestObservabilityContext(observability, request, {
      route: "/users/:id",
    });

    const user = await ctx.run(
      ctx.withRequestSpan(
        withLogContext(
          { requestId: request.headers["x-request-id"] ?? "missing" },
          asyncFlatMap(
            logEffect("info", "fastify.user.lookup", {
              userId: params.id,
              authorization: request.headers.authorization,
            }),
            () => asyncSucceed({ id: params.id, name: "Grace Hopper" })
          )
        )
      )
    );

    return reply.send({ user, traceId: ctx.trace?.traceId });
  });

  app.get("/metrics", async (_request: any, reply: any) => {
    return reply
      .type(observability.prometheus.contentType)
      .send(observability.prometheus.export());
  });

  await app.listen({ port, host: "0.0.0.0" });
  console.log(`Fastify observability example listening on http://localhost:${port}`);
  console.log(`Try: curl -H 'traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' http://localhost:${port}/users/42`);

  installShutdownHandlers(observability, () => app.close());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
