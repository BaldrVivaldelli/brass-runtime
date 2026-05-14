import { performance } from "perf_hooks";
import { makeHttp } from "../src/http/client";
import { registerHttpEffect } from "../src/http/effectRunner";
import { asyncSucceed } from "../src/core/types/asyncEffect";
import { Runtime } from "../src/core/runtime/runtime";

const gc = (globalThis as any).gc as (() => void) | undefined;
const CALLS = 3000;
const WARMUP = 2000;
const CONCURRENCY = 8;

const transport = () => asyncSucceed({ status: 200, statusText: "OK", headers: {}, bodyText: '{"ok":true}', ms: 0 } as any);
const client = makeHttp({ baseUrl: "http://localhost", transport });
const rt = Runtime.make({});

type Result = { p50: number; p99: number };

function runWithRegister(calls: number, concurrency: number): Promise<Result> {
  return new Promise((resolve) => {
    let next = 0, inFlight = 0, completed = 0;
    const latencies = new Array<number>(calls);
    const launch = () => {
      while (inFlight < concurrency && next < calls) {
        const idx = next++;
        inFlight++;
        const start = performance.now();
        registerHttpEffect(client({ method: "GET", url: "/t" }), {}, () => {
          latencies[idx] = performance.now() - start;
          inFlight--;
          completed++;
          if (completed === calls) {
            latencies.sort((a, b) => a - b);
            resolve({ p50: latencies[Math.floor(calls * 0.5)], p99: latencies[Math.floor(calls * 0.99)] });
          } else { launch(); }
        });
      }
    };
    launch();
  });
}

function runWithRuntime(calls: number, concurrency: number): Promise<Result> {
  return new Promise((resolve) => {
    let next = 0, inFlight = 0, completed = 0;
    const latencies = new Array<number>(calls);
    const launch = () => {
      while (inFlight < concurrency && next < calls) {
        const idx = next++;
        inFlight++;
        const start = performance.now();
        rt.unsafeRunAsync(client({ method: "GET", url: "/t" }), () => {
          latencies[idx] = performance.now() - start;
          inFlight--;
          completed++;
          if (completed === calls) {
            latencies.sort((a, b) => a - b);
            resolve({ p50: latencies[Math.floor(calls * 0.5)], p99: latencies[Math.floor(calls * 0.99)] });
          } else { launch(); }
        });
      }
    };
    launch();
  });
}

function runRawPromise(calls: number, concurrency: number): Promise<Result> {
  return new Promise((resolve) => {
    let next = 0, inFlight = 0, completed = 0;
    const latencies = new Array<number>(calls);
    const launch = () => {
      while (inFlight < concurrency && next < calls) {
        const idx = next++;
        inFlight++;
        const start = performance.now();
        Promise.resolve({ status: 200 }).then(() => {
          latencies[idx] = performance.now() - start;
          inFlight--;
          completed++;
          if (completed === calls) {
            latencies.sort((a, b) => a - b);
            resolve({ p50: latencies[Math.floor(calls * 0.5)], p99: latencies[Math.floor(calls * 0.99)] });
          } else { launch(); }
        });
      }
    };
    launch();
  });
}

async function main() {
  if (gc) { gc(); gc(); }

  // Warmup all paths
  await runRawPromise(WARMUP, CONCURRENCY);
  await runWithRegister(WARMUP, CONCURRENCY);
  await runWithRuntime(WARMUP, CONCURRENCY);

  if (gc) { gc(); await new Promise(r => setTimeout(r, 50)); }

  // Measure
  const raw = await runRawPromise(CALLS, CONCURRENCY);
  if (gc) { gc(); await new Promise(r => setTimeout(r, 20)); }
  const reg = await runWithRegister(CALLS, CONCURRENCY);
  if (gc) { gc(); await new Promise(r => setTimeout(r, 20)); }
  const rtResult = await runWithRuntime(CALLS, CONCURRENCY);

  console.log("\n── P50 Breakdown ──\n");
  console.log(`  Raw Promise.resolve:     p50=${raw.p50.toFixed(3)}ms  p99=${raw.p99.toFixed(3)}ms`);
  console.log(`  registerHttpEffect:      p50=${reg.p50.toFixed(3)}ms  p99=${reg.p99.toFixed(3)}ms  (+${(reg.p50 - raw.p50).toFixed(3)}ms over raw)`);
  console.log(`  rt.unsafeRunAsync:       p50=${rtResult.p50.toFixed(3)}ms  p99=${rtResult.p99.toFixed(3)}ms  (+${(rtResult.p50 - raw.p50).toFixed(3)}ms over raw)`);
  console.log(`\n  Runtime overhead:        +${(rtResult.p50 - reg.p50).toFixed(3)}ms per request (p50)`);
  console.log(`  HTTP layer overhead:     +${(reg.p50 - raw.p50).toFixed(3)}ms per request (p50)`);
}

main().catch(console.error);
