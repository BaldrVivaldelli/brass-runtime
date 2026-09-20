#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const reportDirectory = path.resolve(root, process.argv[2] ?? "artifacts/stability");
const outputPath = path.resolve(
  root,
  process.argv[3] ?? path.join(reportDirectory, "stability-run-manifest.json"),
);
const budgets = readJson(path.join(root, "scripts", "stability-budgets.json"), "stability budgets");
const failures = [];

const runtime = readReport("runtime-soak.json");
const http = readReport("http-soak.json");
const adaptive = readReport("adaptive-soak.json");
const recordedAt = process.env.BRASS_STABILITY_RECORDED_AT ?? new Date().toISOString();
const runId = positiveInteger(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
const runAttempt = positiveInteger(process.env.GITHUB_RUN_ATTEMPT, "GITHUB_RUN_ATTEMPT");
const runNumber = positiveInteger(process.env.GITHUB_RUN_NUMBER, "GITHUB_RUN_NUMBER");
const sourceSha = process.env.GITHUB_SHA ?? "";
const repository = process.env.GITHUB_REPOSITORY ?? "";
const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
const event = process.env.GITHUB_EVENT_NAME ?? "";
const ref = process.env.GITHUB_REF ?? "";

if (!Number.isFinite(Date.parse(recordedAt))) failures.push("recordedAt must be an ISO-compatible timestamp");
if (!/^[a-f0-9]{40}$/.test(sourceSha)) failures.push("GITHUB_SHA must be a full commit SHA");
if (!/^[^/]+\/[^/]+$/.test(repository)) failures.push("GITHUB_REPOSITORY must identify owner/repository");
if (!/^refs\/heads\//.test(ref)) failures.push("GITHUB_REF must identify a branch");
if (!["schedule", "workflow_dispatch"].includes(event)) {
  failures.push("GITHUB_EVENT_NAME must be schedule or workflow_dispatch");
}

const runtimeSummary = summarizeRuntime(runtime?.json);
const httpSummary = summarizeHttp(http?.json);
const adaptiveSummary = summarizeAdaptive(adaptive?.json);
const nodeVersion = normalizedNodeVersion(http?.json?.nodeVersion);
const platform = http?.json?.platform;

if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) failures.push("HTTP report must contain an exact Node version");
if (adaptive?.json?.nodeVersion !== http?.json?.nodeVersion || adaptive?.json?.platform !== platform) {
  failures.push("HTTP and adaptive reports must use the same Node version and platform");
}
if (platform !== "linux-x64") failures.push("stability trend reports must use linux-x64");
if (http?.json?.capabilities?.wasmAvailable !== true || adaptive?.json?.capabilities?.wasmAvailable !== true) {
  failures.push("stability trend reports require the WASM engine");
}

if (failures.length > 0) {
  console.error("Stability run manifest creation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const manifest = {
  schemaVersion: 1,
  kind: "github-actions-stability-run",
  recordedAt: new Date(recordedAt).toISOString(),
  budgetsVersion: budgets.version,
  source: {
    repository,
    sha: sourceSha,
    ref,
  },
  workflow: {
    name: process.env.GITHUB_WORKFLOW ?? "Stability",
    job: process.env.GITHUB_JOB ?? "conformance-fault-and-soak",
    event,
    scheduled: event === "schedule",
    runId,
    runAttempt,
    runNumber,
    runUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
    conformance: {
      command: "npm run test:stability",
      passed: true,
    },
  },
  environment: {
    runner: process.env.RUNNER_NAME ?? "GitHub Actions",
    node: nodeVersion,
    platform,
    forcedGc: true,
    wasmAvailable: true,
  },
  reports: {
    runtime: { ...runtime.identity, ...runtimeSummary },
    http: { ...http.identity, ...httpSummary },
    adaptive: { ...adaptive.identity, ...adaptiveSummary },
  },
  decision: "stability-gates-passed",
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  `Stability run manifest created (${manifest.workflow.event} run ${manifest.workflow.runId}, ` +
  `${runtimeSummary.rounds} runtime rounds, ${httpSummary.calls} HTTP calls, ` +
  `${adaptiveSummary.samplesPerScenario} adaptive samples/scenario).`,
);

function readReport(file) {
  const filePath = path.join(reportDirectory, file);
  try {
    const contents = readFileSync(filePath);
    return {
      json: JSON.parse(contents.toString("utf8")),
      identity: {
        file,
        bytes: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex"),
      },
    };
  } catch (error) {
    failures.push(`${file} cannot be read as JSON: ${error.message}`);
    return null;
  }
}

function summarizeRuntime(report) {
  const rounds = report?.rounds ?? [];
  const aggregateOps = rounds.map((round) => aggregateOpsPerSecond(round?.report));
  const iterations = new Set(rounds.map((round) => round?.report?.iterations));
  const chainDepths = new Set(rounds.map((round) => round?.report?.chainDepth));
  const minAggregateOpsPerSecond = Math.min(...aggregateOps);
  const totalHeapDeltaMb = report?.memory?.delta?.heapUsedMb;
  const totalRssDeltaMb = report?.memory?.delta?.rssMb;

  if (rounds.length !== budgets.runtime.rounds
    || iterations.size !== 1
    || !iterations.has(budgets.runtime.iterations)
    || chainDepths.size !== 1
    || !chainDepths.has(budgets.runtime.chainDepth)
    || !Number.isFinite(minAggregateOpsPerSecond)
    || minAggregateOpsPerSecond < budgets.runtime.minAggregateOpsPerSecond
    || !Number.isFinite(report?.heapTrendMb)
    || report.heapTrendMb > budgets.runtime.maxHeapTrendMb
    || !Number.isFinite(totalHeapDeltaMb)
    || totalHeapDeltaMb > budgets.runtime.maxTotalHeapDeltaMb
    || !Number.isFinite(totalRssDeltaMb)
    || !Number.isFinite(report?.throughputTrendPercent)) {
    failures.push("runtime report does not satisfy the versioned stability budget");
  }

  return {
    rounds: rounds.length,
    iterationsPerRound: budgets.runtime.iterations,
    chainDepth: budgets.runtime.chainDepth,
    minAggregateOpsPerSecond: roundTo(minAggregateOpsPerSecond),
    heapTrendMb: report?.heapTrendMb,
    totalHeapDeltaMb,
    totalRssDeltaMb,
    throughputTrendPercent: report?.throughputTrendPercent,
    passed: true,
  };
}

function summarizeHttp(report) {
  const results = report?.suites?.flatMap((suite) => suite.results ?? []) ?? [];
  const result = results.find((candidate) => candidate?.details?.mode === "soak");
  const details = result?.details ?? {};
  const throughputPerSecond = result?.throughput?.perSecond;

  if (!result
    || details.calls !== budgets.http.calls
    || details.warmupCalls !== budgets.http.warmupCalls
    || details.concurrency !== budgets.http.concurrency
    || details.delayMs !== budgets.http.delayMs
    || details.successCount !== budgets.http.calls
    || !Number.isInteger(details.errorCount)
    || details.errorCount > budgets.http.maxErrors
    || !Number.isFinite(details.heapDeltaMb)
    || details.heapDeltaMb > budgets.http.maxHeapDeltaMb
    || !Number.isFinite(details.adaptiveFinalLimit)
    || details.adaptiveFinalLimit < budgets.http.minAdaptiveFinalLimit
    || !Number.isFinite(details.adaptiveMaxInFlight)
    || details.adaptiveMaxInFlight < budgets.http.minAdaptiveServerInFlight
    || !Number.isFinite(throughputPerSecond)
    || throughputPerSecond <= 0
    || !Number.isFinite(details.requestP50Ms)
    || !Number.isFinite(details.requestP95Ms)
    || !Number.isFinite(details.requestP99Ms)
    || !Number.isFinite(details.rssDeltaMb)
    || !Number.isInteger(details.observedFinishedSpans)
    || details.observedFinishedSpans < 1) {
    failures.push("HTTP report does not satisfy the versioned stability budget");
  }

  return {
    calls: details.calls,
    warmupCalls: details.warmupCalls,
    concurrency: details.concurrency,
    delayMs: details.delayMs,
    successes: details.successCount,
    errors: details.errorCount,
    throughputPerSecond: roundTo(throughputPerSecond),
    requestP50Ms: details.requestP50Ms,
    requestP95Ms: details.requestP95Ms,
    requestP99Ms: details.requestP99Ms,
    heapDeltaMb: details.heapDeltaMb,
    rssDeltaMb: details.rssDeltaMb,
    adaptiveFinalLimit: details.adaptiveFinalLimit,
    adaptiveMaxInFlight: details.adaptiveMaxInFlight,
    observedFinishedSpans: details.observedFinishedSpans,
    passed: true,
  };
}

function summarizeAdaptive(report) {
  const results = report?.suites?.flatMap((suite) => suite.results ?? []) ?? [];
  const summaries = [];

  for (const scenario of budgets.adaptive.scenarios) {
    const result = results.find((candidate) => candidate?.details?.scenario === scenario);
    const details = result?.details ?? {};
    const samplesPerSecond = result?.throughput?.perSecond;
    if (!result
      || details.samples !== budgets.adaptive.samples
      || details.keyCount !== budgets.adaptive.keyCount
      || !Number.isInteger(details.stateCount)
      || details.stateCount > budgets.adaptive.keyCount
      || !Number.isFinite(details.finalLimit)
      || details.finalLimit < 1
      || !Number.isInteger(details.limitChanges)
      || details.limitChanges < budgets.adaptive.minLimitChanges
      || !Number.isFinite(samplesPerSecond)
      || samplesPerSecond < budgets.adaptive.minSamplesPerSecond) {
      failures.push(`${scenario} adaptive report does not satisfy the versioned stability budget`);
    }
    summaries.push({
      scenario,
      stateCount: details.stateCount,
      finalLimit: details.finalLimit,
      limitChanges: details.limitChanges,
      p50: details.p50,
      p99: details.p99,
      samplesPerSecond: roundTo(samplesPerSecond),
    });
  }

  return {
    samplesPerScenario: budgets.adaptive.samples,
    keyCount: budgets.adaptive.keyCount,
    results: summaries,
    passed: true,
  };
}

function aggregateOpsPerSecond(report) {
  const results = report?.results ?? [];
  const units = results.reduce((sum, result) => sum + Number(result?.units ?? 0), 0);
  const durationMs = results.reduce((sum, result) => sum + Number(result?.durationMs ?? 0), 0);
  return units / Math.max(durationMs / 1000, 0.001);
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) failures.push(`${name} must be a positive integer`);
  return parsed;
}

function normalizedNodeVersion(value) {
  return typeof value === "string" ? value.replace(/^v/, "") : "";
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`Could not read ${label}: ${error.message}`);
    process.exit(1);
  }
}

function roundTo(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
