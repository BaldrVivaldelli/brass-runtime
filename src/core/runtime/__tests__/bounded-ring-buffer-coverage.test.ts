import { afterEach, describe, expect, it, vi } from "vitest";
import { PushStatus, RingBuffer } from "../ringBuffer";

afterEach(() => {
  vi.doUnmock("../wasmModule");
  vi.resetModules();
});

describe("bounded ring buffer coverage", () => {
  it("exercises the strict wasm-backed ring buffer adapter", async () => {
    class FakeWasmRingBuffer {
      private readonly values: unknown[] = [];
      constructor(readonly initialCapacity: number, readonly maxCapacity: number) {}
      len() { return this.values.length; }
      capacity() { return this.maxCapacity; }
      is_empty() { return this.values.length === 0; }
      push(value: unknown) {
        if (this.values.length >= this.maxCapacity) return PushStatus.Dropped;
        this.values.push(value);
        return PushStatus.Ok;
      }
      shift() { return this.values.shift(); }
      clear() { this.values.length = 0; }
    }

    vi.doMock("../wasmModule", () => ({
      resolveWasmModule: () => ({ BrassWasmRingBuffer: FakeWasmRingBuffer }),
    }));

    const { makeBoundedRingBuffer } = await import("../boundedRingBuffer");
    const buffer = makeBoundedRingBuffer<number>(2, 2, { engine: "wasm" });

    expect(buffer.isEmpty()).toBe(true);
    expect(buffer.push(1)).toBe(PushStatus.Ok);
    expect(buffer.push(2)).toBe(PushStatus.Ok);
    expect(buffer.push(3)).toBe(PushStatus.Dropped);
    expect(buffer.shift()).toBe(1);
    buffer.clear();

    expect(buffer.stats()).toEqual({
      engine: "wasm",
      fallbackUsed: false,
      data: {
        len: 0,
        capacity: 2,
        pushes: 3,
        shifts: 1,
        clears: 1,
        dropped: 1,
      },
    });
  });

  it("rejects unknown ring buffer engines and exposes TS emptiness", async () => {
    const { makeBoundedRingBuffer } = await import("../boundedRingBuffer");
    const plain = new RingBuffer<number>(2);

    expect(plain.isEmpty()).toBe(true);
    plain.push(1);
    expect(plain.isEmpty()).toBe(false);

    expect(() => makeBoundedRingBuffer(1, 1, { engine: "other" as any })).toThrow(
      /engine must be 'ts' or 'wasm'/,
    );
  });
});
