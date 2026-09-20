#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const evidencePath = path.resolve(
  root,
  process.argv[2] ?? "docs/evidence/stability-local-2026-09-20.json",
);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const budgets = JSON.parse(readFileSync(path.join(root, "scripts", "stability-budgets.json"), "utf8"));
const failures = [];

if (evidence.schemaVersion !== 1 || evidence.kind !== "controlled-local-stability") {
  failures.push("invalid stability evidence schema or kind");
}
if (evidence.budgetsVersion !== budgets.version) failures.push("stability budget version mismatch");
if (!/^\d+\.\d+\.\d+$/.test(evidence.environment?.node ?? "")) {
  failures.push("stability evidence requires an exact Node version");
}

if (evidence.runtime?.rounds !== budgets.runtime.rounds
  || evidence.runtime?.iterationsPerRound !== budgets.runtime.iterations
  || evidence.runtime?.chainDepth !== budgets.runtime.chainDepth
  || evidence.runtime?.heapTrendMb > budgets.runtime.maxHeapTrendMb
  || evidence.runtime?.totalHeapDeltaMb > budgets.runtime.maxTotalHeapDeltaMb
  || evidence.runtime?.passed !== true) {
  failures.push("runtime stability evidence does not satisfy the versioned budget");
}

if (evidence.http?.calls !== budgets.http.calls
  || evidence.http?.concurrency !== budgets.http.concurrency
  || evidence.http?.delayMs !== budgets.http.delayMs
  || evidence.http?.errors > budgets.http.maxErrors
  || evidence.http?.heapDeltaMb > budgets.http.maxHeapDeltaMb
  || evidence.http?.adaptiveFinalLimit < budgets.http.minAdaptiveFinalLimit
  || evidence.http?.adaptiveMaxInFlight < budgets.http.minAdaptiveServerInFlight
  || !Number.isFinite(evidence.http?.throughputPerSecond)
  || evidence.http.throughputPerSecond <= 0
  || evidence.http?.passed !== true) {
  failures.push("HTTP stability evidence does not satisfy the versioned budget");
}

const adaptiveResults = evidence.adaptive?.results;
if (evidence.adaptive?.samplesPerScenario !== budgets.adaptive.samples
  || evidence.adaptive?.keyCount !== budgets.adaptive.keyCount
  || evidence.adaptive?.passed !== true
  || !Array.isArray(adaptiveResults)) {
  failures.push("adaptive stability evidence has invalid configuration");
} else {
  for (const scenario of budgets.adaptive.scenarios) {
    const result = adaptiveResults.find((entry) => entry?.scenario === scenario);
    if (!result
      || result.stateCount > budgets.adaptive.keyCount
      || result.finalLimit < 1
      || result.limitChanges < budgets.adaptive.minLimitChanges
      || result.samplesPerSecond < budgets.adaptive.minSamplesPerSecond) {
      failures.push(`${scenario} adaptive evidence does not satisfy the versioned budget`);
    }
  }
}

for (const section of ["runtime", "http", "adaptive"]) {
  const record = evidence[section];
  if (!/^[a-f0-9]{64}$/.test(record?.sha256 ?? "")) {
    failures.push(`${section} report sha256 is invalid`);
    continue;
  }
  const reportPath = path.resolve(root, record.reportPath ?? "");
  if (existsSync(reportPath)) {
    const actual = createHash("sha256").update(readFileSync(reportPath)).digest("hex");
    if (actual !== record.sha256) failures.push(`${section} report sha256 does not match evidence`);
  }
}

if (!Array.isArray(evidence.limitations) || evidence.limitations.length < 3) {
  failures.push("at least three stability evidence limitations are required");
}
if (!Array.isArray(evidence.reproduce) || evidence.reproduce.length !== 3) {
  failures.push("all three stability reproduction commands are required");
}

if (failures.length > 0) {
  console.error("Stability evidence validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Stability evidence validated (${evidence.runtime.rounds} runtime rounds, ` +
    `${evidence.http.calls} HTTP calls, ${evidence.adaptive.samplesPerScenario} samples/scenario).`,
  );
}
