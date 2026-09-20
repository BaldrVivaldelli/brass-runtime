#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const inputs = process.argv.slice(2);
const targets = inputs.length > 0 ? inputs : ["artifacts/stability-history"];
const manifestPaths = [...new Set(targets.flatMap((target) => findManifests(path.resolve(root, target))))].sort();
const budgets = JSON.parse(readFileSync(path.join(root, "scripts", "stability-budgets.json"), "utf8"));
const failures = [];
const records = manifestPaths.map(readManifest).filter(Boolean).sort((a, b) => a.time - b.time);
const minimumRuns = 4;
const minimumSpanDays = 21;

if (records.length < minimumRuns) failures.push(`weekly trend requires at least ${minimumRuns} retained manifests`);

const runIds = new Set();
for (const record of records) validateRecord(record, runIds);

const intervalsDays = [];
for (let index = 1; index < records.length; index += 1) {
  const intervalDays = (records[index].time - records[index - 1].time) / 86_400_000;
  intervalsDays.push(roundTo(intervalDays));
  if (intervalDays < 5 || intervalDays > 10) {
    failures.push(
      `runs ${records[index - 1].manifest.workflow.runId} and ` +
      `${records[index].manifest.workflow.runId} are not consecutive weekly samples`,
    );
  }
}

const spanDays = records.length > 1 ? (records.at(-1).time - records[0].time) / 86_400_000 : 0;
if (spanDays < minimumSpanDays) {
  failures.push(`weekly trend span ${roundTo(spanDays)} days is below ${minimumSpanDays} days`);
}

const nodeMajors = new Set(records.map(({ manifest }) => manifest.environment?.node?.split(".")[0]));
const platforms = new Set(records.map(({ manifest }) => manifest.environment?.platform));
if (nodeMajors.size > 1 || platforms.size > 1) {
  failures.push("weekly trend samples must use one Node major and platform");
}

