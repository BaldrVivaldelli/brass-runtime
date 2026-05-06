import { PushStatus, RingBuffer } from "./ringBuffer";
import type { EngineStats } from "./engineStats";
import { resolveWasmModule } from "./wasmModule";

type RingBufferStatsData = {
  len: number;
  capacity: number;
  pushes: number;
  shifts: number;
  clears: number;
  dropped: number;
};

type RingLike<T> = {
  readonly length: number;
  readonly capacity: number;
  readonly engine: "ts" | "wasm";
  readonly fallbackUsed: boolean;
  isEmpty(): boolean;
  push(value: T): PushStatus;
  shift(): T | undefined;
  clear(): void;
  stats(): EngineStats<RingBufferStatsData>;
};

export type RingBufferEngine = "ts" | "wasm";

export type RingBufferOptions = {
  engine?: RingBufferEngine;
};

type WasmRingBufferCtor = new (initialCapacity: number, maxCapacity: number) => {
  len(): number;
  capacity(): number;
  is_empty(): boolean;
  push(value: unknown): number;
  shift(): unknown;
  clear(): void;
};

let cachedWasmCtor: WasmRingBufferCtor | null | undefined;

function resolveWasmRingBuffer(): WasmRingBufferCtor | null {
  if (cachedWasmCtor !== undefined) return cachedWasmCtor;

  const mod = resolveWasmModule() as { BrassWasmRingBuffer?: WasmRingBufferCtor } | null;
  cachedWasmCtor = mod?.BrassWasmRingBuffer ?? null;
  return cachedWasmCtor;
}

class WasmRingBuffer<T> implements RingLike<T> {
  readonly engine = "wasm" as const;
  readonly fallbackUsed = false;
  private readonly inner: InstanceType<WasmRingBufferCtor>;
  private pushes = 0;
  private shifts = 0;
  private clears = 0;
  private dropped = 0;

  constructor(initialCapacity: number, maxCapacity: number) {
    const Ctor = resolveWasmRingBuffer();
    if (!Ctor) {
      throw new Error("brass-runtime wasm ring buffer is not available. Run npm run build:wasm first.");
    }
    this.inner = new Ctor(initialCapacity, maxCapacity);
  }

  get length(): number {
    return this.inner.len();
  }

  get capacity(): number {
    return this.inner.capacity();
  }

  isEmpty(): boolean {
    return this.inner.is_empty();
  }

  push(value: T): PushStatus {
    this.pushes++;
    const status = this.inner.push(value) as PushStatus;
    if ((status & 2) !== 0) this.dropped++;
    return status;
  }

  shift(): T | undefined {
    const value = this.inner.shift();
    if (value !== undefined) this.shifts++;
    return value === undefined ? undefined : (value as T);
  }

  clear(): void {
    this.clears++;
    this.inner.clear();
  }

  stats(): EngineStats<RingBufferStatsData> {
    return {
      engine: "wasm",
      fallbackUsed: false,
      data: {
        len: this.length,
        capacity: this.capacity,
        pushes: this.pushes,
        shifts: this.shifts,
        clears: this.clears,
        dropped: this.dropped,
      },
    };
  }
}

class TsBoundedRingBuffer<T> implements RingLike<T> {
  readonly engine = "ts" as const;
  readonly fallbackUsed = false;
  private pushes = 0;
  private shifts = 0;
  private clears = 0;
  private dropped = 0;

  constructor(private readonly inner: RingBuffer<T>) {}

  get length(): number { return this.inner.length; }
  get capacity(): number { return this.inner.capacity; }
  isEmpty(): boolean { return this.inner.isEmpty(); }

  push(value: T): PushStatus {
    this.pushes++;
    const status = this.inner.push(value);
    if ((status & 2) !== 0) this.dropped++;
    return status;
  }

  shift(): T | undefined {
    const value = this.inner.shift();
    if (value !== undefined) this.shifts++;
    return value;
  }

  clear(): void {
    this.clears++;
    this.inner.clear();
  }

  stats(): EngineStats<RingBufferStatsData> {
    return {
      engine: "ts",
      fallbackUsed: false,
      data: {
        len: this.length,
        capacity: this.capacity,
        pushes: this.pushes,
        shifts: this.shifts,
        clears: this.clears,
        dropped: this.dropped,
      },
    };
  }
}

export function makeBoundedRingBuffer<T>(
  initialCapacity: number,
  maxCapacity: number = initialCapacity,
  options: RingBufferOptions = {}
): RingLike<T> {
  const engine = options.engine ?? "ts";

  if (engine === "ts") {
    return new TsBoundedRingBuffer<T>(new RingBuffer<T>(initialCapacity, maxCapacity));
  }

  if (engine === "wasm") {
    return new WasmRingBuffer<T>(initialCapacity, maxCapacity);
  }

  throw new Error(`brass-runtime ring buffer engine must be 'ts' or 'wasm'; received '${String(engine)}'`);
}

export type { RingLike as BoundedRingBuffer, RingBufferStatsData };
