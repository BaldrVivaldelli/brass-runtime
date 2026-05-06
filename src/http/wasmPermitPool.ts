import { resolveWasmModule } from "../core/runtime/wasmModule";

type WasmMemoryLike = { readonly buffer: ArrayBufferLike };

type WasmHttpPermitPoolCtor = new (concurrency: number, maxQueue: number, queueTimeoutMs: number | bigint) => {
  memory(): WasmMemoryLike;
  intern_key(key: string): number;
  acquire(subjectId: number, keyId: number, nowMs: number | bigint): number;
  last_permit_id(): number;
  release(keyId: number, nowMs: number | bigint): number;
  cancel(permitId: number): boolean;
  advance_time(nowMs: number | bigint): number;
  permit_events_len(): number;
  next_deadline_ms(): number;
  metric_u64(id: number): number;
};

const DECISION_RUN_NOW = 0;
const DECISION_QUEUED = 1;
const DECISION_REJECTED = 2;

export type WasmPermitDecision =
  | { readonly kind: "run"; readonly keyId: number; readonly permitId: number }
  | { readonly kind: "queued"; readonly keyId: number; readonly permitId: number }
  | { readonly kind: "rejected"; readonly keyId: number; readonly permitId: number };

export type WasmPermitEvent = {
  readonly subjectId: number;
  readonly permitId: number;
  readonly keyId: number;
};

export type WasmHttpPermitStats = {
  readonly running: number;
  readonly queued: number;
  readonly acquired: number;
  readonly released: number;
  readonly rejected: number;
  readonly queueTimeouts: number;
  readonly keys: number;
};

export class WasmHttpPermitPoolBridge {
  private readonly pool: InstanceType<WasmHttpPermitPoolCtor>;
  private readonly keyCache = new Map<string, number>();

  constructor(Ctor: WasmHttpPermitPoolCtor, options: { concurrency: number; maxQueue: number; queueTimeoutMs: number }) {
    this.pool = new Ctor(options.concurrency, options.maxQueue, toU64(options.queueTimeoutMs));
  }

  acquire(key: string, subjectId: number, nowMs = Date.now()): WasmPermitDecision {
    const keyId = this.internKey(key);
    const decision = this.pool.acquire(subjectId, keyId, toU64(nowMs));
    const permitId = this.pool.last_permit_id();
    if (decision === DECISION_RUN_NOW) return { kind: "run", keyId, permitId };
    if (decision === DECISION_QUEUED) return { kind: "queued", keyId, permitId };
    return { kind: "rejected", keyId, permitId };
  }

  release(keyId: number, nowMs = Date.now()): WasmPermitEvent[] {
    const ptr = this.pool.release(keyId, toU64(nowMs));
    return this.readEvents(ptr, this.pool.permit_events_len());
  }

  cancel(permitId: number): void {
    this.pool.cancel(permitId);
  }

  advanceTime(nowMs = Date.now()): WasmPermitEvent[] {
    const ptr = this.pool.advance_time(toU64(nowMs));
    return this.readEvents(ptr, this.pool.permit_events_len());
  }

  nextDeadlineMs(): number {
    return this.pool.next_deadline_ms();
  }

  stats(): WasmHttpPermitStats {
    return {
      running: this.pool.metric_u64(0),
      queued: this.pool.metric_u64(1),
      acquired: this.pool.metric_u64(2),
      released: this.pool.metric_u64(3),
      rejected: this.pool.metric_u64(4),
      queueTimeouts: this.pool.metric_u64(5),
      keys: this.pool.metric_u64(6),
    };
  }

  private internKey(key: string): number {
    const normalized = key.trim().slice(0, 160) || "global";
    let id = this.keyCache.get(normalized);
    if (id === undefined) {
      id = this.pool.intern_key(normalized);
      this.keyCache.set(normalized, id);
    }
    return id;
  }

  private readEvents(ptr: number, len: number): WasmPermitEvent[] {
    if (ptr === 0 || len <= 1) return [];
    const words = new Uint32Array(this.pool.memory().buffer, ptr, len);
    const count = words[0] >>> 0;
    const out: WasmPermitEvent[] = [];
    for (let i = 0; i < count; i++) {
      const base = 1 + i * 3;
      if (base + 2 >= words.length) break;
      out.push({
        subjectId: words[base] >>> 0,
        permitId: words[base + 1] >>> 0,
        keyId: words[base + 2] >>> 0,
      });
    }
    return out;
  }
}

export function makeWasmHttpPermitPool(options: { concurrency: number; maxQueue: number; queueTimeoutMs: number }): WasmHttpPermitPoolBridge {
  const mod = resolveWasmModule() as { BrassWasmHttpPermitPool?: WasmHttpPermitPoolCtor } | null;
  const Ctor = mod?.BrassWasmHttpPermitPool;
  if (!Ctor) throw new Error("brass-runtime wasm HTTP permit pool is not available. Run npm run build:wasm first.");
  return new WasmHttpPermitPoolBridge(Ctor, options);
}

function toU64(value: number): bigint {
  return BigInt(Math.max(0, Math.floor(value)));
}
