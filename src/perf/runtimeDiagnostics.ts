import type { RuntimePrimitiveProfile, RuntimePrimitiveProfileReport } from "./runtimeProfiler";

export type RuntimePrimitiveDiagnostic = {
  readonly name: string;
  readonly operationsPerSecond: number;
  readonly nsPerOperation: number;
  readonly fibersStarted: number;
  readonly fibersPerThousandOps: number;
};

export type RuntimeDiagnosticsReport = {
  readonly variant: string;
  readonly slowest: RuntimePrimitiveDiagnostic;
  readonly fastest: RuntimePrimitiveDiagnostic;
  readonly hotPrimitives: readonly RuntimePrimitiveDiagnostic[];
  readonly totalFibersStarted: number;
  readonly totalMeasuredUnits: number;
  readonly averageFibersPerThousandOps: number;
  readonly hooksActive: boolean;
  readonly recorderEvents?: number;
  readonly notes: readonly string[];
};

export function diagnoseRuntimeProfile(report: RuntimePrimitiveProfileReport): RuntimeDiagnosticsReport {
  const diagnostics = report.results.map(toDiagnostic);
  const sortedByNs = [...diagnostics].sort((a, b) => b.nsPerOperation - a.nsPerOperation);
  const totalFibersStarted = diagnostics.reduce((sum, item) => sum + item.fibersStarted, 0);
  const totalMeasuredUnits = report.results.reduce((sum, item) => sum + item.units, 0);
  const notes = makeNotes(report, sortedByNs, totalFibersStarted, totalMeasuredUnits);

  return Object.freeze({
    variant: report.variant,
    slowest: sortedByNs[0]!,
    fastest: sortedByNs[sortedByNs.length - 1]!,
    hotPrimitives: Object.freeze(sortedByNs.slice(0, 3)),
    totalFibersStarted,
    totalMeasuredUnits,
    averageFibersPerThousandOps: round((totalFibersStarted / Math.max(totalMeasuredUnits, 1)) * 1_000),
    hooksActive: report.hooksActive,
    recorderEvents: report.recorderEvents,
    notes: Object.freeze(notes),
  });
}

function toDiagnostic(result: RuntimePrimitiveProfile): RuntimePrimitiveDiagnostic {
  return Object.freeze({
    name: result.name,
    operationsPerSecond: result.operationsPerSecond,
    nsPerOperation: result.nsPerOperation,
    fibersStarted: result.fibersStarted,
    fibersPerThousandOps: result.fibersPerThousandOps,
  });
}

function makeNotes(
  report: RuntimePrimitiveProfileReport,
  sortedByNs: readonly RuntimePrimitiveDiagnostic[],
  totalFibersStarted: number,
  totalMeasuredUnits: number,
): string[] {
  const notes: string[] = [];
  const topLevelPure = report.results.filter((item) =>
    item.name === "async-succeed/top-level"
    || item.name === "async-fail/top-level"
    || item.name === "async-sync/top-level"
    || item.name === "flatMap-chain"
  );
  const pureStartedFibers = topLevelPure.reduce((sum, item) => sum + item.fibersStarted, 0);

  if (pureStartedFibers === 0 && report.variant === "default") {
    notes.push("Native top-level fast path avoided root fibers for pure/sync runtime primitives.");
  }
  if (report.hooksActive) {
    notes.push("Hooks are active, so top-level pure effects keep normal fiber/event semantics.");
  }
  if (report.recorderEvents && report.recorderEvents > 0) {
    notes.push(`Runtime recorder retained ${report.recorderEvents} events during the profile.`);
  }
  if (totalFibersStarted > totalMeasuredUnits * 0.25) {
    notes.push("Fiber allocation pressure is visible; compare with the fiber-only baseline to isolate scheduling overhead.");
  }
  if (sortedByNs[0]) {
    notes.push(`${sortedByNs[0].name} is the hottest sampled primitive by ns/op.`);
  }

  return notes;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
