import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Runtime } from "../core/runtime/runtime";
import { Scheduler } from "../core/runtime/scheduler";
import type { Async } from "../core/types/asyncEffect";
import {
  makeHttp,
  type HttpClient,
  type HttpClientStats,
} from "../http/client";
import { makeDefaultHttpClient, type DefaultHttpClient } from "../http/defaultClient";
import type { HttpResponse } from "../http/httpClient";
import type { LifecycleStats } from "../http/lifecycle";
import {
  makeObservability,
  withHttpObservability,
  type Observability,
} from "../observability";
import { captureMemorySnapshot, diffMemorySnapshots, type PerfMemoryDelta } from "./memory";
import type { PerfRecorder } from "./recorder";

export type HttpProfileVariant =
  | "node-http-text"
  | "wire-raw"
  | "default-minimal-json"
  | "default-balanced-no-adaptive-json"
  | "default-balanced-json"
  | "default-json"
  | "default-json-observed";

export type HttpLayerProfileOptions = {
  readonly calls?: number;
  readonly concurrency?: number;
  readonly delayMs?: number;
  readonly timeoutMs?: number;
  readonly warmupCalls?: number;
  readonly statsSampleMs?: number;
  readonly forceGc?: boolean;
  readonly variants?: readonly HttpProfileVariant[];
  readonly recorder?: PerfRecorder;
};

export type HttpLayerProfileResult = {
  readonly variant: HttpProfileVariant;
  readonly label: string;
  readonly calls: number;
  readonly warmupCalls: number;
  readonly concurrency: number;
  readonly delayMs: number;
  readonly timeoutMs: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly durationMs: number;
  readonly warmupDurationMs: number;
  readonly httpPerSec: number;
  readonly requestP50Ms: number;
  readonly requestP90Ms: number;
  readonly requestP95Ms: number;
  readonly requestP99Ms: number;
  readonly serverRequests: number;
  readonly serverMaxInFlight: number;
  readonly clientMaxInFlight: number;
  readonly clientWireMaxInFlight: number;
  readonly clientPoolMaxRunning?: number;
  readonly clientPoolMaxQueued?: number;
  readonly lifecycleMaxQueueDepth?: number;
  readonly lifecycleStarted?: number;
  readonly lifecycleCompleted?: number;
  readonly lifecycleFailed?: number;
  readonly clientStarted?: number;
  readonly clientSucceeded?: number;
  readonly clientFailed?: number;
  readonly clientTimedOut?: number;
  readonly adaptiveMinLimit?: number;
  readonly adaptiveMaxLimit?: number;
  readonly adaptiveFinalLimit?: number;
  readonly adaptiveMaxInFlight?: number;
  readonly adaptiveMaxQueueDepth?: number;
  readonly adaptiveFinalGradient?: number;
  readonly adaptiveWindowSize?: number;
  readonly observedFinishedSpans?: number;
  readonly observedPrunedSpans?: number;
  readonly observabilityFlushMs?: number;
  readonly gcAvailable: boolean;
  readonly memory: {
    readonly before: ReturnType<typeof captureMemorySnapshot>;
    readonly after: ReturnType<typeof captureMemorySnapshot>;
    readonly delta: PerfMemoryDelta;
  };
  readonly firstError?: string;
};

export type HttpLayerProfileReport = {
  readonly calls: number;
  readonly concurrency: number;
  readonly delayMs: number;
  readonly timeoutMs: number;
  readonly warmupCalls: number;
  readonly variants: readonly HttpProfileVariant[];
  readonly results: readonly HttpLayerProfileResult[];
};

type DummyPayload = {
  readonly ok: true;
  readonly id: number;
  readonly delayMs: number;
  readonly path: string;
};

type DummyServer = {
  readonly baseUrl: string;
  readonly stats: () => {
    readonly requests: number;
    readonly maxInFlight: number;
  };
  readonly resetStats: () => void;
  readonly close: () => Promise<void>;
};

