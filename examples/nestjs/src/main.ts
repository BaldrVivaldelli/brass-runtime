import "reflect-metadata";
import {
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Req,
  Res,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { makeExpressRequestObservabilityContext } from "brass-runtime/observability";
import {
  buildExampleBrass,
  getExampleUserEffect,
  portFromEnv,
  type ExampleBrass,
} from "../../shared/src";

@Injectable()
class BrassService implements OnApplicationShutdown {
  private readonly brassPromise = buildExampleBrass({
    serviceName: "brass-nestjs-example",
    environment: "local",
  });

  get(): Promise<ExampleBrass> {
    return this.brassPromise;
  }

  async onApplicationShutdown() {
    const brass = await this.brassPromise;
    await brass.shutdown();
  }
}

@Controller()
class AppController {
  constructor(private readonly brassService: BrassService) {}

  @Get("/users/:id")
  async user(@Param("id") id: string, @Req() req: any) {
    const brass = await this.brassService.get();
    const ctx = makeExpressRequestObservabilityContext(brass.observability, req, {
      route: "/users/:id",
    });
    const response = await ctx.run(
      ctx.withRequestSpan(getExampleUserEffect(brass, id)),
    );

    return {
      user: response.body,
      traceId: ctx.trace?.traceId,
    };
  }

  @Get("/metrics")
  async metrics(@Res() res: any) {
    const brass = await this.brassService.get();
    return res
      .type(brass.observability.prometheus.contentType)
      .send(brass.observability.prometheus.export());
  }

  @Get("/health")
  async health() {
    const brass = await this.brassService.get();
    return brass.observability.health();
  }
}

@Module({
  providers: [BrassService],
  controllers: [AppController],
})
class AppModule {}

async function main() {
  const app = await NestFactory.create(AppModule, {
    logger: ["log", "warn", "error"],
  });
  const port = portFromEnv(3002);

  app.enableShutdownHooks();
  await app.listen(port);

  console.log(`NestJS example listening on http://localhost:${port}`);
  console.log(`Try: curl http://localhost:${port}/users/42`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

