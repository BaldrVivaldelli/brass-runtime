/**
 * Benchmark: real HTTP concurrency against a local delayed JSON server.
 *
 * The default run uses 100,000 calls so `npm run benchmark` remains useful as a
 * daily signal. Use `BRASS_HTTP_BENCH_MODE=soak` or set
 * `BRASS_HTTP_BENCH_CALLS=1000000` for the longer stress run.
 */

import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { BenchmarkDef } from "./runner";
import { Runtime } from "../core/runtime/runtime";
import { Scheduler } from "../core/runtime/scheduler";
import type { Async } from "../core/types/asyncEffect";
import {
  makeHttp,
  type HttpClient,
  type HttpClientStats,
  type HttpError,
} from "../http/client";
import { makeDefaultHttpClient, type DefaultHttpClient } from "../http/defaultClient";
import type { HttpResponse } from "../http/httpClient";
import type { LifecycleStats } from "../http/lifecycle";
import { makeNodeHttpTransport, type NodeHttpTransport } from "../http/nodeTransport";
import type { HttpTransport } from "../http/transport";
import {
  makeObservability,
  withHttpObservability,
  type Observability,
} from "../observability";

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

type HttpBenchMode = "daily" | "compare" | "soak";

type HttpScenarioKind =
  | "node-http-text"
  | "wire-raw"
  | "default-minimal-json"
  | "default-proxy-json"
  | "default-proxy-node-json"
  | "default-balanced-no-adaptive-json"
  | "default-balanced-json"
  | "default-json"
  | "default-json-observed";

