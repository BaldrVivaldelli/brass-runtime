#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const budgets = [
  { match: "baseline asyncSucceed", maxPerOpMs: 0.75 },
  { match: "withSpan start/end", maxPerOpMs: 1.0 },
  { match: "logEffect structured sink", maxPerOpMs: 1.0 },
  { match: "span+event+log composition", maxPerOpMs: 1.25 },
  { match: "OTLP trace flush 25 spans", maxPerOpMs: 12.0 },
];

const run = spawnSync("npm", ["run", "--silent", "benchmark:json", "--", "observability-overhead"], {
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
  console.error("Could not parse benchmark JSON output");
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
  if (result.perOpMs > budget.maxPerOpMs) {
    failures.push(`${result.operation}: ${result.perOpMs}ms/op > ${budget.maxPerOpMs}ms/op`);
  }
}

if (failures.length > 0) {
  console.error("Observability benchmark budget failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Observability benchmark budget ok");
for (const budget of budgets) {
  const result = results.find((entry) => entry.operation.includes(budget.match));
  console.log(`- ${result.operation}: ${result.perOpMs}ms/op <= ${budget.maxPerOpMs}ms/op`);
}
