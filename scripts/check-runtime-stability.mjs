#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const budgets = JSON.parse(readFileSync(new URL("./stability-budgets.json", import.meta.url), "utf8"));
const config = budgets.runtime;
const run = spawnSync(
  process.execPath,
  [
    "--expose-gc",
    "--import",
    "tsx",
    "src/perf/cli.ts",
    "--profile",
    "runtime-soak",
    "--rounds",
    String(config.rounds),
    "--runtime-iterations",
    String(config.iterations),
    "--runtime-chain-depth",
    String(config.chainDepth),
    "--force-gc",
    "--json",
  ],
  { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" }, maxBuffer: 16 * 1024 * 1024 },
);

if (run.error) {
  throw run.error;
}
if (run.status !== 0) {
  process.stderr.write(run.stderr);
  process.stderr.write(run.stdout);
  process.exit(run.status ?? 1);
}

const report = parseReport(run.stdout, "runtime stability");
writeReportIfRequested(run.stdout);
const failures = [];

if (report.rounds?.length !== config.rounds) {
  failures.push(`expected ${config.rounds} rounds, received ${report.rounds?.length ?? 0}`);
}
for (const round of report.rounds ?? []) {
  const aggregate = aggregateOpsPerSecond(round.report);
  if (aggregate < config.minAggregateOpsPerSecond) {
    failures.push(`round ${round.round}: ${roundTo(aggregate)} ops/s < ${config.minAggregateOpsPerSecond}`);
  }
}
if (!Number.isFinite(report.heapTrendMb) || report.heapTrendMb > config.maxHeapTrendMb) {
  failures.push(`heap trend ${report.heapTrendMb}MB > ${config.maxHeapTrendMb}MB`);
}
const totalHeap = report.memory?.delta?.heapUsedMb;
if (!Number.isFinite(totalHeap) || totalHeap > config.maxTotalHeapDeltaMb) {
  failures.push(`total heap delta ${totalHeap}MB > ${config.maxTotalHeapDeltaMb}MB`);
}

finish("Runtime stability", failures, [
  `rounds=${report.rounds?.length ?? 0}`,
  `heapTrendMb=${report.heapTrendMb}`,
  `totalHeapDeltaMb=${totalHeap}`,
]);

function aggregateOpsPerSecond(runtimeReport) {
  const results = runtimeReport?.results ?? [];
  const units = results.reduce((sum, result) => sum + Number(result.units ?? 0), 0);
  const durationMs = results.reduce((sum, result) => sum + Number(result.durationMs ?? 0), 0);
  return units / Math.max(durationMs / 1000, 0.001);
}

function parseReport(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Could not parse ${label} JSON output`);
    console.error(raw);
    throw error;
  }
}

function writeReportIfRequested(raw) {
  const path = process.env.BRASS_STABILITY_REPORT_PATH;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
}

function finish(label, failures, details) {
  if (failures.length > 0) {
    console.error(`${label} gate failed:`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`${label} gate ok (budget v${budgets.version})`);
  console.log(`- ${details.join(" ")}`);
}

function roundTo(value) {
  return Math.round(value * 1000) / 1000;
}
