#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const evidencePath = path.resolve(
  root,
  process.argv[2] ?? "docs/evidence/stability-ci-2026-09-20.json",
);
const artifactDirectory = process.argv[3] ? path.resolve(root, process.argv[3]) : null;
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const budgets = JSON.parse(readFileSync(path.join(root, "scripts", "stability-budgets.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const failures = [];

if (evidence.schemaVersion !== 1 || evidence.kind !== "github-actions-stability") {
  failures.push("invalid remote stability evidence schema or kind");
}
if (evidence.packageVersion !== packageJson.version) failures.push("remote evidence package version mismatch");
if (evidence.budgetsVersion !== budgets.version) failures.push("remote evidence budget version mismatch");
if (!/^[a-f0-9]{40}$/.test(evidence.sourceSha ?? "")) failures.push("remote evidence source SHA is invalid");

const workflow = evidence.workflow;
const startedAt = Date.parse(workflow?.startedAt);
const completedAt = Date.parse(workflow?.completedAt);
if (!Number.isInteger(workflow?.runId)
  || !Number.isInteger(workflow?.jobId)
  || !/^https:\/\/github\.com\//.test(workflow?.runUrl ?? "")
  || workflow?.event !== "workflow_dispatch"
  || workflow?.conclusion !== "success"
  || !Number.isFinite(startedAt)
  || !Number.isFinite(completedAt)
  || completedAt < startedAt
  || workflow?.durationSeconds !== (completedAt - startedAt) / 1000) {
  failures.push("remote stability workflow identity or successful duration is invalid");
}
if (!/^\d+\.\d+\.\d+$/.test(evidence.environment?.node ?? "")
  || evidence.environment?.platform !== "linux-x64"
  || evidence.environment?.forcedGc !== true
  || evidence.environment?.wasmAvailable !== true) {
  failures.push("remote stability environment is incomplete");
}

const artifact = evidence.artifact;
if (!Number.isInteger(artifact?.id)
  || artifact?.name !== `brass-stability-${workflow?.runId}`
  || !Number.isInteger(artifact?.sizeBytes)
  || artifact.sizeBytes < 1
  || Date.parse(artifact?.expiresAt) <= completedAt) {
  failures.push("retained stability artifact metadata is invalid");
}
for (const fileName of ["runtime-soak.json", "http-soak.json", "adaptive-soak.json"]) {
  const record = artifact?.files?.[fileName];
  if (!Number.isInteger(record?.bytes) || record.bytes < 1 || !/^[a-f0-9]{64}$/.test(record?.sha256 ?? "")) {
    failures.push(`${fileName} retained artifact identity is invalid`);
    continue;
  }
  if (artifactDirectory) {
    const filePath = path.join(artifactDirectory, fileName);
    if (!existsSync(filePath)) {
      failures.push(`${fileName} is missing from the supplied artifact directory`);
      continue;
    }
    const contents = readFileSync(filePath);
    if (contents.byteLength !== record.bytes) failures.push(`${fileName} byte count does not match evidence`);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    if (sha256 !== record.sha256) failures.push(`${fileName} sha256 does not match evidence`);
  }
}

if (evidence.conformance?.command !== "npm run test:stability" || evidence.conformance?.result !== "passed") {
  failures.push("semantic conformance and fault corpus must pass");
}
if (evidence.runtime?.rounds !== budgets.runtime.rounds
  || evidence.runtime?.iterationsPerRound !== budgets.runtime.iterations
  || evidence.runtime?.chainDepth !== budgets.runtime.chainDepth
  || evidence.runtime?.heapTrendMb > budgets.runtime.maxHeapTrendMb
  || evidence.runtime?.totalHeapDeltaMb > budgets.runtime.maxTotalHeapDeltaMb
  || evidence.runtime?.passed !== true) {
  failures.push("remote runtime soak does not satisfy the versioned budget");
}
if (evidence.http?.calls !== budgets.http.calls
  || evidence.http?.concurrency !== budgets.http.concurrency
  || evidence.http?.delayMs !== budgets.http.delayMs
  || evidence.http?.successes !== budgets.http.calls
  || evidence.http?.errors > budgets.http.maxErrors
  || evidence.http?.heapDeltaMb > budgets.http.maxHeapDeltaMb
  || evidence.http?.adaptiveFinalLimit < budgets.http.minAdaptiveFinalLimit
  || evidence.http?.adaptiveMaxInFlight < budgets.http.minAdaptiveServerInFlight
  || !Number.isFinite(evidence.http?.throughputPerSecond)
  || evidence.http.throughputPerSecond <= 0
  || evidence.http?.passed !== true) {
  failures.push("remote HTTP soak does not satisfy the versioned budget");
}

const adaptiveResults = evidence.adaptive?.results;
if (evidence.adaptive?.samplesPerScenario !== budgets.adaptive.samples
  || evidence.adaptive?.keyCount !== budgets.adaptive.keyCount
  || evidence.adaptive?.passed !== true
  || !Array.isArray(adaptiveResults)) {
  failures.push("remote adaptive soak has invalid configuration");
} else {
  for (const scenario of budgets.adaptive.scenarios) {
    const result = adaptiveResults.find((entry) => entry?.scenario === scenario);
    if (!result
      || result.stateCount > budgets.adaptive.keyCount
      || result.finalLimit < 1
      || result.limitChanges < budgets.adaptive.minLimitChanges
      || result.samplesPerSecond < budgets.adaptive.minSamplesPerSecond) {
      failures.push(`${scenario} remote adaptive evidence does not satisfy the versioned budget`);
    }
  }
}

if (!Array.isArray(evidence.limitations) || evidence.limitations.length < 3) {
  failures.push("at least three remote stability evidence limitations are required");
}
if (!Array.isArray(evidence.reproduce) || evidence.reproduce.length !== 3) {
  failures.push("remote stability evidence requires view, download, and hash commands");
}

if (failures.length > 0) {
  console.error("Remote stability evidence validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Remote stability evidence validated (run ${workflow.runId}, ${evidence.runtime.rounds} runtime rounds, ` +
    `${evidence.http.calls} HTTP calls, ${evidence.adaptive.samplesPerScenario} samples/scenario, ` +
    `artifact checked: ${artifactDirectory ? "yes" : "no"}).`,
  );
}
