import { captureMemorySnapshot, diffMemorySnapshots, type PerfMemoryDelta } from "./memory";
import { diagnoseRuntimeProfile, type RuntimeDiagnosticsReport } from "./runtimeDiagnostics";
import {
  profileRuntimePrimitives,
  type RuntimePrimitiveProfileOptions,
  type RuntimePrimitiveProfileReport,
  type RuntimeProfileVariant,
} from "./runtimeProfiler";

export type RuntimeSoakOptions = {
  readonly rounds?: number;
  readonly runtime?: RuntimePrimitiveProfileOptions;
  readonly variant?: RuntimeProfileVariant;
  readonly forceGc?: boolean;
};

export type RuntimeSoakRound = {
  readonly round: number;
  readonly report: RuntimePrimitiveProfileReport;
  readonly diagnostics: RuntimeDiagnosticsReport;
  readonly heapDeltaMb: number;
  readonly rssDeltaMb: number;
};

export type RuntimeSoakReport = {
  readonly variant: RuntimeProfileVariant;
  readonly rounds: readonly RuntimeSoakRound[];
  readonly memory: {
    readonly delta: PerfMemoryDelta;
  };
  readonly throughputTrendPercent: number;
  readonly heapTrendMb: number;
};

export async function profileRuntimeSoak(options: RuntimeSoakOptions = {}): Promise<RuntimeSoakReport> {
  const rounds = positiveInt(options.rounds, 5);
  const variant = options.variant ?? options.runtime?.variant ?? "default";
  const before = captureMemorySnapshot({ forceGc: options.forceGc });
  const results: RuntimeSoakRound[] = [];

  for (let i = 0; i < rounds; i++) {
    const roundBefore = captureMemorySnapshot({ forceGc: options.forceGc });
    const report = await profileRuntimePrimitives({
      ...(options.runtime ?? {}),
      variant,
    });
    const roundAfter = captureMemorySnapshot({ forceGc: options.forceGc });
    const delta = diffMemorySnapshots(roundBefore, roundAfter);
    results.push(Object.freeze({
      round: i + 1,
      report,
      diagnostics: diagnoseRuntimeProfile(report),
      heapDeltaMb: delta.heapUsedMb,
      rssDeltaMb: delta.rssMb,
    }));
  }

  const after = captureMemorySnapshot({ forceGc: options.forceGc });
  return Object.freeze({
    variant,
    rounds: Object.freeze(results),
    memory: Object.freeze({
      delta: diffMemorySnapshots(before, after),
    }),
    throughputTrendPercent: round(throughputTrend(results)),
    heapTrendMb: round(results.reduce((sum, item) => sum + item.heapDeltaMb, 0)),
  });
}

export function formatRuntimeSoakReport(report: RuntimeSoakReport): string {
  const lines: string[] = [];
  lines.push("Brass Runtime Soak Profile");
  lines.push(`variant=${report.variant} rounds=${report.rounds.length} throughputTrend=${signed(report.throughputTrendPercent)}% heapTrend=${report.heapTrendMb}MB`);
  lines.push("");
  for (const round of report.rounds) {
    const aggregateOps = aggregateOpsPerSecond(round.report);
    lines.push(`- round ${round.round}: aggregate=${formatNumber(aggregateOps)} ops/s heapDelta=${round.heapDeltaMb}MB rssDelta=${round.rssDeltaMb}MB hot=${round.diagnostics.slowest.name}`);
  }
  lines.push("");
  lines.push(`Total memory: heapDelta=${report.memory.delta.heapUsedMb}MB rssDelta=${report.memory.delta.rssMb}MB`);
  return lines.join("\n");
}

function throughputTrend(rounds: readonly RuntimeSoakRound[]): number {
  if (rounds.length < 2) return 0;
  const first = aggregateOpsPerSecond(rounds[0]!.report);
  const last = aggregateOpsPerSecond(rounds[rounds.length - 1]!.report);
  if (first <= 0) return 0;
  return ((last - first) / first) * 100;
}

function aggregateOpsPerSecond(report: RuntimePrimitiveProfileReport): number {
  const totalUnits = report.results.reduce((sum, item) => sum + item.units, 0);
  const totalDurationMs = report.results.reduce((sum, item) => sum + item.durationMs, 0);
  return totalUnits / Math.max(totalDurationMs / 1000, 0.001);
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function formatNumber(value: number): string {
  return value >= 1_000 ? value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : value.toFixed(3);
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
