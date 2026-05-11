import {
  profileHttpLayers,
  type HttpLayerProfileOptions,
  type HttpLayerProfileResult,
  type HttpProfileVariant,
} from "./httpProfiler";

export type HttpMemoryVerdict = "ok" | "watch" | "critical" | "unknown-gc";

export type HttpMemoryLabOptions = Omit<HttpLayerProfileOptions, "recorder"> & {
  readonly rounds?: number;
  readonly heapWarnMb?: number;
  readonly heapCriticalMb?: number;
  readonly heapPer10kWarnMb?: number;
};

export type HttpMemoryLabVariantSummary = {
  readonly variant: HttpProfileVariant;
  readonly label: string;
  readonly rounds: number;
  readonly callsPerRound: number;
  readonly totalCalls: number;
  readonly meanHttpPerSec: number;
  readonly minHttpPerSec: number;
  readonly maxHttpPerSec: number;
  readonly maxP99Ms: number;
  readonly totalHeapDeltaMb: number;
  readonly maxHeapDeltaMb: number;
  readonly heapDeltaPer10kRequestsMb: number;
  readonly totalRssDeltaMb: number;
  readonly maxRssDeltaMb: number;
  readonly totalErrors: number;
  readonly gcAvailable: boolean;
  readonly observedFinishedSpans: number;
  readonly adaptiveFinalLimit?: number;
  readonly verdict: HttpMemoryVerdict;
  readonly notes: readonly string[];
};

export type HttpMemoryLabRound = {
  readonly round: number;
  readonly results: readonly HttpLayerProfileResult[];
};

export type HttpMemoryLabReport = {
  readonly calls: number;
  readonly concurrency: number;
  readonly delayMs: number;
  readonly warmupCalls: number;
  readonly rounds: number;
  readonly forceGc: boolean;
  readonly variants: readonly HttpProfileVariant[];
  readonly summaries: readonly HttpMemoryLabVariantSummary[];
  readonly roundsData: readonly HttpMemoryLabRound[];
  readonly recommendations: readonly string[];
};

const DEFAULT_MEMORY_VARIANTS: readonly HttpProfileVariant[] = [
  "node-http-text",
  "wire-raw",
  "default-minimal-json",
  "default-balanced-no-adaptive-json",
  "default-balanced-json",
  "default-json",
  "default-json-observed",
];

export async function profileHttpMemoryLab(options: HttpMemoryLabOptions = {}): Promise<HttpMemoryLabReport> {
  const calls = positiveInt(options.calls, 20_000);
  const concurrency = positiveInt(options.concurrency, 512);
  const delayMs = nonNegativeInt(options.delayMs, 2);
  const timeoutMs = positiveInt(options.timeoutMs, 30_000);
  const warmupCalls = nonNegativeInt(options.warmupCalls, Math.min(2_000, Math.floor(calls / 10)));
  const statsSampleMs = positiveInt(options.statsSampleMs, 10);
  const rounds = positiveInt(options.rounds, 1);
  const forceGc = options.forceGc ?? true;
  const variants = options.variants && options.variants.length > 0 ? options.variants : DEFAULT_MEMORY_VARIANTS;
  const roundsData: HttpMemoryLabRound[] = [];

  for (let i = 0; i < rounds; i++) {
    const report = await profileHttpLayers({
      calls,
      concurrency,
      delayMs,
      timeoutMs,
      warmupCalls,
      statsSampleMs,
      forceGc,
      variants,
    });
    roundsData.push(Object.freeze({
      round: i + 1,
      results: report.results,
    }));
  }

  const summaries = summarizeByVariant(roundsData, {
    calls,
    heapWarnMb: options.heapWarnMb ?? 16,
    heapCriticalMb: options.heapCriticalMb ?? 64,
    heapPer10kWarnMb: options.heapPer10kWarnMb ?? 4,
  });

  return Object.freeze({
    calls,
    concurrency,
    delayMs,
    warmupCalls,
    rounds,
    forceGc,
    variants: Object.freeze([...variants]),
    summaries,
    roundsData: Object.freeze(roundsData),
    recommendations: makeHttpMemoryRecommendations(summaries, forceGc),
  });
}

