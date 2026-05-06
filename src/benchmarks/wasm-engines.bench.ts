import type { BenchmarkDef } from "./runner";
import { makeBoundedRingBuffer } from "../core/runtime/boundedRingBuffer";
import { Scheduler } from "../core/runtime/scheduler";
import { makeStreamChunker } from "../core/stream/chunks";

const OPS = 100_000;
const CHUNK_OPS = 50_000;
const CHUNK_SIZE = 256;

type Engine = "ts" | "wasm";

function ringBufferBench(engine: Engine): void {
  const q = makeBoundedRingBuffer<number>(1024, 1024, { engine });
  for (let i = 0; i < OPS; i++) q.push(i);
  for (let i = 0; i < OPS; i++) q.shift();
  const stats = q.stats();
  if (engine === "wasm" && stats.engine !== "wasm") throw new Error("expected wasm ring buffer");
}

function chunkBench(engine: Engine): void {
  const chunker = makeStreamChunker<number>(CHUNK_SIZE, { engine });
  let chunks = 0;
  for (let i = 0; i < CHUNK_OPS; i++) {
    chunker.push(i);
    if (chunker.isFull()) {
      chunks += chunker.takeChunk().length;
    }
  }
  if (!chunker.isEmpty()) chunks += chunker.takeChunk().length;
  if (chunks !== CHUNK_OPS) throw new Error(`lost items: ${chunks}/${CHUNK_OPS}`);
}

function schedulerBench(engine: Engine): Promise<void> {
  return new Promise<void>((resolve) => {
    const scheduler = new Scheduler({ engine, initialCapacity: 1024, maxCapacity: 8192 });
    let remaining = OPS;
    function step() {
      remaining--;
      if (remaining > 0) scheduler.schedule(step, "bench");
      else resolve();
    }
    scheduler.schedule(step, "bench-start");
  });
}

export const benchmarks: BenchmarkDef[] = [
  { name: `ring buffer ts (${OPS.toLocaleString()} push/shift)`, iterations: 50, warmup: 10, fn: () => ringBufferBench("ts") },
  { name: `ring buffer wasm (${OPS.toLocaleString()} push/shift)`, iterations: 50, warmup: 10, fn: () => ringBufferBench("wasm") },
  { name: `chunker ts (${CHUNK_OPS.toLocaleString()} items / ${CHUNK_SIZE})`, iterations: 50, warmup: 10, fn: () => chunkBench("ts") },
  { name: `chunker wasm (${CHUNK_OPS.toLocaleString()} items / ${CHUNK_SIZE})`, iterations: 50, warmup: 10, fn: () => chunkBench("wasm") },
  { name: `scheduler ts (${OPS.toLocaleString()} tasks)`, iterations: 20, warmup: 5, fn: () => schedulerBench("ts") },
  { name: `scheduler wasm (${OPS.toLocaleString()} tasks)`, iterations: 20, warmup: 5, fn: () => schedulerBench("wasm") },
];
