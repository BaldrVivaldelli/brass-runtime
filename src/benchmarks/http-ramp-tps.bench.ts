/**
 * Benchmark: open-loop HTTP TPS ramp against a local delayed JSON server.
 *
 * This complements `http-concurrent`: instead of asking "how fast can it go?",
 * this benchmark asks "can it sustain a requested arrival rate?".
 */

import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { BenchmarkDef } from "./runner";
import { Scheduler } from "../core/runtime/scheduler";
import { Runtime } from "../core/runtime/runtime";
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
  readonly close: () => Promise<void>;
};

type RampClientKind =
  | "node-http-text"
  | "wire-raw"
  | "default-minimal-json"
  | "default-balanced-json"
  | "default-json"
  | "default-json-observed";

type RampConfig = {
  readonly maxTps: number;
  readonly stepTps: number;
  readonly stepSeconds: number;
  readonly concurrency: number;
  readonly delayMs: number;
  readonly timeoutMs: number;
  readonly statsSampleMs: number;
  readonly clientKind: RampClientKind;
  readonly targets: readonly number[];
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

type ScenarioRunner = {
  readonly runOne: LoadRunner;
  readonly readClientStats?: () => ClientSnapshot | undefined;
  readonly cleanup?: () => Promise<void> | void;
};

type MutableStepStats = {
  readonly targetTps: number;
  readonly plannedCount: number;
  scheduledCount: number;
  sentCount: number;
  droppedCount: number;
  missedCount: number;
  successCount: number;
  errorCount: number;
  startedAtMs: number;
  durationMs: number;
  readonly latencies: number[];
};

type RampDetails = Record<string, unknown> & {
  units: number;
  unit: "http";
  variant: RampClientKind;
  profile: string;
  targetMaxTps: number;
  stepTps: number;
  stepSeconds: number;
  plannedCount: number;
  sentCount: number;
  droppedCount: number;
  missedCount: number;
  successCount: number;
  errorCount: number;
  durationMs: number;
  throughputDurationMs: number;
  actualAvgTps: number;
  maxStepActualTps: number;
  requestP50Ms: number;
  requestP95Ms: number;
  requestP99Ms: number;
};

const FOCUSED_RUN = isFocusedRampRun();
const MAX_TPS = envInt("BRASS_HTTP_RAMP_MAX_TPS", FOCUSED_RUN ? 300 : 120);
const STEP_TPS = envInt("BRASS_HTTP_RAMP_STEP_TPS", 60);
const STEP_SECONDS = envInt("BRASS_HTTP_RAMP_STEP_SECONDS", FOCUSED_RUN ? 5 : 1);
const DELAY_MS = envNonNegativeInt("BRASS_HTTP_RAMP_DELAY_MS", 2);
const CONCURRENCY = envInt("BRASS_HTTP_RAMP_CONCURRENCY", Math.max(512, MAX_TPS * 2));
const TIMEOUT_MS = envInt("BRASS_HTTP_RAMP_TIMEOUT_MS", 30_000);
const STATS_SAMPLE_MS = envInt("BRASS_HTTP_RAMP_STATS_SAMPLE_MS", 10);
const CLIENT_KIND = resolveClientKind();
const CONFIG: RampConfig = {
  maxTps: MAX_TPS,
  stepTps: STEP_TPS,
  stepSeconds: STEP_SECONDS,
  concurrency: CONCURRENCY,
  delayMs: DELAY_MS,
  timeoutMs: TIMEOUT_MS,
  statsSampleMs: STATS_SAMPLE_MS,
  clientKind: CLIENT_KIND,
  targets: buildRampTargets(MAX_TPS, STEP_TPS),
};

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

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveClientKind(): RampClientKind {
  const raw = process.env.BRASS_HTTP_RAMP_CLIENT?.trim().toLowerCase();
  switch (raw) {
    case "node":
    case "node-http":
    case "node-http-text":
      return "node-http-text";
    case "wire":
    case "wire-raw":
      return "wire-raw";
    case "minimal":
    case "default-minimal-json":
      return "default-minimal-json";
    case "balanced":
    case "default-balanced-json":
      return "default-balanced-json";
    case "observed":
    case "observability":
    case "default-json-observed":
      return "default-json-observed";
    case "default":
    case "default-json":
    case undefined:
      return envBool("BRASS_HTTP_RAMP_OBSERVABILITY", false)
        ? "default-json-observed"
        : "default-json";
    default:
      return "default-json";
  }
}

function isFocusedRampRun(): boolean {
  return process.argv.some((arg) => arg.includes("http-ramp-tps"));
}

function buildRampTargets(maxTps: number, stepTps: number): readonly number[] {
  const up: number[] = [];
  for (let tps = stepTps; tps < maxTps; tps += stepTps) up.push(tps);
  if (up.at(-1) !== maxTps) up.push(maxTps);

  const down: number[] = [];
  for (let tps = maxTps - stepTps; tps >= stepTps; tps -= stepTps) down.push(tps);
  if (down.length > 0 && down.at(-1) !== stepTps) down.push(stepTps);

  return [...up, ...down];
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

function makeBenchRuntime(config: RampConfig, observability?: Observability): Runtime<unknown> {
  const capacity = Math.max(65_536, config.concurrency * 8, config.maxTps * 16);
  return Runtime.makeWithEngine(observability?.env ?? {}, "ts", {
    hooks: observability?.hooks,
    scheduler: new Scheduler({
      laneMode: "single",
      initialCapacity: capacity,
      maxCapacity: capacity,
      flushBudget: 8_192,
    }),
    inferLane: false,
  }).withLane("bench/http-ramp-tps");
}

function baseHttpConfig(baseUrl: string, config: RampConfig) {
  return {
    baseUrl,
    timeoutMs: config.timeoutMs,
    pool: {
      concurrency: config.concurrency,
      maxQueue: config.concurrency,
      queueTimeoutMs: config.timeoutMs,
      key: "origin" as const,
    },
  };
}

function makeWireClient(baseUrl: string, config: RampConfig): HttpClient {
  return makeHttp(baseHttpConfig(baseUrl, config));
}

function makeDefaultClient(
  baseUrl: string,
  config: RampConfig,
  preset: "minimal" | "balanced" | "default",
  observability?: Observability,
): DefaultHttpClient {
  return makeDefaultHttpClient({
    preset,
    compression: false,
    ...baseHttpConfig(baseUrl, config),
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

function makeScenarioRunner(
  server: DummyServer,
  config: RampConfig,
  observability: Observability | undefined,
): ScenarioRunner {
  switch (config.clientKind) {
    case "node-http-text":
      return makeNodeHttpRunner(server, config);
    case "wire-raw":
      return makeWireRawRunner(server, config);
    case "default-minimal-json":
      return makeDefaultJsonRunner(server, config, "minimal");
    case "default-balanced-json":
      return makeDefaultJsonRunner(server, config, "balanced");
    case "default-json":
      return makeDefaultJsonRunner(server, config, "default");
    case "default-json-observed":
      return makeDefaultJsonRunner(server, config, "default", observability);
  }
}

function makeNodeHttpRunner(server: DummyServer, config: RampConfig): ScenarioRunner {
  const agent = new HttpAgent({
    keepAlive: true,
    maxSockets: config.concurrency,
    maxFreeSockets: config.concurrency,
  });

  return {
    runOne: (id, cb) => {
      let completed = false;
      const complete = (result: { readonly ok: boolean; readonly error?: unknown }) => {
        if (completed) return;
        completed = true;
        cb(result);
      };
      const url = `${server.baseUrl}/todos/${id % 100}?i=${id}`;
      const req = httpRequest(url, { agent, method: "GET" }, (res) => {
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on("end", () => {
          complete({ ok: res.statusCode === 200 && bytes > 0 });
        });
      });
      req.setTimeout(config.timeoutMs, () => {
        req.destroy(new Error(`node:http request timed out after ${config.timeoutMs}ms`));
      });
      req.on("error", (error) => complete({ ok: false, error }));
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

function makeWireRawRunner(server: DummyServer, config: RampConfig): ScenarioRunner {
  const rt = makeBenchRuntime(config);
  const client = makeWireClient(server.baseUrl, config);
  return {
    runOne: (id, cb) => {
      const effect = client({ method: "GET", url: `/todos/${id % 100}?i=${id}` });
      runRuntimeEffect(rt, effect, cb, (res) => res.status === 200 && res.bodyText.length > 0);
    },
    readClientStats: () => snapshotWireStats(client.stats()),
    cleanup: () => client.shutdown?.(),
  };
}

function makeDefaultJsonRunner(
  server: DummyServer,
  config: RampConfig,
  preset: "minimal" | "balanced" | "default",
  observability?: Observability,
): ScenarioRunner {
  const rt = makeBenchRuntime(config, observability);
  const client = makeDefaultClient(server.baseUrl, config, preset, observability);

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
    cleanup: () => {
      client.cache.clear();
      client.shutdown();
    },
  };
}

async function runRampScenario(config: RampConfig): Promise<RampDetails> {
  const server = await startDummyServer(config.delayMs);
  const observability = config.clientKind === "default-json-observed"
    ? makeObservability({
        logs: false,
        traces: { maxFinishedSpans: Math.max(10_000, plannedRequestCount(config) * 2) },
        autoStart: false,
      })
    : undefined;
  const runner = makeScenarioRunner(server, config, observability);

  try {
    return await runRampLoad(config, server, runner, observability);
  } finally {
    await runner.cleanup?.();
    await observability?.shutdown();
    await server.close();
  }
}

function runRampLoad(
  config: RampConfig,
  server: DummyServer,
  runner: ScenarioRunner,
  observability?: Observability,
): Promise<RampDetails> {
  return new Promise((resolve, reject) => {
    const steps = config.targets.map((targetTps) => makeStepStats(targetTps, config.stepSeconds));
    const pending = new Set<Promise<void>>();
    const allLatencies: number[] = [];
    let nextId = 0;
    let inFlight = 0;
    let maxClientInFlight = 0;
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
    const initialClientStats = runner.readClientStats?.();

    const sampleClientStats = () => {
      const stats = runner.readClientStats?.();
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

    const launch = (step: MutableStepStats): boolean => {
      if (inFlight >= config.concurrency) return false;

      const id = nextId++;
      const requestStartedAt = performance.now();
      let completed = false;
      inFlight++;
      step.sentCount++;
      if (inFlight > maxClientInFlight) maxClientInFlight = inFlight;
      sampleClientStats();

      const complete = (result: { readonly ok: boolean; readonly error?: unknown }) => {
        if (completed) return;
        completed = true;
        const latencyMs = performance.now() - requestStartedAt;
        inFlight--;
        step.latencies.push(latencyMs);
        allLatencies.push(latencyMs);

        if (result.ok) {
          step.successCount++;
        } else {
          step.errorCount++;
          if (firstError === undefined) firstError = result.error ?? "unknown HTTP ramp benchmark error";
        }
        sampleClientStats();
      };

      const request = new Promise<void>((requestResolve) => {
        try {
          runner.runOne(id, (result) => {
            complete(result);
            requestResolve();
          });
        } catch (error) {
          complete({ ok: false, error });
          requestResolve();
        }
      });
      pending.add(request);
      request.finally(() => pending.delete(request));
      return true;
    };

    const run = async () => {
      forceGc();
      const memoryBefore = memorySnapshot();
      const startedAt = performance.now();
      const sampleTimer = runner.readClientStats
        ? setInterval(sampleClientStats, config.statsSampleMs)
        : undefined;

      try {
        for (const step of steps) {
          await runRampStep(config, step, launch);
        }

        await drainPending(pending);
        sampleClientStats();
        const durationMs = performance.now() - startedAt;
        const observabilityFlushMs = flushObservability(observability);
        forceGc();
        const memoryAfter = memorySnapshot();
        const serverStats = server.stats();
        const tracerStats = observability?.tracer.stats();
        const total = summarizeSteps(steps, durationMs, allLatencies);

        resolve({
          units: total.sentCount,
          unit: "http",
          variant: config.clientKind,
          profile: config.targets.join("->"),
          targetMaxTps: config.maxTps,
          stepTps: config.stepTps,
          stepSeconds: config.stepSeconds,
          plannedCount: total.plannedCount,
          scheduledCount: total.scheduledCount,
          sentCount: total.sentCount,
          droppedCount: total.droppedCount,
          missedCount: total.missedCount,
          successCount: total.successCount,
          errorCount: total.errorCount,
          durationMs: round(durationMs),
          throughputDurationMs: round(durationMs),
          actualAvgTps: total.actualAvgTps,
          maxStepActualTps: total.maxStepActualTps,
          requestP50Ms: total.requestP50Ms,
          requestP95Ms: total.requestP95Ms,
          requestP99Ms: total.requestP99Ms,
          targetAvgTps: total.targetAvgTps,
          concurrency: config.concurrency,
          delayMs: config.delayMs,
          serverMaxInFlight: serverStats.maxInFlight,
          clientMaxInFlight: maxClientInFlight,
          heapDeltaMb: toMb(memoryAfter.heapUsed - memoryBefore.heapUsed),
          rssDeltaMb: toMb(memoryAfter.rss - memoryBefore.rss),
          externalDeltaMb: toMb(memoryAfter.external - memoryBefore.external),
          gcAvailable: hasGc(),
          observabilityFlushMs,
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
          steps: steps.map(formatStep),
        });
      } finally {
        if (sampleTimer) clearInterval(sampleTimer);
      }
    };

    void run().catch(reject);
  });
}

function makeStepStats(targetTps: number, stepSeconds: number): MutableStepStats {
  return {
    targetTps,
    plannedCount: Math.max(1, Math.round(targetTps * stepSeconds)),
    scheduledCount: 0,
    sentCount: 0,
    droppedCount: 0,
    missedCount: 0,
    successCount: 0,
    errorCount: 0,
    startedAtMs: 0,
    durationMs: 0,
    latencies: [],
  };
}

async function runRampStep(
  config: RampConfig,
  step: MutableStepStats,
  launch: (step: MutableStepStats) => boolean,
): Promise<void> {
  const stepStartedAt = performance.now();
  const stepDurationMs = config.stepSeconds * 1000;
  const stepEndAt = stepStartedAt + stepDurationMs;
  const intervalMs = 1000 / step.targetTps;
  step.startedAtMs = stepStartedAt;

  while (step.scheduledCount < step.plannedCount) {
    const now = performance.now();
    if (now >= stepEndAt) break;

    const elapsedMs = now - stepStartedAt;
    const dueCount = Math.min(step.plannedCount, Math.floor(elapsedMs / intervalMs) + 1);
    while (step.scheduledCount < dueCount) {
      step.scheduledCount++;
      if (!launch(step)) step.droppedCount++;
    }

    const nextDueAt = stepStartedAt + step.scheduledCount * intervalMs;
    const sleepMs = Math.min(nextDueAt - performance.now(), stepEndAt - performance.now(), 10);
    await sleep(Math.max(0, sleepMs));
  }

  step.missedCount = Math.max(0, step.plannedCount - step.scheduledCount);
  const remainingMs = stepEndAt - performance.now();
  if (remainingMs > 0) await sleep(remainingMs);
  step.durationMs = performance.now() - stepStartedAt;
}

async function drainPending(pending: Set<Promise<void>>): Promise<void> {
  while (pending.size > 0) {
    await Promise.race(pending);
  }
}

function summarizeSteps(
  steps: readonly MutableStepStats[],
  durationMs: number,
  allLatencies: readonly number[],
) {
  const plannedCount = sumBy(steps, (step) => step.plannedCount);
  const scheduledCount = sumBy(steps, (step) => step.scheduledCount);
  const sentCount = sumBy(steps, (step) => step.sentCount);
  const droppedCount = sumBy(steps, (step) => step.droppedCount);
  const missedCount = sumBy(steps, (step) => step.missedCount);
  const successCount = sumBy(steps, (step) => step.successCount);
  const errorCount = sumBy(steps, (step) => step.errorCount);
  const latencyPercentiles = percentiles(allLatencies);
  return {
    plannedCount,
    scheduledCount,
    sentCount,
    droppedCount,
    missedCount,
    successCount,
    errorCount,
    targetAvgTps: round(plannedCount / (sumBy(steps, (step) => step.plannedCount / step.targetTps))),
    actualAvgTps: round(sentCount / (durationMs / 1000)),
    maxStepActualTps: round(Math.max(0, ...steps.map((step) => step.sentCount / Math.max(0.001, step.durationMs / 1000)))),
    requestP50Ms: latencyPercentiles.p50,
    requestP95Ms: latencyPercentiles.p95,
    requestP99Ms: latencyPercentiles.p99,
  };
}

function formatStep(step: MutableStepStats) {
  const latencyPercentiles = percentiles(step.latencies);
  return {
    targetTps: step.targetTps,
    actualTps: round(step.sentCount / Math.max(0.001, step.durationMs / 1000)),
    plannedCount: step.plannedCount,
    scheduledCount: step.scheduledCount,
    sentCount: step.sentCount,
    droppedCount: step.droppedCount,
    missedCount: step.missedCount,
    successCount: step.successCount,
    errorCount: step.errorCount,
    requestP50Ms: latencyPercentiles.p50,
    requestP95Ms: latencyPercentiles.p95,
    requestP99Ms: latencyPercentiles.p99,
  };
}

function sumBy<A>(items: readonly A[], f: (item: A) => number): number {
  return items.reduce((sum, item) => sum + f(item), 0);
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

function plannedRequestCount(config: RampConfig): number {
  return config.targets.reduce((sum, targetTps) => sum + Math.round(targetTps * config.stepSeconds), 0);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMb(bytes: number): number {
  return round(bytes / (1024 * 1024));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function benchmarkName(config: RampConfig): string {
  return [
    "http ramp TPS",
    config.clientKind,
    `max=${config.maxTps}`,
    `step=${config.stepTps}`,
    `${config.stepSeconds}s/step`,
    `concurrency=${config.concurrency}`,
    `delay=${config.delayMs}ms`,
  ].join(" ");
}

export const benchmarks: BenchmarkDef[] = [
  {
    name: benchmarkName(CONFIG),
    iterations: 1,
    warmup: 0,
    unit: "http",
    fn: () => runRampScenario(CONFIG),
  },
];

export default benchmarks;
