import type { HttpError, HttpRequest } from "./client";

export type HttpPoolKeyResolver = "global" | "origin" | "host" | ((req: HttpRequest, url: URL) => string);

export type HttpPoolConfig = {
  /** Max concurrent downstream calls per resolved key. */
  readonly concurrency?: number;
  /** Max queued waiters per key. `0` means fail fast when the pool is full. */
  readonly maxQueue?: number;
  /** Max time a request may wait for a pool slot before failing fast. */
  readonly queueTimeoutMs?: number;
  /** How to isolate pools. Default: `origin`; useful values: `global`, `host`, `origin`. */
  readonly key?: HttpPoolKeyResolver;
};

export type HttpPoolKeyStats = {
  readonly key: string;
  readonly running: number;
  readonly queued: number;
  readonly concurrency: number;
  readonly maxQueue: number;
  readonly acquired: number;
  readonly released: number;
  readonly rejected: number;
  readonly queueTimeouts: number;
  readonly abortedWhileQueued: number;
};

export type HttpPoolStats = {
  readonly running: number;
  readonly queued: number;
  readonly acquired: number;
  readonly released: number;
  readonly rejected: number;
  readonly queueTimeouts: number;
  readonly abortedWhileQueued: number;
  readonly keys: HttpPoolKeyStats[];
};

export type HttpPoolLease = {
  readonly key: string;
  release: () => void;
};

type Waiter = {
  resolve: (lease: HttpPoolLease) => void;
  reject: (error: HttpError) => void;
  signal: AbortSignal;
  abort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

type PoolState = {
  key: string;
  running: number;
  queue: Waiter[];
  acquired: number;
  released: number;
  rejected: number;
  queueTimeouts: number;
  abortedWhileQueued: number;
};

const DEFAULT_CONCURRENCY = 64;
const DEFAULT_MAX_QUEUE = 256;

const clampInt = (n: number | undefined, fallback: number, min: number): number => {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
};

const queueTimeoutError = (key: string, timeoutMs: number): HttpError => ({
  _tag: "PoolTimeout",
  key,
  timeoutMs,
  message: `HTTP pool '${key}' did not grant a slot within ${timeoutMs}ms`,
});

const poolRejectedError = (key: string, maxQueue: number): HttpError => ({
  _tag: "PoolRejected",
  key,
  limit: maxQueue,
  message: `HTTP pool '${key}' queue is full`,
});

const abortError = (): HttpError => ({ _tag: "Abort" });

export function resolveHttpPoolKey(
  resolver: HttpPoolKeyResolver | undefined,
  req: HttpRequest,
  url: URL,
): string {
  const custom = req.poolKey?.trim();
  if (custom) return custom.slice(0, 160);

  const r = resolver ?? "origin";
  if (typeof r === "function") return r(req, url).trim().slice(0, 160) || "global";
  if (r === "global") return "global";
  if (r === "host") return url.host;
  return url.origin;
}

export class HttpConcurrencyPool {
  private readonly states = new Map<string, PoolState>();
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly queueTimeoutMs: number | undefined;
  readonly keyResolver: HttpPoolKeyResolver | undefined;

  constructor(config: HttpPoolConfig = {}) {
    this.concurrency = clampInt(config.concurrency, DEFAULT_CONCURRENCY, 1);
    this.maxQueue = clampInt(config.maxQueue, DEFAULT_MAX_QUEUE, 0);
    this.queueTimeoutMs = config.queueTimeoutMs !== undefined && Number.isFinite(config.queueTimeoutMs)
      ? Math.max(0, Math.floor(config.queueTimeoutMs))
      : undefined;
    this.keyResolver = config.key;
  }

  acquire(key: string, signal: AbortSignal): Promise<HttpPoolLease> {
    const state = this.getState(key);
    if (signal.aborted) return Promise.reject(abortError());

    if (state.running < this.concurrency) {
      state.running++;
      state.acquired++;
      return Promise.resolve(this.makeLease(state));
    }

    if (state.queue.length >= this.maxQueue) {
      state.rejected++;
      return Promise.reject(poolRejectedError(key, this.maxQueue));
    }

    return new Promise<HttpPoolLease>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
      };

      const removeWaiter = () => {
        const idx = state.queue.indexOf(waiter);
        if (idx >= 0) state.queue.splice(idx, 1);
      };

      const cleanup = () => {
        if (waiter.timer !== undefined) {
          clearTimeout(waiter.timer);
          waiter.timer = undefined;
        }
        if (waiter.abort) {
          signal.removeEventListener("abort", waiter.abort);
          waiter.abort = undefined;
        }
      };

      waiter.abort = () => {
        cleanup();
        removeWaiter();
        state.abortedWhileQueued++;
        reject(abortError());
      };
      signal.addEventListener("abort", waiter.abort, { once: true });

      if (this.queueTimeoutMs !== undefined && this.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          cleanup();
          removeWaiter();
          state.queueTimeouts++;
          reject(queueTimeoutError(key, this.queueTimeoutMs!));
        }, this.queueTimeoutMs);
      }

      state.queue.push(waiter);
    });
  }

  stats(): HttpPoolStats {
    const keys = Array.from(this.states.values()).map((state): HttpPoolKeyStats => ({
      key: state.key,
      running: state.running,
      queued: state.queue.length,
      concurrency: this.concurrency,
      maxQueue: this.maxQueue,
      acquired: state.acquired,
      released: state.released,
      rejected: state.rejected,
      queueTimeouts: state.queueTimeouts,
      abortedWhileQueued: state.abortedWhileQueued,
    })).sort((a, b) => (b.running + b.queued) - (a.running + a.queued) || a.key.localeCompare(b.key));

    return keys.reduce<HttpPoolStats>((acc, key) => ({
      running: acc.running + key.running,
      queued: acc.queued + key.queued,
      acquired: acc.acquired + key.acquired,
      released: acc.released + key.released,
      rejected: acc.rejected + key.rejected,
      queueTimeouts: acc.queueTimeouts + key.queueTimeouts,
      abortedWhileQueued: acc.abortedWhileQueued + key.abortedWhileQueued,
      keys: acc.keys.concat(key),
    }), {
      running: 0,
      queued: 0,
      acquired: 0,
      released: 0,
      rejected: 0,
      queueTimeouts: 0,
      abortedWhileQueued: 0,
      keys: [],
    });
  }

  private getState(key: string): PoolState {
    const k = key.trim().slice(0, 160) || "global";
    const existing = this.states.get(k);
    if (existing) return existing;
    const created: PoolState = {
      key: k,
      running: 0,
      queue: [],
      acquired: 0,
      released: 0,
      rejected: 0,
      queueTimeouts: 0,
      abortedWhileQueued: 0,
    };
    this.states.set(k, created);
    return created;
  }

  private makeLease(state: PoolState): HttpPoolLease {
    let released = false;
    return {
      key: state.key,
      release: () => {
        if (released) return;
        released = true;
        if (state.running > 0) state.running--;
        state.released++;
        this.drain(state);
      },
    };
  }

  private drain(state: PoolState): void {
    while (state.running < this.concurrency && state.queue.length > 0) {
      const waiter = state.queue.shift()!;
      if (waiter.timer !== undefined) {
        clearTimeout(waiter.timer);
        waiter.timer = undefined;
      }
      if (waiter.abort) {
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.abort = undefined;
      }
      if (waiter.signal.aborted) {
        state.abortedWhileQueued++;
        waiter.reject(abortError());
        continue;
      }
      state.running++;
      state.acquired++;
      waiter.resolve(this.makeLease(state));
    }
  }
}
