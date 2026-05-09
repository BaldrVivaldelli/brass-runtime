import type { MetricsRegistry } from "../core/runtime/metrics";
import type { Runtime } from "../core/runtime/runtime";
import type { RuntimeRegistry } from "../core/runtime/registry";
import type { CircuitBreakerStats } from "../core/runtime/circuitBreaker";
import { asyncSync, type Async } from "../core/types/asyncEffect";
import type { AdaptiveLimiterStats } from "../http/adaptiveLimiter";

export type HealthStatus = "ok" | "degraded" | "down";

export type HealthCheckResult = {
  readonly status: HealthStatus;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
};

export type HealthCheck = () => HealthCheckResult;

export type RuntimeHealthOptions = {
  readonly runtime?: Runtime<any>;
  readonly registry?: RuntimeRegistry;
  readonly metrics?: MetricsRegistry;
  readonly circuitBreakers?: Record<string, { stats: () => CircuitBreakerStats }>;
  readonly adaptiveLimiters?: Record<string, { stats: () => AdaptiveLimiterStats }>;
  readonly checks?: Record<string, HealthCheck>;
  readonly clock?: () => number;
  readonly readiness?: {
    readonly failOnDegraded?: boolean;
  };
};

export type RuntimeHealthReport = {
  readonly status: HealthStatus;
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly fibers?: {
    readonly active: number;
    readonly suspended: number;
    readonly done: number;
  };
  readonly scopes?: {
    readonly open: number;
    readonly closed: number;
  };
  readonly runtime?: {
    readonly engine?: string;
    readonly fiberStats?: unknown;
    readonly scheduler?: unknown;
  };
  readonly metrics?: {
    readonly counters: number;
    readonly gauges: number;
    readonly histograms: number;
    readonly activeFibers?: number;
    readonly activeScopes?: number;
    readonly activeSpans?: number;
  };
  readonly circuitBreakers: Record<string, CircuitBreakerStats & { readonly status: HealthStatus }>;
  readonly adaptiveLimiters: Record<string, AdaptiveLimiterStats & { readonly status: HealthStatus }>;
  readonly checks: Record<string, HealthCheckResult>;
};

export type HealthHttpResponse = {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
};

export function snapshotRuntimeHealth(options: RuntimeHealthOptions = {}): RuntimeHealthReport {
  const checkedAtMs = options.clock?.() ?? Date.now();
  const checks = runChecks(options.checks);
  const circuitBreakers = collectCircuitBreakers(options.circuitBreakers);
  const adaptiveLimiters = collectAdaptiveLimiters(options.adaptiveLimiters);
  const fibers = options.registry ? fiberSummary(options.registry) : undefined;
  const scopes = options.registry ? scopeSummary(options.registry) : undefined;
  const metrics = options.metrics ? metricsSummary(options.metrics) : undefined;
  const runtime = options.runtime ? runtimeSummary(options.runtime) : undefined;

  const status = aggregateStatus([
    ...Object.values(checks).map((check) => check.status),
    ...Object.values(circuitBreakers).map((breaker) => breaker.status),
    ...Object.values(adaptiveLimiters).map((limiter) => limiter.status),
    ...(runtimeSchedulerDropped(runtime) > 0 ? ["degraded" as const] : []),
  ]);

  return {
    status,
    ready: status === "ok" || (status === "degraded" && options.readiness?.failOnDegraded !== true),
    checkedAt: new Date(checkedAtMs).toISOString(),
    ...(fibers ? { fibers } : {}),
    ...(scopes ? { scopes } : {}),
    ...(runtime ? { runtime } : {}),
    ...(metrics ? { metrics } : {}),
    circuitBreakers,
    adaptiveLimiters,
    checks,
  };
}

export function makeRuntimeHealth(options: RuntimeHealthOptions = {}): Async<unknown, never, RuntimeHealthReport> {
  return asyncSync(() => snapshotRuntimeHealth(options)) as Async<unknown, never, RuntimeHealthReport>;
}

export const runtimeHealth = makeRuntimeHealth;

export function readiness(options: RuntimeHealthOptions = {}): Async<unknown, never, boolean> {
  return asyncSync(() => snapshotRuntimeHealth(options).ready) as Async<unknown, never, boolean>;
}

