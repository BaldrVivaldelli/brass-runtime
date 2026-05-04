import { resolveWasmModule } from "../../wasmModule";
import type { FiberId } from "../opcodes";

export type WasmFiberRegistryStats = {
  readonly live: number;
  readonly queued: number;
  readonly running: number;
  readonly suspended: number;
  readonly done: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly wakeQueueLen: number;
  readonly registered: number;
  readonly completed: number;
  readonly wakeups: number;
  readonly duplicateWakeups: number;
  readonly joins: number;
};

type WasmFiberRegistryCtor = new () => {
  register_fiber(fiberId: number, parentId: number, scopeId: number, nowMs: number): boolean;
  mark_queued(fiberId: number, nowMs: number): boolean;
  mark_running(fiberId: number, nowMs: number): boolean;
  mark_suspended(fiberId: number, nowMs: number): boolean;
  mark_done(fiberId: number, state: number, nowMs: number): number;
  drop_fiber(fiberId: number): boolean;
  add_joiner(fiberId: number): number;
  wake(fiberId: number): boolean;
  drain_wakeup(): number;
  wake_queue_len(): number;
  state_of(fiberId: number): number;
  stats_json(): string;
};

const FIBER_STATE_QUEUED = 0;
const FIBER_STATE_RUNNING = 1;
const FIBER_STATE_SUSPENDED = 2;
const FIBER_STATE_DONE = 3;
const FIBER_STATE_FAILED = 4;
const FIBER_STATE_INTERRUPTED = 5;

type FiberRegistryStatus = "queued" | "running" | "suspended" | "done" | "failed" | "interrupted";

export class WasmFiberRegistryBridge {
  private readonly registry: InstanceType<WasmFiberRegistryCtor>;

  constructor() {
    const mod = resolveWasmModule() as { BrassWasmFiberRegistry?: WasmFiberRegistryCtor } | null;
    const Ctor = mod?.BrassWasmFiberRegistry;
    if (!Ctor) {
      throw new Error("brass-runtime wasm fiber registry is not available. Run npm run build:wasm first.");
    }
    this.registry = new Ctor();
  }

  registerFiber(fiberId: FiberId, parentId?: number, scopeId?: number): void {
    this.registry.register_fiber(fiberId, parentId ?? 0, scopeId ?? 0, Date.now());
  }

  markQueued(fiberId: FiberId): void {
    this.registry.mark_queued(fiberId, Date.now());
  }

  markRunning(fiberId: FiberId): void {
    this.registry.mark_running(fiberId, Date.now());
  }

  markSuspended(fiberId: FiberId): void {
    this.registry.mark_suspended(fiberId, Date.now());
  }

  markDone(fiberId: FiberId, status: Exclude<FiberRegistryStatus, "queued" | "running" | "suspended">): number {
    return this.registry.mark_done(fiberId, statusToCode(status), Date.now());
  }

  dropFiber(fiberId: FiberId): void {
    this.registry.drop_fiber(fiberId);
  }

  addJoiner(fiberId: FiberId): void {
    this.registry.add_joiner(fiberId);
  }

  wake(fiberId: FiberId): boolean {
    return this.registry.wake(fiberId);
  }

  drainWakeup(): FiberId | undefined {
    const id = this.registry.drain_wakeup();
    return id === 0 ? undefined : id;
  }

  drainWakeups(): FiberId[] {
    const ids: FiberId[] = [];
    for (;;) {
      const id = this.drainWakeup();
      if (id === undefined) return ids;
      ids.push(id);
    }
  }

  wakeQueueLength(): number {
    return this.registry.wake_queue_len();
  }

  stateOf(fiberId: FiberId): FiberRegistryStatus | "missing" {
    const code = this.registry.state_of(fiberId);
    if (code === 0xffffffff) return "missing";
    return codeToStatus(code);
  }

  stats(): WasmFiberRegistryStats {
    return JSON.parse(this.registry.stats_json()) as WasmFiberRegistryStats;
  }
}

function statusToCode(status: FiberRegistryStatus): number {
  switch (status) {
    case "queued": return FIBER_STATE_QUEUED;
    case "running": return FIBER_STATE_RUNNING;
    case "suspended": return FIBER_STATE_SUSPENDED;
    case "done": return FIBER_STATE_DONE;
    case "failed": return FIBER_STATE_FAILED;
    case "interrupted": return FIBER_STATE_INTERRUPTED;
  }
}

function codeToStatus(code: number): FiberRegistryStatus | "missing" {
  switch (code) {
    case FIBER_STATE_QUEUED: return "queued";
    case FIBER_STATE_RUNNING: return "running";
    case FIBER_STATE_SUSPENDED: return "suspended";
    case FIBER_STATE_DONE: return "done";
    case FIBER_STATE_FAILED: return "failed";
    case FIBER_STATE_INTERRUPTED: return "interrupted";
    default: return "missing";
  }
}