type ClientSnapshot = {
  readonly wireInFlight?: number;
  readonly wireStarted?: number;
  readonly wireSucceeded?: number;
  readonly wireFailed?: number;
  readonly wireTimedOut?: number;
  readonly poolRunning?: number;
  readonly poolQueued?: number;
  readonly adaptiveLimit?: number;
  readonly adaptiveInFlight?: number;
  readonly adaptiveQueueDepth?: number;
  readonly adaptiveGradient?: number;
  readonly adaptiveWindowSize?: number;
  readonly lifecycleQueueDepth?: number;
  readonly lifecycleStarted?: number;
  readonly lifecycleCompleted?: number;
  readonly lifecycleFailed?: number;
};

type LoadRunner = (
  id: number,
  cb: (result: { readonly ok: boolean; readonly error?: unknown }) => void,
) => void;

type HttpScenario = {
  readonly variant: HttpProfileVariant;
  readonly label: string;
  readonly calls: number;
  readonly warmupCalls: number;
  readonly idOffset?: number;
  readonly concurrency: number;
  readonly delayMs: number;
  readonly timeoutMs: number;
  readonly statsSampleMs: number;
  readonly forceGc: boolean;
};

type ScenarioRunner = {
  readonly runOne: LoadRunner;
  readonly readClientStats?: () => ClientSnapshot | undefined;
  readonly reset?: () => Promise<void> | void;
  readonly cleanup?: () => Promise<void> | void;
};

export const HTTP_PROFILE_VARIANTS: readonly HttpProfileVariant[] = [
  "node-http-text",
  "wire-raw",
  "default-minimal-json",
  "default-balanced-no-adaptive-json",
  "default-balanced-json",
  "default-json",
  "default-json-observed",
];

export async function profileHttpLayers(options: HttpLayerProfileOptions = {}): Promise<HttpLayerProfileReport> {
  const calls = positiveInt(options.calls, 1_000);
  const concurrency = positiveInt(options.concurrency, 64);
  const delayMs = nonNegativeInt(options.delayMs, 1);
  const timeoutMs = positiveInt(options.timeoutMs, 30_000);
  const warmupCalls = nonNegativeInt(options.warmupCalls, Math.min(200, Math.floor(calls / 10)));
  const statsSampleMs = positiveInt(options.statsSampleMs, 10);
  const variants = normalizeVariants(options.variants);

  const results: HttpLayerProfileResult[] = [];
  for (const variant of variants) {
    const scenario: HttpScenario = {
      variant,
      label: labelForVariant(variant),
      calls,
      warmupCalls,
      concurrency,
      delayMs,
      timeoutMs,
      statsSampleMs,
      forceGc: options.forceGc ?? false,
    };
    const result = await options.recorder?.measureAsync(
      `http.profile.${variant}`,
      () => runScenario(scenario),
      { calls, concurrency, delayMs },
      { variant },
    ) ?? await runScenario(scenario);
    options.recorder?.gauge("http.profile.throughput", result.httpPerSec, "http/s", { variant });
    options.recorder?.gauge("http.profile.heap-delta", result.memory.delta.heapUsedMb, "MB", { variant });
    results.push(result);
  }

  return Object.freeze({
    calls,
    concurrency,
    delayMs,
    timeoutMs,
    warmupCalls,
    variants,
    results: Object.freeze(results),
  });
}

async function runScenario(scenario: HttpScenario): Promise<HttpLayerProfileResult> {
  const server = await startDummyServer(scenario.delayMs);
  const observability = scenario.variant === "default-json-observed"
    ? makeObservability({
        logs: false,
        traces: { maxFinishedSpans: 10_000 },
        autoStart: false,
      })
    : undefined;
  const runner = makeScenarioRunner(scenario, server, observability);
  let warmupDurationMs = 0;

  try {
    if (scenario.warmupCalls > 0) {
      const warmup = await runHttpLoad(
        {
          ...scenario,
          calls: scenario.warmupCalls,
          warmupCalls: 0,
          idOffset: scenario.calls + 1_000_000,
        },
        server,
        runner.runOne,
        runner.readClientStats,
        observability,
      );
      warmupDurationMs = warmup.durationMs;
      flushObservability(observability);
      dropFinishedSpans(observability);
      await runner.reset?.();
      server.resetStats();
    }

    const result = await runHttpLoad(
      scenario,
      server,
      runner.runOne,
      runner.readClientStats,
      observability,
    );
    return Object.freeze({ ...result, warmupDurationMs: round(warmupDurationMs) });
  } finally {
    await runner.cleanup?.();
    await observability?.shutdown();
    await server.close();
  }
}

