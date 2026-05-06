import { sanitizeLaneKey } from "../../scheduler";
import { resolveWasmModule } from "../../wasmModule";
import type { FiberId } from "../opcodes";

export type ReadyQueueScheduleKind = "micro" | "macro" | "none" | "dropped";

export type FiberReadyQueueStats = {
  readonly engine: "ts" | "wasm";
  readonly fallbackUsed: boolean;
  readonly data: unknown;
};

export interface FiberReadyQueue {
  readonly engine: "ts" | "wasm";
  enqueue(fiberId: FiberId, tag: string): ReadyQueueScheduleKind;
  beginFlush(): number;
  shift(): FiberId | undefined;
  endFlush(ran: number): ReadyQueueScheduleKind;
  len(): number;
  clear(): void;
  stats(): FiberReadyQueueStats;
}

const POLICY_MICRO = 0;
const POLICY_MACRO = 1;
const POLICY_NONE = 2;
const POLICY_DROPPED = 3;
const DEFAULT_FLUSH_BUDGET = 2048;
const DEFAULT_LANE_CAPACITY = 1024;
const DEFAULT_LANE_BUDGET = 64;
const DEFAULT_MAX_LANES = 256;

export type FiberReadyQueueOptions = {
  readonly engine?: "ts" | "wasm";
  readonly flushBudget?: number;
  readonly microThreshold?: number;
  readonly laneCapacity?: number;
  readonly laneBudget?: number;
  readonly maxLanes?: number;
};

type WasmFiberReadyQueueCtor = new (
  flushBudget: number,
  microThreshold: number,
  laneCapacity: number,
  laneBudget: number,
  maxLanes: number,
) => {
  enqueue_fiber(fiberId: number, tag: string): number;
  intern_lane?: (key: string) => number;
  enqueue_fiber_lane?: (fiberId: number, laneId: number) => number;
  begin_flush(): number;
  shift_fiber(): number;
  end_flush(ran: number): number;
  len(): number;
  clear(): void;
  stats_json(): string;
};

function resolveWasmReadyQueue(): WasmFiberReadyQueueCtor | null {
  const mod = resolveWasmModule() as { BrassWasmFiberReadyQueue?: WasmFiberReadyQueueCtor } | null;
  return mod?.BrassWasmFiberReadyQueue ?? null;
}

function decodePolicy(policy: number): ReadyQueueScheduleKind {
  switch (policy) {
    case POLICY_MICRO: return "micro";
    case POLICY_MACRO: return "macro";
    case POLICY_DROPPED: return "dropped";
    default: return "none";
  }
}

export function makeFiberReadyQueue(options: FiberReadyQueueOptions = {}): FiberReadyQueue {
  const requested = options.engine ?? "ts";
  if (requested === "ts") return new TsFiberReadyQueue(options);
  if (requested === "wasm") {
    const Ctor = resolveWasmReadyQueue();
    if (!Ctor) throw new Error("brass-runtime wasm fiber ready queue is not available. Run npm run build:wasm first.");
    return new WasmFiberReadyQueue(Ctor, options);
  }
  throw new Error(`brass-runtime fiber ready queue engine must be 'ts' or 'wasm'; received '${String(requested)}'`);
}

class WasmFiberReadyQueue implements FiberReadyQueue {
  readonly engine = "wasm" as const;
  private readonly queue: InstanceType<WasmFiberReadyQueueCtor>;
  private readonly laneCache = new Map<string, number>();

  constructor(Ctor: WasmFiberReadyQueueCtor, options: FiberReadyQueueOptions) {
    this.queue = new Ctor(
      options.flushBudget ?? DEFAULT_FLUSH_BUDGET,
      options.microThreshold ?? DEFAULT_FLUSH_BUDGET * 2,
      options.laneCapacity ?? DEFAULT_LANE_CAPACITY,
      options.laneBudget ?? DEFAULT_LANE_BUDGET,
      options.maxLanes ?? DEFAULT_MAX_LANES,
    );
    if (typeof this.queue.intern_lane !== "function" || typeof this.queue.enqueue_fiber_lane !== "function") {
      throw new Error("brass-runtime wasm fiber ready queue requires laneId/interning exports; TS/string fallback is disabled");
    }
  }

