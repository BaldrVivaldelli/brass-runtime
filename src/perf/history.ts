import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrassPerformanceReport } from "./report";
import type { HttpLayerProfileReport } from "./httpProfiler";
import type { HttpMemoryLabReport, HttpMemoryLabVariantSummary } from "./httpMemoryLab";
import type { RuntimeAbReport } from "./runtimeAb";
import type { RuntimePrimitiveProfileReport } from "./runtimeProfiler";
import type { RuntimeSoakReport } from "./runtimeSoak";

export type PerfHistoryProfile = "all" | "runtime" | "http" | "runtime-ab" | "runtime-soak" | "http-memory";

export type PerfMetricDirection = "higher-is-better" | "lower-is-better" | "neutral";

export type PerfHistoryMetric = {
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly direction: PerfMetricDirection;
  readonly tags?: Readonly<Record<string, string>>;
};

export type PerfHistoryEntry = {
  readonly id: string;
  readonly timestamp: string;
  readonly profile: PerfHistoryProfile;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly metrics: readonly PerfHistoryMetric[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly report?: unknown;
};

export type PerfBaseline = {
  readonly name: string;
  readonly savedAt: string;
  readonly entry: PerfHistoryEntry;
};

export type PerfHistoryStoreOptions = {
  readonly directory?: string;
  readonly historyFileName?: string;
  readonly baselinesDirectoryName?: string;
  readonly maxEntries?: number;
  readonly includeReport?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type PerfBaselineThresholds = {
  readonly maxRegressionPercent?: number;
  readonly maxHeapRegressionPercent?: number;
  readonly warnAtRatio?: number;
  readonly failOnMissingMetric?: boolean;
};

export type PerfBaselineComparisonStatus = "pass" | "warn" | "fail";

export type PerfBaselineComparisonItem = {
  readonly metric: PerfHistoryMetric;
  readonly baselineValue: number;
  readonly currentValue: number;
  readonly delta: number;
  readonly deltaPercent: number;
  readonly status: PerfBaselineComparisonStatus;
  readonly reason: string;
};

export type PerfBaselineComparison = {
  readonly baselineName: string;
  readonly baselineId: string;
  readonly currentId: string;
  readonly comparedMetrics: number;
  readonly missingMetrics: readonly string[];
  readonly status: PerfBaselineComparisonStatus;
  readonly passed: boolean;
  readonly items: readonly PerfBaselineComparisonItem[];
};

type StorePaths = {
  readonly directory: string;
  readonly historyFile: string;
  readonly baselinesDirectory: string;
};

const DEFAULT_HISTORY_DIR = ".brass/perf-history";
const DEFAULT_HISTORY_FILE = "runs.jsonl";
const DEFAULT_BASELINES_DIR = "baselines";

export function defaultPerfHistoryDirectory(cwd = process.cwd()): string {
  return join(cwd, DEFAULT_HISTORY_DIR);
}

export function createPerfHistoryEntry(
  profile: PerfHistoryProfile,
  report: unknown,
  options: PerfHistoryStoreOptions = {},
): PerfHistoryEntry {
  const timestamp = new Date().toISOString();
  const metrics = extractPerfMetrics(profile, report);
  return Object.freeze({
    id: makeEntryId(profile, timestamp),
    timestamp,
    profile,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    metrics,
    ...(options.metadata ? { metadata: Object.freeze({ ...options.metadata }) } : {}),
    ...(options.includeReport ? { report } : {}),
  });
}

export async function recordPerfHistoryRun(
  profile: PerfHistoryProfile,
  report: unknown,
  options: PerfHistoryStoreOptions = {},
): Promise<{ readonly entry: PerfHistoryEntry; readonly path: string }> {
  const entry = createPerfHistoryEntry(profile, report, options);
  const path = await writePerfHistoryEntry(entry, options);
  return Object.freeze({ entry, path });
}

export async function writePerfHistoryEntry(
  entry: PerfHistoryEntry,
  options: PerfHistoryStoreOptions = {},
): Promise<string> {
  const paths = resolveStorePaths(options);
  await mkdir(paths.directory, { recursive: true });
  await appendFile(paths.historyFile, `${JSON.stringify(entry)}\n`, "utf8");
  if (options.maxEntries && options.maxEntries > 0) {
    await pruneHistoryFile(paths.historyFile, Math.floor(options.maxEntries));
  }
  return paths.historyFile;
}

export async function readPerfHistory(options: PerfHistoryStoreOptions = {}): Promise<readonly PerfHistoryEntry[]> {
  const paths = resolveStorePaths(options);
  let raw = "";
  try {
    raw = await readFile(paths.historyFile, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return Object.freeze([]);
    throw error;
  }

  const entries: PerfHistoryEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as PerfHistoryEntry);
    } catch {
      // History is append-only and human-editable; ignore malformed lines.
    }
  }
  return Object.freeze(entries);
}

