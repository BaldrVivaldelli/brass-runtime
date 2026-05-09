/**
 * Benchmark runner for brass-runtime.
 *
 * Discovers and executes all *.bench.ts files in this directory,
 * collects timing data, and reports results in JSON format.
 *
 * Usage:
 *   npx tsx src/benchmarks/runner.ts            # run all benchmarks
 *   npx tsx src/benchmarks/runner.ts --json      # JSON-only output (for CI)
 *   npx tsx src/benchmarks/runner.ts <pattern>   # run benchmarks matching pattern
 */

import { readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeCapabilities } from "../core/runtime/capabilities";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


export interface BenchmarkResult {
  /** Human-readable name of the benchmark. */
  operation: string;
  /** Number of iterations executed. */
  iterations: number;
  /** Total wall-clock time in milliseconds. */
  totalMs: number;
  /** Average time per operation in milliseconds. */
  perOpMs: number;
  /** Percentile breakdown (p50, p90, p95, p99) in milliseconds. */
  percentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
  };
  /** Optional suite-specific measurements, for example memory counters. */
  details?: Record<string, unknown>;
  /** Optional derived throughput based on work units completed per benchmark iteration. */
  throughput?: {
    unit: string;
    unitsPerRun: number;
    perSecond: number;
  };
}

export interface BenchmarkSuite {
  /** File the benchmark was loaded from. */
  file: string;
  results: BenchmarkResult[];
}

export interface BenchmarkReport {
  timestamp: string;
  platform: string;
  nodeVersion: string;
  capabilities: ReturnType<typeof runtimeCapabilities>;
  suites: BenchmarkSuite[];
}

// ---------------------------------------------------------------------------
// Benchmark definition helpers (used by individual bench files)
// ---------------------------------------------------------------------------

export type BenchFn = () => void | Promise<void> | Record<string, unknown> | Promise<Record<string, unknown> | void>;

export interface BenchmarkDef {
  name: string;
  fn: BenchFn;
  /** Number of iterations. Defaults to 1000. */
  iterations?: number;
  /** Warmup iterations (not measured). Defaults to 50. */
  warmup?: number;
  /** Number of work units completed by each measured benchmark iteration. */
  unitsPerRun?: number;
  /** Unit name for throughput display, for example "req", "task", or "item". */
  unit?: string;
}

/**
 * Run a single benchmark definition and return its result.
 *
 * Each iteration is timed individually using `performance.now()` so we can
 * compute percentiles.  A warmup phase runs first to let the JIT stabilise.
 */