function startDummyServer(delayMs: number): Promise<DummyServer> {
  return new Promise((resolve, reject) => {
    let requests = 0;
    let inFlight = 0;
    let maxInFlight = 0;

    const server = createServer((req, res) => {
      const id = ++requests;
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;

      const finish = () => {
        const payload: DummyPayload = {
          ok: true,
          id,
          delayMs,
          path: req.url ?? "/",
        };
        const body = JSON.stringify(payload);
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
        });
        res.end(body, () => {
          inFlight--;
        });
      };

      if (delayMs > 0) setTimeout(finish, delayMs);
      else finish();
    });

    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.maxRequestsPerSocket = 0;

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        stats: () => ({ requests, maxInFlight }),
        resetStats: () => {
          requests = 0;
          maxInFlight = inFlight;
        },
        close: () => closeServer(server),
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function makeScenarioRunner(
  scenario: HttpScenario,
  server: DummyServer,
  observability: Observability | undefined,
): ScenarioRunner {
  switch (scenario.variant) {
    case "node-http-text":
      return makeNodeHttpRunner(server, scenario);
    case "wire-raw":
      return makeWireRawRunner(server, scenario);
    case "default-minimal-json":
      return makeDefaultJsonRunner(server, scenario, "minimal");
    case "default-balanced-no-adaptive-json":
      return makeDefaultJsonRunner(server, scenario, "balanced", true);
    case "default-balanced-json":
      return makeDefaultJsonRunner(server, scenario, "balanced");
    case "default-json":
      return makeDefaultJsonRunner(server, scenario, "default");
    case "default-json-observed":
      return makeDefaultJsonRunner(server, scenario, "default", false, observability);
  }
}

function makeNodeHttpRunner(server: DummyServer, scenario: HttpScenario): ScenarioRunner {
  const agent = new HttpAgent({
    keepAlive: true,
    maxSockets: scenario.concurrency,
    maxFreeSockets: scenario.concurrency,
  });

  return {
    runOne: (id, cb) => {
      let done = false;
      const finish = (result: { readonly ok: boolean; readonly error?: unknown }) => {
        if (done) return;
        done = true;
        cb(result);
      };
      const url = `${server.baseUrl}/todos/${id % 100}?i=${id}`;
      const req = httpRequest(url, { agent, method: "GET" }, (res) => {
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on("end", () => {
          finish({ ok: res.statusCode === 200 && bytes > 0 });
        });
      });
      req.setTimeout(scenario.timeoutMs, () => {
        req.destroy(new Error(`node:http request timed out after ${scenario.timeoutMs}ms`));
      });
      req.on("error", (error) => finish({ ok: false, error }));
      req.end();
    },
    cleanup: () => agent.destroy(),
  };
}

function makeWireRawRunner(server: DummyServer, scenario: HttpScenario): ScenarioRunner {
  const rt = makeProfileRuntime(scenario.concurrency);
  const client = makeWireClient(server.baseUrl, scenario);
  return {
    runOne: (id, cb) => {
      const effect = client({ method: "GET", url: `/todos/${id % 100}?i=${id}` });
      runRuntimeEffect(rt, effect, cb, (res) => res.status === 200 && res.bodyText.length > 0);
    },
    readClientStats: () => snapshotWireStats(client.stats()),
    cleanup: async () => {
      client.shutdown?.();
      client.destroy?.();
      await rt.shutdown();
    },
  };
}

function makeDefaultJsonRunner(
  server: DummyServer,
  scenario: HttpScenario,
  preset: "minimal" | "balanced" | "default",
  disableAdaptiveLimiter = false,
  observability?: Observability,
): ScenarioRunner {
  const rt = makeProfileRuntime(scenario.concurrency, observability);
  const client = preset === "minimal"
    ? makeMinimalClient(server.baseUrl, scenario)
    : makeDefaultClient(server.baseUrl, scenario, preset, disableAdaptiveLimiter, observability);

  return {
    runOne: (id, cb) => {
      const effect = client.getJson<DummyPayload>(`/todos/${id % 100}?i=${id}`);
      runRuntimeEffect(
        rt,
        effect as Async<unknown, unknown, HttpResponse<DummyPayload>>,
        cb,
        (res) => res.status === 200 && res.body.ok === true,
      );
    },
    readClientStats: () => snapshotLifecycleStats(client.stats()),
    reset: () => client.cache.clear(),
    cleanup: async () => {
      await rt.toPromise(client.shutdown());
      await rt.shutdown();
    },
  };
}

function makeProfileRuntime(concurrency: number, observability?: Observability): Runtime<any> {
  const capacity = Math.max(65_536, concurrency * 8);
  return Runtime.makeWithEngine(observability?.env ?? {}, "ts", {
    hooks: observability?.hooks,
    scheduler: new Scheduler({
      laneMode: "single",
      initialCapacity: capacity,
      maxCapacity: capacity,
      flushBudget: 8_192,
    }),
    inferLane: false,
  }).withLane("perf/http");
}

function baseHttpConfig(baseUrl: string, scenario: HttpScenario) {
  return {
    baseUrl,
    timeoutMs: scenario.timeoutMs,
    pool: {
      concurrency: scenario.concurrency,
      maxQueue: scenario.concurrency,
      queueTimeoutMs: scenario.timeoutMs,
      key: "origin" as const,
    },
  };
}

function makeWireClient(baseUrl: string, scenario: HttpScenario): HttpClient {
  return makeHttp(baseHttpConfig(baseUrl, scenario));
}

function makeMinimalClient(baseUrl: string, scenario: HttpScenario): DefaultHttpClient {
  return makeDefaultHttpClient({
    preset: "minimal",
    compression: false,
    ...baseHttpConfig(baseUrl, scenario),
  });
}

function makeDefaultClient(
  baseUrl: string,
  scenario: HttpScenario,
  preset: "balanced" | "default",
  disableAdaptiveLimiter: boolean,
  observability?: Observability,
): DefaultHttpClient {
  return makeDefaultHttpClient({
    preset,
    compression: false,
    ...baseHttpConfig(baseUrl, scenario),
    ...(disableAdaptiveLimiter ? { adaptiveLimiter: false as const } : {}),
    ...(observability
      ? {
          middleware: [
            withHttpObservability({
              metrics: observability.metrics,
              logs: false,
              spans: {},
              injectTraceHeaders: true,
              route: "/todos/:id",
            }),
          ],
        }
      : {}),
  });
}

function runRuntimeEffect<A>(
  rt: Runtime<any>,
  effect: Async<any, unknown, A>,
  cb: (result: { readonly ok: boolean; readonly error?: unknown }) => void,
  validate: (value: A) => boolean,
): void {
  rt.unsafeRunAsync(effect, (exit) => {
    if (exit._tag === "Success") {
      cb({ ok: validate(exit.value) });
    } else {
      cb({ ok: false, error: exit });
    }
  });
}

function runHttpLoad(
  scenario: HttpScenario,
  server: DummyServer,
  runOne: LoadRunner,
  readClientStats?: () => ClientSnapshot | undefined,
  observability?: Observability,
): Promise<Omit<HttpLayerProfileResult, "warmupDurationMs">> {
  return new Promise((resolve, reject) => {
    let next = 0;
    let inFlight = 0;
    let maxClientInFlight = 0;
    let completed = 0;
    let successCount = 0;
    let errorCount = 0;
    let firstError: unknown;
    let maxWireInFlight = 0;
    let maxPoolRunning = 0;
    let maxPoolQueued = 0;
    let maxLifecycleQueueDepth = 0;
    let sawPoolStats = false;
    let minAdaptiveLimit = Number.POSITIVE_INFINITY;
    let maxAdaptiveLimit = 0;
    let maxAdaptiveInFlight = 0;
    let maxAdaptiveQueueDepth = 0;
    let sawAdaptiveStats = false;
    let lastClientStats: ClientSnapshot | undefined;
    const initialClientStats = readClientStats?.();
    let latencies = new Array<number>(scenario.calls);
    const memoryBefore = captureMemorySnapshot({ forceGc: scenario.forceGc });
    const startedAt = performance.now();

    const sampleClientStats = () => {
      const stats = readClientStats?.();
      if (!stats) return;
      lastClientStats = stats;
      maxWireInFlight = Math.max(maxWireInFlight, stats.wireInFlight ?? 0);
      if (stats.poolRunning !== undefined || stats.poolQueued !== undefined) {
        sawPoolStats = true;
        maxPoolRunning = Math.max(maxPoolRunning, stats.poolRunning ?? 0);
        maxPoolQueued = Math.max(maxPoolQueued, stats.poolQueued ?? 0);
      }
      if (stats.adaptiveLimit !== undefined) {
        sawAdaptiveStats = true;
        minAdaptiveLimit = Math.min(minAdaptiveLimit, stats.adaptiveLimit);
        maxAdaptiveLimit = Math.max(maxAdaptiveLimit, stats.adaptiveLimit);
        maxAdaptiveInFlight = Math.max(maxAdaptiveInFlight, stats.adaptiveInFlight ?? 0);
        maxAdaptiveQueueDepth = Math.max(maxAdaptiveQueueDepth, stats.adaptiveQueueDepth ?? 0);
      }
      maxLifecycleQueueDepth = Math.max(maxLifecycleQueueDepth, stats.lifecycleQueueDepth ?? 0);
    };

    const sampleTimer = readClientStats
      ? setInterval(sampleClientStats, scenario.statsSampleMs)
      : undefined;

    const finish = () => {
      if (sampleTimer) clearInterval(sampleTimer);
      sampleClientStats();
      const durationMs = performance.now() - startedAt;
      const observabilityFlushMs = flushObservability(observability);
      const latencyPercentiles = percentiles(latencies);
      latencies = [];
      const memoryAfter = captureMemorySnapshot({ forceGc: scenario.forceGc });
      const serverStats = server.stats();
      const tracerStats = observability?.tracer.stats();
      resolve(Object.freeze({
        variant: scenario.variant,
        label: scenario.label,
        calls: scenario.calls,
        warmupCalls: scenario.warmupCalls,
        concurrency: scenario.concurrency,
        delayMs: scenario.delayMs,
        timeoutMs: scenario.timeoutMs,
        successCount,
        errorCount,
        durationMs: round(durationMs),
        httpPerSec: round(scenario.calls / Math.max(durationMs / 1000, 0.001)),
        requestP50Ms: latencyPercentiles.p50,
        requestP90Ms: latencyPercentiles.p90,
        requestP95Ms: latencyPercentiles.p95,
        requestP99Ms: latencyPercentiles.p99,
        serverRequests: serverStats.requests,
        serverMaxInFlight: serverStats.maxInFlight,
        clientMaxInFlight: maxClientInFlight,
        clientWireMaxInFlight: maxWireInFlight,
        ...(sawPoolStats
          ? {
              clientPoolMaxRunning: maxPoolRunning,
              clientPoolMaxQueued: maxPoolQueued,
            }
          : {}),
        ...(sawAdaptiveStats
          ? {
              adaptiveMinLimit: minAdaptiveLimit,
              adaptiveMaxLimit: maxAdaptiveLimit,
              adaptiveFinalLimit: lastClientStats?.adaptiveLimit ?? 0,
              adaptiveMaxInFlight: maxAdaptiveInFlight,
              adaptiveMaxQueueDepth: maxAdaptiveQueueDepth,
              adaptiveFinalGradient: lastClientStats?.adaptiveGradient ?? 0,
              adaptiveWindowSize: lastClientStats?.adaptiveWindowSize ?? 0,
            }
          : {}),
        lifecycleMaxQueueDepth: maxLifecycleQueueDepth,
        clientStarted: delta(lastClientStats?.wireStarted, initialClientStats?.wireStarted),
        clientSucceeded: delta(lastClientStats?.wireSucceeded, initialClientStats?.wireSucceeded),
        clientFailed: delta(lastClientStats?.wireFailed, initialClientStats?.wireFailed),
        clientTimedOut: delta(lastClientStats?.wireTimedOut, initialClientStats?.wireTimedOut),
        lifecycleStarted: delta(lastClientStats?.lifecycleStarted, initialClientStats?.lifecycleStarted),
        lifecycleCompleted: delta(lastClientStats?.lifecycleCompleted, initialClientStats?.lifecycleCompleted),
        lifecycleFailed: delta(lastClientStats?.lifecycleFailed, initialClientStats?.lifecycleFailed),
        observedFinishedSpans: tracerStats?.finishedSpans ?? 0,
        observedPrunedSpans: tracerStats?.prunedFinishedSpans ?? 0,
        observabilityFlushMs,
        gcAvailable: memoryAfter.gcAvailable,
        memory: {
          before: memoryBefore,
          after: memoryAfter,
          delta: diffMemorySnapshots(memoryBefore, memoryAfter),
        },
        firstError: firstError ? String(firstError) : undefined,
      }));
    };

    const launch = (): void => {
      while (inFlight < scenario.concurrency && next < scenario.calls) {
        const id = next++;
        const requestId = id + (scenario.idOffset ?? 0);
        const requestStartedAt = performance.now();
        inFlight++;
        if (inFlight > maxClientInFlight) maxClientInFlight = inFlight;
        sampleClientStats();

        runOne(requestId, (result) => {
          latencies[id] = performance.now() - requestStartedAt;
          inFlight--;
          completed++;

          if (result.ok) {
            successCount++;
          } else {
            errorCount++;
            if (firstError === undefined) firstError = result.error ?? "unknown HTTP profiler error";
          }

          sampleClientStats();
          if (completed === scenario.calls) {
            finish();
            return;
          }
          launch();
        });
      }
    };

    try {
      launch();
    } catch (error) {
      if (sampleTimer) clearInterval(sampleTimer);
      reject(error);
    }
  });
}

function snapshotWireStats(stats: HttpClientStats): ClientSnapshot {
  return {
    wireInFlight: stats.inFlight,
    wireStarted: stats.started,
    wireSucceeded: stats.succeeded,
    wireFailed: stats.failed,
    wireTimedOut: stats.timedOut,
    poolRunning: stats.pool?.running,
    poolQueued: stats.pool?.queued,
    adaptiveLimit: stats.adaptiveLimiter?.limit,
    adaptiveInFlight: stats.adaptiveLimiter?.inFlight,
    adaptiveQueueDepth: stats.adaptiveLimiter?.queueDepth,
    adaptiveGradient: stats.adaptiveLimiter?.gradient,
    adaptiveWindowSize: stats.adaptiveLimiter?.windowSize,
  };
}

function snapshotLifecycleStats(stats: LifecycleStats): ClientSnapshot {
  return {
    ...snapshotWireStats(stats.wire),
    lifecycleQueueDepth: stats.queueDepth,
    lifecycleStarted: stats.requestsStarted,
    lifecycleCompleted: stats.requestsCompleted,
    lifecycleFailed: stats.requestsFailed,
  };
}

function flushObservability(observability: Observability | undefined): number {
  if (!observability) return 0;
  const startedAt = performance.now();
  (observability.hooks as unknown as { flush?: (budget?: number) => void }).flush?.(Number.MAX_SAFE_INTEGER);
  return round(performance.now() - startedAt);
}

function dropFinishedSpans(observability: Observability | undefined): void {
  if (!observability) return;
  const spanIds = observability.tracer.exportFinished().map((span) => span.spanId);
  if (spanIds.length > 0) observability.tracer.pruneFinished(spanIds);
}

function percentiles(samples: readonly number[]) {
  const sorted = samples.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return {
    p50: round(percentile(sorted, 0.5)),
    p90: round(percentile(sorted, 0.9)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function labelForVariant(variant: HttpProfileVariant): string {
  switch (variant) {
    case "node-http-text":
      return "node:http transport text";
    case "wire-raw":
      return "brass wire raw";
    case "default-minimal-json":
      return "default client minimal JSON";
    case "default-balanced-no-adaptive-json":
      return "default client balanced JSON without adaptive limiter";
    case "default-balanced-json":
      return "default client balanced JSON";
    case "default-json":
      return "default client JSON";
    case "default-json-observed":
      return "default client JSON + observability";
  }
}

function normalizeVariants(value: readonly HttpProfileVariant[] | undefined): readonly HttpProfileVariant[] {
  if (!value || value.length === 0) return HTTP_PROFILE_VARIANTS;
  const allowed = new Set<HttpProfileVariant>(HTTP_PROFILE_VARIANTS);
  const variants = value.filter((variant) => allowed.has(variant));
  return Object.freeze(variants.length > 0 ? variants : [...HTTP_PROFILE_VARIANTS]);
}

function delta(current: number | undefined, baseline: number | undefined): number {
  return Math.max(0, (current ?? 0) - (baseline ?? 0));
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
