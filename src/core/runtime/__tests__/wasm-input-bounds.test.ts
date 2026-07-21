import { describe, expect, it } from "vitest";
import { resolveWasmModule } from "../wasmModule";

type WasmConstructor<T = Record<string, (...args: never[]) => unknown>> = new (
  ...args: any[]
) => T;

const wasm = resolveWasmModule({ fresh: true });

function constructor<T>(name: string): WasmConstructor<T> {
  const value = wasm?.[name];
  if (typeof value !== "function") throw new Error(`${name} is unavailable`);
  return value as WasmConstructor<T>;
}

describe.runIf(wasm !== null)("real WASM input bounds", () => {
  it("rejects oversized collection and scheduler allocations before construction", () => {
    const Ring = constructor("BrassWasmRingBuffer");
    const Chunk = constructor("BrassWasmChunkBuffer");
    const Scheduler = constructor("BrassWasmSchedulerStateMachine");
    const ReadyQueue = constructor("BrassWasmFiberReadyQueue");
    const Timer = constructor("BrassWasmTimerWheel");
    const HttpPool = constructor("BrassWasmHttpPermitPool");

    expect(() => new Ring(1_048_577, 1_048_577)).toThrow(/capacity.*limit/i);
    expect(() => new Chunk(1_048_577)).toThrow(/capacity.*limit/i);
    expect(() => new Scheduler(2, 1_048_577, 64, 1_000, 1_024, 64, 256))
      .toThrow(/configuration.*limit/i);
    expect(() => new ReadyQueue(64, 1_000, 1_048_577, 64, 256))
      .toThrow(/configuration.*limit/i);
    expect(() => new Timer(1n, 1_048_577)).toThrow(/bucket.*limit/i);
    expect(() => new HttpPool(1_048_577, 0, 0n)).toThrow(/configuration.*limit/i);
  });

  it("rejects oversized ABI buffers and invalid retry numbers recoverably", () => {
    const Vm = constructor<{ prepare_program_words(words: number): number }>("BrassWasmVm");
    const Retry = constructor<{
      start(
        nowMs: number,
        maxRetries: number,
        baseDelayMs: number,
        maxDelayMs: number,
        maxElapsedMs: number,
        seed: bigint,
      ): number;
      next_delay_ms(id: number, nowMs: number, retryable: boolean, retryAfterMs: number): number;
    }>("BrassWasmRetryPlanner");

    const vm = new Vm();
    expect(() => vm.prepare_program_words(4_194_308)).toThrow(/program buffer.*limit/i);

    const retry = new Retry();
    expect(() => retry.start(Number.NaN, 1, 1, 10, 100, 1n)).toThrow(/invalid|unbounded/i);
    expect(() => retry.start(0, 65_537, 1, 10, 100, 1n)).toThrow(/invalid|unbounded/i);
    const id = retry.start(0, 1, 1, 10, 100, 1n);
    expect(retry.next_delay_ms(id, Number.POSITIVE_INFINITY, true, -1)).toBe(-1);
  });

  it("keeps recoverable JSON serialization compatible with the generated API", () => {
    const Chunk = constructor<{ push(value: unknown): boolean; stats_json(): string }>(
      "BrassWasmChunkBuffer",
    );
    const chunk = new Chunk(2);
    expect(chunk.push("one")).toBe(true);
    expect(JSON.parse(chunk.stats_json())).toMatchObject({ len: 1, maxChunkSize: 2 });
  });

  it("resets VM-owned fibers and diagnostics without replacing the wrapper", () => {
    const Vm = constructor<{
      create_fiber_bin(words: Uint32Array): number;
      reset(): void;
      stats_json(): string;
    }>("BrassWasmVm");
    const vm = new Vm();
    const fiberId = vm.create_fiber_bin(new Uint32Array([1, 0, 1, 0, 42, 0, 0]));
    expect(fiberId).toBeGreaterThan(0);
    expect(JSON.parse(vm.stats_json())).toMatchObject({ started: 1, live: 1 });

    vm.reset();

    expect(JSON.parse(vm.stats_json())).toMatchObject({ started: 0, live: 0 });
  });
});
