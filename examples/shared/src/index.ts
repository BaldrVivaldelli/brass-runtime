import { Runtime } from "brass-runtime/core";
import {
  HttpClientService,
  defineHttpPolicyPresets,
  makeDefaultHttpClient,
  promiseHttpTransport,
  type DefaultHttpClient,
} from "brass-runtime/http";
import { s, type InferSchema } from "brass-runtime/schema";
import {
  ObservabilityService,
  makeObservability,
  makeObservabilityLayer,
  makeObservedHttpClientLayer,
  makeObservedRuntimeLayer,
  makeOtlpOptions,
  withHttpObservability,
  type Observability,
  type ObservabilityOptions,
} from "brass-runtime/observability";
import {
  Layer,
  LayerContext,
  RuntimeService,
  makeConfigLayer,
} from "brass-runtime/core";

export const ExampleConfigService = Layer.tag<ExampleConfig>("ExampleConfig");

export const ExampleConfigSchema = s.object({
  serviceName: s.nonEmptyString(),
  apiBaseUrl: s.url(),
  environment: s.nonEmptyString().optional(),
  otlpEndpoint: s.url().optional(),
});

export const ExampleUserSchema = s.object({
  id: s.nonEmptyString(),
  name: s.nonEmptyString(),
  role: s.enum(["admin", "user"] as const),
});

export type ExampleConfig = InferSchema<typeof ExampleConfigSchema>;
export type ExampleUser = InferSchema<typeof ExampleUserSchema>;

export type ExampleConfigInput = Partial<ExampleConfig> & {
  readonly mockOtlp?: boolean;
};

export type ExampleBrass = {
  readonly config: ExampleConfig;
  readonly observability: Observability;
  readonly runtime: Runtime<any>;
  readonly http: DefaultHttpClient;
  readonly getUser: (id: string) => Promise<ExampleUser>;
  readonly shutdown: () => Promise<void>;
};

export const examplePolicyPresets = defineHttpPolicyPresets({
  readModel: {
    lane: "read-model",
    priority: 3,
    retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1_000 },
  },
  command: {
    lane: "command",
    priority: 1,
    retry: false,
  },
});

