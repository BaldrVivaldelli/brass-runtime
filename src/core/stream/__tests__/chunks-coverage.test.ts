import { afterEach, describe, expect, it, vi } from "vitest";
import { Runtime } from "../../runtime/runtime";
import { asyncFail, asyncSucceed } from "../../types/asyncEffect";
import { collectStream, fromArray } from "../stream";

vi.mock("../../runtime/wasmModule", () => ({
  resolveWasmModule: vi.fn(),
}));

const rt = Runtime.make({});
const run = <A>(effect: any) => rt.toPromise(effect) as Promise<A>;

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("stream chunks", () => {
  it("chunks streams with TS chunker and exposes stats", async () => {
    const { chunks, makeStreamChunker } = await import("../chunks");
    const chunker = makeStreamChunker<number>(0);

    expect(chunker.maxChunkSize).toBe(1);
    expect(chunker.length).toBe(0);
    expect(chunker.isEmpty()).toBe(true);
    expect(chunker.push(1)).toBe(true);
    expect(chunker.push(2)).toBe(false);
    expect(chunker.isFull()).toBe(true);
    expect(chunker.takeChunk()).toEqual([1]);
    expect(chunker.takeChunk()).toEqual([]);
    chunker.push(3);
    chunker.clear();
    expect(chunker.stats()).toEqual({
      engine: "ts",
      fallbackUsed: false,
      data: { len: 0, maxChunkSize: 1, emittedChunks: 1, emittedItems: 1, flushes: 2 },
    });

    await expect(run(collectStream(chunks(fromArray([1, 2, 3, 4, 5]), 2)))).resolves.toEqual([[1, 2], [3, 4], [5]]);
    await expect(run(collectStream(chunks(fromArray<number>([]), 2)))).resolves.toEqual([]);
  });

  it("maps chunks synchronously and with effects, including empty mapped chunks and failures", async () => {
    const { mapChunks, mapChunksEffect } = await import("../chunks");

    await expect(
      run(collectStream(mapChunks(fromArray([1, 2, 3, 4]), 2, (chunk) => chunk.map((n) => n * 10)))),
    ).resolves.toEqual([10, 20, 30, 40]);

    await expect(
      run(collectStream(mapChunks(fromArray([1, 2, 3]), 2, (chunk) => chunk.length === 2 ? [] : [chunk[0]!]))),
    ).resolves.toEqual([3]);

    await expect(
      run(collectStream(mapChunksEffect(2, (chunk: readonly number[]) => asyncSucceed(chunk.map((n) => String(n))))(fromArray([1, 2, 3])))),
    ).resolves.toEqual(["1", "2", "3"]);

    await expect(
      run(collectStream(mapChunksEffect(2, () => asyncFail("chunk-failed"))(fromArray([1, 2])))),
    ).rejects.toBe("chunk-failed");
  });

  it("uses WASM chunker when requested and rejects unavailable or invalid engines", async () => {
    const wasmModule = await import("../../runtime/wasmModule");
    const resolveWasmModule = vi.mocked(wasmModule.resolveWasmModule);

    class FakeChunkBuffer {
      private values: unknown[] = [];
      constructor(private readonly max: number) {}
      len() { return this.values.length; }
      max_chunk_size() { return this.max; }
      is_empty() { return this.values.length === 0; }
      is_full() { return this.values.length >= this.max; }
      push(value: unknown) {
        if (this.is_full()) return false;
        this.values.push(value);
        return true;
      }
      take_chunk() {
        const chunk = this.values;
        this.values = [];
        return chunk;
      }
      clear() { this.values = []; }
      stats_json() { return JSON.stringify({ len: this.values.length, maxChunkSize: this.max, emittedChunks: 0, emittedItems: 0, flushes: 0 }); }
    }

    resolveWasmModule.mockReturnValueOnce({ BrassWasmChunkBuffer: FakeChunkBuffer });
    const { makeStreamChunker } = await import("../chunks");
    const wasmChunker = makeStreamChunker<number>(2, { engine: "wasm" });
    expect(wasmChunker.push(1)).toBe(true);
    expect(wasmChunker.push(2)).toBe(true);
    expect(wasmChunker.push(3)).toBe(false);
    expect(wasmChunker.length).toBe(2);
    expect(wasmChunker.maxChunkSize).toBe(2);
    expect(wasmChunker.isFull()).toBe(true);
    expect(wasmChunker.takeChunk()).toEqual([1, 2]);
    expect(wasmChunker.isEmpty()).toBe(true);
    wasmChunker.clear();
    expect(wasmChunker.stats()).toMatchObject({ engine: "wasm", fallbackUsed: false });
    expect(() => makeStreamChunker(2, { engine: "bad" as any })).toThrow(/stream chunk engine/);

    vi.resetModules();
    const freshWasmModule = await import("../../runtime/wasmModule");
    vi.mocked(freshWasmModule.resolveWasmModule).mockReturnValueOnce({});
    const { makeStreamChunker: makeFreshChunker } = await import("../chunks");
    expect(() => makeFreshChunker(2, { engine: "wasm" })).toThrow(/wasm chunk buffer is not available/);
  });
});
