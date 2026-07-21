#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeServiceClient } from "../agent/native/client";
import { TypeScriptSearchIndex } from "../agent/native/searchPilot";
import type { NativeIndexDocument, NativeSearchHit, NativeServiceTransport } from "../agent/native/protocol";
import { createNodeNativeServiceTransport } from "../agent/node/nativeServiceProcess";
import type { RuntimeBoundaryEvent } from "../core/runtime/boundaryDiagnostics";

const DOCUMENT_COUNT = Number(process.env.BRASS_NATIVE_BENCH_DOCUMENTS ?? "4000");
const QUERY_COUNT = Number(process.env.BRASS_NATIVE_BENCH_QUERIES ?? "200");
const WARMUP_QUERIES = Number(process.env.BRASS_NATIVE_BENCH_WARMUP ?? "20");
const CANCELLATION_TRIALS = Number(process.env.BRASS_NATIVE_BENCH_CANCEL_TRIALS ?? "20");
const IDLE_WINDOW_MS = Number(process.env.BRASS_NATIVE_BENCH_IDLE_MS ?? "500");
const scriptPath = fileURLToPath(import.meta.url);

type WorkerResult = {
  readonly engine: "ts" | "rust-native";
  readonly initialIndexMs: number;
  readonly fullReindexMs: number;
  readonly queryLatencyMs: Percentiles;
  readonly queryCpuMs: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly resultDigest: string;
  readonly errorCount: number;
  readonly cancellationLatencyMs: Percentiles;
  readonly crossingCount: number;
  readonly crossingBytes: number;
  readonly unexpectedFallbacks: number;
  readonly idleCpuPercent: number | null;
  readonly startupMs: number;
  readonly serviceBuild?: string;
};

type Percentiles = { readonly p50: number; readonly p95: number; readonly p99: number };

if (process.argv.includes("--worker")) {
  void workerMain().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
} else {
  main();
}

