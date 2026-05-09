/**
 * Benchmark: adaptive limiter algorithm and diagnostics under synthetic load.
 *
 * Daily mode is intentionally small so `npm run benchmark` stays practical.
 * Use `BRASS_ADAPTIVE_BENCH_MODE=soak` or a larger
 * `BRASS_ADAPTIVE_BENCH_SAMPLES` for long-running limiter soak checks.
 */

import type { BenchmarkDef } from "./runner";
import {
  AdaptiveLimiter,
  type AdaptiveLimiterPreset,
  type LimitChangeEvent,
} from "../http/adaptiveLimiter";

type AdaptiveBenchMode = "daily" | "soak";
type AdaptiveScenario = "stable" | "saturation-recovery";

type AdaptiveBenchConfig = {
  readonly scenario: AdaptiveScenario;
  readonly samples: number;
  readonly keyCount: number;
  readonly preset: AdaptiveLimiterPreset;
};

type AdaptiveBenchDetails = Record<string, unknown> & {
  units: number;
  unit: "sample";
  scenario: AdaptiveScenario;
  samples: number;
  keyCount: number;
  preset: AdaptiveLimiterPreset;
  finalLimit: number;
  maxLimitSeen: number;
  minLimitSeen: number;
  stateCount: number;
  limitChanges: number;
  p50: number;
  p99: number;
  requestsPerSecond: number;
  completionsPerSecond: number;
  throughputDurationMs: number;
};

const MODE = resolveMode();
const DEFAULT_SAMPLES = MODE === "soak" ? 500_000 : 25_000;
const SAMPLES = envInt("BRASS_ADAPTIVE_BENCH_SAMPLES", DEFAULT_SAMPLES);
const KEY_COUNT = envInt("BRASS_ADAPTIVE_BENCH_KEYS", MODE === "soak" ? 64 : 16);
const PRESET = resolvePreset();

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveMode(): AdaptiveBenchMode {
  return process.env.BRASS_ADAPTIVE_BENCH_MODE?.trim().toLowerCase() === "soak"
    ? "soak"
    : "daily";
}

function resolvePreset(): AdaptiveLimiterPreset {
  const raw = process.env.BRASS_ADAPTIVE_BENCH_PRESET?.trim().toLowerCase();
  if (raw === "conservative" || raw === "balanced" || raw === "aggressive") return raw;
  return "balanced";
}

async function runAdaptiveLimiterScenario(config: AdaptiveBenchConfig): Promise<AdaptiveBenchDetails> {
  const events: LimitChangeEvent[] = [];
  const limiter = new AdaptiveLimiter({
    preset: config.preset,
    stateTtlMs: false,
    historySize: 128,
    onLimitChange: (event) => events.push(event),
  });
  const controller = new AbortController();
  const startedAt = performance.now();
  let maxLimitSeen = 0;
  let minLimitSeen = Number.POSITIVE_INFINITY;

  for (let i = 0; i < config.samples; i++) {
    const key = `origin-${i % config.keyCount}`;
    const before = limiter.stats(key);
    maxLimitSeen = Math.max(maxLimitSeen, before.limit);
    minLimitSeen = Math.min(minLimitSeen, before.limit);

    const lease = await limiter.acquire(key, controller.signal, { priority: i % 10 });
    const sample = sampleFor(config.scenario, i, config.samples, before.limit);
    lease.release(sample.latencyMs, sample.status === undefined ? undefined : { status: sample.status });
  }

  const durationMs = performance.now() - startedAt;
  const stats = limiter.stats();
  limiter.shutdown();

  return {
    units: config.samples,
    unit: "sample",
    scenario: config.scenario,
    samples: config.samples,
    keyCount: config.keyCount,
    preset: config.preset,
    finalLimit: stats.limit,
    maxLimitSeen,
    minLimitSeen: Number.isFinite(minLimitSeen) ? minLimitSeen : stats.limit,
    stateCount: stats.stateCount ?? 0,
    limitChanges: events.length,
    p50: stats.p50 ?? 0,
    p99: stats.p99 ?? 0,
    requestsPerSecond: stats.requestsPerSecond ?? 0,
    completionsPerSecond: stats.completionsPerSecond ?? 0,
    throughputDurationMs: durationMs,
  };
}

function sampleFor(
  scenario: AdaptiveScenario,
  index: number,
  total: number,
  limit: number,
): { readonly latencyMs: number; readonly status?: number } {
  if (scenario === "stable") {
    return { latencyMs: 18 + (index % 7) };
  }

  const progress = index / total;
  if (progress < 0.35) {
    return { latencyMs: 20 + (index % 5) };
  }
  if (progress < 0.7) {
    const fastFail = index % 11 === 0;
    return {
      latencyMs: fastFail ? 8 : 35 + Math.min(240, limit * 4) + (index % 17),
      status: fastFail ? 503 : 200,
    };
  }
  return { latencyMs: 16 + (index % 6) };
}

const iterations = MODE === "soak" ? 3 : 5;
const warmup = MODE === "soak" ? 1 : 1;

export const benchmarks: BenchmarkDef[] = [
  {
    name: `adaptive-limiter/${PRESET}/stable`,
    iterations,
    warmup,
    unitsPerRun: SAMPLES,
    unit: "sample",
    fn: () => runAdaptiveLimiterScenario({
      scenario: "stable",
      samples: SAMPLES,
      keyCount: KEY_COUNT,
      preset: PRESET,
    }),
  },
  {
    name: `adaptive-limiter/${PRESET}/saturation-recovery`,
    iterations,
    warmup,
    unitsPerRun: SAMPLES,
    unit: "sample",
    fn: () => runAdaptiveLimiterScenario({
      scenario: "saturation-recovery",
      samples: SAMPLES,
      keyCount: KEY_COUNT,
      preset: PRESET,
    }),
  },
];

export default benchmarks;
