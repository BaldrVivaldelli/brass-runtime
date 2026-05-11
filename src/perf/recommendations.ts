import type { HttpLayerProfileReport, HttpLayerProfileResult } from "./httpProfiler";
import type { PerfMemoryDelta } from "./memory";
import type { RuntimePrimitiveProfileReport } from "./runtimeProfiler";

export type PerfRecommendationSeverity = "info" | "warn" | "critical";

export type PerfRecommendation = {
  readonly severity: PerfRecommendationSeverity;
  readonly area: "runtime" | "http" | "memory" | "observability" | "benchmark";
  readonly title: string;
  readonly message: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly action?: string;
};

export type PerfRecommendationThresholds = {
  readonly maxHeapDeltaMb?: number;
  readonly criticalHeapDeltaMb?: number;
  readonly minDefaultVsNodeRatio?: number;
  readonly minObservedVsDefaultRatio?: number;
  readonly maxHttpP99Ms?: number;
  readonly minRuntimeOpsPerSecond?: number;
};

export type PerfRecommendationInput = {
  readonly http?: HttpLayerProfileReport;
  readonly runtime?: RuntimePrimitiveProfileReport;
  readonly memoryDelta?: PerfMemoryDelta;
  readonly thresholds?: PerfRecommendationThresholds;
};

export function recommendPerformance(input: PerfRecommendationInput): readonly PerfRecommendation[] {
  const thresholds = {
    maxHeapDeltaMb: input.thresholds?.maxHeapDeltaMb ?? 16,
    criticalHeapDeltaMb: input.thresholds?.criticalHeapDeltaMb ?? 64,
    minDefaultVsNodeRatio: input.thresholds?.minDefaultVsNodeRatio ?? 0.7,
    minObservedVsDefaultRatio: input.thresholds?.minObservedVsDefaultRatio ?? 0.7,
    maxHttpP99Ms: input.thresholds?.maxHttpP99Ms ?? Math.max(250, (input.http?.delayMs ?? 1) * 80),
    minRuntimeOpsPerSecond: input.thresholds?.minRuntimeOpsPerSecond ?? 25_000,
  };

  const out: PerfRecommendation[] = [];
  addHttpRecommendations(out, input.http, thresholds);
  addRuntimeRecommendations(out, input.runtime, thresholds);
  addMemoryRecommendations(out, input.memoryDelta, thresholds);

  if (out.length === 0) {
    out.push({
      severity: "info",
      area: "benchmark",
      title: "No obvious performance regression",
      message: "The sampled runtime, HTTP, and memory signals are inside the default profiler thresholds.",
      action: "Keep this report as a baseline and compare it after larger runtime or HTTP changes.",
    });
  }

  return Object.freeze(out.map((item) => Object.freeze(item)));
}

function addHttpRecommendations(
  out: PerfRecommendation[],
  report: HttpLayerProfileReport | undefined,
  thresholds: Required<PerfRecommendationThresholds>,
): void {
  if (!report) return;
  const node = findResult(report, "node-http-text");
  const def = findResult(report, "default-json");
  const observed = findResult(report, "default-json-observed");

  for (const result of report.results) {
    if (result.errorCount > 0) {
      out.push({
        severity: "critical",
        area: "http",
        title: `HTTP errors in ${result.variant}`,
        message: `${result.errorCount} of ${result.calls} profiled requests failed.`,
        evidence: {
          variant: result.variant,
          firstError: result.firstError,
          successCount: result.successCount,
          errorCount: result.errorCount,
        },
        action: "Inspect timeout, pool, queue, retry, and server-side pressure before trusting throughput numbers.",
      });
    }

    if (result.memory.delta.heapUsedMb >= thresholds.criticalHeapDeltaMb) {
      out.push(memoryRecommendation("critical", result));
    } else if (result.memory.delta.heapUsedMb >= thresholds.maxHeapDeltaMb) {
      out.push(memoryRecommendation("warn", result));
    }

    if (result.requestP99Ms > thresholds.maxHttpP99Ms) {
      out.push({
        severity: "warn",
        area: "http",
        title: `High p99 latency in ${result.variant}`,
        message: `p99 was ${result.requestP99Ms}ms against a ${report.delayMs}ms local server delay.`,
        evidence: {
          variant: result.variant,
          p50Ms: result.requestP50Ms,
          p95Ms: result.requestP95Ms,
          p99Ms: result.requestP99Ms,
          thresholdMs: thresholds.maxHttpP99Ms,
        },
        action: "Compare queue depth, adaptive limiter state, and observability overhead for this variant.",
      });
    }

    if ((result.lifecycleMaxQueueDepth ?? 0) > 0 || (result.clientPoolMaxQueued ?? 0) > 0) {
      out.push({
        severity: "info",
        area: "http",
        title: `Queueing observed in ${result.variant}`,
        message: "The client queued work during the run, so throughput is bounded by a limiter or pool setting.",
        evidence: {
          variant: result.variant,
          lifecycleMaxQueueDepth: result.lifecycleMaxQueueDepth,
          clientPoolMaxQueued: result.clientPoolMaxQueued,
          concurrency: result.concurrency,
        },
        action: "Tune priority concurrency, pool concurrency, or adaptive limiter bounds for this workload.",
      });
    }

    if ((result.adaptiveMaxQueueDepth ?? 0) > 0 && (result.adaptiveFinalLimit ?? result.concurrency) < result.concurrency / 4) {
      out.push({
        severity: "warn",
        area: "http",
        title: `Adaptive limiter constrained ${result.variant}`,
        message: "The adaptive limiter ended far below requested concurrency while requests queued.",
        evidence: {
          variant: result.variant,
          adaptiveFinalLimit: result.adaptiveFinalLimit,
          adaptiveMaxQueueDepth: result.adaptiveMaxQueueDepth,
          concurrency: result.concurrency,
          adaptiveFinalGradient: result.adaptiveFinalGradient,
        },
        action: "Try a warmer initial limit, more warmup calls, or a more aggressive preset for short local workloads.",
      });
    }
  }

  if (node && def) {
    const ratio = ratioOf(def.httpPerSec, node.httpPerSec);
    if (ratio < thresholds.minDefaultVsNodeRatio) {
      out.push({
        severity: "warn",
        area: "http",
        title: "Default HTTP overhead is visible",
        message: `Default JSON throughput is ${(ratio * 100).toFixed(1)}% of the node:http baseline.`,
        evidence: {
          nodeHttpPerSec: node.httpPerSec,
          defaultHttpPerSec: def.httpPerSec,
          ratio,
        },
        action: "Run the focused HTTP profile with GC enabled and compare minimal, balanced, default, and observed variants.",
      });
    }
  }

  if (def && observed) {
    const ratio = ratioOf(observed.httpPerSec, def.httpPerSec);
    if (ratio < thresholds.minObservedVsDefaultRatio) {
      out.push({
        severity: "warn",
        area: "observability",
        title: "Observability overhead is visible",
        message: `Observed default throughput is ${(ratio * 100).toFixed(1)}% of the unobserved default client.`,
        evidence: {
          defaultHttpPerSec: def.httpPerSec,
          observedHttpPerSec: observed.httpPerSec,
          ratio,
          observedFinishedSpans: observed.observedFinishedSpans,
        },
        action: "Check span retention, attribute cardinality, trace sampling, and exporter flush strategy.",
      });
    }
  }
}

