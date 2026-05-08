import { describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { Runtime } from "../../core/runtime/runtime";
import { createNodeDecompressor } from "../compression/decompressorNode";
import { createNoopDecompressor } from "../compression/decompressor.noop";
import { createDecompressor } from "../compression/decompressor";
import { isNodeEnvironment } from "../compression/environment";
import { emptyRequestCompressionStats, emptyStats } from "../compression/types";
import { sleepMs } from "../sleep";
import { makeWasmHttpPermitPool, WasmHttpPermitPoolBridge } from "../wasmPermitPool";

vi.mock("../../core/runtime/wasmModule", () => ({
  resolveWasmModule: vi.fn(),
}));

const rt = Runtime.make({});
const wait = () => new Promise((resolve) => setImmediate(resolve));

describe("compression small helpers", () => {
  it("creates mutable response and request stats with zero values", () => {
    expect(emptyStats()).toEqual({
      decompressed: { gzip: 0, br: 0, deflate: 0 },
      compressedBytes: 0,
      decompressedBytes: 0,
      passthroughCount: 0,
      errorCount: 0,
      unsupportedEncodingCount: 0,
    });
    expect(emptyRequestCompressionStats()).toEqual({
      compressedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      originalBytes: 0,
      compressedBytes: 0,
    });
  });

  it("passes data through in noop decompressor", () => {
    const decompressor = createNoopDecompressor();
    const input = new Uint8Array([1, 2, 3]);

    expect(decompressor.isPassthrough).toBe(true);
    expect(decompressor.decompress(input, "gzip")).toEqual({ ok: true, data: Buffer.from(input) });
  });

  it("decompresses supported Node encodings and reports unsupported/errors", () => {
    const decompressor = createNodeDecompressor(zlib);

    expect(decompressor.isPassthrough).toBe(false);
    expect(decompressor.decompress(zlib.gzipSync("gzip"), "gzip")).toMatchObject({ ok: true, data: Buffer.from("gzip") });
    expect(decompressor.decompress(zlib.brotliCompressSync("br"), "br")).toMatchObject({ ok: true, data: Buffer.from("br") });
    expect(decompressor.decompress(zlib.deflateSync("deflate"), "deflate")).toMatchObject({ ok: true, data: Buffer.from("deflate") });
    expect(decompressor.decompress(Buffer.from("x"), "identity" as any)).toEqual({
      ok: false,
      error: "Unsupported encoding: identity",
    });
    expect(decompressor.decompress(Buffer.from("not gzip"), "gzip")).toMatchObject({ ok: false });
  });

  it("detects Node and creates the Node decompressor in this environment", () => {
    expect(isNodeEnvironment()).toBe(true);
    expect(createDecompressor().isPassthrough).toBe(false);
  });
});

describe("sleepMs", () => {
  it("normalizes negative durations and supports interruption", async () => {
    await expect(rt.toPromise(sleepMs(-10))).resolves.toBeUndefined();

    const fiber = rt.fork(sleepMs(100));
    await wait();
    fiber.interrupt();
    await new Promise<void>((resolve) => fiber.join((exit) => {
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Interrupt" } });
      resolve();
    }));
  });
});

describe("WasmHttpPermitPoolBridge", () => {
  it("adapts permit decisions, events, stats, cancellation, and factory resolution", async () => {
    const wasmModule = await import("../../core/runtime/wasmModule");
    const resolveWasmModule = vi.mocked(wasmModule.resolveWasmModule);

    class FakePermitPool {
      readonly buffer = new ArrayBuffer(64);
      private last = 0;
      private keys = new Map<string, number>();

      constructor(
        readonly concurrency: number,
        readonly maxQueue: number,
        readonly queueTimeoutMs: bigint,
      ) {}

      memory() {
        return { buffer: this.buffer };
      }

      intern_key(key: string) {
        const existing = this.keys.get(key);
        if (existing !== undefined) return existing;
        const id = this.keys.size + 1;
        this.keys.set(key, id);
        return id;
      }

      acquire(_subjectId: number, _keyId: number) {
        this.last++;
        return this.last - 1;
      }

      last_permit_id() {
        return this.last;
      }

      release() {
        this.writeEvents(1, 10, 20, 30);
        return 4;
      }

      cancel() {
        return true;
      }

      advance_time() {
        this.writeEvents(2, 11, 21, 31, 12, 22, 32);
        return 4;
      }

      permit_events_len() {
        return 7;
      }

      next_deadline_ms() {
        return 123;
      }

      metric_u64(id: number) {
        return id + 100;
      }

      private writeEvents(...values: number[]) {
        new Uint32Array(this.buffer).set(values, 1);
      }
    }

    const bridge = new WasmHttpPermitPoolBridge(FakePermitPool, {
      concurrency: 2,
      maxQueue: 3,
      queueTimeoutMs: 4.9,
    });

    expect(bridge.acquire("   ", 1, -5)).toEqual({ kind: "run", keyId: 1, permitId: 1 });
    expect(bridge.acquire("alpha", 2, 10.9)).toEqual({ kind: "queued", keyId: 2, permitId: 2 });
    expect(bridge.acquire("alpha", 3, 11)).toEqual({ kind: "rejected", keyId: 2, permitId: 3 });
    expect(bridge.release(2, 20)).toEqual([{ subjectId: 10, permitId: 20, keyId: 30 }]);
    expect(bridge.advanceTime(30)).toEqual([
      { subjectId: 11, permitId: 21, keyId: 31 },
      { subjectId: 12, permitId: 22, keyId: 32 },
    ]);
    bridge.cancel(3);
    expect(bridge.nextDeadlineMs()).toBe(123);
    expect(bridge.stats()).toEqual({
      running: 100,
      queued: 101,
      acquired: 102,
      released: 103,
      rejected: 104,
      queueTimeouts: 105,
      keys: 106,
    });

    resolveWasmModule.mockReturnValueOnce({ BrassWasmHttpPermitPool: FakePermitPool });
    expect(makeWasmHttpPermitPool({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 1 })).toBeInstanceOf(WasmHttpPermitPoolBridge);

    resolveWasmModule.mockReturnValueOnce({});
    expect(() => makeWasmHttpPermitPool({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 1 })).toThrow(/wasm HTTP permit pool is not available/);
  });
});
