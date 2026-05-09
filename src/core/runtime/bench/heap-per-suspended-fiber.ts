#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime, fromPromiseAbortable } from "../runtime";
import { Scheduler } from "../scheduler";
import type { HostExecutor } from "../hostAction";

export type HeapPerSuspendedFiberArgs = {
  engine: "ts" | "wasm";
  fibers: number;
  delayMs: number;
  mode: "closure" | "host-action";
};

export type HeapPerSuspendedFiberResult = {
  engine: HeapPerSuspendedFiberArgs["engine"];
  mode: HeapPerSuspendedFiberArgs["mode"];
  fibers: number;
  delayMs: number;
  sum: number;
  before: ReturnType<typeof sample>;
  plateau: ReturnType<typeof sample>;
  after: ReturnType<typeof sample>;
  perSuspendedFiber: {
    heapUsed: number;
    rss: number;
    external: number;
  };
  stats: ReturnType<Runtime<unknown>["stats"]>;
};

const DEFAULT_ARGS: HeapPerSuspendedFiberArgs = {
  engine: "wasm",
  fibers: 10_000,
  delayMs: 2_000,
  mode: "host-action",
};

if (isDirectCli()) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await measureHeapPerSuspendedFiber(args);
  console.log(JSON.stringify(result, null, 2));
}

export async function measureHeapPerSuspendedFiber(
  input: Partial<HeapPerSuspendedFiberArgs> = {},
): Promise<HeapPerSuspendedFiberResult> {
  const args: HeapPerSuspendedFiberArgs = { ...DEFAULT_ARGS, ...input };
  const hostExecutor: HostExecutor = {
    async execute(_action, context) {
      await sleepAbortable(args.delayMs, context.signal);
      return { kind: "ok", value: 1 };
    },
  };

  const schedulerCapacity = Math.max(1024, args.fibers + 1024);
  const scheduler = new Scheduler({
    initialCapacity: schedulerCapacity,
    maxCapacity: schedulerCapacity,
    laneCapacity: schedulerCapacity,
  });
  const runtime = new Runtime({
    env: {},
    engine: args.engine,
    hostExecutor,
    scheduler,
    wasm: {
      readyQueue: {
        laneCapacity: schedulerCapacity,
        flushBudget: Math.min(4096, schedulerCapacity),
      },
    },
  });

  try {
    gcIfAvailable();
    const before = sample("before");

    const fibers = [];
    for (let i = 0; i < args.fibers; i += 1) {
      const effect = args.mode === "closure"
        ? fromPromiseAbortable<unknown, number>(async (signal) => {
            await sleepAbortable(args.delayMs, signal);
            return 1;
          }, (error) => error)
        : { _tag: "HostAction", action: { kind: "custom", target: "sleep", timeoutMs: args.delayMs + 100 } };
      fibers.push(runtime.fork(effect as any));
    }

    await wait(Math.min(250, Math.max(20, Math.floor(args.delayMs / 10))));
    gcIfAvailable();
    const plateau = sample("plateau");

    const results = await Promise.all(fibers.map((fiber) => new Promise<number>((resolve, reject) => {
      fiber.join((exit) => {
        if (exit._tag === "Success") resolve(Number(exit.value));
        else reject(exit.cause);
      });
    })));

    gcIfAvailable();
    const after = sample("after");

    const deltaHeap = plateau.heapUsed - before.heapUsed;
    const deltaRss = plateau.rss - before.rss;
    const deltaExternal = plateau.external - before.external;

    return {
      engine: args.engine,
      mode: args.mode,
      fibers: args.fibers,
      delayMs: args.delayMs,
      sum: results.reduce((acc, value) => acc + value, 0),
      before,
      plateau,
      after,
      perSuspendedFiber: {
        heapUsed: deltaHeap / args.fibers,
        rss: deltaRss / args.fibers,
        external: deltaExternal / args.fibers,
      },
      stats: runtime.stats(),
    };
  } finally {
    await runtime.shutdown();
  }
}

function sample(label: string) {
  const mem = process.memoryUsage();
  return {
    label,
    rss: mem.rss,
    heapTotal: mem.heapTotal,
    heapUsed: mem.heapUsed,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    timestamp: Date.now(),
  };
}

function gcIfAvailable(): void {
  const g = globalThis as typeof globalThis & { gc?: () => void };
  if (typeof g.gc === "function") g.gc();
}

function parseArgs(argv: string[]): HeapPerSuspendedFiberArgs {
  const out: HeapPerSuspendedFiberArgs = { ...DEFAULT_ARGS };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--engine" && value) out.engine = value as HeapPerSuspendedFiberArgs["engine"];
    if (key === "--fibers" && value) out.fibers = Number(value);
    if (key === "--delayMs" && value) out.delayMs = Number(value);
    if (key === "--mode" && value) out.mode = value as HeapPerSuspendedFiberArgs["mode"];
  }
  return out;
}

function isDirectCli(): boolean {
  const invoked = process.argv[1];
  return invoked ? resolve(invoked) === fileURLToPath(import.meta.url) : false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
