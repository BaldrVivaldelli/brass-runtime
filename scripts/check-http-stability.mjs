#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const budgets = JSON.parse(readFileSync(new URL("./stability-budgets.json", import.meta.url), "utf8"));
const config = budgets.http;
const run = spawnSync(process.execPath, ["scripts/check-http-benchmark-budget.mjs"], {
  encoding: "utf8",
  env: {
    ...process.env,
    FORCE_COLOR: "0",
    BRASS_HTTP_BENCH_MODE: "soak",
    BRASS_HTTP_BENCH_CALLS: String(config.calls),
    BRASS_HTTP_BENCH_CONCURRENCY: String(config.concurrency),
    BRASS_HTTP_BENCH_DELAY_MS: String(config.delayMs),
    BRASS_HTTP_BENCH_WARMUP_CALLS: String(config.warmupCalls),
    BRASS_HTTP_BENCH_MAX_ERRORS: String(config.maxErrors),
    BRASS_HTTP_BENCH_MAX_HEAP_DELTA_MB: String(config.maxHeapDeltaMb),
    BRASS_HTTP_BENCH_MIN_ADAPTIVE_FINAL_LIMIT: String(config.minAdaptiveFinalLimit),
    BRASS_HTTP_BENCH_MIN_ADAPTIVE_SERVER_IN_FLIGHT: String(config.minAdaptiveServerInFlight),
  },
  maxBuffer: 16 * 1024 * 1024,
});

process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);
console.log(`HTTP stability gate ok (budget v${budgets.version}, calls=${config.calls}).`);
