import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const manifestCreator = path.join(root, "scripts", "create-stability-run-manifest.mjs");
const trendValidator = path.join(root, "scripts", "check-stability-trend.mjs");
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describe("scheduled stability trend evidence", () => {
  it("creates a self-verifying manifest from passing raw reports", () => {
    const directory = makeDirectory();
    writeReports(directory);

    const result = createManifest(directory, { runId: 101, recordedAt: "2026-09-05T03:05:00Z" });
    const manifest = JSON.parse(readFileSync(path.join(directory, "stability-run-manifest.json"), "utf8"));

    expect(result).toMatchObject({ status: 0 });
    expect(manifest).toMatchObject({
      kind: "github-actions-stability-run",
      budgetsVersion: 1,
      workflow: { event: "schedule", scheduled: true, runId: 101 },
      decision: "stability-gates-passed",
      reports: {
        runtime: { rounds: 10, passed: true },
        http: { calls: 100000, errors: 0, passed: true },
        adaptive: { samplesPerScenario: 100000, passed: true },
      },
    });
    expect(manifest.reports.runtime.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses to summarize a raw report that violates a budget", () => {
    const directory = makeDirectory();
    writeReports(directory, { httpErrors: 1 });

    const result = createManifest(directory, { runId: 102, recordedAt: "2026-09-05T03:05:00Z" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HTTP report does not satisfy");
  });

  it("accepts four consecutive scheduled samples spanning three weeks", () => {
    const history = makeHistory([
      "2026-09-05T03:05:00Z",
      "2026-09-12T03:06:00Z",
      "2026-09-19T03:04:00Z",
      "2026-09-26T03:07:00Z",
    ]);
    const reportPath = path.join(history, "summary", "trend.json");

    const result = validateTrend(history, reportPath);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(result).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("4 scheduled runs, 21.001 days");
    expect(report).toMatchObject({
      kind: "github-actions-stability-trend",
      runCount: 4,
      spanDays: 21.001,
      decision: "weekly-stability-trend-established",
    });
  });

  it("keeps an incomplete but valid scheduled history green while it accumulates", () => {
    const history = makeHistory([
      "2026-09-05T03:05:00Z",
      "2026-09-12T03:06:00Z",
      "2026-09-19T03:04:00Z",
    ]);

    const result = validateTrend(history, undefined, true);

    expect(result).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("pending (3/4 scheduled runs, 13.999/21 days");
  });

  it("still rejects a manual run when incomplete history is allowed", () => {
    const history = makeHistory(["2026-09-05T03:05:00Z"], "workflow_dispatch");

    const result = validateTrend(history, undefined, true);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not a successful scheduled stability run");
  });

  it("does not count manual runs as a weekly trend", () => {
    const history = makeHistory([
      "2026-09-05T03:05:00Z",
      "2026-09-12T03:05:00Z",
      "2026-09-19T03:05:00Z",
      "2026-09-26T03:05:00Z",
    ], "workflow_dispatch");

    const result = validateTrend(history);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not a successful scheduled stability run");
  });

  it("rejects four samples that do not span a weekly history", () => {
    const history = makeHistory([
      "2026-09-20T03:05:00Z",
      "2026-09-21T03:05:00Z",
      "2026-09-22T03:05:00Z",
      "2026-09-23T03:05:00Z",
    ]);

    const result = validateTrend(history);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("below 21 days");
  });

  it("re-hashes every raw report instead of trusting its manifest", () => {
    const history = makeHistory([
      "2026-09-05T03:05:00Z",
      "2026-09-12T03:05:00Z",
      "2026-09-19T03:05:00Z",
      "2026-09-26T03:05:00Z",
    ]);
    appendFileSync(path.join(history, "run-202", "http-soak.json"), "\n", "utf8");

    const result = validateTrend(history);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match its http raw report");
  });

  it("derives trend metrics from the hashed raw reports", () => {
    const history = makeHistory([
      "2026-09-05T03:05:00Z",
      "2026-09-12T03:05:00Z",
      "2026-09-19T03:05:00Z",
      "2026-09-26T03:05:00Z",
    ]);
    const manifestPath = path.join(history, "run-203", "stability-run-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.reports.http.requestP95Ms = 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

    const result = validateTrend(history);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("http metrics do not match its raw report");
  });
});

function makeDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "brass-stability-trend-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeHistory(recordedAtValues, event = "schedule") {
  const history = makeDirectory();
  for (const [index, recordedAt] of recordedAtValues.entries()) {
    const runId = 201 + index;
    const directory = path.join(history, `run-${runId}`);
    writeReports(directory);
    const result = createManifest(directory, { runId, recordedAt, event });
    expect(result).toMatchObject({ status: 0 });
  }
  return history;
}

function createManifest(directory, { runId, recordedAt, event = "schedule" }) {
  return runNode([manifestCreator, directory], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BRASS_STABILITY_RECORDED_AT: recordedAt,
      GITHUB_RUN_ID: String(runId),
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_NUMBER: String(runId),
      GITHUB_SHA: runId.toString(16).padStart(40, "0"),
      GITHUB_REPOSITORY: "BaldrVivaldelli/brass-runtime",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW: "Stability",
      GITHUB_JOB: "conformance-fault-and-soak",
      RUNNER_NAME: "test-runner",
    },
  });
}

function validateTrend(history, reportPath, allowIncomplete = false) {
  return runNode([trendValidator, ...(allowIncomplete ? ["--allow-incomplete"] : []), history], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(reportPath ? { BRASS_STABILITY_TREND_REPORT_PATH: reportPath } : {}),
    },
  });
}

