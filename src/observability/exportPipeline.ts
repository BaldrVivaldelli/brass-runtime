import type { MetricsRegistry } from "../core/runtime/metrics";

export type ExportSignal = "metrics" | "traces" | "logs";

export type ExportRetryOptions = {
  readonly attempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type ExportPipelineTuning = {
  readonly maxQueueSize?: number;
  readonly batchSize?: number;
  readonly timeoutMs?: number;
  readonly retry?: ExportRetryOptions;
  readonly dropPolicy?: "drop-oldest" | "drop-newest";
  readonly shutdownTimeoutMs?: number;
};

export type ExportBatchResult = {
  readonly status?: number;
  readonly body?: string;
};

export type ExportPipelineOptions<T> = ExportPipelineTuning & {
  readonly signal: ExportSignal;
  readonly metrics?: MetricsRegistry;
  readonly clock?: () => number;
  readonly exportBatch: (items: readonly T[]) => Promise<ExportBatchResult>;
  readonly onDrop?: (items: readonly T[]) => void;
};

export type ExportPipelineFlushOptions = {
  readonly deadlineMs?: number;
};

export type ExportPipelineFlushResult = {
  readonly exported: number;
  readonly dropped: number;
  readonly failed: number;
  readonly batchCount: number;
  readonly attempts: number;
  readonly queueSize: number;
  readonly status?: number;
  readonly body?: string;
  readonly errors: readonly unknown[];
};

export type ExportPipelineStats = {
  readonly queueSize: number;
  readonly dropped: number;
};

export type ExportPipeline<T> = {
  readonly enqueue: (items: readonly T[]) => number;
  readonly flush: (options?: ExportPipelineFlushOptions) => Promise<ExportPipelineFlushResult>;
  readonly shutdown: (timeoutMs?: number) => Promise<ExportPipelineFlushResult>;
  readonly stats: () => ExportPipelineStats;
};

const DEFAULT_BATCH_SIZE = 512;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export function makeExportPipeline<T>(options: ExportPipelineOptions<T>): ExportPipeline<T> {
  const signal = options.signal;
  const clock = options.clock ?? Date.now;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const maxQueueSize = Math.max(0, Math.floor(options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE));
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const dropPolicy = options.dropPolicy ?? "drop-oldest";
  const queueGauge = options.metrics?.gauge("brass_export_queue_size", { signal });
  let queue: T[] = [];
  let droppedTotal = 0;

  const setQueueSize = () => queueGauge?.set(queue.length);

  const dropItems = (items: T[]) => {
    if (items.length === 0) return;
    droppedTotal += items.length;
    options.metrics?.counter("brass_export_dropped_total", { signal }).increment(items.length);
    options.onDrop?.(items);
  };

  const enqueue = (items: readonly T[]): number => {
    if (items.length === 0 || maxQueueSize === 0) {
      dropItems([...items]);
      setQueueSize();
      return 0;
    }

    const incoming = [...items];
    const available = maxQueueSize - queue.length;

    if (incoming.length <= available) {
      queue.push(...incoming);
      options.metrics?.counter("brass_export_enqueued_total", { signal }).increment(incoming.length);
      setQueueSize();
      return incoming.length;
    }

    if (dropPolicy === "drop-newest") {
      const accepted = incoming.slice(0, Math.max(0, available));
      const dropped = incoming.slice(accepted.length);
      queue.push(...accepted);
      options.metrics?.counter("brass_export_enqueued_total", { signal }).increment(accepted.length);
      dropItems(dropped);
      setQueueSize();
      return accepted.length;
    }

    const total = queue.length + incoming.length;
    const dropCount = Math.max(0, total - maxQueueSize);
    const dropped = queue.splice(0, Math.min(dropCount, queue.length));
    const remainingDrop = dropCount - dropped.length;
    if (remainingDrop > 0) dropped.push(...incoming.splice(0, remainingDrop));
    queue.push(...incoming);
    options.metrics?.counter("brass_export_enqueued_total", { signal }).increment(incoming.length);
    dropItems(dropped);
    setQueueSize();
    return incoming.length;
  };

  const flush = async (flushOptions: ExportPipelineFlushOptions = {}): Promise<ExportPipelineFlushResult> => {
    const startedAt = clock();
    const deadlineMs = flushOptions.deadlineMs;
    const errors: unknown[] = [];
    let exported = 0;
    let failed = 0;
    let batchCount = 0;
    let attempts = 0;
    let lastStatus: number | undefined;
    let lastBody: string | undefined;

    while (queue.length > 0) {
      if (deadlineMs !== undefined && clock() - startedAt >= deadlineMs) break;

      const batch = queue.splice(0, batchSize);
      const batchStartedAt = clock();
      try {
        const result = await exportWithRetry(
          () => withTimeout(() => options.exportBatch(batch), timeoutMs),
          {
            signal,
            metrics: options.metrics,
            retry: options.retry,
          }
        );
        exported += batch.length;
        batchCount++;
        attempts += result.attempts;
        lastStatus = result.value.status;
        lastBody = result.value.body;
        options.metrics?.counter("brass_export_batches_total", { signal, status: "success" }).increment();
        options.metrics?.counter("brass_export_items_total", { signal, status: "success" }).increment(batch.length);
        options.metrics?.histogram("brass_export_batch_duration_ms", undefined, { signal, status: "success" }).observe(clock() - batchStartedAt);
      } catch (error) {
        failed += batch.length;
        errors.push(error);
        queue = [...batch, ...queue];
        options.metrics?.counter("brass_export_batches_total", { signal, status: "failure" }).increment();
        options.metrics?.counter("brass_export_items_total", { signal, status: "failure" }).increment(batch.length);
        options.metrics?.histogram("brass_export_batch_duration_ms", undefined, { signal, status: "failure" }).observe(clock() - batchStartedAt);
        break;
      } finally {
        setQueueSize();
      }
    }

    options.metrics?.histogram("brass_export_flush_duration_ms", undefined, { signal }).observe(clock() - startedAt);

    return {
      exported,
      dropped: droppedTotal,
      failed,
      batchCount,
      attempts,
      queueSize: queue.length,
      status: lastStatus,
      body: lastBody,
      errors,
    };
  };

  return {
    enqueue,
    flush,
    shutdown: (deadline = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS) => flush({ deadlineMs: deadline }),
    stats: () => ({ queueSize: queue.length, dropped: droppedTotal }),
  };
}

export async function exportWithRetry<T>(
  operation: () => Promise<T>,
  options: {
    readonly signal: ExportSignal;
    readonly metrics?: MetricsRegistry;
    readonly retry?: ExportRetryOptions;
  }
): Promise<{ value: T; attempts: number }> {
  const attempts = Math.max(1, Math.floor(options.retry?.attempts ?? 1));
  const initialDelayMs = Math.max(0, options.retry?.initialDelayMs ?? 100);
  const maxDelayMs = Math.max(initialDelayMs, options.retry?.maxDelayMs ?? 2_000);
  const jitterRatio = Math.max(0, Math.min(1, options.retry?.jitterRatio ?? 0.2));
  const sleep = options.retry?.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return { value: await operation(), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      options.metrics?.counter("brass_export_retries_total", { signal: options.signal }).increment();
      await sleep(jitteredDelay(initialDelayMs, maxDelayMs, jitterRatio, attempt));
    }
  }

  throw lastError;
}

export async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return operation();

  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        handle = setTimeout(() => reject(new Error(`Observability export timed out after ${timeoutMs}ms`)), timeoutMs);
        (handle as any).unref?.();
      }),
    ]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

function jitteredDelay(initialDelayMs: number, maxDelayMs: number, jitterRatio: number, attempt: number): number {
  const base = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, attempt - 1));
  if (base <= 0 || jitterRatio <= 0) return base;
  const spread = base * jitterRatio;
  return Math.max(0, Math.round(base - spread + Math.random() * spread * 2));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    (handle as any).unref?.();
  });
}
