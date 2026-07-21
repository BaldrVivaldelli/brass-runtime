#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const budget = JSON.parse(readFileSync(new URL("../src/benchmarks/runtime-budgets-v1.json", import.meta.url), "utf8"));
const primitiveReport = runBenchmark("runtime-primitives");
const heapReport = runBenchmark("heap-suspended-fiber");
const results = [...primitiveReport.suites, ...heapReport.suites].flatMap((suite) => suite.results);
const failures = [];

for (const gate of budget.latency) {
  const result = results.find((entry) => entry.operation.includes(gate.match));
  if (!result) {
    failures.push(`${gate.match}: missing result`);
    continue;
  }
  const units = result.throughput?.unitsPerRun;
  if (typeof units !== "number" || units <= 0) {
    failures.push(`${result.operation}: missing unitsPerRun`);
    continue;
  }
  const perUnitUs = (result.perOpMs / units) * 1000;
  if (perUnitUs > gate.maxPerUnitUs) {
    failures.push(`${result.operation}: ${round(perUnitUs)}us/unit > ${gate.maxPerUnitUs}us/unit`);
  }
  if (gate.maxConsecutive !== undefined) {
    if (result.details?.maximumConsecutive > gate.maxConsecutive) {
      failures.push(`${result.operation}: run ${result.details.maximumConsecutive} > ${gate.maxConsecutive}`);
    }
    if (result.details?.dropped !== 0) failures.push(`${result.operation}: dropped tasks`);
  }
  if (result.details?.liveFibers !== undefined && result.details.liveFibers !== 0) {
    failures.push(`${result.operation}: ${result.details.liveFibers} live fibers after completion`);
  }
  if (result.details?.suspendedFibers !== undefined && result.details.suspendedFibers !== 0) {
    failures.push(`${result.operation}: ${result.details.suspendedFibers} suspended fibers after completion`);
  }
}

for (const gate of budget.heap) {
  const result = results.find((entry) => entry.operation.includes(gate.match));
  if (!result) {
    failures.push(`${gate.match}: missing result`);
    continue;
  }
  if (result.details?.heapPerFiberBytes > gate.maxHeapPerFiberBytes) {
    failures.push(`${result.operation}: heap ${result.details.heapPerFiberBytes}B > ${gate.maxHeapPerFiberBytes}B`);
  }
  if (result.details?.rssPerFiberBytes > gate.maxRssPerFiberBytes) {
    failures.push(`${result.operation}: RSS ${result.details.rssPerFiberBytes}B > ${gate.maxRssPerFiberBytes}B`);
  }
}

if (failures.length > 0) {
  console.error(`Runtime primitive budget v${budget.version} failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Runtime primitive budget v${budget.version} ok`);
for (const gate of budget.latency) {
  const result = results.find((entry) => entry.operation.includes(gate.match));
  console.log(`- ${result.operation}: ${round((result.perOpMs / result.throughput.unitsPerRun) * 1000)}us/${result.throughput.unit}`);
}
for (const gate of budget.heap) {
  const result = results.find((entry) => entry.operation.includes(gate.match));
  console.log(`- ${result.operation}: heap=${result.details.heapPerFiberBytes}B rss=${result.details.rssPerFiberBytes}B`);
}

function runBenchmark(pattern) {
  const run = spawnSync("npm", ["run", "--silent", "benchmark:json", "--", pattern], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (run.status !== 0) {
    process.stderr.write(run.stderr);
    process.stderr.write(run.stdout);
    process.exit(run.status ?? 1);
  }
  try {
    return JSON.parse(run.stdout);
  } catch (error) {
    console.error(`Could not parse ${pattern} benchmark output`);
    console.error(run.stdout);
    throw error;
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
