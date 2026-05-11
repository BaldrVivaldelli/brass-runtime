#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const budgets = [
  { match: "RuntimeTrack flatMap chain", maxPerUnitUs: 0.75 },
  { match: "RuntimeTrack FiberRef update/get", maxPerUnitUs: 1.0 },
  { match: "RuntimeTrack interruptibility mask/restore", maxPerUnitUs: 1.5 },
  { match: "RuntimeTrack Layer 2 typed provideContext", maxPerUnitUs: 50.0 },
  { match: "RuntimeTrack LayerScope memoized diamond graph", maxPerOpMs: 0.5 },
  { match: "RuntimeTrack ScheduleDriver pure", maxPerUnitUs: 0.5 },
  { match: "RuntimeTrack ScheduleDriver observed", maxPerUnitUs: 1.5 },
];

const run = spawnSync("npm", ["run", "--silent", "benchmark:json", "--", "runtime-performance-track"], {
  encoding: "utf8",
  env: { ...process.env, FORCE_COLOR: "0" },
});

if (run.status !== 0) {
  process.stderr.write(run.stderr);
  process.stderr.write(run.stdout);
  process.exit(run.status ?? 1);
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch (error) {
  console.error("Could not parse runtime benchmark JSON output");
  console.error(run.stdout);
  throw error;
}

const results = report.suites.flatMap((suite) => suite.results);
const failures = [];

for (const budget of budgets) {
  const result = results.find((entry) => entry.operation.includes(budget.match));
  if (!result) {
    failures.push(`${budget.match}: missing result`);
    continue;
  }

  if (budget.maxPerOpMs !== undefined && result.perOpMs > budget.maxPerOpMs) {
    failures.push(`${result.operation}: ${result.perOpMs}ms/op > ${budget.maxPerOpMs}ms/op`);
  }

  if (budget.maxPerUnitUs !== undefined) {
    const unitsPerRun = result.throughput?.unitsPerRun;
    if (typeof unitsPerRun !== "number" || unitsPerRun <= 0) {
      failures.push(`${result.operation}: missing unitsPerRun for per-unit budget`);
      continue;
    }
    const perUnitUs = (result.perOpMs / unitsPerRun) * 1000;
    if (perUnitUs > budget.maxPerUnitUs) {
      failures.push(`${result.operation}: ${round(perUnitUs)}us/unit > ${budget.maxPerUnitUs}us/unit`);
    }
  }

  const details = result.details ?? {};
  if (result.operation.includes("LayerScope memoized diamond")) {
    if (details.acquiredOnce !== true) failures.push(`${result.operation}: shared layer was not acquired once`);
    if (details.releasedOnce !== true) failures.push(`${result.operation}: shared layer was not released once`);
  }
  if (result.operation.includes("ScheduleDriver observed")) {
    const units = result.throughput?.unitsPerRun;
    if (typeof units === "number" && details.observed !== units) {
      failures.push(`${result.operation}: observed ${details.observed} decisions, expected ${units}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Runtime benchmark budget failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Runtime benchmark budget ok");
for (const budget of budgets) {
  const result = results.find((entry) => entry.operation.includes(budget.match));
  const unitsPerRun = result.throughput?.unitsPerRun;
  const perUnit = typeof unitsPerRun === "number" && unitsPerRun > 0
    ? ` ${round((result.perOpMs / unitsPerRun) * 1000)}us/${result.throughput.unit}`
    : "";
  console.log(`- ${result.operation}: ${result.perOpMs}ms/op${perUnit}`);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
