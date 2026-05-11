import { captureMemorySnapshot, diffMemorySnapshots, type PerfMemoryDelta, type PerfMemorySnapshot } from "./memory";
import { makePerfRecorder, type PerfRecorder, type PerfRecorderOptions, type PerfRecorderStats, type PerfEventSummary } from "./recorder";
import { profileHttpLayers, type HttpLayerProfileOptions, type HttpLayerProfileReport } from "./httpProfiler";
import { profileRuntimePrimitives, type RuntimePrimitiveProfileOptions, type RuntimePrimitiveProfileReport } from "./runtimeProfiler";
import { diagnoseRuntimeProfile, type RuntimeDiagnosticsReport } from "./runtimeDiagnostics";
import { recommendPerformance, type PerfRecommendation, type PerfRecommendationThresholds } from "./recommendations";

export type BrassPerformanceProfileOptions = {
  readonly runtime?: false | RuntimePrimitiveProfileOptions;
  readonly http?: false | HttpLayerProfileOptions;
  readonly memory?: false | {
    readonly forceGc?: boolean;
    readonly gcPasses?: number;
  };
  readonly recorder?: PerfRecorder | PerfRecorderOptions;
  readonly thresholds?: PerfRecommendationThresholds;
};

export type BrassPerformanceReport = {
  readonly timestamp: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly runtime?: RuntimePrimitiveProfileReport;
  readonly runtimeDiagnostics?: RuntimeDiagnosticsReport;
  readonly http?: HttpLayerProfileReport;
  readonly memory?: {
    readonly before: PerfMemorySnapshot;
    readonly after: PerfMemorySnapshot;
    readonly delta: PerfMemoryDelta;
  };
  readonly recorder: {
    readonly stats: PerfRecorderStats;
    readonly summary: readonly PerfEventSummary[];
  };
  readonly recommendations: readonly PerfRecommendation[];
};

export async function runBrassPerformanceProfile(
  options: BrassPerformanceProfileOptions = {},
): Promise<BrassPerformanceReport> {
  const recorder = resolveRecorder(options.recorder);
  const memoryOptions = options.memory === false ? undefined : options.memory ?? {};
  const before = memoryOptions ? captureMemorySnapshot(memoryOptions) : undefined;

  const runtime = options.runtime === false
    ? undefined
    : await recorder.measureAsync(
        "perf.runtime",
        () => profileRuntimePrimitives({ ...(options.runtime ?? {}), recorder }),
      );

  const http = options.http === false
    ? undefined
    : await recorder.measureAsync(
        "perf.http",
        () => profileHttpLayers({ ...(options.http ?? {}), recorder }),
      );

  const after = memoryOptions ? captureMemorySnapshot(memoryOptions) : undefined;
  const memory = before && after
    ? Object.freeze({
        before,
        after,
        delta: diffMemorySnapshots(before, after),
      })
    : undefined;

  const runtimeDiagnostics = runtime ? diagnoseRuntimeProfile(runtime) : undefined;
  const recommendations = recommendPerformance({
    runtime,
    http,
    memoryDelta: memory?.delta,
    thresholds: options.thresholds,
  });

  return Object.freeze({
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    runtime,
    runtimeDiagnostics,
    http,
    memory,
    recorder: Object.freeze({
      stats: recorder.stats(),
      summary: recorder.explain(),
    }),
    recommendations,
  });
}

export function formatPerformanceReport(report: BrassPerformanceReport): string {
  const lines: string[] = [];
  lines.push("Brass Performance Profile");
  lines.push(`timestamp=${report.timestamp} node=${report.nodeVersion} platform=${report.platform}/${report.arch}`);

  if (report.runtime) {
    lines.push("");
    lines.push(`Runtime primitives (${report.runtime.variant})`);
    for (const result of report.runtime.results) {
      lines.push(`- ${result.name}: ${formatNumber(result.operationsPerSecond)} ${result.unit}/s, ns/op=${result.nsPerOperation}, fibers=${result.fibersStarted}`);
    }
  }

  if (report.runtimeDiagnostics) {
    lines.push("");
    lines.push("Runtime diagnostics");
    lines.push(`- hottest: ${report.runtimeDiagnostics.slowest.name} (${report.runtimeDiagnostics.slowest.nsPerOperation} ns/op)`);
    lines.push(`- fibers: ${report.runtimeDiagnostics.totalFibersStarted} total, ${report.runtimeDiagnostics.averageFibersPerThousandOps}/1k ops`);
    for (const note of report.runtimeDiagnostics.notes) lines.push(`- ${note}`);
  }

  if (report.http) {
    lines.push("");
    lines.push(`HTTP layers (${report.http.calls} calls, concurrency=${report.http.concurrency}, delay=${report.http.delayMs}ms)`);
    for (const result of report.http.results) {
      const heap = result.memory.delta.heapUsedMb;
      const p99 = result.requestP99Ms;
      lines.push(`- ${result.variant}: ${formatNumber(result.httpPerSec)} http/s, p99=${p99}ms, heapDelta=${heap}MB, errors=${result.errorCount}`);
    }
  }

  if (report.memory) {
    lines.push("");
    lines.push(`Memory: heapDelta=${report.memory.delta.heapUsedMb}MB rssDelta=${report.memory.delta.rssMb}MB gc=${report.memory.after.gcAvailable ? "available" : "unavailable"}`);
  }

  lines.push("");
  lines.push("Recommendations");
  for (const item of report.recommendations) {
    lines.push(`- [${item.severity}] ${item.area}: ${item.title}`);
    lines.push(`  ${item.message}`);
    if (item.action) lines.push(`  action: ${item.action}`);
  }

  return lines.join("\n");
}

function resolveRecorder(input: PerfRecorder | PerfRecorderOptions | undefined): PerfRecorder {
  if (isPerfRecorder(input)) return input;
  return makePerfRecorder(input);
}

function isPerfRecorder(input: PerfRecorder | PerfRecorderOptions | undefined): input is PerfRecorder {
  return Boolean(input && "record" in input && typeof (input as PerfRecorder).record === "function");
}

function formatNumber(value: number): string {
  return value >= 1_000 ? value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : value.toFixed(3);
}
