#!/usr/bin/env node
import { formatPerformanceReport, runBrassPerformanceProfile, type BrassPerformanceProfileOptions } from "./report";
import { HTTP_PROFILE_VARIANTS, type HttpProfileVariant } from "./httpProfiler";
import { formatRuntimeAbReport, profileRuntimeAb, type RuntimeAbOptions } from "./runtimeAb";
import { formatRuntimeSoakReport, profileRuntimeSoak, type RuntimeSoakOptions } from "./runtimeSoak";
import { formatHttpMemoryLabReport, profileHttpMemoryLab, type HttpMemoryLabOptions } from "./httpMemoryLab";
import {
  comparePerfToBaseline,
  createPerfHistoryEntry,
  formatPerfBaselineComparison,
  loadPerfBaseline,
  savePerfBaseline,
  writePerfHistoryEntry,
  type PerfBaselineComparison,
  type PerfBaselineThresholds,
  type PerfHistoryEntry,
} from "./history";
import type { RuntimeProfileVariant } from "./runtimeProfiler";

type CliOptions = {
  readonly json: boolean;
  readonly profile: PerfProfile;
  readonly options: BrassPerformanceProfileOptions;
  readonly runtimeAb: RuntimeAbOptions;
  readonly runtimeSoak: RuntimeSoakOptions;
  readonly httpMemory: HttpMemoryLabOptions;
  readonly history: CliHistoryOptions;
};

type PerfProfile = "all" | "runtime" | "http" | "runtime-ab" | "runtime-soak" | "http-memory";

type CliHistoryOptions = {
  readonly recordHistory: boolean;
  readonly historyDir?: string;
  readonly maxEntries?: number;
  readonly saveBaseline?: string;
  readonly compareBaseline?: string;
  readonly failOnBaselineRegression: boolean;
  readonly thresholds: PerfBaselineThresholds;
};

type CliHistoryResult = {
  readonly entry: PerfHistoryEntry;
  readonly historyPath?: string;
  readonly savedBaselinePath?: string;
  readonly comparison?: PerfBaselineComparison;
};

async function main(argv: readonly string[]): Promise<void> {
  const cli = parseArgs(argv);
  if (cli.profile === "runtime-ab") {
    const report = await profileRuntimeAb(cli.runtimeAb);
    await printReport(cli, report, formatRuntimeAbReport(report));
    return;
  }
  if (cli.profile === "runtime-soak") {
    const report = await profileRuntimeSoak(cli.runtimeSoak);
    await printReport(cli, report, formatRuntimeSoakReport(report));
    return;
  }
  if (cli.profile === "http-memory") {
    const report = await profileHttpMemoryLab(cli.httpMemory);
    await printReport(cli, report, formatHttpMemoryLabReport(report));
    return;
  }

  const report = await runBrassPerformanceProfile(cli.options);
  await printReport(cli, report, formatPerformanceReport(report));
}