  enqueue(fiberId: FiberId, tag: string): ReadyQueueScheduleKind {
    const laneKey = inferLane(tag);
    let laneId = this.laneCache.get(laneKey);
    if (laneId === undefined) {
      laneId = this.queue.intern_lane!(laneKey);
      this.laneCache.set(laneKey, laneId);
    }
    return decodePolicy(this.queue.enqueue_fiber_lane!(fiberId, laneId));
  }

  beginFlush(): number { return this.queue.begin_flush(); }

  shift(): FiberId | undefined {
    const fiberId = this.queue.shift_fiber();
    return fiberId === 0 ? undefined : fiberId as FiberId;
  }

  endFlush(ran: number): ReadyQueueScheduleKind { return decodePolicy(this.queue.end_flush(ran)); }
  len(): number { return this.queue.len(); }
  clear(): void { this.queue.clear(); }

  stats(): FiberReadyQueueStats {
    return {
      engine: this.engine,
      fallbackUsed: false,
      data: JSON.parse(this.queue.stats_json()) as unknown,
    };
  }
}

type JsLane = {
  key: string;
  queue: FiberId[];
  head: number;
  len: number;
  enqueuedFibers: number;
  executedFibers: number;
  droppedFibers: number;
};

class TsFiberReadyQueue implements FiberReadyQueue {
  readonly engine = "ts" as const;
  private readonly lanes = new Map<string, JsLane>();
  private readonly laneOrder: string[] = [];
  private rrIndex = 0;
  private rrRemaining = 0;
  private phase: "idle" | "scheduled" | "flushing" = "idle";
  private totalLen = 0;
  private scheduledFlushes = 0;
  private completedFlushes = 0;
  private enqueuedFibers = 0;
  private executedFibers = 0;
  private droppedFibers = 0;
  private yieldedByBudget = 0;

  constructor(private readonly options: FiberReadyQueueOptions) {}

  enqueue(fiberId: FiberId, tag: string): ReadyQueueScheduleKind {
    const lane = this.getOrCreateLane(inferLane(tag));
    this.enqueuedFibers += 1;
    lane.enqueuedFibers += 1;
    const capacity = this.options.laneCapacity ?? DEFAULT_LANE_CAPACITY;
    if (lane.len >= capacity) {
      this.droppedFibers += 1;
      lane.droppedFibers += 1;
      return "dropped";
    }
    lane.queue[(lane.head + lane.len) % capacity] = fiberId;
    lane.len += 1;
    this.totalLen += 1;
    if (this.phase !== "idle") return "none";
    this.phase = "scheduled";
    this.scheduledFlushes += 1;
    return this.totalLen > (this.options.microThreshold ?? DEFAULT_FLUSH_BUDGET * 2) ? "macro" : "micro";
  }

  beginFlush(): number {
    if (this.phase === "flushing") return 0;
    if (this.totalLen === 0) {
      this.phase = "idle";
      return 0;
    }
    this.phase = "flushing";
    return Math.min(this.options.flushBudget ?? DEFAULT_FLUSH_BUDGET, this.totalLen);
  }

  shift(): FiberId | undefined {
    const n = this.laneOrder.length;
    if (n === 0) return undefined;

    if (this.rrRemaining > 0) {
      const idx = (this.rrIndex + n - 1) % n;
      const lane = this.lanes.get(this.laneOrder[idx]);
      const fiberId = lane ? this.shiftLane(lane) : undefined;
      if (fiberId !== undefined) {
        this.rrRemaining -= 1;
        return fiberId;
      }
      this.rrRemaining = 0;
    }

    for (let scanned = 0; scanned < n; scanned++) {
      const idx = this.rrIndex % n;
      this.rrIndex = (idx + 1) % n;
      const lane = this.lanes.get(this.laneOrder[idx]);
      if (!lane || lane.len === 0) continue;
      this.rrRemaining = Math.max(0, (this.options.laneBudget ?? DEFAULT_LANE_BUDGET) - 1);
      return this.shiftLane(lane);
    }
    return undefined;
  }