export async function savePerfBaseline(
  name: string,
  entry: PerfHistoryEntry,
  options: PerfHistoryStoreOptions = {},
): Promise<{ readonly baseline: PerfBaseline; readonly path: string }> {
  const paths = resolveStorePaths(options);
  await mkdir(paths.baselinesDirectory, { recursive: true });
  const baseline = Object.freeze({
    name,
    savedAt: new Date().toISOString(),
    entry,
  });
  const path = baselinePath(paths, name);
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  return Object.freeze({ baseline, path });
}

export async function loadPerfBaseline(
  name: string,
  options: PerfHistoryStoreOptions = {},
): Promise<PerfBaseline | undefined> {
  const paths = resolveStorePaths(options);
  try {
    return JSON.parse(await readFile(baselinePath(paths, name), "utf8")) as PerfBaseline;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function comparePerfToBaseline(
  current: PerfHistoryEntry,
  baseline: PerfBaseline,
  thresholds: PerfBaselineThresholds = {},
): PerfBaselineComparison {
  const normalized = normalizeThresholds(thresholds);
  const currentByKey = new Map(current.metrics.map((metric) => [metricKey(metric), metric]));
  const items: PerfBaselineComparisonItem[] = [];
  const missingMetrics: string[] = [];

  for (const baselineMetric of baseline.entry.metrics) {
    if (baselineMetric.direction === "neutral") continue;
    const currentMetric = currentByKey.get(metricKey(baselineMetric));
    if (!currentMetric) {
      missingMetrics.push(formatMetricName(baselineMetric));
      continue;
    }
    const item = compareMetric(currentMetric, baselineMetric, normalized);
    items.push(item);
  }

  const hasFailures = items.some((item) => item.status === "fail")
    || (normalized.failOnMissingMetric && missingMetrics.length > 0);
  const hasWarnings = items.some((item) => item.status === "warn")
    || (!normalized.failOnMissingMetric && missingMetrics.length > 0);
  const status: PerfBaselineComparisonStatus = hasFailures ? "fail" : hasWarnings ? "warn" : "pass";

  return Object.freeze({
    baselineName: baseline.name,
    baselineId: baseline.entry.id,
    currentId: current.id,
    comparedMetrics: items.length,
    missingMetrics: Object.freeze(missingMetrics),
    status,
    passed: status !== "fail",
    items: Object.freeze(items),
  });
}

export function formatPerfBaselineComparison(comparison: PerfBaselineComparison): string {
  const lines: string[] = [];
  lines.push(`Baseline comparison: ${comparison.baselineName} status=${comparison.status}`);
  lines.push(`compared=${comparison.comparedMetrics} missing=${comparison.missingMetrics.length}`);
  for (const item of comparison.items.filter((candidate) => candidate.status !== "pass")) {
    const sign = item.deltaPercent >= 0 ? "+" : "";
    lines.push(`- [${item.status}] ${formatMetricName(item.metric)} ${item.baselineValue} -> ${item.currentValue} (${sign}${item.deltaPercent}%)`);
    lines.push(`  ${item.reason}`);
  }
  for (const missing of comparison.missingMetrics) {
    lines.push(`- [warn] missing metric: ${missing}`);
  }
  if (comparison.items.every((item) => item.status === "pass") && comparison.missingMetrics.length === 0) {
    lines.push("- all comparable metrics stayed within baseline thresholds");
  }
  return lines.join("\n");
}

export function extractPerfMetrics(profile: PerfHistoryProfile, report: unknown): readonly PerfHistoryMetric[] {
  const metrics: PerfHistoryMetric[] = [];
  if (isBrassPerformanceReport(report)) {
    if (report.runtime) pushRuntimeMetrics(metrics, "runtime", report.runtime);
    if (report.http) pushHttpMetrics(metrics, "http", report.http);
    if (report.memory) {
      pushMetric(metrics, "profile.heap_delta_mb", report.memory.delta.heapUsedMb, "MB", "lower-is-better", { profile });
      pushMetric(metrics, "profile.rss_delta_mb", report.memory.delta.rssMb, "MB", "lower-is-better", { profile });
    }
    return Object.freeze(metrics);
  }
  if (isRuntimeAbReport(report)) {
    pushRuntimeMetrics(metrics, "runtime_ab.baseline", report.baseline);
    pushRuntimeMetrics(metrics, "runtime_ab.candidate", report.candidate);
    for (const comparison of report.comparisons) {
      pushMetric(metrics, "runtime_ab.delta_percent", comparison.deltaPercent, "%", "higher-is-better", {
        primitive: comparison.primitive,
        baseline: report.baselineVariant,
        candidate: report.candidateVariant,
      });
    }
    pushMetric(metrics, "runtime_ab.heap_delta_mb", report.memory.delta.heapUsedMb, "MB", "lower-is-better", { profile });
    pushMetric(metrics, "runtime_ab.rss_delta_mb", report.memory.delta.rssMb, "MB", "lower-is-better", { profile });
    return Object.freeze(metrics);
  }
  if (isRuntimeSoakReport(report)) {
    pushMetric(metrics, "runtime_soak.throughput_trend_percent", report.throughputTrendPercent, "%", "higher-is-better", { variant: report.variant });
    pushMetric(metrics, "runtime_soak.heap_trend_mb", report.heapTrendMb, "MB", "lower-is-better", { variant: report.variant });
    pushMetric(metrics, "runtime_soak.heap_delta_mb", report.memory.delta.heapUsedMb, "MB", "lower-is-better", { variant: report.variant });
    for (const round of report.rounds) {
      pushMetric(metrics, "runtime_soak.aggregate_ops_per_second", aggregateRuntimeOps(round.report), "ops/s", "higher-is-better", {
        variant: report.variant,
        round: String(round.round),
      });
    }
    return Object.freeze(metrics);
  }
  if (isHttpMemoryLabReport(report)) {
    for (const summary of report.summaries) pushHttpMemoryMetrics(metrics, summary);
    return Object.freeze(metrics);
  }
  if (isHttpLayerProfileReport(report)) {
    pushHttpMetrics(metrics, "http", report);
    return Object.freeze(metrics);
  }
  if (isRuntimePrimitiveProfileReport(report)) {
    pushRuntimeMetrics(metrics, "runtime", report);
  }
  return Object.freeze(metrics);
}

function pushRuntimeMetrics(
  metrics: PerfHistoryMetric[],
  prefix: string,
  report: RuntimePrimitiveProfileReport,
): void {
  for (const result of report.results) {
    const tags = { variant: report.variant, primitive: result.name };
    pushMetric(metrics, `${prefix}.ops_per_second`, result.operationsPerSecond, `${result.unit}/s`, "higher-is-better", tags);
    pushMetric(metrics, `${prefix}.ns_per_operation`, result.nsPerOperation, "ns/op", "lower-is-better", tags);
    pushMetric(metrics, `${prefix}.fibers_per_1000_ops`, result.fibersPerThousandOps, "fibers/1k", "lower-is-better", tags);
  }
}

function pushHttpMetrics(metrics: PerfHistoryMetric[], prefix: string, report: HttpLayerProfileReport): void {
  for (const result of report.results) {
    const tags = { variant: result.variant };
    pushMetric(metrics, `${prefix}.requests_per_second`, result.httpPerSec, "http/s", "higher-is-better", tags);
    pushMetric(metrics, `${prefix}.p99_ms`, result.requestP99Ms, "ms", "lower-is-better", tags);
    pushMetric(metrics, `${prefix}.heap_delta_mb`, result.memory.delta.heapUsedMb, "MB", "lower-is-better", tags);
    pushMetric(metrics, `${prefix}.rss_delta_mb`, result.memory.delta.rssMb, "MB", "lower-is-better", tags);
    pushMetric(metrics, `${prefix}.errors`, result.errorCount, "count", "lower-is-better", tags);
  }
}

function pushHttpMemoryMetrics(metrics: PerfHistoryMetric[], summary: HttpMemoryLabVariantSummary): void {
  const tags = { variant: summary.variant };
  pushMetric(metrics, "http_memory.mean_requests_per_second", summary.meanHttpPerSec, "http/s", "higher-is-better", tags);
  pushMetric(metrics, "http_memory.max_p99_ms", summary.maxP99Ms, "ms", "lower-is-better", tags);
  pushMetric(metrics, "http_memory.heap_per_10k_mb", summary.heapDeltaPer10kRequestsMb, "MB/10k", "lower-is-better", tags);
  pushMetric(metrics, "http_memory.total_heap_delta_mb", summary.totalHeapDeltaMb, "MB", "lower-is-better", tags);
  pushMetric(metrics, "http_memory.total_rss_delta_mb", summary.totalRssDeltaMb, "MB", "lower-is-better", tags);
  pushMetric(metrics, "http_memory.errors", summary.totalErrors, "count", "lower-is-better", tags);
}

function pushMetric(
  metrics: PerfHistoryMetric[],
  name: string,
  value: number,
  unit: string,
  direction: PerfMetricDirection,
  tags?: Readonly<Record<string, string>>,
): void {
  if (!Number.isFinite(value)) return;
  metrics.push(Object.freeze({
    name,
    value: round(value),
    unit,
    direction,
    ...(tags ? { tags: Object.freeze({ ...tags }) } : {}),
  }));
}

function compareMetric(
  current: PerfHistoryMetric,
  baseline: PerfHistoryMetric,
  thresholds: Required<PerfBaselineThresholds>,
): PerfBaselineComparisonItem {
  const delta = round(current.value - baseline.value);
  const deltaPercent = round(percentDelta(current.value, baseline.value));
  const regressionPercent = regressionFor(current, baseline);
  const limit = isHeapLikeMetric(current) ? thresholds.maxHeapRegressionPercent : thresholds.maxRegressionPercent;
  const warnLimit = limit * thresholds.warnAtRatio;
  const status: PerfBaselineComparisonStatus = regressionPercent > limit
    ? "fail"
    : regressionPercent > warnLimit
      ? "warn"
      : "pass";
  return Object.freeze({
    metric: current,
    baselineValue: baseline.value,
    currentValue: current.value,
    delta,
    deltaPercent,
    status,
    reason: reasonForMetric(current, regressionPercent, limit),
  });
}

function regressionFor(current: PerfHistoryMetric, baseline: PerfHistoryMetric): number {
  if (current.direction === "higher-is-better") {
    if (baseline.value <= 0) return current.value < baseline.value ? 100 : 0;
    return Math.max(0, ((baseline.value - current.value) / baseline.value) * 100);
  }
  if (current.direction === "lower-is-better") {
    if (baseline.value === 0) return current.value > 0 ? 100 : 0;
    return Math.max(0, ((current.value - baseline.value) / Math.abs(baseline.value)) * 100);
  }
  return 0;
}

function reasonForMetric(metric: PerfHistoryMetric, regressionPercent: number, limit: number): string {
  if (regressionPercent <= 0) return "no regression against baseline";
  return `${formatMetricName(metric)} regressed ${round(regressionPercent)}% (limit ${limit}%)`;
}

function resolveStorePaths(options: PerfHistoryStoreOptions): StorePaths {
  const directory = resolve(options.directory ?? defaultPerfHistoryDirectory());
  return Object.freeze({
    directory,
    historyFile: join(directory, options.historyFileName ?? DEFAULT_HISTORY_FILE),
    baselinesDirectory: join(directory, options.baselinesDirectoryName ?? DEFAULT_BASELINES_DIR),
  });
}

function baselinePath(paths: StorePaths, name: string): string {
  return join(paths.baselinesDirectory, `${sanitizeBaselineName(name)}.json`);
}

function sanitizeBaselineName(name: string): string {
  let safe = "";
  let lastWasReplacement = false;

  for (const char of name.trim()) {
    if (isSafeBaselineNameChar(char)) {
      safe += char;
      lastWasReplacement = false;
      continue;
    }
    if (safe.length > 0 && !lastWasReplacement) {
      safe += "-";
      lastWasReplacement = true;
    }
  }

  let start = 0;
  let end = safe.length;
  while (start < end && safe.charCodeAt(start) === HYPHEN_CODE) start += 1;
  while (end > start && safe.charCodeAt(end - 1) === HYPHEN_CODE) end -= 1;

  const normalized = safe.slice(start, end);
  return normalized.length > 0 ? normalized : "baseline";
}

const HYPHEN_CODE = 45;
const DOT_CODE = 46;
const UNDERSCORE_CODE = 95;
const ZERO_CODE = 48;
const NINE_CODE = 57;
const UPPER_A_CODE = 65;
const UPPER_Z_CODE = 90;
const LOWER_A_CODE = 97;
const LOWER_Z_CODE = 122;

function isSafeBaselineNameChar(char: string): boolean {
  if (char.length !== 1) return false;
  const code = char.charCodeAt(0);
  return (
    code === HYPHEN_CODE ||
    code === DOT_CODE ||
    code === UNDERSCORE_CODE ||
    (code >= ZERO_CODE && code <= NINE_CODE) ||
    (code >= UPPER_A_CODE && code <= UPPER_Z_CODE) ||
    (code >= LOWER_A_CODE && code <= LOWER_Z_CODE)
  );
}

async function pruneHistoryFile(historyFile: string, maxEntries: number): Promise<void> {
  const raw = await readFile(historyFile, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= maxEntries) return;
  await writeFile(historyFile, `${lines.slice(-maxEntries).join("\n")}\n`, "utf8");
}

function normalizeThresholds(thresholds: PerfBaselineThresholds): Required<PerfBaselineThresholds> {
  return {
    maxRegressionPercent: positiveNumber(thresholds.maxRegressionPercent, 10),
    maxHeapRegressionPercent: positiveNumber(thresholds.maxHeapRegressionPercent, 25),
    warnAtRatio: clamp(positiveNumber(thresholds.warnAtRatio, 0.5), 0, 1),
    failOnMissingMetric: thresholds.failOnMissingMetric ?? false,
  };
}

function aggregateRuntimeOps(report: RuntimePrimitiveProfileReport): number {
  const units = report.results.reduce((sum, result) => sum + result.units, 0);
  const durationMs = report.results.reduce((sum, result) => sum + result.durationMs, 0);
  return round(units / Math.max(durationMs / 1000, 0.001));
}

function metricKey(metric: PerfHistoryMetric): string {
  const tags = metric.tags
    ? Object.entries(metric.tags).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(",")
    : "";
  return `${metric.name}|${tags}`;
}

function formatMetricName(metric: PerfHistoryMetric): string {
  const tags = metric.tags
    ? Object.entries(metric.tags).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(",")
    : "";
  return tags.length > 0 ? `${metric.name}{${tags}}` : metric.name;
}

function isHeapLikeMetric(metric: PerfHistoryMetric): boolean {
  return metric.name.includes("heap") || metric.name.includes("rss");
}

function makeEntryId(profile: PerfHistoryProfile, timestamp: string): string {
  return `${profile}-${timestamp.replace(/[^0-9A-Za-z]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

function isBrassPerformanceReport(value: unknown): value is BrassPerformanceReport {
  return isRecord(value) && ("recorder" in value || "recommendations" in value) && ("runtime" in value || "http" in value || "memory" in value);
}

function isRuntimePrimitiveProfileReport(value: unknown): value is RuntimePrimitiveProfileReport {
  return isRecord(value) && Array.isArray(value.results) && typeof value.variant === "string" && typeof value.chainDepth === "number";
}

function isHttpLayerProfileReport(value: unknown): value is HttpLayerProfileReport {
  return isRecord(value) && Array.isArray(value.results) && typeof value.calls === "number" && value.results.some((item) => isRecord(item) && "httpPerSec" in item);
}

function isRuntimeAbReport(value: unknown): value is RuntimeAbReport {
  return isRecord(value) && Array.isArray(value.comparisons) && isRuntimePrimitiveProfileReport(value.baseline) && isRuntimePrimitiveProfileReport(value.candidate);
}

function isRuntimeSoakReport(value: unknown): value is RuntimeSoakReport {
  return isRecord(value) && Array.isArray(value.rounds) && typeof value.throughputTrendPercent === "number" && typeof value.variant === "string";
}

function isHttpMemoryLabReport(value: unknown): value is HttpMemoryLabReport {
  return isRecord(value) && Array.isArray(value.summaries) && Array.isArray(value.roundsData);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function percentDelta(current: number, baseline: number): number {
  if (baseline === 0) return current === 0 ? 0 : 100;
  return ((current - baseline) / Math.abs(baseline)) * 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