function parseArgs(argv: readonly string[]): CliOptions {
  let json = envBool("BRASS_PERF_JSON", false);
  let profile = envProfile("BRASS_PERF_PROFILE", "all");
  let calls = envInt("BRASS_PERF_CALLS", undefined);
  let concurrency = envInt("BRASS_PERF_CONCURRENCY", undefined);
  let delayMs = envInt("BRASS_PERF_DELAY_MS", undefined);
  let warmupCalls = envInt("BRASS_PERF_WARMUP_CALLS", undefined);
  let timeoutMs = envInt("BRASS_PERF_TIMEOUT_MS", undefined);
  let statsSampleMs = envInt("BRASS_PERF_STATS_SAMPLE_MS", undefined);
  let runtimeIterations = envInt("BRASS_PERF_RUNTIME_ITERATIONS", undefined);
  let runtimeChainDepth = envInt("BRASS_PERF_RUNTIME_CHAIN_DEPTH", undefined);
  let runtimeVariant = envRuntimeVariant("BRASS_PERF_RUNTIME_VARIANT");
  let baseline = envRuntimeVariant("BRASS_PERF_BASELINE");
  let candidate = envRuntimeVariant("BRASS_PERF_CANDIDATE");
  let rounds = envInt("BRASS_PERF_ROUNDS", undefined);
  let forceGc = envBool("BRASS_PERF_FORCE_GC", false);
  let variants = envVariants("BRASS_PERF_VARIANTS");
  let recordHistory = envBool("BRASS_PERF_RECORD_HISTORY", false);
  let historyDir = envString("BRASS_PERF_HISTORY_DIR");
  let historyMaxEntries = envInt("BRASS_PERF_HISTORY_MAX_ENTRIES", undefined);
  let saveBaseline = envString("BRASS_PERF_SAVE_BASELINE");
  let compareBaseline = envString("BRASS_PERF_COMPARE_BASELINE");
  let failOnBaselineRegression = envBool("BRASS_PERF_FAIL_ON_BASELINE_REGRESSION", false);
  let baselineMaxRegressionPercent = envNumber("BRASS_PERF_BASELINE_MAX_REGRESSION_PERCENT");
  let baselineMaxHeapRegressionPercent = envNumber("BRASS_PERF_BASELINE_MAX_HEAP_REGRESSION_PERCENT");
  let baselineWarnAtRatio = envNumber("BRASS_PERF_BASELINE_WARN_AT_RATIO");

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--profile":
        profile = parseProfile(readValue(argv, ++i, arg));
        break;
      case "--calls":
        calls = parsePositive(readValue(argv, ++i, arg), arg);
        break;
      case "--concurrency":
        concurrency = parsePositive(readValue(argv, ++i, arg), arg);
        break;
      case "--delay-ms":
        delayMs = parseNonNegative(readValue(argv, ++i, arg), arg);
        break;
      case "--warmup":
      case "--warmup-calls":
        warmupCalls = parseNonNegative(readValue(argv, ++i, arg), arg);
        break;
      case "--timeout-ms":
        timeoutMs = parsePositive(readValue(argv, ++i, arg), arg);
        break;
      case "--stats-sample-ms":
        statsSampleMs = parsePositive(readValue(argv, ++i, arg), arg);
        break;
      case "--runtime-iterations":
        runtimeIterations = parsePositive(readValue(argv, ++i, arg), arg);
        break;
      case "--runtime-chain-depth":
        runtimeChainDepth = parsePositive(readValue(argv, ++i, arg), arg);
        break;
      case "--runtime-variant":
        runtimeVariant = parseRuntimeVariant(readValue(argv, ++i, arg));
        break;
      case "--baseline":
        baseline = parseRuntimeVariant(readValue(argv, ++i, arg));
        break;
      case "--candidate":
        candidate = parseRuntimeVariant(readValue(argv, ++i, arg));
        break;
      case "--rounds":
        rounds = parsePositive(readValue(argv, ++i, arg), arg);
        break;
      case "--variants":
        variants = parseVariants(readValue(argv, ++i, arg));
        break;
      case "--force-gc":
        forceGc = true;
        break;
      case "--no-gc":
        forceGc = false;
        break;
      case "--no-http":
        profile = "runtime";
        break;
      case "--no-runtime":
        profile = "http";
        break;
      case "--record-history":
        recordHistory = true;
        break;
      case "--history-dir":
        historyDir = readValue(argv, ++i, arg);
        break;
      case "--history-max-entries":
        historyMaxEntries = parsePositive(readValue(argv, ++i, arg), arg);
        break;
      case "--save-baseline":
        saveBaseline = readValue(argv, ++i, arg);
        break;
      case "--compare-baseline":
        compareBaseline = readValue(argv, ++i, arg);
        break;
      case "--fail-on-baseline-regression":
        failOnBaselineRegression = true;
        break;
      case "--baseline-max-regression-percent":
        baselineMaxRegressionPercent = parseNonNegativeNumber(readValue(argv, ++i, arg), arg);
        break;
      case "--baseline-max-heap-regression-percent":
        baselineMaxHeapRegressionPercent = parseNonNegativeNumber(readValue(argv, ++i, arg), arg);
        break;
      case "--baseline-warn-at-ratio":
        baselineWarnAtRatio = parseNonNegativeNumber(readValue(argv, ++i, arg), arg);
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
    profile,
    options: {
      runtime: profile === "http"
          ? false
          : {
            ...(runtimeIterations !== undefined ? { iterations: runtimeIterations } : {}),
            ...(runtimeChainDepth !== undefined ? { chainDepth: runtimeChainDepth } : {}),
            ...(runtimeVariant !== undefined ? { variant: runtimeVariant } : {}),
          },
      http: profile === "runtime"
        ? false
        : {
            ...(calls !== undefined ? { calls } : {}),
            ...(concurrency !== undefined ? { concurrency } : {}),
            ...(delayMs !== undefined ? { delayMs } : {}),
            ...(warmupCalls !== undefined ? { warmupCalls } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(statsSampleMs !== undefined ? { statsSampleMs } : {}),
            ...(variants !== undefined ? { variants } : {}),
            forceGc,
          },
      memory: { forceGc },
    },
    runtimeAb: {
      baseline,
      candidate,
      runtime: {
        ...(runtimeIterations !== undefined ? { iterations: runtimeIterations } : {}),
        ...(runtimeChainDepth !== undefined ? { chainDepth: runtimeChainDepth } : {}),
      },
      forceGc,
    },
    runtimeSoak: {
      rounds,
      variant: runtimeVariant,
      runtime: {
        ...(runtimeIterations !== undefined ? { iterations: runtimeIterations } : {}),
        ...(runtimeChainDepth !== undefined ? { chainDepth: runtimeChainDepth } : {}),
      },
      forceGc,
    },
    httpMemory: {
      ...(calls !== undefined ? { calls } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(delayMs !== undefined ? { delayMs } : {}),
      ...(warmupCalls !== undefined ? { warmupCalls } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(statsSampleMs !== undefined ? { statsSampleMs } : {}),
      ...(variants !== undefined ? { variants } : {}),
      rounds,
      forceGc,
    },
    history: {
      recordHistory,
      ...(historyDir !== undefined ? { historyDir } : {}),
      ...(historyMaxEntries !== undefined ? { maxEntries: historyMaxEntries } : {}),
      ...(saveBaseline !== undefined ? { saveBaseline } : {}),
      ...(compareBaseline !== undefined ? { compareBaseline } : {}),
      failOnBaselineRegression,
      thresholds: {
        ...(baselineMaxRegressionPercent !== undefined ? { maxRegressionPercent: baselineMaxRegressionPercent } : {}),
        ...(baselineMaxHeapRegressionPercent !== undefined ? { maxHeapRegressionPercent: baselineMaxHeapRegressionPercent } : {}),
        ...(baselineWarnAtRatio !== undefined ? { warnAtRatio: baselineWarnAtRatio } : {}),
      },
    },
  };
}

function printHelp(): void {
  console.log([
    "Usage: npm run perf -- [options]",
    "",
    "Options:",
    "  --profile all|runtime|http|runtime-ab|runtime-soak|http-memory",
    "  --json",
    "  --calls N",
    "  --concurrency N",
    "  --delay-ms N",
    "  --warmup N",
    "  --variants node-http-text,default-json,default-json-observed",
    "  --runtime-iterations N",
    "  --runtime-chain-depth N",
    "  --runtime-variant default|fiber-only|active-hooks|recorder|wide-scheduler",
    "  --baseline default|fiber-only|active-hooks|recorder|wide-scheduler",
    "  --candidate default|fiber-only|active-hooks|recorder|wide-scheduler",
    "  --rounds N",
    "  --force-gc",
    "  --no-gc",
    "  --record-history",
    "  --history-dir PATH",
    "  --history-max-entries N",
    "  --save-baseline NAME",
    "  --compare-baseline NAME",
    "  --baseline-max-regression-percent N",
    "  --baseline-max-heap-regression-percent N",
    "  --baseline-warn-at-ratio N",
    "  --fail-on-baseline-regression",
  ].join("\n"));
}

async function printReport(cli: CliOptions, report: unknown, textReport: string): Promise<void> {
  const history = await maybeHandleHistory(cli, report);
  if (cli.json) {
    console.log(JSON.stringify(history ? { report, history } : report, null, 2));
  } else {
    console.log(history ? `${textReport}\n\n${formatCliHistory(history)}` : textReport);
  }
  if (history?.comparison && !history.comparison.passed && cli.history.failOnBaselineRegression) {
    process.exitCode = 1;
  }
}

async function maybeHandleHistory(cli: CliOptions, report: unknown): Promise<CliHistoryResult | undefined> {
  const config = cli.history;
  if (!config.recordHistory && !config.saveBaseline && !config.compareBaseline) return undefined;

  const storeOptions = {
    ...(config.historyDir !== undefined ? { directory: config.historyDir } : {}),
    ...(config.maxEntries !== undefined ? { maxEntries: config.maxEntries } : {}),
    metadata: {
      cliProfile: cli.profile,
    },
  };
  const entry = createPerfHistoryEntry(cli.profile, report, storeOptions);
  const historyPath = config.recordHistory ? await writePerfHistoryEntry(entry, storeOptions) : undefined;
  const savedBaseline = config.saveBaseline
    ? await savePerfBaseline(config.saveBaseline, entry, storeOptions)
    : undefined;
  const loadedBaseline = config.compareBaseline
    ? await loadPerfBaseline(config.compareBaseline, storeOptions)
    : undefined;
  if (config.compareBaseline && !loadedBaseline) {
    throw new Error(`Perf baseline '${config.compareBaseline}' was not found`);
  }
  const comparison = loadedBaseline ? comparePerfToBaseline(entry, loadedBaseline, config.thresholds) : undefined;

  return Object.freeze({
    entry,
    ...(historyPath !== undefined ? { historyPath } : {}),
    ...(savedBaseline !== undefined ? { savedBaselinePath: savedBaseline.path } : {}),
    ...(comparison !== undefined ? { comparison } : {}),
  });
}

function formatCliHistory(history: CliHistoryResult): string {
  const lines: string[] = [];
  lines.push("Performance history");
  if (history.historyPath) lines.push(`- recorded: ${history.historyPath}`);
  if (history.savedBaselinePath) lines.push(`- baseline saved: ${history.savedBaselinePath}`);
  if (history.comparison) {
    lines.push("");
    lines.push(formatPerfBaselineComparison(history.comparison));
  }
  return lines.join("\n");
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parseProfile(value: string): PerfProfile {
  if (value === "all" || value === "runtime" || value === "http" || value === "runtime-ab" || value === "runtime-soak" || value === "http-memory") return value;
  throw new Error(`Invalid --profile value: ${value}`);
}

function parseRuntimeVariant(value: string): RuntimeProfileVariant {
  if (value === "default" || value === "fiber-only" || value === "active-hooks" || value === "recorder" || value === "wide-scheduler") return value;
  throw new Error(`Invalid runtime variant: ${value}`);
}

function parseVariants(value: string): readonly HttpProfileVariant[] {
  const allowed = new Set<string>(HTTP_PROFILE_VARIANTS);
  return Object.freeze(value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (!allowed.has(item)) {
        throw new Error(`Invalid HTTP profile variant: ${item}`);
      }
      return item as HttpProfileVariant;
    }));
}

function parsePositive(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number`);
  return Math.floor(parsed);
}

function parseNonNegative(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number`);
  return Math.floor(parsed);
}

function parseNonNegativeNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}

function envInt(name: string, fallback: number | undefined): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function envString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim();
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

function envProfile(name: string, fallback: PerfProfile): PerfProfile {
  const raw = process.env[name];
  if (!raw) return fallback;
  return parseProfile(raw.trim());
}

function envRuntimeVariant(name: string): RuntimeProfileVariant | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return undefined;
  return parseRuntimeVariant(raw.trim());
}

function envVariants(name: string): readonly HttpProfileVariant[] | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return undefined;
  return parseVariants(raw);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