export function formatHttpMemoryLabReport(report: HttpMemoryLabReport): string {
  const lines: string[] = [];
  lines.push("Brass HTTP Long-Run Memory Lab");
  lines.push(`calls=${report.calls} concurrency=${report.concurrency} delay=${report.delayMs}ms rounds=${report.rounds} forceGc=${report.forceGc}`);
  lines.push("");
  lines.push("Variants");
  for (const summary of report.summaries) {
    lines.push(`- ${summary.variant}: ${formatNumber(summary.meanHttpPerSec)} http/s, maxP99=${summary.maxP99Ms}ms, heap=${summary.totalHeapDeltaMb}MB (${summary.heapDeltaPer10kRequestsMb}MB/10k), rss=${summary.totalRssDeltaMb}MB, errors=${summary.totalErrors}, verdict=${summary.verdict}`);
    for (const note of summary.notes) lines.push(`  note: ${note}`);
  }
  lines.push("");
  lines.push("Recommendations");
  for (const recommendation of report.recommendations) lines.push(`- ${recommendation}`);
  return lines.join("\n");
}

function summarizeByVariant(
  roundsData: readonly HttpMemoryLabRound[],
  thresholds: {
    readonly calls: number;
    readonly heapWarnMb: number;
    readonly heapCriticalMb: number;
    readonly heapPer10kWarnMb: number;
  },
): readonly HttpMemoryLabVariantSummary[] {
  const byVariant = new Map<HttpProfileVariant, HttpLayerProfileResult[]>();
  for (const round of roundsData) {
    for (const result of round.results) {
      const items = byVariant.get(result.variant) ?? [];
      items.push(result);
      byVariant.set(result.variant, items);
    }
  }

  return Object.freeze([...byVariant.entries()].map(([variant, results]) => {
    const totalCalls = results.reduce((sum, result) => sum + result.calls, 0);
    const heapDeltas = results.map((result) => result.memory.delta.heapUsedMb);
    const rssDeltas = results.map((result) => result.memory.delta.rssMb);
    const totalHeapDeltaMb = round(sum(heapDeltas));
    const totalRssDeltaMb = round(sum(rssDeltas));
    const heapDeltaPer10kRequestsMb = round(totalHeapDeltaMb / Math.max(totalCalls / 10_000, 1));
    const gcAvailable = results.every((result) => result.gcAvailable);
    const maxHeapDeltaMb = round(Math.max(...heapDeltas));
    const maxRssDeltaMb = round(Math.max(...rssDeltas));
    const verdict = memoryVerdict({
      gcAvailable,
      totalHeapDeltaMb,
      heapDeltaPer10kRequestsMb,
      heapWarnMb: thresholds.heapWarnMb,
      heapCriticalMb: thresholds.heapCriticalMb,
      heapPer10kWarnMb: thresholds.heapPer10kWarnMb,
    });
    return Object.freeze({
      variant,
      label: results[0]?.label ?? variant,
      rounds: results.length,
      callsPerRound: thresholds.calls,
      totalCalls,
      meanHttpPerSec: round(mean(results.map((result) => result.httpPerSec))),
      minHttpPerSec: round(Math.min(...results.map((result) => result.httpPerSec))),
      maxHttpPerSec: round(Math.max(...results.map((result) => result.httpPerSec))),
      maxP99Ms: round(Math.max(...results.map((result) => result.requestP99Ms))),
      totalHeapDeltaMb,
      maxHeapDeltaMb,
      heapDeltaPer10kRequestsMb,
      totalRssDeltaMb,
      maxRssDeltaMb,
      totalErrors: results.reduce((sum, result) => sum + result.errorCount, 0),
      gcAvailable,
      observedFinishedSpans: results.reduce((sum, result) => sum + (result.observedFinishedSpans ?? 0), 0),
      adaptiveFinalLimit: lastDefined(results.map((result) => result.adaptiveFinalLimit)),
      verdict,
      notes: Object.freeze(notesForVariant(variant, verdict, gcAvailable, heapDeltaPer10kRequestsMb)),
    });
  }));
}

