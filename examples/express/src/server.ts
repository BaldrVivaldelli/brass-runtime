import express from "express";
import { makeExpressRequestObservabilityContext } from "brass-runtime/observability";
import {
  buildExampleBrass,
  closeHttpServer,
  getExampleUserEffect,
  installShutdownHandlers,
  portFromEnv,
} from "../../shared/src";

async function main() {
  const brass = await buildExampleBrass({
    serviceName: "brass-express-example",
    environment: "local",
  });
  const app = express();
  const port = portFromEnv(3000);

  app.get("/users/:id", async (req, res, next) => {
    const ctx = makeExpressRequestObservabilityContext(brass.observability, req, {
      route: "/users/:id",
    });

    try {
      const response = await ctx.run(
        ctx.withRequestSpan(getExampleUserEffect(brass, req.params.id)),
      );

      res.json({
        user: response.body,
        traceId: ctx.trace?.traceId,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/metrics", (_req, res) => {
    res
      .type(brass.observability.prometheus.contentType)
      .send(brass.observability.prometheus.export());
  });

  app.get("/health", (_req, res) => {
    res.json(brass.observability.health());
  });

  const server = app.listen(port, () => {
    console.log(`Express example listening on http://localhost:${port}`);
    console.log(`Try: curl http://localhost:${port}/users/42`);
  });

  installShutdownHandlers(async () => {
    await closeHttpServer(server);
    await brass.shutdown();
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

