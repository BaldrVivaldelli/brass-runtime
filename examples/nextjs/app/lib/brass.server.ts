import "server-only";
import {
  createExampleBrass,
  getExampleUserEffect,
  type ExampleBrass,
} from "../../../shared/src";

let singleton: ExampleBrass | undefined;

export function getServerBrass(): ExampleBrass {
  if (!singleton) {
    singleton = createExampleBrass({
      serviceName: process.env.OTEL_SERVICE_NAME ?? "brass-nextjs-example",
      environment: process.env.NODE_ENV ?? "development",
      apiBaseUrl: process.env.USERS_API_BASE_URL ?? "https://example.local",
      otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      mockOtlp: process.env.BRASS_EXAMPLE_REAL_OTLP !== "true",
    });
  }

  return singleton;
}

export async function readExampleUser(id: string) {
  const brass = getServerBrass();
  const response = await brass.runtime.toPromise(getExampleUserEffect(brass, id));
  return response.body;
}

