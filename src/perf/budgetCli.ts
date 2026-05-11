#!/usr/bin/env node
import { formatRuntimePerfBudgetReport, runRuntimePerfBudget } from "./budget";
import type { RuntimeProfileVariant } from "./runtimeProfiler";

async function main(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  const report = await runRuntimePerfBudget(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatRuntimePerfBudgetReport(report));
  if (!report.passed) process.exitCode = 1;
}

type CliBudgetOptions = {
  readonly json: boolean;
  readonly baseline?: RuntimeProfileVariant;
  readonly candidate?: RuntimeProfileVariant;
  readonly runtime?: {
    readonly iterations?: number;
    readonly chainDepth?: number;
  };
  readonly thresholds?: {
    readonly maxRegressionPercent?: number;
    readonly minSignificantDeltaPercent?: number;
  };
  readonly minOpsPerSecond?: number;
  readonly maxHeapDeltaMb?: number;
  readonly forceGc?: boolean;
};

function parseArgs(argv: readonly string[]): CliBudgetOptions {
  let json = envBool("BRASS_PERF_JSON", false);
  let baseline = envVariant("BRASS_PERF_BASELINE");
  let candidate = envVariant("BRASS_PERF_CANDIDATE");
  let iterations = envInt("BRASS_PERF_RUNTIME_ITERATIONS");
  let chainDepth = envInt("BRASS_PERF_RUNTIME_CHAIN_DEPTH");
  let maxRegressionPercent = envNumber("BRASS_PERF_MAX_REGRESSION_PERCENT");
  let minSignificantDeltaPercent = envNumber("BRASS_PERF_MIN_SIGNIFICANT_DELTA_PERCENT");
  let minOpsPerSecond = envNumber("BRASS_PERF_MIN_OPS_PER_SECOND");
  let maxHeapDeltaMb = envNumber("BRASS_PERF_MAX_HEAP_DELTA_MB");
  let forceGc = envBool("BRASS_PERF_FORCE_GC", false);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--baseline":
        baseline = parseVariant(readValue(argv, ++i, arg));
        break;
      case "--candidate":
        candidate = parseVariant(readValue(argv, ++i, arg));
        break;
      case "--runtime-iterations":
        iterations = parsePositive(readValue(argv, ++i, arg), arg);
        break;
      case "--runtime-chain-depth":
        chainDepth = parsePositive(readValue(argv, ++i, arg), arg);
        break;
      case "--max-regression-percent":
        maxRegressionPercent = parseNonNegative(readValue(argv, ++i, arg), arg);
        break;
      case "--min-significant-delta-percent":
        minSignificantDeltaPercent = parseNonNegative(readValue(argv, ++i, arg), arg);
        break;
      case "--min-ops-per-second":
        minOpsPerSecond = parseNonNegative(readValue(argv, ++i, arg), arg);
        break;
      case "--max-heap-delta-mb":
        maxHeapDeltaMb = parseNonNegative(readValue(argv, ++i, arg), arg);
        break;
      case "--force-gc":
        forceGc = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    json,
    baseline,
    candidate,
    runtime: {
      ...(iterations !== undefined ? { iterations } : {}),
      ...(chainDepth !== undefined ? { chainDepth } : {}),
    },
    thresholds: {
      ...(maxRegressionPercent !== undefined ? { maxRegressionPercent } : {}),
      ...(minSignificantDeltaPercent !== undefined ? { minSignificantDeltaPercent } : {}),
    },
    minOpsPerSecond,
    maxHeapDeltaMb,
    forceGc,
  };
}

function printHelp(): void {
  console.log([
    "Usage: npm run perf:runtime:budget -- [options]",
    "",
    "Options:",
    "  --json",
    "  --baseline default|fiber-only|active-hooks|recorder|wide-scheduler",
    "  --candidate default|fiber-only|active-hooks|recorder|wide-scheduler",
    "  --runtime-iterations N",
    "  --runtime-chain-depth N",
    "  --max-regression-percent N",
    "  --min-ops-per-second N",
    "  --max-heap-delta-mb N",
    "  --force-gc",
  ].join("\n"));
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parseVariant(value: string): RuntimeProfileVariant {
  if (value === "default" || value === "fiber-only" || value === "active-hooks" || value === "recorder" || value === "wide-scheduler") {
    return value;
  }
  throw new Error(`Invalid runtime variant: ${value}`);
}

function parsePositive(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`);
  return Math.floor(parsed);
}

function parseNonNegative(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}

function envVariant(name: string): RuntimeProfileVariant | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return undefined;
  return parseVariant(raw.trim());
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
