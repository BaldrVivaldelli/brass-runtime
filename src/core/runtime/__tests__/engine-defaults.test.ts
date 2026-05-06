import { describe, expect, it } from "vitest";
import { makeBoundedRingBuffer } from "../boundedRingBuffer";
import { makeStreamChunker } from "../../stream/chunks";
import { Scheduler } from "../scheduler";
import * as wasmModule from "../wasmModule";

/**
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5
 *
 * Tests that ring buffer, chunker, and scheduler default to the TS engine,
 * and that explicit engine: "wasm" configuration is respected.
 */
describe("Engine defaults", () => {
  describe("Ring buffer defaults to TS engine (Req 4.1)", () => {
    it("creates instance with engine ts by default", () => {
      const buf = makeBoundedRingBuffer<number>(10);
      const stats = buf.stats();
      expect(stats.engine).toBe("ts");
    });

    it("push/shift operations work with default engine", () => {
      const buf = makeBoundedRingBuffer<number>(4);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.length).toBe(3);
      expect(buf.shift()).toBe(1);
      expect(buf.shift()).toBe(2);
      expect(buf.shift()).toBe(3);
      expect(buf.shift()).toBeUndefined();
    });

    it("stats reflect ts engine after operations", () => {
      const buf = makeBoundedRingBuffer<number>(8);
      buf.push(10);
      buf.push(20);
      buf.shift();
      const stats = buf.stats();
      expect(stats.engine).toBe("ts");
      expect(stats.fallbackUsed).toBe(false);
      expect(stats.data.pushes).toBe(2);
      expect(stats.data.shifts).toBe(1);
      expect(stats.data.len).toBe(1);
    });
  });

  describe("StreamChunker defaults to TS engine (Req 4.2)", () => {
    it("creates instance with engine ts by default", () => {
      const chunker = makeStreamChunker<number>(5);
      const stats = chunker.stats();
      expect(stats.engine).toBe("ts");
    });

    it("add/flush operations work with default engine", () => {
      const chunker = makeStreamChunker<number>(3);
      chunker.push(1);
      chunker.push(2);
      chunker.push(3);
      expect(chunker.isFull()).toBe(true);
      const chunk = chunker.takeChunk();
      expect(chunk).toEqual([1, 2, 3]);
      expect(chunker.isEmpty()).toBe(true);
    });

    it("stats reflect ts engine after operations", () => {
      const chunker = makeStreamChunker<string>(4);
      chunker.push("a");
      chunker.push("b");
      chunker.takeChunk();
      const stats = chunker.stats();
      expect(stats.engine).toBe("ts");
      expect(stats.fallbackUsed).toBe(false);
      expect(stats.data.emittedChunks).toBe(1);
      expect(stats.data.emittedItems).toBe(2);
      expect(stats.data.flushes).toBe(1);
    });
  });

  describe("Scheduler defaults to TS engine (Req 4.3)", () => {
    it("creates instance with engine ts by default", () => {
      const scheduler = new Scheduler();
      const stats = scheduler.stats();
      expect(stats.engine).toBe("ts");
    });

    it("enqueue/flush operations work with default engine", async () => {
      const scheduler = new Scheduler();
      const results: number[] = [];
      scheduler.schedule(() => results.push(1), "test:task1");
      scheduler.schedule(() => results.push(2), "test:task2");
      // Wait for microtask flush
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(results).toEqual([1, 2]);
    });

    it("stats reflect ts engine after operations", () => {
      const scheduler = new Scheduler();
      scheduler.schedule(() => {}, "test:task");
      const stats = scheduler.stats();
      expect(stats.engine).toBe("ts");
      expect(stats.fallbackUsed).toBe(false);
      expect(stats.data.enqueuedTasks).toBe(1);
    });
  });

  describe("Explicit engine: 'wasm' configuration is respected (Req 4.4)", () => {
    it("ring buffer with engine wasm uses wasm engine when available", () => {
      wasmModule.resetWasmModuleCache();
      const wasmAvailable = wasmModule.resolveWasmModule() !== null;
      wasmModule.resetWasmModuleCache();

      if (wasmAvailable) {
        const buf = makeBoundedRingBuffer<number>(10, 10, { engine: "wasm" });
        expect(buf.stats().engine).toBe("wasm");
        buf.push(42);
        expect(buf.shift()).toBe(42);
      } else {
        expect(() => makeBoundedRingBuffer<number>(10, 10, { engine: "wasm" })).toThrow(
          /not available/i
        );
      }
    });

    it("chunker with engine wasm uses wasm engine when available", () => {
      wasmModule.resetWasmModuleCache();
      const wasmAvailable = wasmModule.resolveWasmModule() !== null;
      wasmModule.resetWasmModuleCache();

      if (wasmAvailable) {
        const chunker = makeStreamChunker<number>(5, { engine: "wasm" });
        expect(chunker.stats().engine).toBe("wasm");
        chunker.push(1);
        expect(chunker.isEmpty()).toBe(false);
      } else {
        expect(() => makeStreamChunker<number>(5, { engine: "wasm" })).toThrow(
          /not available/i
        );
      }
    });

    it("scheduler with engine wasm uses wasm engine when available", () => {
      wasmModule.resetWasmModuleCache();
      const wasmAvailable = wasmModule.resolveWasmModule() !== null;
      wasmModule.resetWasmModuleCache();

      if (wasmAvailable) {
        const scheduler = new Scheduler({ engine: "wasm" });
        expect(scheduler.stats().engine).toBe("wasm");
      } else {
        expect(() => new Scheduler({ engine: "wasm" })).toThrow(
          /not available/i
        );
      }
    });
  });
});