  endFlush(ran: number): ReadyQueueScheduleKind {
    this.completedFlushes += 1;
    if (this.totalLen === 0) {
      this.phase = "idle";
      return "none";
    }
    this.phase = "scheduled";
    this.scheduledFlushes += 1;
    if (ran >= (this.options.flushBudget ?? DEFAULT_FLUSH_BUDGET)) {
      this.yieldedByBudget += 1;
      return "macro";
    }
    return this.totalLen > (this.options.microThreshold ?? DEFAULT_FLUSH_BUDGET * 2) ? "macro" : "micro";
  }

  len(): number { return this.totalLen; }

  clear(): void {
    for (const lane of this.lanes.values()) {
      lane.queue.length = 0;
      lane.head = 0;
      lane.len = 0;
    }
    this.totalLen = 0;
    this.phase = "idle";
    this.rrIndex = 0;
    this.rrRemaining = 0;
  }

  stats(): FiberReadyQueueStats {
    const lanes = Array.from(this.lanes.values()).map((lane) => ({
      key: lane.key,
      len: lane.len,
      capacity: this.options.laneCapacity ?? DEFAULT_LANE_CAPACITY,
      enqueuedFibers: lane.enqueuedFibers,
      executedFibers: lane.executedFibers,
      droppedFibers: lane.droppedFibers,
    }));
    return {
      engine: this.engine,
      fallbackUsed: false,
      data: {
        phase: this.phase,
        len: this.totalLen,
        scheduledFlushes: this.scheduledFlushes,
        completedFlushes: this.completedFlushes,
        enqueuedFibers: this.enqueuedFibers,
        executedFibers: this.executedFibers,
        droppedFibers: this.droppedFibers,
        yieldedByBudget: this.yieldedByBudget,
        lanes,
      },
    };
  }

  private getOrCreateLane(key: string): JsLane {
    const existing = this.lanes.get(key);
    if (existing) return existing;
    const laneKey = this.lanes.size >= (this.options.maxLanes ?? DEFAULT_MAX_LANES) ? "overflow" : key;
    const overflow = this.lanes.get(laneKey);
    if (overflow) return overflow;
    const lane: JsLane = { key: laneKey, queue: [], head: 0, len: 0, enqueuedFibers: 0, executedFibers: 0, droppedFibers: 0 };
    this.lanes.set(laneKey, lane);
    this.laneOrder.push(laneKey);
    return lane;
  }

  private shiftLane(lane: JsLane): FiberId | undefined {
    if (lane.len === 0) return undefined;
    const capacity = this.options.laneCapacity ?? DEFAULT_LANE_CAPACITY;
    const fiberId = lane.queue[lane.head];
    lane.queue[lane.head] = 0 as FiberId;
    lane.head = (lane.head + 1) % capacity;
    lane.len -= 1;
    this.totalLen -= 1;
    this.executedFibers += 1;
    lane.executedFibers += 1;
    return fiberId;
  }
}

function inferLane(tag: string): string {
  const explicit = extractTaggedLane(tag, "lane:");
  if (explicit) return sanitizeLaneKey(explicit);
  const caller = extractTaggedLane(tag, "caller:");
  if (caller) return sanitizeLaneKey(caller);

  const firstSep = firstSeparatorIndex(tag);
  const first = firstSep < 0 ? tag : tag.slice(0, firstSep);
  return sanitizeLaneKey(first || "anonymous");
}

function extractTaggedLane(tag: string, prefix: string): string | undefined {
  if (!tag.startsWith(prefix)) return undefined;
  const end = tag.indexOf("|", prefix.length);
  if (end < 0) return undefined;
  const value = tag.slice(prefix.length, end);
  return value.length > 0 ? value : undefined;
}

function firstSeparatorIndex(value: string): number {
  let best = -1;
  for (const sep of [".", "#", "/"] as const) {
    const idx = value.indexOf(sep);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}