export function healthToHttpResponse(report: RuntimeHealthReport): HealthHttpResponse {
  return {
    status: report.ready ? 200 : 503,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  };
}

function runChecks(checks: RuntimeHealthOptions["checks"]): Record<string, HealthCheckResult> {
  const out: Record<string, HealthCheckResult> = {};
  for (const [name, check] of Object.entries(checks ?? {})) {
    try {
      out[name] = normalizeHealthCheckResult(check());
    } catch (error) {
      out[name] = {
        status: "down",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return out;
}

function collectCircuitBreakers(
  breakers: RuntimeHealthOptions["circuitBreakers"]
): RuntimeHealthReport["circuitBreakers"] {
  const out: RuntimeHealthReport["circuitBreakers"] = {};
  for (const [name, breaker] of Object.entries(breakers ?? {})) {
    const stats = breaker.stats();
    out[name] = {
      ...stats,
      status: stats.state === "open" ? "down" : stats.state === "half-open" ? "degraded" : "ok",
    };
  }
  return out;
}

function collectAdaptiveLimiters(
  limiters: RuntimeHealthOptions["adaptiveLimiters"]
): RuntimeHealthReport["adaptiveLimiters"] {
  const out: RuntimeHealthReport["adaptiveLimiters"] = {};
  for (const [name, limiter] of Object.entries(limiters ?? {})) {
    const stats = limiter.stats();
    out[name] = {
      ...stats,
      status: adaptiveLimiterStatus(stats),
    };
  }
  return out;
}

function adaptiveLimiterStatus(stats: AdaptiveLimiterStats): HealthStatus {
  const rejectionRate = stats.rejectionRate ?? 0;
  const errorRate = stats.errorRate ?? 0;
  if (rejectionRate >= 0.5) return "down";
  if (rejectionRate > 0 || stats.queueDepth > stats.limit || errorRate >= 0.25) return "degraded";
  return "ok";
}

function fiberSummary(registry: RuntimeRegistry): NonNullable<RuntimeHealthReport["fibers"]> {
  const fibers = Array.from(registry.fibers.values());
  return {
    active: fibers.filter((fiber) => fiber.status === "Running").length,
    suspended: fibers.filter((fiber) => fiber.runState === "Suspended").length,
    done: fibers.filter((fiber) => fiber.runState === "Done").length,
  };
}

function scopeSummary(registry: RuntimeRegistry): NonNullable<RuntimeHealthReport["scopes"]> {
  const scopes = Array.from(registry.scopes.values());
  return {
    open: scopes.filter((scope) => scope.closedAt === undefined).length,
    closed: scopes.filter((scope) => scope.closedAt !== undefined).length,
  };
}

function metricsSummary(metrics: MetricsRegistry): NonNullable<RuntimeHealthReport["metrics"]> {
  const snapshot = metrics.snapshot();
  const gaugeValue = (name: string) => snapshot.gauges.find((gauge) => gauge.name === name)?.value;
  return {
    counters: snapshot.counters.length,
    gauges: snapshot.gauges.length,
    histograms: snapshot.histograms.length,
    activeFibers: gaugeValue("brass_runtime_fibers_active"),
    activeScopes: gaugeValue("brass_runtime_scopes_active"),
    activeSpans: gaugeValue("brass_runtime_spans_active"),
  };
}

function runtimeSummary(runtime: Runtime<any>): NonNullable<RuntimeHealthReport["runtime"]> {
  const stats = runtime.stats?.();
  const scheduler = runtime.scheduler?.stats?.();
  return {
    engine: stats?.engine,
    fiberStats: stats?.data,
    scheduler,
  };
}

function runtimeSchedulerDropped(runtime: RuntimeHealthReport["runtime"]): number {
  const data = (runtime?.scheduler as any)?.data;
  return typeof data?.droppedTasks === "number" ? data.droppedTasks : 0;
}

function aggregateStatus(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

function normalizeHealthCheckResult(result: HealthCheckResult): HealthCheckResult {
  return {
    status: result.status,
    ...(result.message ? { message: result.message } : {}),
    ...(result.details ? { details: result.details } : {}),
  };
}
