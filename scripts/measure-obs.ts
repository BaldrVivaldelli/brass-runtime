import { performance } from "perf_hooks";
import { Runtime } from "../src/core/runtime/runtime";
import { makeDefaultHttpClient } from "../src/http/defaultClient";
import { asyncSucceed } from "../src/core/types/asyncEffect";
import { makeObservability, withHttpObservability } from "../src/observability/index";
import type { HttpTransport, HttpError, HttpWireResponse } from "../src/http/client";
import type { Async } from "../src/core/types/asyncEffect";

const gc = (globalThis as any).gc as (() => void) | undefined;
const CALLS = 3000;
const WARMUP = 2000;
const CONCURRENCY = 8;

const wireResponse = { status: 200, statusText: "OK", headers: {}, bodyText: '{"ok":true}', ms: 0 } as const;
const transport: HttpTransport = () => asyncSucceed(wireResponse) as Async<unknown, HttpError, HttpWireResponse>;

// Client WITHOUT observability
const clientPlain = makeDefaultHttpClient({
  baseUrl: "http://localhost",
  preset: "proxy",
  transport,
});

// Client WITH observability (full featured)
const obsFull = makeObservability({ serviceName: "test" });
const clientObsFull = makeDefaultHttpClient({
  baseUrl: "http://localhost",
  preset: "proxy",
  transport,
  middleware: [withHttpObservability(obsFull)],
});

// Client WITH observability (metrics only - lean path)
const obsLean = makeObservability({ serviceName: "test", logs: false, traces: false });
const clientObsLean = makeDefaultHttpClient({
  baseUrl: "http://localhost",
  preset: "proxy",
  transport,
  middleware: [withHttpObservability({
    metrics: obsLean.metrics,
    logs: false,
    spans: false,
    injectTraceHeaders: false,
  })],
});

const rt = Runtime.make({});

function runLoad(client: { getJson: (url: string) => any }, calls: number): Promise<{ p50: number; p99: number }> {
  return new Promise((resolve) => {
    let next = 0, inFlight = 0, completed = 0;
    const latencies = new Array<number>(calls);
    const launch = () => {
      while (inFlight < CONCURRENCY && next < calls) {
        const idx = next++;
        inFlight++;
        const start = performance.now();
        rt.unsafeRunAsync(client.getJson("/t") as any, () => {
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

  // Warmup all
  await runLoad(clientPlain, WARMUP);
  await runLoad(clientObsFull, WARMUP);
  await runLoad(clientObsLean, WARMUP);
  if (gc) { gc(); await new Promise(r => setTimeout(r, 50)); }

  // Measure
  const plain = await runLoad(clientPlain, CALLS);
  if (gc) { gc(); await new Promise(r => setTimeout(r, 20)); }
  const obsLeanResult = await runLoad(clientObsLean, CALLS);
  if (gc) { gc(); await new Promise(r => setTimeout(r, 20)); }
  const obsFullResult = await runLoad(clientObsFull, CALLS);

  console.log("\n── Observability Overhead ──\n");
  console.log(`  No observability:    p50=${plain.p50.toFixed(3)}ms  p99=${plain.p99.toFixed(3)}ms`);
  console.log(`  Lean (metrics only): p50=${obsLeanResult.p50.toFixed(3)}ms  p99=${obsLeanResult.p99.toFixed(3)}ms  (+${(obsLeanResult.p50 - plain.p50).toFixed(3)}ms overhead)`);
  console.log(`  Full observability:  p50=${obsFullResult.p50.toFixed(3)}ms  p99=${obsFullResult.p99.toFixed(3)}ms  (+${(obsFullResult.p50 - plain.p50).toFixed(3)}ms overhead)`);
}

main().catch(console.error);