export async function runBenchmark(def: BenchmarkDef): Promise<BenchmarkResult> {
  const iterations = def.iterations ?? 1000;
  const warmup = def.warmup ?? 50;

  // Warmup
  for (let i = 0; i < warmup; i++) {
    await runBenchFn(def.fn);
  }

  // Measured runs
  const samples: number[] = new Array(iterations);
  let details: Record<string, unknown> | undefined;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const returnedDetails = await runBenchFn(def.fn);
    samples[i] = performance.now() - start;
    if (returnedDetails) details = returnedDetails;
  }

  // Sort for percentile computation
  samples.sort((a, b) => a - b);

  const totalMs = samples.reduce((s, v) => s + v, 0);

  const perOpMs = totalMs / iterations;
  const throughput = makeThroughput(def, details, perOpMs);

  return {
    operation: def.name,
    iterations,
    totalMs: round(totalMs),
    perOpMs: round(perOpMs),
    percentiles: {
      p50: round(percentile(samples, 0.5)),
      p90: round(percentile(samples, 0.9)),
      p95: round(percentile(samples, 0.95)),
      p99: round(percentile(samples, 0.99)),
    },
    ...(details ? { details } : {}),
    ...(throughput ? { throughput } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function runBenchFn(fn: BenchFn): Promise<Record<string, unknown> | undefined> {
  const value = fn();
  const result = value instanceof Promise ? await value : value;
  return isDetails(result) ? result : undefined;
}

function isDetails(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeThroughput(
  def: BenchmarkDef,
  details: Record<string, unknown> | undefined,
  perOpMs: number
): BenchmarkResult["throughput"] | undefined {
  const units = def.unitsPerRun ?? readNumericDetail(details, "units");
  const durationMs = readNumericDetail(details, "throughputDurationMs") ?? perOpMs;
  if (units === undefined || units <= 0 || durationMs <= 0) return undefined;

  const unit = def.unit ?? readStringDetail(details, "unit") ?? "op";
  return {
    unit,
    unitsPerRun: units,
    perSecond: round(units / (durationMs / 1000)),
  };
}

function readNumericDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringDetail(details: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatDetails(details: Record<string, unknown> | undefined): string {
  if (!details) return "";
  const entries = Object.entries(details)
    .filter(([key]) => key !== "unit" && key !== "units" && key !== "throughputDurationMs")
    .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 6)
    .map(([key, value]) => `${key}=${formatDetailValue(value)}`);
  return entries.length > 0 ? `  ${entries.join(" ")}` : "";
}

function formatThroughput(throughput: BenchmarkResult["throughput"]): string {
  if (!throughput) return "";
  return `  ${throughput.unit}/s=${formatRate(throughput.perSecond)}`;
}

function formatRate(value: number): string {
  if (value >= 1_000_000) return `${round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${round(value / 1_000)}k`;
  return String(round(value));
}

function formatDetailValue(value: unknown): string {
  return typeof value === "number" ? String(round(value)) : String(value);
}

// ---------------------------------------------------------------------------
// Suite runner
// ---------------------------------------------------------------------------

/**
 * Convention: each *.bench.ts file default-exports (or named-exports `benchmarks`)
 * an array of BenchmarkDef objects.
 */
async function loadSuite(filePath: string): Promise<BenchmarkDef[]> {
  const mod = await import(filePath);
  const defs: BenchmarkDef[] = mod.benchmarks ?? mod.default ?? [];
  if (!Array.isArray(defs)) {
    console.warn(`  ⚠ ${basename(filePath)}: expected an array of BenchmarkDef, skipping.`);
    return [];
  }
  return defs;
}

async function runSuite(filePath: string): Promise<BenchmarkSuite> {
  const defs = await loadSuite(filePath);
  const results: BenchmarkResult[] = [];

  for (const def of defs) {
    const result = await runBenchmark(def);
    results.push(result);
  }

  return { file: basename(filePath), results };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes("--json");
  const pattern = args.find((a) => !a.startsWith("--"));

  const __dirname = dirname(__filename);
  const dir = __dirname
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".bench.ts"))
    .filter((f) => (pattern ? f.includes(pattern) : true))
    .sort();

  if (files.length === 0) {
    if (!jsonOnly) console.log("No benchmark files found.");
    process.exit(0);
  }

  if (!jsonOnly) {
    console.log(`\n🏋️  brass-runtime benchmarks`);
    console.log(`   Found ${files.length} suite(s)\n`);
  }

  const suites: BenchmarkSuite[] = [];

  for (const file of files) {
    if (!jsonOnly) console.log(`▸ ${file}`);

    const suite = await runSuite(join(dir, file));
    suites.push(suite);

    if (!jsonOnly) {
      for (const r of suite.results) {
        const status = r.perOpMs < 1 ? "✓" : "⚠";
        console.log(
          `  ${status} ${r.operation}: ${r.perOpMs}ms/op  (total ${r.totalMs}ms, ${r.iterations} iters)  ` +
            `p50=${r.percentiles.p50}ms p99=${r.percentiles.p99}ms` +
            formatThroughput(r.throughput) +
            formatDetails(r.details)
        );
      }
      console.log();
    }
  }

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version,
    capabilities: runtimeCapabilities(),
    suites,
  };

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log("─".repeat(60));
    console.log("JSON report:");
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  console.error("Benchmark runner failed:", err);
  process.exit(1);
});