type HttpScenario = {
  readonly kind: HttpScenarioKind;
  readonly label: string;
  readonly mode: HttpBenchMode;
  readonly calls: number;
  readonly warmupCalls: number;
  readonly idOffset?: number;
  readonly concurrency: number;
  readonly delayMs: number;
  readonly timeoutMs: number;
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

type HttpLoadDetails = Record<string, unknown> & {
  units: number;
  unit: "http";
  variant: HttpScenarioKind;
  mode: HttpBenchMode;
  calls: number;
  warmupCalls: number;
  concurrency: number;
  delayMs: number;
  successCount: number;
  errorCount: number;
  durationMs: number;
  throughputDurationMs: number;
  httpPerSec: number;
  requestP50Ms: number;
  requestP90Ms: number;
  requestP95Ms: number;
  requestP99Ms: number;
};

const MODE = resolveMode();
const DEFAULT_CALLS = MODE === "soak" ? 1_000_000 : 100_000;
const TOTAL_CALLS = envInt("BRASS_HTTP_BENCH_CALLS", DEFAULT_CALLS);
const CONCURRENCY = envInt("BRASS_HTTP_BENCH_CONCURRENCY", 512);
const DELAY_MS = envNonNegativeInt("BRASS_HTTP_BENCH_DELAY_MS", 2);
const TIMEOUT_MS = envInt("BRASS_HTTP_BENCH_TIMEOUT_MS", 30_000);
const STATS_SAMPLE_MS = envInt("BRASS_HTTP_BENCH_STATS_SAMPLE_MS", 10);
const WARMUP_CALLS = envNonNegativeInt("BRASS_HTTP_BENCH_WARMUP_CALLS", defaultWarmupCalls(MODE, TOTAL_CALLS));
const SELECTED_VARIANTS = envStringSet("BRASS_HTTP_BENCH_VARIANTS");

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function envStringSet(name: string): ReadonlySet<string> {
  const raw = process.env[name];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function resolveMode(): HttpBenchMode {
  const raw = process.env.BRASS_HTTP_BENCH_MODE?.trim().toLowerCase();
  if (raw === "daily" || raw === "compare" || raw === "soak") return raw;
  const requestedCalls = Number(process.env.BRASS_HTTP_BENCH_CALLS);
  if (Number.isFinite(requestedCalls) && requestedCalls >= 1_000_000) return "soak";
  return isFocusedHttpRun() ? "compare" : "daily";
}

function defaultWarmupCalls(mode: HttpBenchMode, calls: number): number {
  const cap = mode === "soak" ? 10_000 : mode === "daily" ? 5_000 : 1_000;
  return Math.min(cap, Math.max(0, Math.floor(calls / 10)));
}

function isFocusedHttpRun(): boolean {
  return process.argv.some((arg) => arg.includes("http-concurrent"));
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

function makeBenchRuntime(observability?: Observability): Runtime<unknown> {
  const capacity = Math.max(65_536, CONCURRENCY * 8);
  return Runtime.makeWithEngine(observability?.env ?? {}, "ts", {
    hooks: observability?.hooks,
    scheduler: new Scheduler({
      laneMode: "single",
      initialCapacity: capacity,
      maxCapacity: capacity,
      flushBudget: 8_192,
    }),
    inferLane: false,
  }).withLane("bench/http-concurrent");
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
  preset: "proxy" | "balanced" | "default",
  disableAdaptiveLimiter: boolean,
  observability?: Observability,
  transport?: HttpTransport,
): DefaultHttpClient {
  return makeDefaultHttpClient({
    preset,
    compression: false,
    ...baseHttpConfig(baseUrl, scenario),
    ...(transport ? { transport } : {}),
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

function runHttpLoad(
  scenario: HttpScenario,
  server: DummyServer,
  runOne: LoadRunner,
  readClientStats?: () => ClientSnapshot | undefined,
  observability?: Observability,
): Promise<HttpLoadDetails> {
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
    forceGc();
    const memoryBefore = memorySnapshot();
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
      ? setInterval(sampleClientStats, STATS_SAMPLE_MS)
      : undefined;

    const finish = () => {
      if (sampleTimer) clearInterval(sampleTimer);
      sampleClientStats();
      const durationMs = performance.now() - startedAt;
      const observabilityFlushMs = flushObservability(observability);
      const latencyPercentiles = percentiles(latencies);
      latencies = [];
      forceGc();
      const memoryAfter = memorySnapshot();
      const serverStats = server.stats();
      const tracerStats = observability?.tracer.stats();
      resolve({
        units: scenario.calls,
        unit: "http",
        throughputDurationMs: durationMs,
        requestP50Ms: latencyPercentiles.p50,
        requestP99Ms: latencyPercentiles.p99,
        serverMaxInFlight: serverStats.maxInFlight,
        clientMaxInFlight: maxClientInFlight,
        heapDeltaMb: toMb(memoryAfter.heapUsed - memoryBefore.heapUsed),
        rssDeltaMb: toMb(memoryAfter.rss - memoryBefore.rss),
        successCount,
        errorCount,
        requestP90Ms: latencyPercentiles.p90,
        requestP95Ms: latencyPercentiles.p95,
        calls: scenario.calls,
        warmupCalls: scenario.warmupCalls,
        concurrency: scenario.concurrency,
        delayMs: scenario.delayMs,
        variant: scenario.kind,
        mode: scenario.mode,
        durationMs,
        httpPerSec: scenario.calls / (durationMs / 1000),
        observabilityFlushMs,
        gcAvailable: hasGc(),
        heapBeforeMb: toMb(memoryBefore.heapUsed),
        heapAfterMb: toMb(memoryAfter.heapUsed),
        rssBeforeMb: toMb(memoryBefore.rss),
        rssAfterMb: toMb(memoryAfter.rss),
        externalDeltaMb: toMb(memoryAfter.external - memoryBefore.external),
        serverRequests: serverStats.requests,
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
        firstError: firstError ? String(firstError) : "",
      });
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
            if (firstError === undefined) firstError = result.error ?? "unknown HTTP benchmark error";
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

type ScenarioRunner = {
  readonly runOne: LoadRunner;
  readonly readClientStats?: () => ClientSnapshot | undefined;
  readonly reset?: () => Promise<void> | void;
  readonly cleanup?: () => Promise<void> | void;
};

function makeNodeHttpRunner(server: DummyServer, scenario: HttpScenario): ScenarioRunner {
  const agent = new HttpAgent({
    keepAlive: true,
    maxSockets: scenario.concurrency,
    maxFreeSockets: scenario.concurrency,
  });

  return {
    runOne: (id, cb) => {
      const url = `${server.baseUrl}/todos/${id % 100}?i=${id}`;
      const req = httpRequest(url, { agent, method: "GET" }, (res) => {
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on("end", () => {
          cb({ ok: res.statusCode === 200 && bytes > 0 });
        });
      });
      req.setTimeout(scenario.timeoutMs, () => {
        req.destroy(new Error(`node:http request timed out after ${scenario.timeoutMs}ms`));
      });
      req.on("error", (error) => cb({ ok: false, error }));
      req.end();
    },
    cleanup: () => agent.destroy(),
  };
}

function runRuntimeEffect<A>(
  rt: Runtime<unknown>,
  effect: Async<unknown, HttpError, A>,
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

function makeWireRawRunner(server: DummyServer, scenario: HttpScenario): ScenarioRunner {
  const rt = makeBenchRuntime();
  const client = makeWireClient(server.baseUrl, scenario);
  return {
    runOne: (id, cb) => {
      const effect = client({ method: "GET", url: `/todos/${id % 100}?i=${id}` });
      runRuntimeEffect(rt, effect, cb, (res) => res.status === 200 && res.bodyText.length > 0);
    },
    readClientStats: () => snapshotWireStats(client.stats()),
  };
}

function makeDefaultJsonRunner(
  server: DummyServer,
  scenario: HttpScenario,
  preset: "minimal" | "proxy" | "balanced" | "default",
  disableAdaptiveLimiter = false,
  observability?: Observability,
  transport?: NodeHttpTransport,
): ScenarioRunner {
  const rt = makeBenchRuntime(observability);
  const client = preset === "minimal"
    ? makeMinimalClient(server.baseUrl, scenario)
    : makeDefaultClient(server.baseUrl, scenario, preset, disableAdaptiveLimiter, observability, transport);

  return {
    runOne: (id, cb) => {
      const effect = client.getJson<DummyPayload>(`/todos/${id % 100}?i=${id}`);
      runRuntimeEffect(
        rt,
        effect as Async<unknown, HttpError, HttpResponse<DummyPayload>>,
        cb,
        (res) => res.status === 200 && res.body.ok === true,
      );
    },
    readClientStats: () => snapshotLifecycleStats(client.stats()),
    reset: () => client.cache.clear(),
    cleanup: () => transport?.destroy(),
  };
}

async function runScenario(scenario: HttpScenario): Promise<HttpLoadDetails> {
  const server = await startDummyServer(scenario.delayMs);
  const observability = scenario.kind === "default-json-observed"
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
      if (warmup.errorCount > 0) {
        throw new Error(`HTTP concurrent warmup had ${warmup.errorCount} errors; first=${warmup.firstError}`);
      }
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
    if (result.errorCount > 0) {
      throw new Error(`HTTP concurrent benchmark had ${result.errorCount} errors; first=${result.firstError}`);
    }
    return { ...result, warmupDurationMs: round(warmupDurationMs) };
  } finally {
    await runner.cleanup?.();
    await observability?.shutdown();
    await server.close();
  }
}

function makeScenarioRunner(
  scenario: HttpScenario,
  server: DummyServer,
  observability: Observability | undefined,
): ScenarioRunner {
  switch (scenario.kind) {
    case "node-http-text":
      return makeNodeHttpRunner(server, scenario);
    case "wire-raw":
      return makeWireRawRunner(server, scenario);
    case "default-minimal-json":
      return makeDefaultJsonRunner(server, scenario, "minimal");
    case "default-proxy-json":
      return makeDefaultJsonRunner(server, scenario, "proxy");
    case "default-proxy-node-json":
      return makeDefaultJsonRunner(
        server,
        scenario,
        "proxy",
        false,
        undefined,
        makeNodeHttpTransport({
          maxSockets: scenario.concurrency,
          maxFreeSockets: scenario.concurrency,
          socketTimeoutMs: scenario.timeoutMs,
        }),
      );
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

function delta(current: number | undefined, baseline: number | undefined): number {
  return Math.max(0, (current ?? 0) - (baseline ?? 0));
}

function flushObservability(observability: Observability | undefined): number {
  if (!observability) return 0;
  const started = performance.now();
  (observability.hooks as unknown as { flush?: (budget?: number) => void }).flush?.(Number.MAX_SAFE_INTEGER);
  return round(performance.now() - started);
}

function dropFinishedSpans(observability: Observability | undefined): void {
  if (!observability) return;
  const spanIds = observability.tracer.exportFinished().map((span) => span.spanId);
  if (spanIds.length > 0) observability.tracer.pruneFinished(spanIds);
}

function hasGc(): boolean {
  return typeof (globalThis as unknown as { gc?: () => void }).gc === "function";
}

function forceGc(): void {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc !== "function") return;
  gc();
  gc();
}

type MemorySnapshot = ReturnType<typeof process.memoryUsage>;

function memorySnapshot(): MemorySnapshot {
  return process.memoryUsage();
}

function toMb(bytes: number): number {
  return round(bytes / (1024 * 1024));
}

function percentiles(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
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

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function scenarioLabel(scenario: HttpScenario): string {
  return `${scenario.label} (${scenario.calls.toLocaleString()} calls, concurrency=${scenario.concurrency}, delay=${scenario.delayMs}ms, mode=${scenario.mode})`;
}

function scenario(
  kind: HttpScenarioKind,
  label: string,
  delayMs: number,
  mode: HttpBenchMode = MODE,
): HttpScenario {
  return {
    kind,
    label,
    mode,
    calls: TOTAL_CALLS,
    warmupCalls: WARMUP_CALLS,
    concurrency: CONCURRENCY,
    delayMs,
    timeoutMs: TIMEOUT_MS,
  };
}

function scenariosForMode(mode: HttpBenchMode): readonly HttpScenario[] {
  if (mode === "daily") {
    return filterScenarios([
      scenario("default-json", "http local dummy default JSON", DELAY_MS, mode),
    ]);
  }

  if (mode === "soak") {
    return filterScenarios([
      scenario("default-json-observed", "http local dummy soak default JSON + observability", DELAY_MS, mode),
    ]);
  }

  return filterScenarios([
    scenario("node-http-text", "http local dummy node:http transport text", DELAY_MS, mode),
    scenario("wire-raw", "http local dummy wire raw", DELAY_MS, mode),
    scenario("default-minimal-json", "http local dummy makeDefault minimal JSON", DELAY_MS, mode),
    scenario("default-proxy-json", "http local dummy makeDefault proxy JSON", DELAY_MS, mode),
    scenario("default-proxy-node-json", "http local dummy makeDefault proxy JSON + node transport", DELAY_MS, mode),
    scenario("default-balanced-no-adaptive-json", "http local dummy makeDefault balanced JSON without adaptive", DELAY_MS, mode),
    scenario("default-balanced-json", "http local dummy makeDefault balanced JSON", DELAY_MS, mode),
    scenario("default-json", "http local dummy makeDefault default JSON", DELAY_MS, mode),
    scenario("default-json-observed", "http local dummy makeDefault default JSON + observability", DELAY_MS, mode),
  ]);
}

function filterScenarios(scenarios: readonly HttpScenario[]): readonly HttpScenario[] {
  if (SELECTED_VARIANTS.size === 0) return scenarios;
  return scenarios.filter((item) => SELECTED_VARIANTS.has(item.kind));
}

export const benchmarks: BenchmarkDef[] = scenariosForMode(MODE).map((item) => ({
  name: scenarioLabel(item),
  iterations: 1,
  warmup: 0,
  unitsPerRun: item.calls,
  unit: "http",
  fn: () => runScenario(item),
}));
