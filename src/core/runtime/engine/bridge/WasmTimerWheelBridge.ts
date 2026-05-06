import { resolveWasmModule } from "../../wasmModule";

export type TimerEvent = {
  readonly timerId: number;
  readonly subjectId: number;
  readonly kind: number;
  readonly deadlineMs: number;
};

type WasmMemoryLike = { readonly buffer: ArrayBufferLike };

type WasmTimerWheelCtor = new (tickMs: number | bigint, bucketCount: number) => {
  memory(): WasmMemoryLike;
  schedule_deadline(subjectId: number, kind: number, deadlineMs: number | bigint): number;
  cancel(timerId: number): boolean;
  advance_time(nowMs: number | bigint): number;
  expired_len(): number;
  next_deadline_ms(): number;
  metric_u64(id: number): number;
  metrics_snapshot_ptr?: () => number;
  metrics_snapshot_len?: () => number;
};

export type WasmTimerWheelStats = {
  readonly live: number;
  readonly scheduled: number;
  readonly canceled: number;
  readonly expired: number;
  readonly buckets: number;
};

export class WasmTimerWheelBridge {
  private readonly wheel: InstanceType<WasmTimerWheelCtor>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onExpired: (events: readonly TimerEvent[]) => void;

  constructor(Ctor: WasmTimerWheelCtor, options: { tickMs?: number; bucketCount?: number; onExpired: (events: readonly TimerEvent[]) => void }) {
    this.wheel = new Ctor(toU64(options.tickMs ?? 10), options.bucketCount ?? 4096);
    this.onExpired = options.onExpired;
  }

  schedule(subjectId: number, kind: number, deadlineMs: number): number {
    const id = this.wheel.schedule_deadline(subjectId, kind, toU64(deadlineMs));
    this.schedulePump();
    return id;
  }

  cancel(timerId: number | undefined): void {
    if (timerId === undefined) return;
    this.wheel.cancel(timerId);
    this.schedulePump();
  }

  flush(nowMs = Date.now()): void {
    const ptr = this.wheel.advance_time(toU64(nowMs));
    const events = this.readEvents(ptr, this.wheel.expired_len());
    if (events.length > 0) this.onExpired(events);
    this.schedulePump();
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  stats(): WasmTimerWheelStats {
    return {
      live: this.wheel.metric_u64(0),
      scheduled: this.wheel.metric_u64(1),
      canceled: this.wheel.metric_u64(2),
      expired: this.wheel.metric_u64(3),
      buckets: this.wheel.metric_u64(4),
    };
  }

  private schedulePump(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.wheel.next_deadline_ms();
    if (!Number.isFinite(next) || next < 0) return;
    const delay = Math.max(0, Math.min(2 ** 31 - 1, Math.floor(next - Date.now())));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, delay);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private readEvents(ptr: number, len: number): TimerEvent[] {
    if (ptr === 0 || len <= 1) return [];
    const words = new Uint32Array(this.wheel.memory().buffer, ptr, len);
    const count = words[0] >>> 0;
    const out: TimerEvent[] = [];
    for (let i = 0; i < count; i++) {
      const base = 1 + i * 5;
      if (base + 4 >= words.length) break;
      const lo = words[base + 3] >>> 0;
      const hi = words[base + 4] >>> 0;
      out.push({
        timerId: words[base] >>> 0,
        subjectId: words[base + 1] >>> 0,
        kind: words[base + 2] >>> 0,
        deadlineMs: hi * 0x1_0000_0000 + lo,
      });
    }
    return out;
  }
}

export function makeWasmTimerWheel(options: { tickMs?: number; bucketCount?: number; onExpired: (events: readonly TimerEvent[]) => void }): WasmTimerWheelBridge {
  const mod = resolveWasmModule() as { BrassWasmTimerWheel?: WasmTimerWheelCtor } | null;
  const Ctor = mod?.BrassWasmTimerWheel;
  if (!Ctor) throw new Error("brass-runtime wasm timer wheel is not available. Run npm run build:wasm first.");
  return new WasmTimerWheelBridge(Ctor, options);
}

function toU64(value: number): bigint {
  return BigInt(Math.max(0, Math.floor(value)));
}
