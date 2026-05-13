import type { HttpError, HttpRequest } from "./client";
import { makeWasmHttpPermitPool, type WasmHttpPermitPoolBridge, type WasmPermitEvent } from "./wasmPermitPool";

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
  /**
   * Strict engine selector for permit governance. Defaults to ts.
   * - ts: TypeScript permit pool.
   * - wasm: require BrassWasmHttpPermitPool from wasm/pkg; never falls back.
   */
  readonly engine?: "ts" | "wasm";
  /** Back-compat knob: wasm=true maps to engine="wasm", wasm=false maps to engine="ts". */
  readonly wasm?: boolean;
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
  readonly wasm?: unknown;
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

type WasmWaiter = {
  waiter: Waiter;
  state: PoolState;
  keyId: number;
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

function resolveHttpPoolEngine(config: HttpPoolConfig): "ts" | "wasm" {
  if (config.engine !== undefined) {
    if (config.engine === "ts" || config.engine === "wasm") return config.engine;
    throw new Error(`brass-runtime HTTP pool engine must be 'ts' or 'wasm'; received '${String(config.engine)}'`);
  }
  if (config.wasm === true) return "wasm";
  if (config.wasm === false) return "ts";
  return "ts";
}

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
  private readonly wasm: WasmHttpPermitPoolBridge | undefined;
  private readonly wasmWaiters = new Map<number, WasmWaiter>();
  private wasmTimer: ReturnType<typeof setTimeout> | undefined;
  private nextSubjectId = 1;

  constructor(config: HttpPoolConfig = {}) {
    this.concurrency = clampInt(config.concurrency, DEFAULT_CONCURRENCY, 1);
    this.maxQueue = clampInt(config.maxQueue, DEFAULT_MAX_QUEUE, 0);
    this.queueTimeoutMs = config.queueTimeoutMs !== undefined && Number.isFinite(config.queueTimeoutMs)
      ? Math.max(0, Math.floor(config.queueTimeoutMs))
      : undefined;
    this.keyResolver = config.key;
    const engine = resolveHttpPoolEngine(config);
    this.wasm = engine === "wasm"
      ? makeWasmHttpPermitPool({
        concurrency: this.concurrency,
        maxQueue: this.maxQueue,
        queueTimeoutMs: this.queueTimeoutMs ?? 0,
      })
      : undefined;
  }

  acquire(key: string, signal: AbortSignal): Promise<HttpPoolLease> {
    return this.wasm ? this.acquireWasm(key, signal) : this.acquireJs(key, signal);
  }

  /** Try synchronous acquire. Returns lease directly or undefined if contended. */
  tryAcquireSync(key: string, signal: AbortSignal): HttpPoolLease | undefined {
    // For WASM engine, always return undefined to preserve existing WASM path
    if (this.wasm) return undefined;
    if (signal.aborted) return undefined;
    const state = this.getState(key);
    if (state.running < this.concurrency) {
      state.running++;
      state.acquired++;
      return this.makeLease(state);
    }
    return undefined;
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
      wasm: this.wasm?.stats(),
      keys: acc.keys.concat(key),
    }), {
      running: 0,
      queued: 0,
      acquired: 0,
      released: 0,
      rejected: 0,
      queueTimeouts: 0,
      abortedWhileQueued: 0,
      ...(this.wasm ? { wasm: this.wasm.stats() } : {}),
      keys: [],
    });
  }

  private acquireJs(key: string, signal: AbortSignal): Promise<HttpPoolLease> {
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
      const waiter: Waiter = { signal, resolve, reject };
      const removeWaiter = () => this.removeWaiter(state, waiter);
      const cleanup = () => this.cleanupWaiter(waiter);

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

  private acquireWasm(key: string, signal: AbortSignal): Promise<HttpPoolLease> {
    const wasm = this.wasm!;
    const state = this.getState(key);
    if (signal.aborted) return Promise.reject(abortError());

    const subjectId = this.allocateSubjectId();
    const decision = wasm.acquire(key, subjectId);

    if (decision.kind === "run") {
      state.running++;
      state.acquired++;
      return Promise.resolve(this.makeLease(state, decision.keyId));
    }

    if (decision.kind === "rejected") {
      state.rejected++;
      return Promise.reject(poolRejectedError(key, this.maxQueue));
    }

    return new Promise<HttpPoolLease>((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject };
      const removeWaiter = () => this.removeWaiter(state, waiter);
      const cleanup = () => this.cleanupWaiter(waiter);

      waiter.abort = () => {
        cleanup();
        removeWaiter();
        wasm.cancel(decision.permitId);
        this.wasmWaiters.delete(decision.permitId);
        state.abortedWhileQueued++;
        reject(abortError());
      };
      signal.addEventListener("abort", waiter.abort, { once: true });

      state.queue.push(waiter);
      this.wasmWaiters.set(decision.permitId, { waiter, state, keyId: decision.keyId });
      this.scheduleWasmTimeoutPump();
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

  private makeLease(state: PoolState, wasmKeyId?: number): HttpPoolLease {
    let released = false;
    return {
      key: state.key,
      release: () => {
        if (released) return;
        released = true;
        if (state.running > 0) state.running--;
        state.released++;
        if (this.wasm && wasmKeyId !== undefined) {
          this.handleWasmGrants(this.wasm.release(wasmKeyId));
          this.scheduleWasmTimeoutPump();
          return;
        }
        this.drain(state);
      },
    };
  }

  private drain(state: PoolState): void {
    while (state.running < this.concurrency && state.queue.length > 0) {
      const waiter = state.queue.shift()!;
      this.cleanupWaiter(waiter);
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

  private handleWasmGrants(events: readonly WasmPermitEvent[]): void {
    for (const event of events) {
      const pending = this.wasmWaiters.get(event.permitId);
      if (!pending) continue;
      this.wasmWaiters.delete(event.permitId);
      this.cleanupWaiter(pending.waiter);
      this.removeWaiter(pending.state, pending.waiter);
      if (pending.waiter.signal.aborted) {
        pending.state.abortedWhileQueued++;
        pending.waiter.reject(abortError());
        continue;
      }
      pending.state.running++;
      pending.state.acquired++;
      pending.waiter.resolve(this.makeLease(pending.state, event.keyId));
    }
  }

  private handleWasmTimeouts(events: readonly WasmPermitEvent[]): void {
    for (const event of events) {
      const pending = this.wasmWaiters.get(event.permitId);
      if (!pending) continue;
      this.wasmWaiters.delete(event.permitId);
      this.cleanupWaiter(pending.waiter);
      this.removeWaiter(pending.state, pending.waiter);
      pending.state.queueTimeouts++;
      pending.waiter.reject(queueTimeoutError(pending.state.key, this.queueTimeoutMs ?? 0));
    }
  }

  private scheduleWasmTimeoutPump(): void {
    if (!this.wasm) return;
    if (this.wasmTimer !== undefined) clearTimeout(this.wasmTimer);
    this.wasmTimer = undefined;
    const next = this.wasm.nextDeadlineMs();
    if (!Number.isFinite(next) || next < 0) return;
    const delay = Math.max(0, Math.min(2 ** 31 - 1, Math.floor(next - Date.now())));
    this.wasmTimer = setTimeout(() => {
      this.wasmTimer = undefined;
      if (!this.wasm) return;
      this.handleWasmTimeouts(this.wasm.advanceTime());
      this.scheduleWasmTimeoutPump();
    }, delay);
    if (typeof this.wasmTimer.unref === "function") this.wasmTimer.unref();
  }

  private cleanupWaiter(waiter: Waiter): void {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    if (waiter.abort) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.abort = undefined;
    }
  }

  private removeWaiter(state: PoolState, waiter: Waiter): void {
    const idx = state.queue.indexOf(waiter);
    if (idx >= 0) state.queue.splice(idx, 1);
  }

  private allocateSubjectId(): number {
    const id = this.nextSubjectId >>> 0;
    this.nextSubjectId = (this.nextSubjectId + 1) >>> 0;
    if (this.nextSubjectId === 0) this.nextSubjectId = 1;
    return id === 0 ? this.allocateSubjectId() : id;
  }
}
