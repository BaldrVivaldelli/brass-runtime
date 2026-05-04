#!/usr/bin/env node
import { Runtime, fromPromiseAbortable } from "../runtime";
import { fromHostAction } from "../hostAction";
import type { HostExecutor } from "../hostAction";

type Args = {
  engine: "js" | "wasm" | "wasm-reference" | "auto";
  fibers: number;
  delayMs: number;
  mode: "closure" | "host-action";
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const hostExecutor: HostExecutor = {
    async execute(_action, context) {
      await sleepAbortable(args.delayMs, context.signal);
      return { kind: "ok", value: 1 };
    },
  };

  const runtime = new Runtime({ env: {}, engine: args.engine, hostExecutor });

  gcIfAvailable();
  const before = sample("before");

  const fibers = [];
  for (let i = 0; i < args.fibers; i += 1) {
    const effect = args.mode === "closure"
      ? fromPromiseAbortable<unknown, number>(async (signal) => {
          await sleepAbortable(args.delayMs, signal);
          return 1;
        }, (error) => error)
      : fromHostAction({ kind: "custom", target: "sleep", timeoutMs: args.delayMs + 100 });
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

  console.log(JSON.stringify({
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
  }, null, 2));

  await runtime.shutdown();
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

function parseArgs(argv: string[]): Args {
  const out: Args = {
    engine: "wasm-reference",
    fibers: 10_000,
    delayMs: 2_000,
    mode: "host-action",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--engine" && value) out.engine = value as Args["engine"];
    if (key === "--fibers" && value) out.fibers = Number(value);
    if (key === "--delayMs" && value) out.delayMs = Number(value);
    if (key === "--mode" && value) out.mode = value as Args["mode"];
  }
  return out;
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
