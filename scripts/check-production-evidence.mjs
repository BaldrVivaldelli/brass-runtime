#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

const evidencePath = path.resolve(
  process.cwd(),
  process.argv[2] ?? "docs/evidence/production-like-baseline-2026-09-19.json",
);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const failures = [];
const expectedRuntimeOperations = [
  "flatMap chain",
  "FiberRef update/get",
  "interruptibility mask/restore",
  "Layer 2 typed provideContext",
  "LayerScope memoized diamond graph",
  "ScheduleDriver pure",
  "ScheduleDriver observed",
];
const expectedHttpVariants = [
  "node-http-text",
  "wire-raw",
  "default-minimal-json",
  "default-proxy-json",
  "default-proxy-node-json",
  "high-throughput-proxy-node-json",
  "default-balanced-no-adaptive-json",
  "default-balanced-json",
  "default-node-json",
  "default-json",
  "default-json-observed",
];
const expectedObservabilityOperations = [
  "baseline asyncSucceed",
  "withSpan start/end",
  "logEffect structured sink",
  "span+event+log composition",
  "OTLP trace flush 25 spans",
];

if (evidence.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (evidence.kind !== "production-like-baseline") failures.push("unexpected evidence kind");
if (evidence.claimLevel !== "controlled-local") failures.push("claimLevel must remain controlled-local");
if (!Array.isArray(evidence.limitations) || evidence.limitations.length < 3) {
  failures.push("limitations must disclose benchmark scope");
}
for (const gate of [
  "runtimeBudget",
  "httpBudget",
  "observabilityBudget",
  "zeroHttpErrors",
  "allPassed",
]) {
  if (evidence.gates?.[gate] !== true) failures.push(`gate ${gate} must be true`);
}
if (evidence.runtime?.results?.length !== 7) failures.push("expected 7 runtime results");
if (evidence.http?.results?.length !== 11) failures.push("expected 11 HTTP results");
if (evidence.observability?.results?.length !== 5) failures.push("expected 5 observability results");
validateExactNames("runtime operations", evidence.runtime?.results, "operation", expectedRuntimeOperations);
validateExactNames("HTTP variants", evidence.http?.results, "variant", expectedHttpVariants);
validateExactNames(
  "observability operations",
  evidence.observability?.results,
  "operation",
  expectedObservabilityOperations,
);
if (!evidence.runtime?.command?.includes("runtime-performance-track")) failures.push("missing runtime reproduction command");
if (evidence.http?.command !== "npm run benchmark:http:budget") failures.push("missing HTTP budget command");
if (!evidence.observability?.command?.includes("observability-overhead")) {
  failures.push("missing observability reproduction command");
}

for (const result of evidence.runtime?.results ?? []) {
  if (!positive(result.unitsPerRun) || !nonNegative(result.perOpMs)) {
    failures.push(`runtime ${result.operation}: invalid units or timing`);
  }
  if (result.maxPerUnitUs === undefined && result.maxPerOpMs === undefined) {
    failures.push(`runtime ${result.operation}: missing budget`);
  }
  if (result.maxPerUnitUs !== undefined) {
    if (!positive(result.perUnitUs) || !positive(result.maxPerUnitUs)) {
      failures.push(`runtime ${result.operation}: invalid per-unit timing or budget`);
    } else if (result.perUnitUs > result.maxPerUnitUs) {
      failures.push(`runtime ${result.operation}: ${result.perUnitUs}us > ${result.maxPerUnitUs}us`);
    }
  }
  if (result.maxPerOpMs !== undefined) {
    if (!positive(result.maxPerOpMs)) {
      failures.push(`runtime ${result.operation}: invalid per-operation budget`);
    } else if (result.perOpMs > result.maxPerOpMs) {
      failures.push(`runtime ${result.operation}: ${result.perOpMs}ms > ${result.maxPerOpMs}ms`);
    }
  }
  if (result.operation.includes("diamond") && (!result.acquiredOnce || !result.releasedOnce)) {
    failures.push("LayerScope diamond ownership invariant failed");
  }
  if (result.operation.includes("observed") && result.observed !== result.unitsPerRun) {
    failures.push("ScheduleDriver observation count mismatch");
  }
}

const httpThresholds = evidence.http?.thresholds ?? {};
if (!positive(httpThresholds.maxHeapDeltaMb)) failures.push("HTTP maxHeapDeltaMb must be positive");
if (!positive(httpThresholds.minAdaptiveFinalLimit)) failures.push("HTTP minAdaptiveFinalLimit must be positive");
if (!positive(httpThresholds.minAdaptiveServerInFlight)) {
  failures.push("HTTP minAdaptiveServerInFlight must be positive");
}
if (!Number.isInteger(httpThresholds.maxErrors) || httpThresholds.maxErrors < 0) {
  failures.push("HTTP maxErrors must be a non-negative integer");
}
if (evidence.http?.workload?.gcAvailable !== true) failures.push("HTTP evidence must use explicit GC");
for (const result of evidence.http?.results ?? []) {
  if (
    !positive(result.httpPerSecond)
    || !Number.isInteger(result.errorCount)
    || result.errorCount < 0
    || !Number.isFinite(result.heapDeltaMb)
  ) {
    failures.push(`HTTP ${result.variant}: invalid throughput, errors, or heap measurement`);
  }
  if (result.errorCount > httpThresholds.maxErrors) {
    failures.push(`HTTP ${result.variant}: ${result.errorCount} errors`);
  }
  if (result.heapDeltaMb > httpThresholds.maxHeapDeltaMb) {
    failures.push(`HTTP ${result.variant}: heap delta ${result.heapDeltaMb}MB exceeds budget`);
  }
  if (
    result.adaptiveFinalLimit !== undefined &&
    result.adaptiveFinalLimit < httpThresholds.minAdaptiveFinalLimit
  ) {
    failures.push(`HTTP ${result.variant}: adaptive final limit below budget`);
  }
  if (
    result.adaptiveMaxInFlight !== undefined &&
    result.adaptiveMaxInFlight < httpThresholds.minAdaptiveServerInFlight
  ) {
    failures.push(`HTTP ${result.variant}: adaptive in-flight count below budget`);
  }
}

for (const result of evidence.observability?.results ?? []) {
  if (!nonNegative(result.perOpMs) || !positive(result.maxPerOpMs)) {
    failures.push(`observability ${result.operation}: invalid timing or budget`);
  }
  if (result.perOpMs > result.maxPerOpMs) {
    failures.push(`observability ${result.operation}: ${result.perOpMs}ms > ${result.maxPerOpMs}ms`);
  }
}

if (failures.length > 0) {
  console.error("Production-like evidence validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Production-like evidence validated (${evidence.runtime.results.length} runtime, ` +
    `${evidence.http.results.length} HTTP, ${evidence.observability.results.length} observability results).`,
);

function positive(value) {
  return Number.isFinite(value) && value > 0;
}

function nonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validateExactNames(label, results, key, expected) {
  if (!Array.isArray(results)) return;
  const names = results.map((result) => result?.[key]);
  const actual = new Set(names);
  const duplicateNames = [...actual].filter((name) => names.filter((candidate) => candidate === name).length > 1);
  const missingNames = expected.filter((name) => !actual.has(name));
  const unexpectedNames = [...actual].filter((name) => !expected.includes(name));

  if (duplicateNames.length > 0) failures.push(`${label}: duplicate ${duplicateNames.join(", ")}`);
  if (missingNames.length > 0) failures.push(`${label}: missing ${missingNames.join(", ")}`);
  if (unexpectedNames.length > 0) failures.push(`${label}: unexpected ${unexpectedNames.join(", ")}`);
}
