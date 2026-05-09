import type { BenchmarkDef } from "./runner";
import { makeBoundedRingBuffer } from "../core/runtime/boundedRingBuffer";
import { Scheduler } from "../core/runtime/scheduler";
import { makeStreamChunker } from "../core/stream/chunks";

const TS_OPS = 1_000_000;
const WASM_OPS = 100_000;
const TS_CHUNK_OPS = 1_000_000;
const WASM_CHUNK_OPS = 100_000;
const CHUNK_SIZE = 256;

type Engine = "ts" | "wasm";

function ringBufferBench(engine: Engine, ops: number): void {
  const q = makeBoundedRingBuffer<number>(ops, ops, { engine });
  for (let i = 0; i < ops; i++) q.push(i);
  for (let i = 0; i < ops; i++) q.shift();
  const stats = q.stats();
  if (engine === "wasm" && stats.engine !== "wasm") throw new Error("expected wasm ring buffer");
}

function chunkBench(engine: Engine, ops: number): void {
  const chunker = makeStreamChunker<number>(CHUNK_SIZE, { engine });
  let chunks = 0;
  for (let i = 0; i < ops; i++) {
    chunker.push(i);
    if (chunker.isFull()) {
      chunks += chunker.takeChunk().length;
    }
  }
  if (!chunker.isEmpty()) chunks += chunker.takeChunk().length;
  if (chunks !== ops) throw new Error(`lost items: ${chunks}/${ops}`);
}

function schedulerBench(engine: Engine, ops: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const scheduler = new Scheduler({
      engine,
      laneMode: engine === "ts" ? "single" : "fair",
      flushBudget: engine === "ts" ? 8_192 : undefined,
      initialCapacity: 1024,
      maxCapacity: 8192,
    });
    let remaining = ops;
    function step() {
      remaining--;
      if (remaining > 0) scheduler.schedule(step, "bench");
      else resolve();
    }
    scheduler.schedule(step, "bench-start");
  });
}

export const benchmarks: BenchmarkDef[] = [
  { name: `ring buffer ts (${TS_OPS.toLocaleString()} push then shift)`, iterations: 30, warmup: 5, fn: () => ringBufferBench("ts", TS_OPS) },
  { name: `ring buffer wasm (${WASM_OPS.toLocaleString()} push then shift)`, iterations: 50, warmup: 10, fn: () => ringBufferBench("wasm", WASM_OPS) },
  { name: `chunker ts (${TS_CHUNK_OPS.toLocaleString()} items / ${CHUNK_SIZE})`, iterations: 30, warmup: 5, fn: () => chunkBench("ts", TS_CHUNK_OPS) },
  { name: `chunker wasm (${WASM_CHUNK_OPS.toLocaleString()} items / ${CHUNK_SIZE})`, iterations: 50, warmup: 10, fn: () => chunkBench("wasm", WASM_CHUNK_OPS) },
  { name: `scheduler ts (${TS_OPS.toLocaleString()} tasks)`, iterations: 10, warmup: 3, fn: () => schedulerBench("ts", TS_OPS) },
  { name: `scheduler wasm (${WASM_OPS.toLocaleString()} tasks)`, iterations: 20, warmup: 5, fn: () => schedulerBench("wasm", WASM_OPS) },
];
