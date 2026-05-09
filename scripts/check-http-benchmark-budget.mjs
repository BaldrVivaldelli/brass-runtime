#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const calls = process.env.BRASS_HTTP_BENCH_CALLS ?? "1000";
const concurrency = process.env.BRASS_HTTP_BENCH_CONCURRENCY ?? "64";
const delayMs = process.env.BRASS_HTTP_BENCH_DELAY_MS ?? "1";
const maxHeapDeltaMb = Number(process.env.BRASS_HTTP_BENCH_MAX_HEAP_DELTA_MB ?? "24");
const minAdaptiveFinalLimit = Number(process.env.BRASS_HTTP_BENCH_MIN_ADAPTIVE_FINAL_LIMIT ?? "4");
const minAdaptiveServerInFlight = Number(process.env.BRASS_HTTP_BENCH_MIN_ADAPTIVE_SERVER_IN_FLIGHT ?? "4");

const run = spawnSync(
  process.execPath,
  ["--expose-gc", "--import", "tsx", "src/benchmarks/runner.ts", "--json", "http-concurrent"],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      BRASS_HTTP_BENCH_MODE: "compare",
      BRASS_HTTP_BENCH_CALLS: calls,
      BRASS_HTTP_BENCH_CONCURRENCY: concurrency,
      BRASS_HTTP_BENCH_DELAY_MS: delayMs,
    },
  },
);

if (run.status !== 0) {
  process.stderr.write(run.stderr);
  process.stderr.write(run.stdout);
  process.exit(run.status ?? 1);
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch (error) {
  console.error("Could not parse HTTP benchmark JSON output");
  console.error(run.stdout);
  throw error;
}

const results = report.suites.flatMap((suite) => suite.results);
const failures = [];

for (const result of results) {
  const details = result.details ?? {};
  if ((details.errorCount ?? 0) > 0) {
    failures.push(`${result.operation}: ${details.errorCount} HTTP errors`);
  }
  if (details.gcAvailable === true && typeof details.heapDeltaMb === "number" && details.heapDeltaMb > maxHeapDeltaMb) {
    failures.push(`${result.operation}: heapDeltaMb ${details.heapDeltaMb} > ${maxHeapDeltaMb}`);
  }
  if (typeof details.adaptiveFinalLimit === "number" && details.adaptiveFinalLimit < minAdaptiveFinalLimit) {
    failures.push(`${result.operation}: adaptiveFinalLimit ${details.adaptiveFinalLimit} < ${minAdaptiveFinalLimit}`);
  }
  if (typeof details.adaptiveMaxInFlight === "number" && details.adaptiveMaxInFlight < minAdaptiveServerInFlight) {
    failures.push(`${result.operation}: adaptiveMaxInFlight ${details.adaptiveMaxInFlight} < ${minAdaptiveServerInFlight}`);
  }
  if (typeof details.serverMaxInFlight === "number" && details.adaptiveFinalLimit !== undefined && details.serverMaxInFlight < minAdaptiveServerInFlight) {
    failures.push(`${result.operation}: serverMaxInFlight ${details.serverMaxInFlight} < ${minAdaptiveServerInFlight}`);
  }
}

if (failures.length > 0) {
  console.error("HTTP benchmark budget failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("HTTP benchmark budget ok");
for (const result of results) {
  const details = result.details ?? {};
  const heap = typeof details.heapDeltaMb === "number" ? ` heapDeltaMb=${details.heapDeltaMb}` : "";
  const adaptive = typeof details.adaptiveFinalLimit === "number"
    ? ` adaptiveFinalLimit=${details.adaptiveFinalLimit} adaptiveMaxInFlight=${details.adaptiveMaxInFlight}`
    : "";
  console.log(`- ${result.operation}: ${result.throughput?.perSecond ?? 0} ${result.throughput?.unit ?? "op"}/s${heap}${adaptive}`);
}