function memoryVerdict(input: {
  readonly gcAvailable: boolean;
  readonly totalHeapDeltaMb: number;
  readonly heapDeltaPer10kRequestsMb: number;
  readonly heapWarnMb: number;
  readonly heapCriticalMb: number;
  readonly heapPer10kWarnMb: number;
}): HttpMemoryVerdict {
  if (!input.gcAvailable) return "unknown-gc";
  if (input.totalHeapDeltaMb >= input.heapCriticalMb) return "critical";
  if (input.totalHeapDeltaMb >= input.heapWarnMb) return "watch";
  if (input.heapDeltaPer10kRequestsMb >= input.heapPer10kWarnMb) return "watch";
  return "ok";
}

function notesForVariant(
  variant: HttpProfileVariant,
  verdict: HttpMemoryVerdict,
  gcAvailable: boolean,
  heapDeltaPer10kRequestsMb: number,
): readonly string[] {
  const notes: string[] = [];
  if (!gcAvailable) notes.push("GC was unavailable; heap delta may be allocator churn rather than retained memory.");
  if (verdict === "watch") notes.push(`Retained heap is worth watching at ${heapDeltaPer10kRequestsMb}MB per 10k requests.`);
  if (verdict === "critical") notes.push("Retained heap crossed the critical threshold after GC.");
  if (variant === "default-json-observed") notes.push("Includes client observability middleware and span retention pressure.");
  if (variant === "default-json") notes.push("Default preset includes adaptive limiter and safe-method cache policy.");
  if (variant === "default-balanced-no-adaptive-json") notes.push("Balanced preset without adaptive limiter isolates limiter overhead.");
  return Object.freeze(notes);
}

function makeHttpMemoryRecommendations(summaries: readonly HttpMemoryLabVariantSummary[], forceGc: boolean): readonly string[] {
  const recommendations: string[] = [];
  if (!summaries.every((summary) => summary.gcAvailable)) {
    recommendations.push("Re-run with node --expose-gc to distinguish allocator churn from retained references.");
  } else if (forceGc) {
    recommendations.push("GC was available; positive heap deltas are stronger retention signals than non-GC runs.");
  }

  const critical = summaries.filter((summary) => summary.verdict === "critical");
  const watch = summaries.filter((summary) => summary.verdict === "watch");
  if (critical.length > 0) {
    recommendations.push(`Critical retained heap in: ${critical.map((summary) => summary.variant).join(", ")}.`);
  } else if (watch.length > 0) {
    recommendations.push(`Watch retained heap in: ${watch.map((summary) => summary.variant).join(", ")}.`);
  } else if (summaries.every((summary) => summary.gcAvailable)) {
    recommendations.push("No variant crossed retained-heap thresholds after GC.");
  }

  const observed = summaries.find((summary) => summary.variant === "default-json-observed");
  const def = summaries.find((summary) => summary.variant === "default-json");
  if (observed && def) {
    const observedHeapOverDefault = round(observed.heapDeltaPer10kRequestsMb - def.heapDeltaPer10kRequestsMb);
    const throughputRatio = def.meanHttpPerSec > 0 ? round((observed.meanHttpPerSec / def.meanHttpPerSec) * 100) : 100;
    recommendations.push(`Observability vs default: heapDeltaPer10k ${signed(observedHeapOverDefault)}MB, throughput ${throughputRatio}% of default.`);
  }

  const lowestHeap = [...summaries].sort((a, b) => a.heapDeltaPer10kRequestsMb - b.heapDeltaPer10kRequestsMb)[0];
  const fastest = [...summaries].sort((a, b) => b.meanHttpPerSec - a.meanHttpPerSec)[0];
  if (lowestHeap) recommendations.push(`Lowest heap/10k variant: ${lowestHeap.variant} (${lowestHeap.heapDeltaPer10kRequestsMb}MB/10k).`);
  if (fastest) recommendations.push(`Fastest variant: ${fastest.variant} (${formatNumber(fastest.meanHttpPerSec)} http/s).`);

  return Object.freeze(recommendations);
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function lastDefined<A>(values: readonly (A | undefined)[]): A | undefined {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== undefined) return values[i];
  }
  return undefined;
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function formatNumber(value: number): string {
  return value >= 1_000 ? value.toLocaleString("en-US", { maximumFractionDigits: 0 }) : value.toFixed(3);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
