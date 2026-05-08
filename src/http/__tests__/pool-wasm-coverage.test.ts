import { describe, expect, it, vi } from "vitest";
import type { WasmPermitDecision, WasmPermitEvent } from "../wasmPermitPool";

vi.mock("../wasmPermitPool", () => ({
  makeWasmHttpPermitPool: vi.fn(),
}));

import { HttpConcurrencyPool } from "../pool";
import { makeWasmHttpPermitPool } from "../wasmPermitPool";

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class FakeWasmPermitPool {
  readonly cancels: number[] = [];
  readonly released: number[] = [];
  decisions: WasmPermitDecision[] = [];
  releaseEvents: WasmPermitEvent[] = [];
  timeoutEvents: WasmPermitEvent[] = [];
  deadline = -1;

  acquire(_key: string, _subjectId: number): WasmPermitDecision {
    return this.decisions.shift() ?? { kind: "run", keyId: 1, permitId: 1 };
  }

  release(keyId: number): WasmPermitEvent[] {
    this.released.push(keyId);
    return this.releaseEvents;
  }

  cancel(permitId: number): void {
    this.cancels.push(permitId);
  }

  advanceTime(): WasmPermitEvent[] {
    return this.timeoutEvents;
  }

  nextDeadlineMs(): number {
    return this.deadline;
  }

  stats() {
    return { wasm: true };
  }
}

describe("HttpConcurrencyPool WASM engine", () => {
  it("grants queued permits from WASM release events and exposes wasm stats", async () => {
    const fake = new FakeWasmPermitPool();
    fake.decisions = [
      { kind: "run", keyId: 11, permitId: 1 },
      { kind: "queued", keyId: 11, permitId: 2 },
    ];
    fake.releaseEvents = [{ subjectId: 2, permitId: 2, keyId: 11 }];
    vi.mocked(makeWasmHttpPermitPool).mockReturnValueOnce(fake as any);

    const pool = new HttpConcurrencyPool({ engine: "wasm", concurrency: 1, maxQueue: 1 });
    const lease1 = await pool.acquire("api", new AbortController().signal);
    const p2 = pool.acquire("api", new AbortController().signal);
    await wait();

    expect(pool.stats()).toMatchObject({ running: 1, queued: 1, wasm: { wasm: true } });
    lease1.release();
    const lease2 = await p2;
    expect(lease2.key).toBe("api");
    expect(fake.released).toEqual([11]);
    lease2.release();
    lease2.release();
    expect(pool.stats()).toMatchObject({ running: 0, acquired: 2, released: 2 });
  });

  it("rejects, aborts queued permits, times out queued permits, and validates engine config", async () => {
    expect(() => new HttpConcurrencyPool({ engine: "bad" as any })).toThrow(/HTTP pool engine/);

    const rejected = new FakeWasmPermitPool();
    rejected.decisions = [{ kind: "rejected", keyId: 1, permitId: 1 }];
    vi.mocked(makeWasmHttpPermitPool).mockReturnValueOnce(rejected as any);
    const rejectedPool = new HttpConcurrencyPool({ wasm: true, maxQueue: 0 });
    await expect(rejectedPool.acquire("api", new AbortController().signal)).rejects.toMatchObject({ _tag: "PoolRejected" });

    const aborted = new FakeWasmPermitPool();
    aborted.decisions = [{ kind: "queued", keyId: 2, permitId: 22 }];
    vi.mocked(makeWasmHttpPermitPool).mockReturnValueOnce(aborted as any);
    const abortPool = new HttpConcurrencyPool({ engine: "wasm", queueTimeoutMs: 0 });
    const controller = new AbortController();
    const abortedAcquire = abortPool.acquire("api", controller.signal);
    controller.abort();
    await expect(abortedAcquire).rejects.toEqual({ _tag: "Abort" });
    expect(aborted.cancels).toEqual([22]);

    const timedOut = new FakeWasmPermitPool();
    timedOut.decisions = [{ kind: "queued", keyId: 3, permitId: 33 }];
    timedOut.timeoutEvents = [{ subjectId: 3, permitId: 33, keyId: 3 }];
    timedOut.deadline = Date.now() - 1;
    vi.mocked(makeWasmHttpPermitPool).mockReturnValueOnce(timedOut as any);
    const timeoutPool = new HttpConcurrencyPool({ engine: "wasm", queueTimeoutMs: 5 });
    await expect(timeoutPool.acquire("api", new AbortController().signal)).rejects.toMatchObject({
      _tag: "PoolTimeout",
      key: "api",
    });
  });
});
