import { captureMemorySnapshot, diffMemorySnapshots, type PerfMemoryDelta } from "./memory";
import { diagnoseRuntimeProfile, type RuntimeDiagnosticsReport } from "./runtimeDiagnostics";
import {
  profileRuntimePrimitives,
  type RuntimePrimitiveProfileOptions,
  type RuntimePrimitiveProfileReport,
  type RuntimeProfileVariant,
} from "./runtimeProfiler";

export type RuntimeAbThresholds = {
  readonly maxRegressionPercent?: number;
  readonly minSignificantDeltaPercent?: number;
};

export type RuntimeAbOptions = {
  readonly baseline?: RuntimeProfileVariant;
  readonly candidate?: RuntimeProfileVariant;
  readonly runtime?: RuntimePrimitiveProfileOptions;
  readonly thresholds?: RuntimeAbThresholds;
  readonly forceGc?: boolean;
};

export type RuntimeAbVerdict = "improved" | "regressed" | "same";

export type RuntimeAbComparison = {
  readonly primitive: string;
  readonly baselineOpsPerSecond: number;
  readonly candidateOpsPerSecond: number;
  readonly deltaPercent: number;
  readonly baselineNsPerOperation: number;
  readonly candidateNsPerOperation: number;
  readonly fibersStartedDelta: number;
  readonly verdict: RuntimeAbVerdict;
};

export type RuntimeAbReport = {
  readonly baselineVariant: RuntimeProfileVariant;
  readonly candidateVariant: RuntimeProfileVariant;
  readonly baseline: RuntimePrimitiveProfileReport;
  readonly candidate: RuntimePrimitiveProfileReport;
  readonly comparisons: readonly RuntimeAbComparison[];
  readonly diagnostics: {
    readonly baseline: RuntimeDiagnosticsReport;
    readonly candidate: RuntimeDiagnosticsReport;
  };
  readonly memory: {
    readonly delta: PerfMemoryDelta;
  };
  readonly passedBudget: boolean;
  readonly budgetViolations: readonly string[];
};

export async function profileRuntimeAb(options: RuntimeAbOptions = {}): Promise<RuntimeAbReport> {
  const baselineVariant = options.baseline ?? "fiber-only";
  const candidateVariant = options.candidate ?? "default";
  const thresholds = normalizeThresholds(options.thresholds);
  const before = captureMemorySnapshot({ forceGc: options.forceGc });
  const baseline = await profileRuntimePrimitives({
    ...(options.runtime ?? {}),
    variant: baselineVariant,
  });
  const candidate = await profileRuntimePrimitives({
    ...(options.runtime ?? {}),
    variant: candidateVariant,
  });
  const after = captureMemorySnapshot({ forceGc: options.forceGc });
  const comparisons = compareRuntimeProfiles(baseline, candidate, thresholds);
  const budgetViolations = comparisons
    .filter((comparison) => comparison.deltaPercent < -thresholds.maxRegressionPercent)
    .map((comparison) => `${comparison.primitive} regressed ${Math.abs(comparison.deltaPercent).toFixed(1)}%`);

  return Object.freeze({
    baselineVariant,
    candidateVariant,
    baseline,
    candidate,
    comparisons,
    diagnostics: Object.freeze({
      baseline: diagnoseRuntimeProfile(baseline),
      candidate: diagnoseRuntimeProfile(candidate),
    }),
    memory: Object.freeze({
      delta: diffMemorySnapshots(before, after),
    }),
    passedBudget: budgetViolations.length === 0,
    budgetViolations: Object.freeze(budgetViolations),
  });
}

export function compareRuntimeProfiles(
  baseline: RuntimePrimitiveProfileReport,
  candidate: RuntimePrimitiveProfileReport,
  thresholds: Required<RuntimeAbThresholds> = normalizeThresholds(),
): readonly RuntimeAbComparison[] {
  const candidateByName = new Map(candidate.results.map((result) => [result.name, result]));
  return Object.freeze(baseline.results
    .flatMap((base) => {
      const next = candidateByName.get(base.name);
      if (!next) return [];
      const deltaPercent = percentDelta(next.operationsPerSecond, base.operationsPerSecond);
      const verdict: RuntimeAbVerdict = deltaPercent >= thresholds.minSignificantDeltaPercent
        ? "improved"
        : deltaPercent <= -thresholds.minSignificantDeltaPercent
          ? "regressed"
          : "same";
      return [Object.freeze({
        primitive: base.name,
        baselineOpsPerSecond: base.operationsPerSecond,
        candidateOpsPerSecond: next.operationsPerSecond,
        deltaPercent: round(deltaPercent),
        baselineNsPerOperation: base.nsPerOperation,
        candidateNsPerOperation: next.nsPerOperation,
        fibersStartedDelta: next.fibersStarted - base.fibersStarted,
        verdict,
      })];
    }));
}

export function formatRuntimeAbReport(report: RuntimeAbReport): string {
  const lines: string[] = [];
  lines.push("Brass Runtime A/B Performance Lab");
  lines.push(`baseline=${report.baselineVariant} candidate=${report.candidateVariant} budget=${report.passedBudget ? "pass" : "fail"}`);
  lines.push("");
  lines.push("Comparisons");
  for (const comparison of report.comparisons) {
    const sign = comparison.deltaPercent >= 0 ? "+" : "";
    lines.push(`- ${comparison.primitive}: ${sign}${comparison.deltaPercent}% (${formatNumber(comparison.baselineOpsPerSecond)} -> ${formatNumber(comparison.candidateOpsPerSecond)} ops/s) ${comparison.verdict}`);
  }
  lines.push("");
  lines.push(`Memory: heapDelta=${report.memory.delta.heapUsedMb}MB rssDelta=${report.memory.delta.rssMb}MB`);
  lines.push("");
  lines.push("Candidate diagnostics");
  for (const note of report.diagnostics.candidate.notes) {
    lines.push(`- ${note}`);
  }
  if (report.budgetViolations.length > 0) {
    lines.push("");
    lines.push("Budget violations");
    for (const violation of report.budgetViolations) lines.push(`- ${violation}`);
  }
  return lines.join("\n");
}

function normalizeThresholds(thresholds: RuntimeAbThresholds = {}): Required<RuntimeAbThresholds> {
  return {
    maxRegressionPercent: positiveNumber(thresholds.maxRegressionPercent, 50),
    minSignificantDeltaPercent: positiveNumber(thresholds.minSignificantDeltaPercent, 5),
  };
}

function percentDelta(candidate: number, baseline: number): number {
  if (baseline <= 0) return 0;
  return ((candidate - baseline) / baseline) * 100;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function formatNumber(value: number): string {
  return value >= 1_000 ? value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : value.toFixed(3);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