function main(): void {
  const executable = process.platform === "win32" ? "brass-native-service.exe" : "brass-native-service";
  const binary = process.env.BRASS_NATIVE_SERVICE_BIN
    ?? resolve(process.cwd(), "target", "release", executable);
  const ts = runWorker("ts", binary);
  const native = runWorker("rust-native", binary);
  const p95ImprovementPercent = improvement(ts.queryLatencyMs.p95, native.queryLatencyMs.p95);
  const cpuImprovementPercent = improvement(ts.queryCpuMs, native.queryCpuMs);
  const rssRatio = native.rssBytes / Math.max(1, ts.rssBytes);
  const heapRatio = native.heapUsedBytes / Math.max(1, ts.heapUsedBytes);
  const gates = {
    parity100Percent: ts.resultDigest === native.resultDigest && ts.errorCount === native.errorCount,
    zeroUnexpectedFallbacks: native.unexpectedFallbacks === 0,
    cancellationP95AtMost50Ms: native.cancellationLatencyMs.p95 <= 50,
    rssAtMost110PercentOfTs: rssRatio <= 1.1,
    heapAtMost110PercentOfTs: heapRatio <= 1.1,
    latencyOrCpuAtLeast15PercentBetter: p95ImprovementPercent >= 15 || cpuImprovementPercent >= 15,
  };
  const promotionEligible = Object.values(gates).every(Boolean);
  const fixtureDescriptor = JSON.stringify({
    version: 1,
    documents: DOCUMENT_COUNT,
    queries: QUERY_COUNT,
    warmupQueries: WARMUP_QUERIES,
    cancellationTrials: CANCELLATION_TRIALS,
    generator: "native-search-pilot-v1",
  });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    machine: {
      platform: `${platform()} ${release()}`,
      architecture: process.arch,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      node: process.version,
      rustc: commandVersion("rustc", ["--version"]),
    },
    workload: {
      fixtureSha256: createHash("sha256").update(fixtureDescriptor).digest("hex"),
      documents: DOCUMENT_COUNT,
      queries: QUERY_COUNT,
      warmupQueries: WARMUP_QUERIES,
      cancellationTrials: CANCELLATION_TRIALS,
      reindexMode: "full-replacement-v1",
    },
    engines: {
      ts,
      wasm: {
        status: "not-applicable",
        reason: "WASM v1 owns fiber coordination and has no indexing/search capability",
      },
      rustNative: native,
    },
    comparison: {
      p95ImprovementPercent: round(p95ImprovementPercent),
      cpuImprovementPercent: round(cpuImprovementPercent),
      rssRatio: round(rssRatio),
      heapRatio: round(heapRatio),
      gates,
      promotionEligible,
      decision: promotionEligible ? "adopt-native-search" : "keep-typescript-default-native-optional",
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function runWorker(engine: WorkerResult["engine"], binary: string): WorkerResult {
  const run = spawnSync(process.execPath, [
    "--expose-gc",
    "--import",
    "tsx",
    scriptPath,
    "--worker",
    engine,
    "--binary",
    binary,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  if (run.error) {
    throw new Error(`${engine} benchmark worker could not start: ${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new Error(`${engine} benchmark worker failed (${run.status}): ${run.stderr || run.stdout}`);
  }
  if (!run.stdout.trim()) {
    throw new Error(`${engine} benchmark worker returned no output (script=${scriptPath}, stderr=${run.stderr})`);
  }
  return JSON.parse(run.stdout) as WorkerResult;
}

async function workerMain(): Promise<void> {
  const workerIndex = process.argv.indexOf("--worker");
  const binaryIndex = process.argv.indexOf("--binary");
  const engine = process.argv[workerIndex + 1] as WorkerResult["engine"];
  const binary = process.argv[binaryIndex + 1];
  const documents = makeDocuments(DOCUMENT_COUNT);
  const queries = makeQueries(QUERY_COUNT + WARMUP_QUERIES);
  const result = engine === "ts"
    ? await runTypeScript(documents, queries)
    : await runNative(documents, queries, binary);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runTypeScript(
  documents: NativeIndexDocument[],
  queries: readonly string[],
): Promise<WorkerResult> {
  const index = new TypeScriptSearchIndex();
  const initialStarted = performance.now();
  index.replace(documents);
  const initialIndexMs = performance.now() - initialStarted;
  documents[0] = { ...documents[0], text: `${documents[0].text} changed` };
  const reindexStarted = performance.now();
  index.replace(documents);
  const fullReindexMs = performance.now() - reindexStarted;
  for (const query of queries.slice(0, WARMUP_QUERIES)) index.search(query, 20);
  gcIfAvailable();
  const cpuBefore = process.cpuUsage();
  const measured = measureSyncQueries(index, queries.slice(WARMUP_QUERIES));
  const cpu = process.cpuUsage(cpuBefore);
  const cancellations: number[] = [];
  for (let trial = 0; trial < CANCELLATION_TRIALS; trial += 1) {
    const controller = new AbortController();
    controller.abort();
    const started = performance.now();
    try {
      index.search("cancelled", 20, controller.signal);
    } catch {
      cancellations.push(performance.now() - started);
    }
  }
  gcIfAvailable();
  const memory = process.memoryUsage();
  return {
    engine: "ts",
    initialIndexMs: round(initialIndexMs),
    fullReindexMs: round(fullReindexMs),
    queryLatencyMs: percentiles(measured.latencies),
    queryCpuMs: round((cpu.user + cpu.system) / 1_000),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    resultDigest: measured.digest,
    errorCount: measured.errorCount,
    cancellationLatencyMs: percentiles(cancellations),
    crossingCount: 0,
    crossingBytes: 0,
    unexpectedFallbacks: 0,
    idleCpuPercent: 0,
    startupMs: 0,
  };
}

async function runNative(
  documents: NativeIndexDocument[],
  queries: readonly string[],
  binary: string,
): Promise<WorkerResult> {
  let transport: NativeServiceTransport | undefined;
  let activeCancellation: { controller: AbortController; startedAt: number } | undefined;
  const boundaries: RuntimeBoundaryEvent[] = [];
  const client = new NativeServiceClient({
    workspaceId: "native-benchmark-v1",
    clientBuild: "native-search-pilot-benchmark-v1",
    transportFactory: () => {
      transport = createNodeNativeServiceTransport({ command: binary });
      return transport;
    },
    defaultTimeoutMs: 30_000,
    diagnostics: { sink: { emit: (event) => boundaries.push(event) } },
    onEvent: (event) => {
      if (event.type === "native.progress" && event.phase === "searching" && activeCancellation) {
        activeCancellation.startedAt = performance.now();
        activeCancellation.controller.abort();
      }
    },
  });
  const startupStarted = performance.now();
  const handshake = await client.connect();
  const startupMs = performance.now() - startupStarted;
  const pid = transport?.processId;
  const idleBefore = pid === undefined ? undefined : childResourceSnapshot(pid);
  await wait(IDLE_WINDOW_MS);
  const idleAfter = pid === undefined ? undefined : childResourceSnapshot(pid);
  const idleCpuMs = resourceCpuDelta(idleBefore, idleAfter);
  const initialStarted = performance.now();
  await client.replaceIndex(documents, { timeoutMs: 30_000 });
  const initialIndexMs = performance.now() - initialStarted;
  documents[0] = { ...documents[0], text: `${documents[0].text} changed` };
  const reindexStarted = performance.now();
  await client.replaceIndex(documents, { timeoutMs: 30_000 });
  const fullReindexMs = performance.now() - reindexStarted;
  for (const query of queries.slice(0, WARMUP_QUERIES)) await client.search(query, 20);
  gcIfAvailable();
  const hostCpuBefore = process.cpuUsage();
  const childCpuBefore = pid === undefined ? undefined : childResourceSnapshot(pid);
  const measured = await measureNativeQueries(client, queries.slice(WARMUP_QUERIES));
  const hostCpu = process.cpuUsage(hostCpuBefore);
  const childCpuAfter = pid === undefined ? undefined : childResourceSnapshot(pid);
  const childCpuMs = resourceCpuDelta(childCpuBefore, childCpuAfter) ?? 0;
  const cancellations: number[] = [];
  const cancellationQuery = Array.from({ length: 64 }, (_, index) => `absent-${index}`).join(" ");
  for (let trial = 0; trial < CANCELLATION_TRIALS; trial += 1) {
    const controller = new AbortController();
    activeCancellation = { controller, startedAt: 0 };
    try {
      await client.search(cancellationQuery, 100, { signal: controller.signal, timeoutMs: 30_000 });
    } catch (error) {
      if (!activeCancellation.startedAt) throw error;
      cancellations.push(performance.now() - activeCancellation.startedAt);
    } finally {
      activeCancellation = undefined;
    }
  }
  await client.health();
  gcIfAvailable();
  const memory = process.memoryUsage();
  const serviceMemory = pid === undefined ? undefined : childResourceSnapshot(pid);
  const crossingCount = boundaries.length;
  const crossingBytes = boundaries.reduce(
    (sum, event) => sum + event.requestBytes + event.responseBytes,
    0,
  );
  const unexpectedFallbacks = boundaries.filter((event) => event.result === "fallback").length;
  await client.shutdown();
  return {
    engine: "rust-native",
    initialIndexMs: round(initialIndexMs),
    fullReindexMs: round(fullReindexMs),
    queryLatencyMs: percentiles(measured.latencies),
    queryCpuMs: round((hostCpu.user + hostCpu.system) / 1_000 + childCpuMs),
    rssBytes: memory.rss + (serviceMemory?.rssBytes ?? 0),
    heapUsedBytes: memory.heapUsed,
    resultDigest: measured.digest,
    errorCount: measured.errorCount,
    cancellationLatencyMs: percentiles(cancellations),
    crossingCount,
    crossingBytes,
    unexpectedFallbacks,
    idleCpuPercent: idleCpuMs === null ? null : round((idleCpuMs / IDLE_WINDOW_MS) * 100),
    startupMs: round(startupMs),
    serviceBuild: handshake.serviceBuild,
  };
}

function measureSyncQueries(index: TypeScriptSearchIndex, queries: readonly string[]) {
  const latencies: number[] = [];
  const hash = createHash("sha256");
  let errorCount = 0;
  for (const query of queries) {
    const started = performance.now();
    try {
      hashHits(hash, index.search(query, 20));
    } catch {
      errorCount += 1;
    }
    latencies.push(performance.now() - started);
  }
  return { latencies, digest: hash.digest("hex"), errorCount };
}

async function measureNativeQueries(client: NativeServiceClient, queries: readonly string[]) {
  const latencies: number[] = [];
  const hash = createHash("sha256");
  let errorCount = 0;
  for (const query of queries) {
    const started = performance.now();
    try {
      hashHits(hash, (await client.search(query, 20)).hits);
    } catch {
      errorCount += 1;
    }
    latencies.push(performance.now() - started);
  }
  return { latencies, digest: hash.digest("hex"), errorCount };
}

function hashHits(hash: ReturnType<typeof createHash>, hits: readonly NativeSearchHit[]): void {
  hash.update(JSON.stringify(hits));
  hash.update("\n");
}

function makeDocuments(count: number): NativeIndexDocument[] {
  return Array.from({ length: count }, (_, index) => {
    const token = `token-${index % 128}`;
    const family = `family-${index % 17}`;
    const text = `${token} ${family} brass runtime structured concurrency cancellation `
      .repeat(18)
      .concat(`document-${index}`);
    return { id: `virtual:document:${index.toString().padStart(5, "0")}`, text };
  });
}

function makeQueries(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    index % 3 === 0 ? `token-${index % 128}` : `family-${index % 17} brass`);
}

function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
  return { p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)) };
}

function improvement(baseline: number, candidate: number): number {
  return baseline <= 0 ? 0 : ((baseline - candidate) / baseline) * 100;
}

function gcIfAvailable(): void {
  const host = globalThis as typeof globalThis & { gc?: () => void };
  host.gc?.();
}

function commandVersion(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, [...args], { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

type ChildResourceSnapshot = { readonly cpuMs: number; readonly rssBytes: number };

function childResourceSnapshot(pid: number): ChildResourceSnapshot | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
    const ticks = Number(fields[11]) + Number(fields[12]);
    const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rssKb = Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1] ?? "0");
    return { cpuMs: (ticks / ticksPerSecond) * 1_000, rssBytes: rssKb * 1_024 };
  } catch {
    return undefined;
  }
}

function resourceCpuDelta(
  before: ChildResourceSnapshot | undefined,
  after: ChildResourceSnapshot | undefined,
): number | null {
  return before && after ? Math.max(0, after.cpuMs - before.cpuMs) : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