function runNode(args, options) {
  let result;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = spawnSync(process.execPath, args, options);
    if (result.status !== 1 || result.stdout !== "" || result.stderr !== "") return result;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return result;
}

function writeReports(directory, { httpErrors = 0 } = {}) {
  mkdirSync(directory, { recursive: true });
  const runtime = {
    variant: "default",
    heapTrendMb: 0.5,
    throughputTrendPercent: 2,
    memory: { delta: { heapUsedMb: 1, rssMb: 2 } },
    rounds: Array.from({ length: 10 }, (_, index) => ({
      round: index + 1,
      report: {
        iterations: 5000,
        chainDepth: 100,
        results: [{ units: 25000, durationMs: 100 }],
      },
    })),
  };
  const http = {
    nodeVersion: "v22.23.2",
    platform: "linux-x64",
    capabilities: { wasmAvailable: true },
    suites: [{
      results: [{
        details: {
          mode: "soak",
          calls: 100000,
          warmupCalls: 5000,
          concurrency: 128,
          delayMs: 1,
          successCount: 100000 - httpErrors,
          errorCount: httpErrors,
          heapDeltaMb: 4,
          rssDeltaMb: 16,
          requestP50Ms: 10,
          requestP95Ms: 20,
          requestP99Ms: 30,
          adaptiveFinalLimit: 64,
          adaptiveMaxInFlight: 32,
          observedFinishedSpans: 10000,
        },
        throughput: { perSecond: 1200 },
      }],
    }],
  };
  const adaptive = {
    nodeVersion: "v22.23.2",
    platform: "linux-x64",
    capabilities: { wasmAvailable: true },
    suites: [{
      results: ["stable", "saturation-recovery"].map((scenario) => ({
        details: {
          scenario,
          samples: 100000,
          keyCount: 64,
          stateCount: 64,
          finalLimit: 64,
          limitChanges: 10,
          p50: 10,
          p99: 20,
        },
        throughput: { perSecond: 10000 },
      })),
    }],
  };

  writeFileSync(path.join(directory, "runtime-soak.json"), JSON.stringify(runtime), "utf8");
  writeFileSync(path.join(directory, "http-soak.json"), JSON.stringify(http), "utf8");
  writeFileSync(path.join(directory, "adaptive-soak.json"), JSON.stringify(adaptive), "utf8");
}
