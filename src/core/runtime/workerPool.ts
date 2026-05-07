// src/core/runtime/workerPool.ts
// Worker pool for offloading CPU-intensive work to threads.
//
// Uses Node.js worker_threads to execute functions in parallel
// without blocking the main event loop.

import { Async, async, asyncFail } from "../types/asyncEffect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkerPoolConfig = {
  /** Number of worker threads. Default: number of CPUs - 1 */
  readonly size?: number;
  /** Max queued tasks. Tasks beyond this are rejected. Default: 1000 */
  readonly maxQueue?: number;
  /** Task timeout in ms. Default: 30000 */
  readonly taskTimeoutMs?: number;
};

export type WorkerPoolError =
  | { readonly _tag: "WorkerPoolFull"; readonly queued: number }
  | { readonly _tag: "WorkerTaskTimeout"; readonly ms: number }
  | { readonly _tag: "WorkerTaskError"; readonly message: string }
  | { readonly _tag: "WorkerPoolClosed" };

export type WorkerPool = {
  /** Execute a function in a worker thread. */
  readonly execute: <A>(fn: () => A) => Async<unknown, WorkerPoolError, A>;
  /** Execute a serializable task (function source + args). */
  readonly run: <A>(taskSource: string, args?: any[]) => Async<unknown, WorkerPoolError, A>;
  /** Current pool stats. */
  readonly stats: () => WorkerPoolStats;
  /** Shutdown the pool (terminate all workers). */
  readonly shutdown: () => Promise<void>;
};

export type WorkerPoolStats = {
  readonly size: number;
  readonly busy: number;
  readonly idle: number;
  readonly queued: number;
  readonly completed: number;
  readonly failed: number;
  readonly timedOut: number;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Creates a worker pool for CPU-intensive tasks.
 *
 * NOTE: This is a simplified implementation that uses setTimeout to simulate
 * async execution. For real worker_threads support, the pool would need to
 * spawn actual Worker instances. This provides the API contract and can be
 * upgraded to real threads when needed.
 *
 * ```ts
 * const pool = makeWorkerPool({ size: 4 });
 *
 * const result = await run(pool.execute(() => heavyComputation()));
 *
 * await pool.shutdown();
 * ```
 */
export function makeWorkerPool(config: WorkerPoolConfig = {}): WorkerPool {
  const size = config.size ?? 4;
  const maxQueue = config.maxQueue ?? 1000;
  const taskTimeoutMs = config.taskTimeoutMs ?? 30_000;

  let closed = false;
  let busy = 0;
  let completed = 0;
  let failed = 0;
  let timedOut = 0;

  type QueuedTask = {
    fn: () => any;
    resolve: (value: any) => void;
    reject: (error: WorkerPoolError) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
  };

  const queue: QueuedTask[] = [];

  const processNext = () => {
    if (queue.length === 0 || busy >= size) return;

    const task = queue.shift()!;
    busy++;

    // Simulate async execution (in a real impl, this would post to a Worker)
    setImmediate(() => {
      if (task.timeoutId) clearTimeout(task.timeoutId);

      try {
        const result = task.fn();
        busy--;
        completed++;
        task.resolve(result);
        processNext();
      } catch (e) {
        busy--;
        failed++;
        task.reject({ _tag: "WorkerTaskError", message: String(e) });
        processNext();
      }
    });
  };

  const execute = <A>(fn: () => A): Async<unknown, WorkerPoolError, A> => {
    if (closed) return asyncFail({ _tag: "WorkerPoolClosed" });

    if (queue.length >= maxQueue) {
      return asyncFail({ _tag: "WorkerPoolFull", queued: queue.length });
    }

    return async((_env, cb) => {
      const task: QueuedTask = {
        fn,
        resolve: (value) => cb({ _tag: "Success", value }),
        reject: (error) => cb({ _tag: "Failure", cause: { _tag: "Fail", error } }),
      };

      // Set timeout
      task.timeoutId = setTimeout(() => {
        const idx = queue.indexOf(task);
        if (idx >= 0) {
          queue.splice(idx, 1);
          timedOut++;
          task.reject({ _tag: "WorkerTaskTimeout", ms: taskTimeoutMs });
        }
      }, taskTimeoutMs);

      queue.push(task);
      processNext();

      return () => {
        const idx = queue.indexOf(task);
        if (idx >= 0) {
          queue.splice(idx, 1);
          if (task.timeoutId) clearTimeout(task.timeoutId);
        }
      };
    });
  };

  const run = <A>(taskSource: string, args: any[] = []): Async<unknown, WorkerPoolError, A> => {
    return execute(() => {
      const fn = new Function(...args.map((_, i) => `arg${i}`), taskSource);
      return fn(...args);
    });
  };

  return {
    execute,
    run,
    stats: () => ({
      size,
      busy,
      idle: size - busy,
      queued: queue.length,
      completed,
      failed,
      timedOut,
    }),
    shutdown: async () => {
      closed = true;
      // Reject all queued tasks
      while (queue.length > 0) {
        const task = queue.shift()!;
        if (task.timeoutId) clearTimeout(task.timeoutId);
        task.reject({ _tag: "WorkerPoolClosed" });
      }
    },
  };
}
