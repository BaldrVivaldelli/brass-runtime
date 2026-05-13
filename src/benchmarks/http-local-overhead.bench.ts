/**
 * Benchmark: in-process HTTP overhead without network latency.
 *
 * This mirrors adapter benchmarks that mock the host HTTP client. It answers a
 * different question than the local-server TPS tests: "how much overhead does
 * Brass add when the downstream returns immediately?"
 */

import { Runtime } from "../core/runtime/runtime";
import { asyncSucceed, type Async } from "../core/types/asyncEffect";
import {
  makeObservability,
  withHttpObservability,
  type Observability,
} from "../observability";
import {
  makeHttp,
  type HttpError,
  type HttpTransport,
  type HttpWireResponse,
} from "../http";
import { makeDefaultHttpClient } from "../http/defaultClient";
import type { HttpResponse } from "../http/httpClient";
import { promiseHttpTransport } from "../http/transport";
import { s } from "../schema";
import type { BenchmarkDef } from "./runner";

type Payload = {
  readonly ok: true;
  readonly id: number;
  readonly source: string;
};

type ScenarioKind =
  | "direct-promise-json"
  | "runtime-async-succeed"
  | "wire-effect-transport"
  | "default-proxy-effect-transport"
  | "default-proxy-effect-schema"
  | "default-proxy-effect-timeout"
  | "default-proxy-effect-pool"
  | "default-proxy-effect-timeout-pool"
  | "default-proxy-promise-transport"
  | "axios-raw-promise"
  | "axios-brass-promise-pool-timeout"
  | "observability-metrics-only"
  | "observability-spans"
  | "default-observed-metrics-only-effect-transport"
  | "default-observed-http-metrics-only-effect-transport"
  | "default-observed-effect-transport";

type LoadRunner = (
  id: number,
  cb: (result: { readonly ok: boolean; readonly error?: unknown }) => void,
) => void;

type ScenarioRunner = {
  readonly runOne: LoadRunner;
  readonly cleanup?: () => Promise<void> | void;
};

type LoadDetails = Record<string, unknown> & {
  readonly units: number;
  readonly unit: "http";
  readonly variant: ScenarioKind;
  readonly calls: number;
  readonly warmupCalls: number;
  readonly concurrency: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly durationMs: number;
  readonly throughputDurationMs: number;
  readonly requestP50Ms: number;
  readonly requestP95Ms: number;
  readonly requestP99Ms: number;
};

const CALLS = envInt("BRASS_HTTP_OVERHEAD_CALLS", 3_000);
const WARMUP_CALLS = envNonNegativeInt("BRASS_HTTP_OVERHEAD_WARMUP_CALLS", 500);
const CONCURRENCY = envInt("BRASS_HTTP_OVERHEAD_CONCURRENCY", 8);
const SPAN_SAMPLING = envRatio("BRASS_HTTP_OVERHEAD_SPAN_SAMPLING", 0.001);
const SELECTED_VARIANTS = envStringSet("BRASS_HTTP_OVERHEAD_VARIANTS");
const BASE_URL = "http://brass.local";
const RESPONSE_BODY_BY_SOURCE = new Map<string, string>();
const RESPONSE_PAYLOAD_BY_SOURCE = new Map<string, Payload>();
const PAYLOAD_SCHEMA = s.object({
  ok: s.literal(true),
  id: s.int(),
  source: s.string(),
});

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

function envRatio(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
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

function payload(id: number, source: string): Payload {
  return {
    ok: true,
    id,
    source,
  };
}

function responseBody(source: string): string {
  const existing = RESPONSE_BODY_BY_SOURCE.get(source);
  if (existing) return existing;
  const created = JSON.stringify(payload(0, source));
  RESPONSE_BODY_BY_SOURCE.set(source, created);
  return created;
}

function responsePayload(source: string): Payload {
  const existing = RESPONSE_PAYLOAD_BY_SOURCE.get(source);
  if (existing) return existing;
  const created = payload(0, source);
  RESPONSE_PAYLOAD_BY_SOURCE.set(source, created);
  return created;
}

function wireResponse(source: string): HttpWireResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    bodyText: responseBody(source),
    ms: 0,
  };
}

function effectTransport(source: string): HttpTransport {
  return () => asyncSucceed(wireResponse(source)) as Async<unknown, HttpError, HttpWireResponse>;
}

function promiseTransport(source: string): HttpTransport {
  return promiseHttpTransport()
    .request(() => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      data: responsePayload(source),
    }))
    .json();
}

