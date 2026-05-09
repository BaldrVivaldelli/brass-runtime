import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BenchmarkDef } from "./runner";
import type {
  HeapPerSuspendedFiberArgs,
  HeapPerSuspendedFiberResult,
} from "../core/runtime/bench/heap-per-suspended-fiber";

const FIBERS = 10_000;
const DELAY_MS = 250;
const HEAP_BENCH_SCRIPT = fileURLToPath(new URL("../core/runtime/bench/heap-per-suspended-fiber.ts", import.meta.url));

function heapBench(
  engine: HeapPerSuspendedFiberArgs["engine"],
  mode: HeapPerSuspendedFiberArgs["mode"],
) {
  return async () => {
    const result = await runHeapBenchWithGc({
      engine,
      mode,
      fibers: FIBERS,
      delayMs: DELAY_MS,
    });

    return {
      engine: result.engine,
      mode: result.mode,
      fibers: result.fibers,
      gc: true,
      heapPerFiberBytes: Math.round(result.perSuspendedFiber.heapUsed),
      rssPerFiberBytes: Math.round(result.perSuspendedFiber.rss),
      externalPerFiberBytes: Math.round(result.perSuspendedFiber.external),
    };
  };
}

function runHeapBenchWithGc(args: HeapPerSuspendedFiberArgs): Promise<HeapPerSuspendedFiberResult> {
  const cliArgs = [
    "--expose-gc",
    "--import",
    "tsx",
    HEAP_BENCH_SCRIPT,
    "--engine",
    args.engine,
    "--mode",
    args.mode,
    "--fibers",
    String(args.fibers),
    "--delayMs",
    String(args.delayMs),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`heap benchmark child exited with ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as HeapPerSuspendedFiberResult);
      } catch (error) {
        reject(new Error(`heap benchmark child returned invalid JSON: ${String(error)}\n${stdout}\n${stderr}`));
      }
    });
  });
}

export const benchmarks: BenchmarkDef[] = [
  {
    name: `heap per suspended fiber ts closure (${FIBERS.toLocaleString()} fibers)`,
    iterations: 1,
    warmup: 0,
    fn: heapBench("ts", "closure"),
  },
  {
    name: `heap per suspended fiber wasm host-action (${FIBERS.toLocaleString()} fibers)`,
    iterations: 1,
    warmup: 0,
    fn: heapBench("wasm", "host-action"),
  },
];

export default benchmarks;
