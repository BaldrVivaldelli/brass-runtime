#!/usr/bin/env node

/**
 * HTTP P99 budget enforcement script.
 *
 * Reads benchmark JSON output from the `http-local-overhead` benchmark and
 * checks per-variant latency budgets, regression thresholds, and error counts.
 *
 * Usage:
 *   node scripts/check-http-p99-budget.mjs [path-to-results.json]
 *
 * If no path is provided, runs the benchmark inline via the runner.
 *
 * Exit codes:
 *   0 — all budgets pass
 *   1 — one or more budgets exceeded
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Thresholds (from requirements 4.1–4.9)
// ---------------------------------------------------------------------------

/** Variants that must satisfy P99/P50 ratio <= 6.0 (Req 4.1, 4.2, 4.3) */
const RATIO_VARIANTS = [
  "default-proxy-effect-timeout",
  "default-proxy-effect-pool",
  "default-proxy-effect-timeout-pool",
];

/** Variants that must satisfy absolute P99 <= 0.5ms (Req 4.4, 4.5) */
const ABSOLUTE_P99_VARIANTS = [
  "default-proxy-effect-timeout",
  "default-proxy-effect-pool",
];

const MAX_P99_P50_RATIO = 6.0;
const MAX_ABSOLUTE_P99_MS = 0.5;
const MAX_P50_REGRESSION_PERCENT = 10;
const MAX_THROUGHPUT_REGRESSION_PERCENT = 5;

// ---------------------------------------------------------------------------
// Baseline path
// ---------------------------------------------------------------------------

const BASELINE_PATH = resolve(ROOT, ".brass/perf-history/baselines/http-local-overhead.json");

// ---------------------------------------------------------------------------
// Load benchmark results
// ---------------------------------------------------------------------------

