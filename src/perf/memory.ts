export type PerfMemorySnapshot = {
  readonly timestamp: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly rssMb: number;
  readonly externalMb: number;
  readonly arrayBuffersMb: number;
  readonly gcAvailable: boolean;
};

export type PerfMemoryDelta = {
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly rssMb: number;
  readonly externalMb: number;
  readonly arrayBuffersMb: number;
};

export type PerfMemorySnapshotOptions = {
  readonly forceGc?: boolean;
  readonly gcPasses?: number;
  readonly clock?: () => number;
};

export type MemoryRetentionReport = {
  readonly label: string;
  readonly durationMs: number;
  readonly before: PerfMemorySnapshot;
  readonly after: PerfMemorySnapshot;
  readonly delta: PerfMemoryDelta;
};

export type MemoryRetentionOptions = PerfMemorySnapshotOptions & {
  readonly label?: string;
};

export type MemoryRetentionResult<A> = {
  readonly value: A;
  readonly report: MemoryRetentionReport;
};

export function hasGc(): boolean {
  return typeof (globalThis as unknown as { gc?: () => void }).gc === "function";
}

export function forceGc(passes = 2): boolean {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc !== "function") return false;
  const count = Math.max(1, Math.floor(passes));
  for (let i = 0; i < count; i++) gc();
  return true;
}

export function captureMemorySnapshot(options: PerfMemorySnapshotOptions = {}): PerfMemorySnapshot {
  if (options.forceGc) forceGc(options.gcPasses);
  const usage = process.memoryUsage();
  const clock = options.clock ?? Date.now;
  return Object.freeze({
    timestamp: clock(),
    heapUsedMb: toMb(usage.heapUsed),
    heapTotalMb: toMb(usage.heapTotal),
    rssMb: toMb(usage.rss),
    externalMb: toMb(usage.external),
    arrayBuffersMb: toMb(usage.arrayBuffers),
    gcAvailable: hasGc(),
  });
}

export function diffMemorySnapshots(before: PerfMemorySnapshot, after: PerfMemorySnapshot): PerfMemoryDelta {
  return Object.freeze({
    heapUsedMb: round(after.heapUsedMb - before.heapUsedMb),
    heapTotalMb: round(after.heapTotalMb - before.heapTotalMb),
    rssMb: round(after.rssMb - before.rssMb),
    externalMb: round(after.externalMb - before.externalMb),
    arrayBuffersMb: round(after.arrayBuffersMb - before.arrayBuffersMb),
  });
}

export async function profileMemoryRetention<A>(
  fn: () => A | Promise<A>,
  options: MemoryRetentionOptions = {},
): Promise<MemoryRetentionResult<A>> {
  const clock = options.clock ?? performance.now.bind(performance);
  const before = captureMemorySnapshot(options);
  const startedAt = clock();
  const value = await fn();
  const durationMs = round(clock() - startedAt);
  const after = captureMemorySnapshot(options);
  const report: MemoryRetentionReport = Object.freeze({
    label: options.label ?? "memory-retention",
    durationMs,
    before,
    after,
    delta: diffMemorySnapshots(before, after),
  });
  return Object.freeze({ value, report });
}

function toMb(bytes: number): number {
  return round(bytes / (1024 * 1024));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
