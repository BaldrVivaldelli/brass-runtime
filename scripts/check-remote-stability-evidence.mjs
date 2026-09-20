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
const artifactTarget = process.argv[4] ?? "primary";
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
const budgets = JSON.parse(readFileSync(path.join(root, "scripts", "stability-budgets.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const failures = [];

if (evidence.schemaVersion !== 2 || evidence.kind !== "github-actions-stability") {
  failures.push("invalid remote stability evidence schema or kind");
}
if (evidence.packageVersion !== packageJson.version) failures.push("remote evidence package version mismatch");
if (evidence.budgetsVersion !== budgets.version) failures.push("remote evidence budget version mismatch");
if (artifactDirectory && !["primary", "repeat"].includes(artifactTarget)) {
  failures.push("artifact target must be primary or repeat");
}

validateSnapshot("primary", evidence, artifactTarget === "primary" ? artifactDirectory : null);
validateSnapshot("repeat", evidence.repeatValidation, artifactTarget === "repeat" ? artifactDirectory : null);

const comparison = evidence.comparison;
if (comparison?.runCount !== 2
  || comparison?.distinctSourceShas !== 2
  || comparison?.relationship !== "same-day-repeat-after-maintenance"
  || comparison?.allBudgetsPassed !== true
  || comparison?.weeklyTrendEstablished !== false
  || !comparison?.claimBoundary?.includes("do not establish a weekly trend")
  || evidence.workflow?.runId === evidence.repeatValidation?.workflow?.runId
  || evidence.sourceSha === evidence.repeatValidation?.sourceSha
  || Date.parse(evidence.repeatValidation?.recordedAt) <= Date.parse(evidence.recordedAt)) {
  failures.push("two-run comparison or weekly-trend claim boundary is invalid");
}
if (evidence.decision !== "two-retained-ci-stability-gates-passed"
  || evidence.repeatValidation?.decision !== "retained-ci-repeat-passed") {
  failures.push("two-run remote stability decision is incomplete");
}
if (!Array.isArray(evidence.limitations) || evidence.limitations.length < 3) {
  failures.push("at least three remote stability evidence limitations are required");
}
if (!Array.isArray(evidence.reproduce) || evidence.reproduce.length !== 6) {
  failures.push("remote stability evidence requires view, download, and hash commands for both runs");
}

if (failures.length > 0) {
  console.error("Remote stability evidence validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Remote stability evidence validated (runs ${evidence.workflow.runId} and ` +
    `${evidence.repeatValidation.workflow.runId}, ${evidence.runtime.rounds} runtime rounds each, ` +
    `${evidence.http.calls} HTTP calls each, ${evidence.adaptive.samplesPerScenario} samples/scenario, ` +
    `artifact checked: ${artifactDirectory ? artifactTarget : "no"}, weekly trend: not yet).`,
  );
}

function validateSnapshot(label, snapshot, suppliedArtifactDirectory) {
  if (!snapshot || !/^[a-f0-9]{40}$/.test(snapshot.sourceSha ?? "")) {
    failures.push(`${label} remote evidence source SHA is invalid`);
    return;
  }

  const workflow = snapshot.workflow;
  const startedAt = Date.parse(workflow?.startedAt);
  const completedAt = Date.parse(workflow?.completedAt);
  if (!Number.isFinite(Date.parse(snapshot.recordedAt))
    || Date.parse(snapshot.recordedAt) < completedAt
    || !Number.isInteger(workflow?.runId)
    || !Number.isInteger(workflow?.jobId)
    || workflow?.runUrl !== `https://github.com/BaldrVivaldelli/brass-runtime/actions/runs/${workflow?.runId}`
    || workflow?.event !== "workflow_dispatch"
    || workflow?.conclusion !== "success"
    || !Number.isFinite(startedAt)
    || !Number.isFinite(completedAt)
    || completedAt < startedAt
    || workflow?.durationSeconds !== (completedAt - startedAt) / 1000) {
    failures.push(`${label} remote stability workflow identity or successful duration is invalid`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(snapshot.environment?.node ?? "")
    || snapshot.environment?.runner !== "ubuntu-latest"
    || snapshot.environment?.platform !== "linux-x64"
    || snapshot.environment?.forcedGc !== true
    || snapshot.environment?.wasmAvailable !== true) {
    failures.push(`${label} remote stability environment is incomplete`);
  }

  const artifact = snapshot.artifact;
  if (!Number.isInteger(artifact?.id)
    || artifact?.name !== `brass-stability-${workflow?.runId}`
    || !Number.isInteger(artifact?.sizeBytes)
    || artifact.sizeBytes < 1
    || Date.parse(artifact?.expiresAt) <= completedAt
    || (label === "repeat" && !/^sha256:[a-f0-9]{64}$/.test(artifact?.archiveDigest ?? ""))) {
    failures.push(`${label} retained stability artifact metadata is invalid`);
  }
  for (const fileName of ["runtime-soak.json", "http-soak.json", "adaptive-soak.json"]) {
    const record = artifact?.files?.[fileName];
    if (!Number.isInteger(record?.bytes) || record.bytes < 1 || !/^[a-f0-9]{64}$/.test(record?.sha256 ?? "")) {
      failures.push(`${label} ${fileName} retained artifact identity is invalid`);
      continue;
    }
    if (suppliedArtifactDirectory) {
      const filePath = path.join(suppliedArtifactDirectory, fileName);
      if (!existsSync(filePath)) {
        failures.push(`${label} ${fileName} is missing from the supplied artifact directory`);
        continue;
      }
      const contents = readFileSync(filePath);
      if (contents.byteLength !== record.bytes) failures.push(`${label} ${fileName} byte count does not match evidence`);
      const sha256 = createHash("sha256").update(contents).digest("hex");
      if (sha256 !== record.sha256) failures.push(`${label} ${fileName} sha256 does not match evidence`);
    }
  }

  if (snapshot.conformance?.command !== "npm run test:stability" || snapshot.conformance?.result !== "passed") {
    failures.push(`${label} semantic conformance and fault corpus must pass`);
  }
  if (snapshot.runtime?.rounds !== budgets.runtime.rounds
    || snapshot.runtime?.iterationsPerRound !== budgets.runtime.iterations
    || snapshot.runtime?.chainDepth !== budgets.runtime.chainDepth
    || snapshot.runtime?.heapTrendMb > budgets.runtime.maxHeapTrendMb
    || snapshot.runtime?.totalHeapDeltaMb > budgets.runtime.maxTotalHeapDeltaMb
    || snapshot.runtime?.passed !== true) {
    failures.push(`${label} remote runtime soak does not satisfy the versioned budget`);
  }
  if (snapshot.http?.calls !== budgets.http.calls
    || snapshot.http?.concurrency !== budgets.http.concurrency
    || snapshot.http?.delayMs !== budgets.http.delayMs
    || snapshot.http?.successes !== budgets.http.calls
    || snapshot.http?.errors > budgets.http.maxErrors
    || snapshot.http?.heapDeltaMb > budgets.http.maxHeapDeltaMb
    || snapshot.http?.adaptiveFinalLimit < budgets.http.minAdaptiveFinalLimit
    || snapshot.http?.adaptiveMaxInFlight < budgets.http.minAdaptiveServerInFlight
    || !Number.isFinite(snapshot.http?.throughputPerSecond)
    || snapshot.http.throughputPerSecond <= 0
    || snapshot.http?.passed !== true) {
    failures.push(`${label} remote HTTP soak does not satisfy the versioned budget`);
  }

  const adaptiveResults = snapshot.adaptive?.results;
  if (snapshot.adaptive?.samplesPerScenario !== budgets.adaptive.samples
    || snapshot.adaptive?.keyCount !== budgets.adaptive.keyCount
    || snapshot.adaptive?.passed !== true
    || !Array.isArray(adaptiveResults)) {
    failures.push(`${label} remote adaptive soak has invalid configuration`);
  } else {
    for (const scenario of budgets.adaptive.scenarios) {
      const result = adaptiveResults.find((entry) => entry?.scenario === scenario);
      if (!result
        || result.stateCount > budgets.adaptive.keyCount
        || result.finalLimit < 1
        || result.limitChanges < budgets.adaptive.minLimitChanges
        || result.samplesPerSecond < budgets.adaptive.minSamplesPerSecond) {
        failures.push(`${label} ${scenario} remote adaptive evidence does not satisfy the versioned budget`);
      }
    }
  }
}