export function exampleConfigFromEnv(input: ExampleConfigInput = {}): ExampleConfig {
  const env = readProcessEnv();
  return {
    serviceName: input.serviceName ?? env.OTEL_SERVICE_NAME ?? "brass-example",
    apiBaseUrl: input.apiBaseUrl ?? env.USERS_API_BASE_URL ?? "https://example.local",
    environment: input.environment ?? env.NODE_ENV ?? "development",
    ...(input.otlpEndpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? { otlpEndpoint: input.otlpEndpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
  };
}

export function createExampleBrass(input: ExampleConfigInput = {}): ExampleBrass {
  const config = exampleConfigFromEnv(input);
  const observability = makeExampleObservability(config, input);
  const runtime = new Runtime({
    env: observability.env,
    hooks: observability.hooks,
    inferLane: false,
  });
  const http = makeDefaultHttpClient({
    baseUrl: config.apiBaseUrl,
    preset: "production",
    policyPresets: examplePolicyPresets,
    transport: makeExampleTransport(),
    middleware: [
      withHttpObservability({
        metrics: observability.metrics,
        policy: { enabled: true, labelKeys: ["preset", "lane"] },
      }),
    ],
  });

  return {
    config,
    observability,
    runtime,
    http,
    getUser: async (id) => {
      const response = await runtime.toPromise(getExampleUserEffect({ http }, id));
      return response.body;
    },
    shutdown: async () => {
      await runtime.toPromise(http.shutdown());
      await observability.shutdown();
    },
  };
}

export async function buildExampleBrass(input: ExampleConfigInput = {}): Promise<ExampleBrass> {
  const config = exampleConfigFromEnv(input);
  const bootstrap = Runtime.make({});
  const built = await bootstrap.toPromise(Layer.build(makeExampleAppLayer(config, input)));
  const context = built.service;
  const runtime = context.unsafeGet(RuntimeService);
  const observability = context.unsafeGet(ObservabilityService);
  const http = context.unsafeGet(HttpClientService);

  return {
    config,
    observability,
    runtime,
    http,
    getUser: async (id) => {
      const response = await runtime.toPromise(getExampleUserEffect({ http }, id));
      return response.body;
    },
    shutdown: async () => {
      await bootstrap.toPromise(built.close());
    },
  };
}

export function makeExampleAppLayer(
  config: ExampleConfig,
  input: ExampleConfigInput = {},
) {
  return Layer.composeAll(
    makeConfigLayer(ExampleConfigService, ExampleConfigSchema, config, { name: "ExampleConfig" }),
    makeObservabilityLayer((ctx) =>
      makeExampleObservabilityOptions(ctx.unsafeGet(ExampleConfigService), input)
    ),
    makeObservedRuntimeLayer({
      inferLane: false,
      env: (ctx: LayerContext) => ({
        config: ctx.unsafeGet(ExampleConfigService),
      }),
    }),
    makeObservedHttpClientLayer((ctx) => ({
      baseUrl: ctx.unsafeGet(ExampleConfigService).apiBaseUrl,
      preset: "production",
      policyPresets: examplePolicyPresets,
      transport: makeExampleTransport(),
    }), {
      httpObservability: {
        policy: { enabled: true, labelKeys: ["preset", "lane"] },
      },
    }),
  );
}

export function getExampleUserEffect(
  brass: Pick<ExampleBrass, "http">,
  id: string,
) {
  return brass.http.getJson(`/users/${encodeURIComponent(id)}`, {
    schema: ExampleUserSchema,
    schemaName: "ExampleUser",
    policy: "readModel",
    timeoutMs: 2_000,
    headers: { "x-example-client": "brass-runtime" },
  });
}

export function makeExampleTransport(latencyMs = 20) {
  return promiseHttpTransport()
    .requestConfig(({ request, url }) => ({
      url: url.toString(),
      method: request.method,
      headers: request.headers,
      body: request.body,
    }))
    .send(async (config) => {
      await sleepWithSignal(latencyMs, config.signal);
      return exampleResponseFor(config.url, config.method);
    })
    .json(
      (response) => response.data,
      (response) => ({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    );
}

export function makeExampleObservability(
  config: ExampleConfig,
  input: ExampleConfigInput = {},
): Observability {
  return makeObservability(makeExampleObservabilityOptions(config, input));
}

export function makeExampleObservabilityOptions(
  config: ExampleConfig,
  input: ExampleConfigInput = {},
): ObservabilityOptions {
  const mockOtlp = input.mockOtlp ?? true;

  return {
    serviceName: config.serviceName,
    resource: {
      "deployment.environment": config.environment ?? "development",
      "example.name": config.serviceName,
    },
    logs: isBrowserRuntime() ? false : { minLevel: "info" },
    sampling: { ratio: 1, respectRemoteSampled: true, forceSampleOnError: true },
    redaction: {},
    cardinality: { maxValuesPerLabel: 100 },
    ...(config.otlpEndpoint
      ? {
          otlp: makeOtlpOptions({
            endpoint: config.otlpEndpoint,
            fetch: mockOtlp ? mockOtlpFetch(config.serviceName) : undefined,
            timeoutMs: 5_000,
            retry: { attempts: 2, initialDelayMs: 100, maxDelayMs: 1_000 },
            pipeline: {
              maxQueueSize: 1_000,
              batchSize: 128,
              dropPolicy: "drop-oldest",
              shutdownTimeoutMs: 5_000,
            },
          }),
          flushIntervalMs: 5_000,
          autoStart: true,
        }
      : { autoStart: false }),
  };
}

export function portFromEnv(defaultPort: number): number {
  const env = readProcessEnv();
  const parsed = Number.parseInt(env.PORT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultPort;
}

export async function closeHttpServer(server: { close: (cb: () => void) => void }): Promise<void> {
  await new Promise<void>((resolve) => server.close(resolve));
}

export function installShutdownHandlers(close: () => Promise<void>): void {
  const maybeProcess = (globalThis as any).process;
  if (!maybeProcess?.once) return;

  const shutdown = async (signal: string) => {
    console.log(`received ${signal}, shutting down Brass example`);
    await close();
    maybeProcess.exit(0);
  };

  maybeProcess.once("SIGINT", shutdown);
  maybeProcess.once("SIGTERM", shutdown);
}

function exampleResponseFor(urlValue: string, method: string) {
  const url = new URL(urlValue);

  if (url.pathname.startsWith("/users/")) {
    const id = decodeURIComponent(url.pathname.slice("/users/".length)) || "unknown";
    return {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      data: {
        id,
        name: id === "1" ? "Ada Lovelace" : "Katherine Johnson",
        role: id === "1" ? "admin" : "user",
      },
    };
  }

  if (url.pathname === "/checkout" && method === "POST") {
    return {
      status: 202,
      statusText: "Accepted",
      headers: { "content-type": "application/json" },
      data: { accepted: true },
    };
  }

  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    data: { ok: true, path: url.pathname },
  };
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };

    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function mockOtlpFetch(serviceName: string) {
  return async (url: string, init: { body?: unknown }) => {
    const body = typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? {});
    const signal = url.includes("/v1/traces") ? "traces" : url.includes("/v1/logs") ? "logs" : "metrics";
    console.log(`[${serviceName}] mocked OTLP ${signal}: ${body.length} bytes`);
    return { ok: true, status: 202, text: async () => "" };
  };
}

function readProcessEnv(): Record<string, string | undefined> {
  return (globalThis as any).process?.env ?? {};
}

function isBrowserRuntime(): boolean {
  return typeof (globalThis as any).window === "object";
}
