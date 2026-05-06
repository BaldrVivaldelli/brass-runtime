import { resolveWasmModule } from "../../core/runtime/wasmModule";

type WasmRetryPlannerCtor = new () => {
  start(nowMs: number, maxRetries: number, baseDelayMs: number, maxDelayMs: number, maxElapsedMs: number, seed: number | bigint): number;
  next_delay_ms(retryId: number, nowMs: number, retryable: boolean, retryAfterMs: number): number;
  drop_state(retryId: number): boolean;
  metric_u64(id: number): number;
};

export type WasmRetryPlannerStats = {
  readonly live: number;
  readonly planned: number;
  readonly exhausted: number;
  readonly dropped: number;
};

export class WasmRetryPlannerBridge {
  private readonly planner: InstanceType<WasmRetryPlannerCtor>;

  constructor(Ctor: WasmRetryPlannerCtor) {
    this.planner = new Ctor();
  }

  start(options: { nowMs: number; maxRetries: number; baseDelayMs: number; maxDelayMs: number; maxElapsedMs?: number }): number {
    return this.planner.start(
      options.nowMs,
      options.maxRetries,
      options.baseDelayMs,
      options.maxDelayMs,
      options.maxElapsedMs ?? -1,
      BigInt(this.seed()),
    );
  }

  nextDelayMs(retryId: number, options: { nowMs: number; retryable: boolean; retryAfterMs?: number }): number | undefined {
    const delay = this.planner.next_delay_ms(retryId, options.nowMs, options.retryable, options.retryAfterMs ?? -1);
    return delay < 0 ? undefined : delay;
  }

  drop(retryId: number): void {
    this.planner.drop_state(retryId);
  }

  stats(): WasmRetryPlannerStats {
    return {
      live: this.planner.metric_u64(0),
      planned: this.planner.metric_u64(1),
      exhausted: this.planner.metric_u64(2),
      dropped: this.planner.metric_u64(3),
    };
  }

  private seed(): number {
    return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  }
}

export function makeWasmRetryPlanner(): WasmRetryPlannerBridge {
  const mod = resolveWasmModule() as { BrassWasmRetryPlanner?: WasmRetryPlannerCtor } | null;
  const Ctor = mod?.BrassWasmRetryPlanner;
  if (!Ctor) throw new Error("brass-runtime wasm retry planner is not available. Run npm run build:wasm first.");
  return new WasmRetryPlannerBridge(Ctor);
}
