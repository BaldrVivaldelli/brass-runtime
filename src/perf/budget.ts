import { profileRuntimeAb, type RuntimeAbOptions, type RuntimeAbReport } from "./runtimeAb";

export type RuntimePerfBudgetOptions = RuntimeAbOptions & {
  readonly minOpsPerSecond?: number;
  readonly maxHeapDeltaMb?: number;
};

export type RuntimePerfBudgetViolation = {
  readonly area: "regression" | "throughput" | "memory";
  readonly message: string;
};

export type RuntimePerfBudgetReport = {
  readonly ab: RuntimeAbReport;
  readonly passed: boolean;
  readonly violations: readonly RuntimePerfBudgetViolation[];
};

export async function runRuntimePerfBudget(
  options: RuntimePerfBudgetOptions = {},
): Promise<RuntimePerfBudgetReport> {
  const ab = await profileRuntimeAb({
    ...options,
    thresholds: {
      maxRegressionPercent: options.thresholds?.maxRegressionPercent ?? 50,
      minSignificantDeltaPercent: options.thresholds?.minSignificantDeltaPercent ?? 5,
    },
  });
  const minOpsPerSecond = positiveNumber(options.minOpsPerSecond, 10_000);
  const maxHeapDeltaMb = positiveNumber(options.maxHeapDeltaMb, 32);
  const violations: RuntimePerfBudgetViolation[] = [];

  for (const violation of ab.budgetViolations) {
    violations.push({ area: "regression", message: violation });
  }

  for (const result of ab.candidate.results) {
    if (result.units >= 1_000 && result.operationsPerSecond < minOpsPerSecond) {
      violations.push({
        area: "throughput",
        message: `${result.name} throughput ${result.operationsPerSecond} ops/s is below ${minOpsPerSecond} ops/s`,
      });
    }
  }

  if (ab.memory.delta.heapUsedMb > maxHeapDeltaMb) {
    violations.push({
      area: "memory",
      message: `runtime A/B heap delta ${ab.memory.delta.heapUsedMb}MB exceeds ${maxHeapDeltaMb}MB`,
    });
  }

  return Object.freeze({
    ab,
    passed: violations.length === 0,
    violations: Object.freeze(violations.map((item) => Object.freeze(item))),
  });
}

export function formatRuntimePerfBudgetReport(report: RuntimePerfBudgetReport): string {
  const lines: string[] = [];
  lines.push(`Runtime performance budget: ${report.passed ? "pass" : "fail"}`);
  lines.push(`baseline=${report.ab.baselineVariant} candidate=${report.ab.candidateVariant}`);
  for (const comparison of report.ab.comparisons) {
    const sign = comparison.deltaPercent >= 0 ? "+" : "";
    lines.push(`- ${comparison.primitive}: ${sign}${comparison.deltaPercent}%`);
  }
  if (report.violations.length > 0) {
    lines.push("");
    lines.push("Violations");
    for (const violation of report.violations) {
      lines.push(`- [${violation.area}] ${violation.message}`);
    }
  }
  return lines.join("\n");
}

function positiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}