function loadResults(filePath) {
  if (!existsSync(filePath)) {
    console.error(`Benchmark results file not found: ${filePath}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`Failed to parse benchmark results JSON: ${err.message}`);
    process.exit(1);
  }
}

function runBenchmarkInline() {
  console.log("No results file provided — running http-local-overhead benchmark...");
  const run = spawnSync(
    process.execPath,
    ["--expose-gc", "--import", "tsx", "src/benchmarks/runner.ts", "--json", "http-local-overhead"],
    {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },
    },
  );

  if (run.status !== 0) {
    process.stderr.write(run.stderr || "");
    process.stderr.write(run.stdout || "");
    console.error("Benchmark run failed with exit code", run.status);
    process.exit(run.status ?? 1);
  }

  try {
    return JSON.parse(run.stdout);
  } catch (err) {
    console.error("Could not parse benchmark JSON output");
    console.error(run.stdout?.slice(0, 500));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Extract per-variant metrics from benchmark report
// ---------------------------------------------------------------------------

/**
 * Extracts variant details from the benchmark report.
 * The http-local-overhead benchmark returns details with:
 *   variant, requestP50Ms, requestP99Ms, httpPerSec, errorCount, warmupCalls
 */
function extractVariantMetrics(report) {
  const results = report.suites?.flatMap((suite) => suite.results) ?? [];
  const variants = new Map();

  for (const result of results) {
    const details = result.details ?? {};
    const variant = details.variant;
    if (!variant) continue;

    variants.set(variant, {
      operation: result.operation,
      variant,
      p50Ms: details.requestP50Ms,
      p99Ms: details.requestP99Ms,
      httpPerSec: details.httpPerSec ?? result.throughput?.perSecond,
      errorCount: details.errorCount ?? 0,
      warmupCalls: details.warmupCalls ?? 0,
    });
  }

  return variants;
}

// ---------------------------------------------------------------------------
// Load baseline
// ---------------------------------------------------------------------------

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function extractBaselineMetrics(baseline) {
  if (!baseline) return null;

  // The baseline may be stored in the same report format
  if (baseline.suites) {
    return extractVariantMetrics(baseline);
  }

  // Or it may be stored as a flat map of variant -> metrics
  if (baseline.variants) {
    const map = new Map();
    for (const [variant, metrics] of Object.entries(baseline.variants)) {
      map.set(variant, metrics);
    }
    return map;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Budget checks
// ---------------------------------------------------------------------------

function checkBudgets(variants, baselineVariants) {
  const failures = [];

  // Check P99/P50 ratio (Req 4.1, 4.2, 4.3)
  for (const variant of RATIO_VARIANTS) {
    const metrics = variants.get(variant);
    if (!metrics) {
      failures.push(`[MISSING] Variant "${variant}" not found in benchmark results`);
      continue;
    }

    const { p50Ms, p99Ms } = metrics;
    if (p50Ms == null || p99Ms == null) {
      failures.push(`[MISSING] Variant "${variant}" missing P50/P99 latency data`);
      continue;
    }

    if (p50Ms <= 0) {
      // Avoid division by zero; P50 of 0 means the measurement is too fast to measure
      continue;
    }

    const ratio = p99Ms / p50Ms;
    if (ratio > MAX_P99_P50_RATIO) {
      failures.push(
        `[P99/P50 RATIO] "${variant}": ratio ${ratio.toFixed(2)} exceeds threshold ${MAX_P99_P50_RATIO} ` +
        `(P99=${p99Ms.toFixed(3)}ms, P50=${p50Ms.toFixed(3)}ms)`
      );
    }
  }

  // Check absolute P99 (Req 4.4, 4.5)
  for (const variant of ABSOLUTE_P99_VARIANTS) {
    const metrics = variants.get(variant);
    if (!metrics) continue; // Already reported above

    const { p99Ms } = metrics;
    if (p99Ms == null) continue;

    if (p99Ms > MAX_ABSOLUTE_P99_MS) {
      failures.push(
        `[ABSOLUTE P99] "${variant}": P99 ${p99Ms.toFixed(3)}ms exceeds threshold ${MAX_ABSOLUTE_P99_MS}ms`
      );
    }
  }

  // Check P50 regression vs baseline (Req 4.6)
  if (baselineVariants) {
    for (const [variant, metrics] of variants) {
      const baselineMetrics = baselineVariants.get(variant);
      if (!baselineMetrics || baselineMetrics.p50Ms == null || metrics.p50Ms == null) continue;
      if (baselineMetrics.p50Ms <= 0) continue;

      const regressionPercent = ((metrics.p50Ms - baselineMetrics.p50Ms) / baselineMetrics.p50Ms) * 100;
      if (regressionPercent > MAX_P50_REGRESSION_PERCENT) {
        failures.push(
          `[P50 REGRESSION] "${variant}": P50 regressed ${regressionPercent.toFixed(1)}% vs baseline ` +
          `(current=${metrics.p50Ms.toFixed(3)}ms, baseline=${baselineMetrics.p50Ms.toFixed(3)}ms, threshold=${MAX_P50_REGRESSION_PERCENT}%)`
        );
      }
    }
  }

  // Check throughput regression vs baseline (Req 4.7)
  if (baselineVariants) {
    for (const [variant, metrics] of variants) {
      const baselineMetrics = baselineVariants.get(variant);
      if (!baselineMetrics || baselineMetrics.httpPerSec == null || metrics.httpPerSec == null) continue;
      if (baselineMetrics.httpPerSec <= 0) continue;

      const regressionPercent = ((baselineMetrics.httpPerSec - metrics.httpPerSec) / baselineMetrics.httpPerSec) * 100;
      if (regressionPercent > MAX_THROUGHPUT_REGRESSION_PERCENT) {
        failures.push(
          `[THROUGHPUT REGRESSION] "${variant}": throughput regressed ${regressionPercent.toFixed(1)}% vs baseline ` +
          `(current=${Math.round(metrics.httpPerSec)} req/s, baseline=${Math.round(baselineMetrics.httpPerSec)} req/s, threshold=${MAX_THROUGHPUT_REGRESSION_PERCENT}%)`
        );
      }
    }
  }

  // Check for HTTP errors during measured run, excluding warmup (Req 4.9)
  for (const [variant, metrics] of variants) {
    if (metrics.errorCount > 0) {
      failures.push(
        `[HTTP ERRORS] "${variant}": ${metrics.errorCount} HTTP error(s) during measured run`
      );
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const resultsPath = args[0];

  // Load or run benchmark
  let report;
  if (resultsPath) {
    report = loadResults(resolve(process.cwd(), resultsPath));
  } else {
    report = runBenchmarkInline();
  }

  // Extract metrics
  const variants = extractVariantMetrics(report);

  if (variants.size === 0) {
    console.error("No variant metrics found in benchmark results.");
    console.error("Ensure the http-local-overhead benchmark was run.");
    process.exit(1);
  }

  // Load baseline for regression checks
  const baseline = loadBaseline();
  const baselineVariants = extractBaselineMetrics(baseline);

  if (!baselineVariants) {
    console.log("⚠ No baseline found at", BASELINE_PATH);
    console.log("  Skipping regression checks (P50 and throughput).");
    console.log("  Run the benchmark and save a baseline to enable regression detection.\n");
  }

  // Run budget checks
  const failures = checkBudgets(variants, baselineVariants);

  // Report results
  if (failures.length > 0) {
    console.error("❌ HTTP P99 budget check FAILED:\n");
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    console.error("");
    process.exit(1);
  }

  console.log("✅ HTTP P99 budget check passed\n");
  console.log("Variant summary:");
  for (const [variant, metrics] of variants) {
    const ratio = metrics.p50Ms > 0 ? (metrics.p99Ms / metrics.p50Ms).toFixed(2) : "N/A";
    const throughput = metrics.httpPerSec ? `${Math.round(metrics.httpPerSec)} req/s` : "N/A";
    console.log(
      `  ${variant}: P50=${metrics.p50Ms?.toFixed(3) ?? "?"}ms P99=${metrics.p99Ms?.toFixed(3) ?? "?"}ms ` +
      `ratio=${ratio} throughput=${throughput} errors=${metrics.errorCount}`
    );
  }
}

main();