function addRuntimeRecommendations(
  out: PerfRecommendation[],
  report: RuntimePrimitiveProfileReport | undefined,
  thresholds: Required<PerfRecommendationThresholds>,
): void {
  if (!report) return;
  for (const result of report.results) {
    if (result.units >= 1_000 && result.operationsPerSecond < thresholds.minRuntimeOpsPerSecond) {
      out.push({
        severity: "info",
        area: "runtime",
        title: `Low sampled runtime throughput for ${result.name}`,
        message: `${result.name} measured ${result.operationsPerSecond} ${result.unit}/s in this local profile.`,
        evidence: {
          primitive: result.name,
          operationsPerSecond: result.operationsPerSecond,
          threshold: thresholds.minRuntimeOpsPerSecond,
          units: result.units,
          durationMs: result.durationMs,
        },
        action: "Use npm run benchmark:runtime for the stable regression budget before changing interpreter internals.",
      });
    }
  }
}

function addMemoryRecommendations(
  out: PerfRecommendation[],
  delta: PerfMemoryDelta | undefined,
  thresholds: Required<PerfRecommendationThresholds>,
): void {
  if (!delta) return;
  if (delta.heapUsedMb >= thresholds.criticalHeapDeltaMb) {
    out.push({
      severity: "critical",
      area: "memory",
      title: "Large retained heap in full profile",
      message: `The whole profiler run retained ${delta.heapUsedMb}MB of heap.`,
      evidence: delta,
      action: "Re-run with node --expose-gc and isolate runtime-only vs HTTP-only profiles.",
    });
  } else if (delta.heapUsedMb >= thresholds.maxHeapDeltaMb) {
    out.push({
      severity: "warn",
      area: "memory",
      title: "Retained heap deserves a focused run",
      message: `The whole profiler run retained ${delta.heapUsedMb}MB of heap.`,
      evidence: delta,
      action: "Compare forceGc=false and forceGc=true to separate allocator churn from retained references.",
    });
  }
}

function memoryRecommendation(severity: PerfRecommendationSeverity, result: HttpLayerProfileResult): PerfRecommendation {
  return {
    severity,
    area: "memory",
    title: `HTTP heap retention in ${result.variant}`,
    message: `${result.variant} retained ${result.memory.delta.heapUsedMb}MB of heap during the sampled run.`,
    evidence: {
      variant: result.variant,
      heapDeltaMb: result.memory.delta.heapUsedMb,
      rssDeltaMb: result.memory.delta.rssMb,
      gcAvailable: result.gcAvailable,
    },
    action: "Run with node --expose-gc, increase calls, and compare with/without observability.",
  };
}

function findResult(report: HttpLayerProfileReport, variant: HttpLayerProfileResult["variant"]): HttpLayerProfileResult | undefined {
  return report.results.find((result) => result.variant === variant);
}

function ratioOf(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
  return numerator / denominator;
}