if (failures.length > 0) {
  console.error("Stability trend validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const first = records[0].manifest;
const last = records.at(-1).manifest;
const summary = {
  schemaVersion: 1,
  kind: "github-actions-stability-trend",
  generatedAt: new Date().toISOString(),
  budgetsVersion: budgets.version,
  runCount: records.length,
  firstRunId: first.workflow.runId,
  lastRunId: last.workflow.runId,
  firstRecordedAt: first.recordedAt,
  lastRecordedAt: last.recordedAt,
  spanDays: roundTo(spanDays),
  intervalsDays,
  distinctSourceShas: new Set(records.map(({ manifest }) => manifest.source.sha)).size,
  environment: {
    nodeMajor: Number([...nodeMajors][0]),
    platform: [...platforms][0],
  },
  change: {
    runtimeHeapTrendMb: metricChange(first.reports.runtime.heapTrendMb, last.reports.runtime.heapTrendMb),
    runtimeTotalHeapDeltaMb: metricChange(
      first.reports.runtime.totalHeapDeltaMb,
      last.reports.runtime.totalHeapDeltaMb,
    ),
    httpThroughputPerSecond: metricChange(
      first.reports.http.throughputPerSecond,
      last.reports.http.throughputPerSecond,
    ),
    httpRequestP95Ms: metricChange(first.reports.http.requestP95Ms, last.reports.http.requestP95Ms),
    httpHeapDeltaMb: metricChange(first.reports.http.heapDeltaMb, last.reports.http.heapDeltaMb),
  },
  decision: "weekly-stability-trend-established",
  claimBoundary: "This trend covers controlled GitHub-hosted stability workloads, not external production behavior.",
};

const outputPath = process.env.BRASS_STABILITY_TREND_REPORT_PATH;
if (outputPath) {
  const resolvedOutputPath = path.resolve(root, outputPath);
  mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  writeFileSync(resolvedOutputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

console.log(
  `Weekly stability trend validated (${summary.runCount} scheduled runs, ${summary.spanDays} days, ` +
  `${summary.distinctSourceShas} source SHAs, Node ${summary.environment.nodeMajor}, ${summary.environment.platform}).`,
);

function findManifests(target) {
  if (!existsSync(target)) return [];
  if (statSync(target).isFile()) return [target];
  const found = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const candidate = path.join(target, entry.name);
    if (entry.isDirectory()) found.push(...findManifests(candidate));
    else if (entry.isFile() && entry.name === "stability-run-manifest.json") found.push(candidate);
  }
  return found;
}

function readManifest(manifestPath) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return { manifest, manifestPath, time: Date.parse(manifest.recordedAt) };
  } catch (error) {
    failures.push(`${manifestPath} cannot be read as a manifest: ${error.message}`);
    return null;
  }
}

function validateRecord(record, runIds) {
  const { manifest, manifestPath, time } = record;
  const runId = manifest.workflow?.runId;
  if (manifest.schemaVersion !== 1
    || manifest.kind !== "github-actions-stability-run"
    || manifest.budgetsVersion !== budgets.version
    || !Number.isFinite(time)) {
    failures.push(`${manifestPath} has an incompatible schema, budget, or timestamp`);
  }
  if (manifest.workflow?.event !== "schedule"
    || manifest.workflow?.scheduled !== true
    || manifest.workflow?.conformance?.passed !== true
    || manifest.workflow?.name !== "Stability"
    || manifest.workflow?.job !== "conformance-fault-and-soak"
    || manifest.decision !== "stability-gates-passed") {
    failures.push(`${manifestPath} is not a successful scheduled stability run`);
  }
  if (!Number.isInteger(runId) || runIds.has(runId)) failures.push(`${manifestPath} has a missing or duplicate run ID`);
  runIds.add(runId);
  if (!/^[a-f0-9]{40}$/.test(manifest.source?.sha ?? "")
    || !/^[^/]+\/[^/]+$/.test(manifest.source?.repository ?? "")
    || manifest.source?.ref !== "refs/heads/main"
    || manifest.workflow?.runUrl !== `https://github.com/${manifest.source?.repository}/actions/runs/${runId}`
    || !Number.isInteger(manifest.workflow?.runAttempt)
    || manifest.workflow.runAttempt < 1
    || !Number.isInteger(manifest.workflow?.runNumber)
    || manifest.workflow.runNumber < 1) {
    failures.push(`${manifestPath} has an invalid source or workflow identity`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.environment?.node ?? "")
    || manifest.environment?.platform !== "linux-x64"
    || manifest.environment?.forcedGc !== true
    || manifest.environment?.wasmAvailable !== true) {
    failures.push(`${manifestPath} has an incompatible execution environment`);
  }

  for (const section of ["runtime", "http", "adaptive"]) {
    const report = manifest.reports?.[section];
    const reportPath = path.join(path.dirname(manifestPath), report?.file ?? "");
    if (report?.file !== `${section}-soak.json`
      || report?.passed !== true
      || !Number.isInteger(report?.bytes)
      || report.bytes < 1
      || !/^[a-f0-9]{64}$/.test(report?.sha256 ?? "")
      || !existsSync(reportPath)) {
      failures.push(`${manifestPath} has incomplete ${section} report identity`);
      continue;
    }
    const contents = readFileSync(reportPath);
    if (contents.byteLength !== report.bytes
      || createHash("sha256").update(contents).digest("hex") !== report.sha256) {
      failures.push(`${manifestPath} does not match its ${section} raw report`);
      continue;
    }
    try {
      if (!reportMatchesManifest(section, JSON.parse(contents.toString("utf8")), report)) {
        failures.push(`${manifestPath} ${section} metrics do not match its raw report`);
      }
    } catch (error) {
      failures.push(`${manifestPath} ${section} raw report is invalid JSON: ${error.message}`);
    }
  }

  if (manifest.reports?.runtime?.rounds !== budgets.runtime.rounds
    || !Number.isFinite(manifest.reports?.runtime?.heapTrendMb)
    || manifest.reports?.runtime?.heapTrendMb > budgets.runtime.maxHeapTrendMb
    || !Number.isFinite(manifest.reports?.runtime?.totalHeapDeltaMb)
    || manifest.reports?.runtime?.totalHeapDeltaMb > budgets.runtime.maxTotalHeapDeltaMb
    || manifest.reports?.http?.calls !== budgets.http.calls
    || !Number.isFinite(manifest.reports?.http?.throughputPerSecond)
    || !Number.isFinite(manifest.reports?.http?.requestP95Ms)
    || manifest.reports?.http?.errors > budgets.http.maxErrors
    || !Number.isFinite(manifest.reports?.http?.heapDeltaMb)
    || manifest.reports?.http?.heapDeltaMb > budgets.http.maxHeapDeltaMb
    || manifest.reports?.adaptive?.samplesPerScenario !== budgets.adaptive.samples
    || !adaptiveScenariosComplete(manifest.reports?.adaptive?.results)) {
    failures.push(`${manifestPath} does not satisfy the current stability budgets`);
  }
}

function reportMatchesManifest(section, raw, report) {
  if (section === "runtime") {
    const rounds = raw?.rounds ?? [];
    const aggregates = rounds.map((round) => aggregateOpsPerSecond(round?.report));
    return report.rounds === rounds.length
      && report.iterationsPerRound === budgets.runtime.iterations
      && report.chainDepth === budgets.runtime.chainDepth
      && rounds.every((round) => round?.report?.iterations === report.iterationsPerRound)
      && rounds.every((round) => round?.report?.chainDepth === report.chainDepth)
      && report.minAggregateOpsPerSecond === roundTo(Math.min(...aggregates))
      && report.heapTrendMb === raw?.heapTrendMb
      && report.totalHeapDeltaMb === raw?.memory?.delta?.heapUsedMb
      && report.totalRssDeltaMb === raw?.memory?.delta?.rssMb
      && report.throughputTrendPercent === raw?.throughputTrendPercent;
  }

  if (section === "http") {
    const result = raw?.suites?.flatMap((suite) => suite.results ?? [])
      .find((candidate) => candidate?.details?.mode === "soak");
    const details = result?.details ?? {};
    return report.calls === details.calls
      && report.warmupCalls === details.warmupCalls
      && report.concurrency === details.concurrency
      && report.delayMs === details.delayMs
      && report.successes === details.successCount
      && report.errors === details.errorCount
      && report.throughputPerSecond === roundTo(result?.throughput?.perSecond)
      && report.requestP50Ms === details.requestP50Ms
      && report.requestP95Ms === details.requestP95Ms
      && report.requestP99Ms === details.requestP99Ms
      && report.heapDeltaMb === details.heapDeltaMb
      && report.rssDeltaMb === details.rssDeltaMb
      && report.adaptiveFinalLimit === details.adaptiveFinalLimit
      && report.adaptiveMaxInFlight === details.adaptiveMaxInFlight
      && report.observedFinishedSpans === details.observedFinishedSpans;
  }

  if (section === "adaptive") {
    const results = raw?.suites?.flatMap((suite) => suite.results ?? []) ?? [];
    return report.samplesPerScenario === budgets.adaptive.samples
      && report.keyCount === budgets.adaptive.keyCount
      && budgets.adaptive.scenarios.every((scenario) => {
        const rawResult = results.find((candidate) => candidate?.details?.scenario === scenario);
        const summary = report.results?.find((candidate) => candidate?.scenario === scenario);
        return summary?.stateCount === rawResult?.details?.stateCount
          && summary?.finalLimit === rawResult?.details?.finalLimit
          && summary?.limitChanges === rawResult?.details?.limitChanges
          && summary?.p50 === rawResult?.details?.p50
          && summary?.p99 === rawResult?.details?.p99
          && summary?.samplesPerSecond === roundTo(rawResult?.throughput?.perSecond);
      });
  }

  return false;
}

function aggregateOpsPerSecond(report) {
  const results = report?.results ?? [];
  const units = results.reduce((sum, result) => sum + Number(result?.units ?? 0), 0);
  const durationMs = results.reduce((sum, result) => sum + Number(result?.durationMs ?? 0), 0);
  return units / Math.max(durationMs / 1000, 0.001);
}

function adaptiveScenariosComplete(results) {
  if (!Array.isArray(results)) return false;
  return budgets.adaptive.scenarios.every((scenario) => {
    const result = results.find((candidate) => candidate?.scenario === scenario);
    return Number.isFinite(result?.samplesPerSecond) && result.samplesPerSecond >= budgets.adaptive.minSamplesPerSecond;
  });
}

function metricChange(first, last) {
  return {
    first,
    last,
    absolute: roundTo(last - first),
    percent: first === 0 ? null : roundTo(((last - first) / Math.abs(first)) * 100),
  };
}

function roundTo(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
