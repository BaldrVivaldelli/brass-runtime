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
  const expressModule = await loadOptionalPackage<any>("express", "npm install --save-dev express");
  const express = expressModule.default ?? expressModule;
  const app = express();
  const port = portFromEnv(3000);
  const observability = makeObservabilityFromEnv(process.env, {
    serviceName: "brass-express-example",
    otlp: {
      metricsUrl: "http://example-collector.local/v1/metrics",
      tracesUrl: "http://example-collector.local/v1/traces",
      fetch: exampleOtlpFetch("express"),
    },
    flushIntervalMs: 5_000,
  });

  app.get("/users/:id", async (req: any, res: any, next: (error?: unknown) => void) => {
    const ctx = makeExpressRequestObservabilityContext(observability, req, {
      route: "/users/:id",
    });

    try {
      const user = await ctx.run(
        ctx.withRequestSpan(
          withLogContext(
            { requestId: req.headers["x-request-id"] ?? "missing" },
            asyncFlatMap(
              logEffect("info", "express.user.lookup", {
                userId: req.params.id,
                authorization: req.headers.authorization,
              }),
              () => asyncSucceed({ id: req.params.id, name: "Ada Lovelace" })
            )
          )
        )
      );

      res.json({ user, traceId: ctx.trace?.traceId });
    } catch (error) {
      next(error);
    }
  });

  app.get("/metrics", (_req: any, res: any) => {
    res.type(observability.prometheus.contentType).send(observability.prometheus.export());
  });

  const server = app.listen(port, () => {
    console.log(`Express observability example listening on http://localhost:${port}`);
    console.log(`Try: curl -H 'traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' http://localhost:${port}/users/42`);
  });

  installShutdownHandlers(observability, () => new Promise<void>((resolve) => server.close(() => resolve())));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
