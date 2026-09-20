#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const budgets = JSON.parse(readFileSync(new URL("./stability-budgets.json", import.meta.url), "utf8"));
const config = budgets.adaptive;
const run = spawnSync(
  process.execPath,
  ["--expose-gc", "--import", "tsx", "src/benchmarks/runner.ts", "--json", "adaptive-limiter-soak"],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      BRASS_ADAPTIVE_BENCH_MODE: "soak",
      BRASS_ADAPTIVE_BENCH_SAMPLES: String(config.samples),
      BRASS_ADAPTIVE_BENCH_KEYS: String(config.keyCount),
    },
    maxBuffer: 16 * 1024 * 1024,
  },
);

if (run.error) {
  throw run.error;
}
if (run.status !== 0) {
  process.stderr.write(run.stderr);
  process.stderr.write(run.stdout);
  process.exit(run.status ?? 1);
}

const report = parseReport(run.stdout);
writeReportIfRequested(run.stdout);
const results = report.suites?.flatMap((suite) => suite.results ?? []) ?? [];
const failures = [];

for (const scenario of config.scenarios) {
  const result = results.find((candidate) => candidate.details?.scenario === scenario);
  if (!result) {
    failures.push(`${scenario}: missing result`);
    continue;
  }
  const details = result.details ?? {};
  if (details.samples !== config.samples) failures.push(`${scenario}: samples ${details.samples} != ${config.samples}`);
  if (details.keyCount !== config.keyCount) failures.push(`${scenario}: keyCount ${details.keyCount} != ${config.keyCount}`);
  if (details.stateCount > config.keyCount) failures.push(`${scenario}: stateCount ${details.stateCount} > ${config.keyCount}`);
  if (!Number.isFinite(details.finalLimit) || details.finalLimit < 1) failures.push(`${scenario}: invalid finalLimit ${details.finalLimit}`);
  if (!Number.isFinite(details.limitChanges) || details.limitChanges < config.minLimitChanges) {
    failures.push(`${scenario}: limitChanges ${details.limitChanges} < ${config.minLimitChanges}`);
  }
  if (!Number.isFinite(result.throughput?.perSecond) || result.throughput.perSecond < config.minSamplesPerSecond) {
    failures.push(`${scenario}: throughput ${result.throughput?.perSecond} < ${config.minSamplesPerSecond} sample/s`);
  }
}

if (failures.length > 0) {
  console.error("Adaptive stability gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Adaptive stability gate ok (budget v${budgets.version})`);
for (const result of results) {
  console.log(`- ${result.details?.scenario}: ${result.throughput?.perSecond} sample/s finalLimit=${result.details?.finalLimit} states=${result.details?.stateCount}`);
}

function parseReport(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Could not parse adaptive stability JSON output");
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