/**
 * Simulates an Axios-like transport with realistic async behavior.
 * Uses setImmediate/queueMicrotask to simulate the minimum async overhead
 * of a real HTTP client (Axios resolves via microtask after socket data arrives).
 */
function axiosLikeTransport(source: string): HttpTransport {
  const payload = responsePayload(source);
  return promiseHttpTransport()
    .request(() => {
      // Simulate Axios: returns a Promise that resolves on next microtask
      // (mimics the minimum overhead of a real HTTP response arriving)
      return new Promise<{ status: number; statusText: string; headers: Record<string, string>; data: Payload }>((resolve) => {
        queueMicrotask(() => {
          resolve({
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
            data: payload,
          });
        });
      });
    })
    .json();
}

function runtime(): Runtime<unknown> {
  return Runtime.makeWithEngine({}, "ts", {
    inferLane: false,
  }).withLane("bench/http-local-overhead");
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

function makeScenarioRunner(kind: ScenarioKind): ScenarioRunner {
  switch (kind) {
    case "direct-promise-json":
      return {
        runOne: (id, cb) => {
          Promise.resolve(payload(id, "direct"))
            .then((value) => cb({ ok: value.ok === true }))
            .catch((error) => cb({ ok: false, error }));
        },
      };
    case "runtime-async-succeed": {
      const rt = runtime();
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            asyncSucceed(payload(id, "runtime")) as Async<unknown, HttpError, Payload>,
            cb,
            (value) => value.ok === true,
          );
        },
      };
    }
    case "wire-effect-transport": {
      const rt = runtime();
      const client = makeHttp({ baseUrl: BASE_URL, transport: effectTransport("wire") });
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client({ method: "GET", url: `/todos/${id % 100}?i=${id}` }),
            cb,
            (res) => res.status === 200 && res.bodyText.length > 0,
          );
        },
        cleanup: () => client.shutdown?.(),
      };
    }
    case "default-proxy-effect-transport": {
      const rt = runtime();
      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "proxy",
        transport: effectTransport("proxy-effect"),
      });
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client.getJson<Payload>(`/todos/${id % 100}?i=${id}`) as Async<
              unknown,
              HttpError,
              HttpResponse<Payload>
            >,
            cb,
            (res) => res.status === 200 && res.body.ok === true,
          );
        },
        cleanup: () => client.shutdown(),
      };
    }
    case "default-proxy-effect-schema": {
      const rt = runtime();
      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "proxy",
        transport: effectTransport("proxy-schema"),
      });
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client.getJson(`/todos/${id % 100}?i=${id}`, { schema: PAYLOAD_SCHEMA }) as Async<
              unknown,
              HttpError,
              HttpResponse<Payload>
            >,
            cb,
            (res) => res.status === 200 && res.body.ok === true,
          );
        },
        cleanup: () => client.shutdown(),
      };
    }
    case "default-proxy-effect-timeout": {
      const rt = runtime();
      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "proxy",
        timeoutMs: 30_000,
        transport: effectTransport("proxy-timeout"),
      });
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client.getJson<Payload>(`/todos/${id % 100}?i=${id}`) as Async<
              unknown,
              HttpError,
              HttpResponse<Payload>
            >,
            cb,
            (res) => res.status === 200 && res.body.ok === true,
          );
        },
        cleanup: () => client.shutdown(),
      };
    }
    case "default-proxy-effect-pool": {
      const rt = runtime();
      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "proxy",
        pool: {
          concurrency: CONCURRENCY,
          maxQueue: CONCURRENCY,
          key: "origin",
        },
        transport: effectTransport("proxy-pool"),
      });
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client.getJson<Payload>(`/todos/${id % 100}?i=${id}`) as Async<
              unknown,
              HttpError,
              HttpResponse<Payload>
            >,
            cb,
            (res) => res.status === 200 && res.body.ok === true,
          );
        },
        cleanup: () => client.shutdown(),
      };
    }
    case "default-proxy-effect-timeout-pool": {
      const rt = runtime();
      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "proxy",
        timeoutMs: 30_000,
        pool: {
          concurrency: CONCURRENCY,
          maxQueue: CONCURRENCY,
          key: "origin",
        },
        transport: effectTransport("proxy-timeout-pool"),
      });
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client.getJson<Payload>(`/todos/${id % 100}?i=${id}`) as Async<
              unknown,
              HttpError,
              HttpResponse<Payload>
            >,
            cb,
            (res) => res.status === 200 && res.body.ok === true,
          );
        },
        cleanup: () => client.shutdown(),
      };
    }
    case "default-proxy-promise-transport": {
      const rt = runtime();
      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "proxy",
        transport: promiseTransport("proxy-promise"),
      });
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client.getJson<Payload>(`/todos/${id % 100}?i=${id}`) as Async<
              unknown,
              HttpError,
              HttpResponse<Payload>
            >,
            cb,
            (res) => res.status === 200 && res.body.ok === true,
          );
        },
        cleanup: () => client.shutdown(),
      };
    }
    case "axios-raw-promise": {
      // Baseline: raw Axios-like promise call without brass — measures the minimum
      // async overhead of a microtask-based HTTP response.
      const payload = responsePayload("axios-raw");
      return {
        runOne: (id, cb) => {
          new Promise<Payload>((resolve) => {
            queueMicrotask(() => resolve(payload));
          }).then(
            (value) => cb({ ok: value.ok === true }),
            (error) => cb({ ok: false, error }),
          );
        },
      };
    }
    case "axios-brass-promise-pool-timeout": {
      // Full brass stack with Axios-like transport: pool + timeout + promise transport.
      // This measures the overhead brass adds over a raw Axios call.
      const rt = runtime();
      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "proxy",
        transport: axiosLikeTransport("axios-brass"),
        timeoutMs: 30_000,
        pool: { concurrency: 8, maxQueue: 64, key: "origin" },
      });
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client.getJson<Payload>(`/todos/${id % 100}?i=${id}`) as Async<
              unknown,
              HttpError,
              HttpResponse<Payload>
            >,
            cb,
            (res) => res.status === 200 && res.body.ok === true,
          );
        },
        cleanup: () => client.shutdown(),
      };
    }
    case "observability-metrics-only": {
      const obs: Observability = makeObservability({
        metrics: false,
        logs: false,
        traces: false,
        autoStart: false,
      });
      const rt = runtime();
      const client = withHttpObservability({
        metrics: obs.metrics,
        logs: false,
        spans: false,
        adaptiveLimiter: false,
        injectTraceHeaders: false,
        includeHostLabel: false,
        route: "/todos/:id",
      })(() => asyncSucceed(wireResponse("observability-metrics")) as Async<unknown, HttpError, HttpWireResponse>);
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client({ method: "GET", url: `/todos/${id % 100}?i=${id}` }),
            cb,
            (res) => res.status === 200 && res.bodyText.length > 0,
          );
        },
        cleanup: () => obs.shutdown(),
      };
    }
    case "observability-spans": {
      const obs: Observability = makeObservability({
        metrics: false,
        logs: false,
        traces: { maxFinishedSpans: Math.max(10_000, CALLS * 2) },
        sampling: SPAN_SAMPLING,
        autoStart: false,
      });
      const rt = Runtime.makeWithEngine(obs.env, "ts", {
        inferLane: false,
      }).withLane("bench/http-local-overhead");
      const client = withHttpObservability({
        metrics: obs.metrics,
        logs: false,
        spans: { events: false, sampleRate: SPAN_SAMPLING },
        spanSink: obs.tracer,
        adaptiveLimiter: false,
        injectTraceHeaders: false,
        includeHostLabel: false,
        route: "/todos/:id",
      })(() => asyncSucceed(wireResponse("observability-spans")) as Async<unknown, HttpError, HttpWireResponse>);
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client({ method: "GET", url: `/todos/${id % 100}?i=${id}` }),
            cb,
            (res) => res.status === 200 && res.bodyText.length > 0,
          );
        },
        cleanup: () => obs.shutdown(),
      };
    }
    case "default-observed-metrics-only-effect-transport": {
      const obs: Observability = makeObservability({
        metrics: false,
        logs: false,
        traces: false,
        autoStart: false,
      });
      const rt = runtime();
      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "proxy",
        transport: effectTransport("observed-metrics"),
        middleware: [
          withHttpObservability({
            metrics: obs.metrics,
            logs: false,
            spans: false,
            adaptiveLimiter: false,
            injectTraceHeaders: false,
            includeHostLabel: false,
            route: "/todos/:id",
          }),
        ],
      });
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client.getJson<Payload>(`/todos/${id % 100}?i=${id}`) as Async<
              unknown,
              HttpError,
              HttpResponse<Payload>
            >,
            cb,
            (res) => res.status === 200 && res.body.ok === true,
          );
        },
        cleanup: async () => {
          client.shutdown();
          await obs.shutdown();
        },
      };
    }
    case "default-observed-http-metrics-only-effect-transport": {
      const obs: Observability = makeObservability({
        logs: false,
        traces: false,
        autoStart: false,
      });
      const rt = runtime();
      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "proxy",
        transport: effectTransport("observed-http-metrics"),
        middleware: [
          withHttpObservability({
            metrics: obs.metrics,
            logs: false,
            spans: false,
            adaptiveLimiter: false,
            injectTraceHeaders: false,
            includeHostLabel: false,
            route: "/todos/:id",
          }),
        ],
      });
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client.getJson<Payload>(`/todos/${id % 100}?i=${id}`) as Async<
              unknown,
              HttpError,
              HttpResponse<Payload>
            >,
            cb,
            (res) => res.status === 200 && res.body.ok === true,
          );
        },
        cleanup: async () => {
          client.shutdown();
          await obs.shutdown();
        },
      };
    }
    case "default-observed-effect-transport": {
      const obs: Observability = makeObservability({
        metrics: false,
        logs: false,
        traces: { maxFinishedSpans: Math.max(10_000, CALLS * 2) },
        sampling: SPAN_SAMPLING,
        autoStart: false,
      });
      const rt = Runtime.makeWithEngine(obs.env, "ts", {
        inferLane: false,
      }).withLane("bench/http-local-overhead");
      const client = makeDefaultHttpClient({
        baseUrl: BASE_URL,
        preset: "proxy",
        transport: effectTransport("observed"),
        middleware: [
          withHttpObservability({
            metrics: obs.metrics,
            logs: false,
            spans: { events: false, sampleRate: SPAN_SAMPLING },
            spanSink: obs.tracer,
            adaptiveLimiter: false,
            injectTraceHeaders: false,
            includeHostLabel: false,
            route: "/todos/:id",
          }),
        ],
      });
      return {
        runOne: (id, cb) => {
          runRuntimeEffect(
            rt,
            client.getJson<Payload>(`/todos/${id % 100}?i=${id}`) as Async<
              unknown,
              HttpError,
              HttpResponse<Payload>
            >,
            cb,
            (res) => res.status === 200 && res.body.ok === true,
          );
        },
        cleanup: async () => {
          client.shutdown();
          await obs.shutdown();
        },
      };
    }
  }
}

async function runScenario(kind: ScenarioKind): Promise<LoadDetails> {
  return runScenarioWithConfig(kind, CALLS, WARMUP_CALLS, CONCURRENCY);
}

async function runScenarioWithConfig(
  kind: ScenarioKind,
  calls: number,
  warmupCalls: number,
  concurrency: number,
): Promise<LoadDetails> {
  const runner = makeScenarioRunner(kind);
  try {
    if (warmupCalls > 0) {
      const warmup = await runLoad(kind, runner, warmupCalls, 1_000_000, concurrency);
      if (warmup.errorCount > 0) {
        throw new Error(`HTTP local overhead warmup had ${warmup.errorCount} errors; first=${warmup.firstError}`);
      }
    }

    const result = await runLoad(kind, runner, calls, 0, concurrency);
    if (result.errorCount > 0) {
      throw new Error(`HTTP local overhead benchmark had ${result.errorCount} errors; first=${result.firstError}`);
    }
    return result;
  } finally {
    await runner.cleanup?.();
  }
}

function runLoad(
  kind: ScenarioKind,
  runner: ScenarioRunner,
  calls: number,
  idOffset: number,
  concurrency: number = CONCURRENCY,
): Promise<LoadDetails & { readonly firstError: string }> {
  return new Promise((resolve, reject) => {
    let next = 0;
    let inFlight = 0;
    let completed = 0;
    let successCount = 0;
    let errorCount = 0;
    let firstError: unknown;
    const latencies = new Array<number>(calls);
    const startedAt = performance.now();

    const finish = () => {
      const durationMs = performance.now() - startedAt;
      const latencyPercentiles = percentiles(latencies);
      resolve({
        units: calls,
        unit: "http",
        variant: kind,
        calls,
        warmupCalls: WARMUP_CALLS,
        concurrency,
        successCount,
        errorCount,
        durationMs: round(durationMs),
        throughputDurationMs: round(durationMs),
        httpPerSec: round(calls / (durationMs / 1000)),
        requestP50Ms: latencyPercentiles.p50,
        requestP95Ms: latencyPercentiles.p95,
        requestP99Ms: latencyPercentiles.p99,
        firstError: firstError ? String(firstError) : "",
      });
    };

    const launch = (): void => {
      while (inFlight < concurrency && next < calls) {
        const index = next++;
        const id = idOffset + index;
        const requestStartedAt = performance.now();
        inFlight++;

        runner.runOne(id, (result) => {
          latencies[index] = performance.now() - requestStartedAt;
          inFlight--;
          completed++;

          if (result.ok) {
            successCount++;
          } else {
            errorCount++;
            if (firstError === undefined) firstError = result.error ?? "unknown HTTP local overhead error";
          }

          if (completed === calls) {
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
      reject(error);
    }
  });
}

function percentiles(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: round(percentile(sorted, 0.5)),
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

function scenarioKinds(): readonly ScenarioKind[] {
  const all: readonly ScenarioKind[] = [
    "direct-promise-json",
    "runtime-async-succeed",
    "wire-effect-transport",
    "default-proxy-effect-transport",
    "default-proxy-effect-schema",
    "default-proxy-effect-timeout",
    "default-proxy-effect-pool",
    "default-proxy-effect-timeout-pool",
    "default-proxy-promise-transport",
    "axios-raw-promise",
    "axios-brass-promise-pool-timeout",
    "observability-metrics-only",
    "observability-spans",
    "default-observed-metrics-only-effect-transport",
    "default-observed-http-metrics-only-effect-transport",
    "default-observed-effect-transport",
  ];
  if (SELECTED_VARIANTS.size === 0) return all;
  return all.filter((kind) => SELECTED_VARIANTS.has(kind));
}

// Feature: http-p99-consolidation, Benchmark regression gate

/**
 * Result of a P99/P50 ratio assertion for a single benchmark variant.
 */
export interface BenchmarkVariantResult {
  variant: string;
  p50Ms: number;
  p99Ms: number;
  ratio: number;
  threshold: number;
  passed: boolean;
}

/**
 * Variants subject to P99/P50 ratio assertion and their thresholds.
 */
const P99_RATIO_VARIANTS: ReadonlyArray<{ name: ScenarioKind; threshold: number }> = [
  { name: "default-proxy-effect-transport", threshold: 4.0 },
  { name: "default-proxy-effect-timeout-pool", threshold: 4.0 },
  { name: "axios-brass-promise-pool-timeout", threshold: 4.0 },
];

/**
 * Asserts P99/P50 ≤ threshold for each variant result.
 * Prints per-variant pass/fail to stdout and exits with non-zero code if any variant fails.
 */
export function assertP99Ratio(results: BenchmarkVariantResult[]): void {
  console.log("\n── P99/P50 Ratio Assertions ──\n");
  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    console.log(
      `${status} ${r.variant}: P99/P50 = ${r.ratio.toFixed(2)}x (threshold: ${r.threshold}x)` +
        ` [p50=${r.p50Ms.toFixed(3)}ms, p99=${r.p99Ms.toFixed(3)}ms]`,
    );
    if (!r.passed) allPassed = false;
  }
  console.log();
  if (!allPassed) {
    console.log("❌ Benchmark regression gate FAILED: one or more variants exceeded P99/P50 threshold.");
    process.exit(1);
  } else {
    console.log("✅ Benchmark regression gate PASSED: all variants within P99/P50 threshold.");
  }
}

/**
 * Runs the P99/P50 ratio assertion benchmark for the gated variants.
 * Uses 1000 measured calls, 500 warmup calls, concurrency 8 as specified
 * by the benchmark regression gate requirements.
 */
export async function runP99Assertions(): Promise<BenchmarkVariantResult[]> {
  const gateCalls = envInt("BRASS_HTTP_OVERHEAD_GATE_CALLS", 1000);
  const gateWarmup = envNonNegativeInt("BRASS_HTTP_OVERHEAD_GATE_WARMUP", 1000);
  const gateConcurrency = envInt("BRASS_HTTP_OVERHEAD_GATE_CONCURRENCY", 8);

  const results: BenchmarkVariantResult[] = [];

  for (const { name, threshold } of P99_RATIO_VARIANTS) {
    const details = await runScenarioWithConfig(name, gateCalls, gateWarmup, gateConcurrency);
    const p50Ms = details.requestP50Ms;
    const p99Ms = details.requestP99Ms;
    const ratio = p50Ms > 0 ? p99Ms / p50Ms : Infinity;
    results.push({
      variant: name,
      p50Ms,
      p99Ms,
      ratio: Math.round(ratio * 100) / 100,
      threshold,
      passed: ratio <= threshold,
    });
  }

  return results;
}

export const benchmarks: BenchmarkDef[] = scenarioKinds().map((kind) => ({
  name: `http local overhead ${kind} calls=${CALLS} warmup=${WARMUP_CALLS} concurrency=${CONCURRENCY}`,
  iterations: 1,
  warmup: 0,
  unit: "http",
  fn: () => runScenario(kind),
}));

export default benchmarks;
