import { performance } from "perf_hooks";
import { Runtime } from "../src/core/runtime/runtime";
import { makeDefaultHttpClient } from "../src/http/defaultClient";
import { makeLifecycleClient } from "../src/http/lifecycle/lifecycleClient";
import { asyncSucceed } from "../src/core/types/asyncEffect";
import type { HttpTransport, HttpError, HttpWireResponse } from "../src/http/client";
import type { Async } from "../src/core/types/asyncEffect";

const gc = (globalThis as any).gc as (() => void) | undefined;
const CALLS = 5000;
const WARMUP = 3000;
const CONCURRENCY = 8;

const wireResponse = { status: 200, statusText: "OK", headers: {}, bodyText: '{"ok":true}', ms: 0 } as const;
const transport: HttpTransport = () => asyncSucceed(wireResponse) as Async<unknown, HttpError, HttpWireResponse>;

const baseConfig = {
  baseUrl: "http://localhost",
  transport,
};

const rt = Runtime.make({});

// Variant 1: Wire only (no lifecycle)
const wireClient = makeLifecycleClient({
  ...baseConfig,
  // No layers — zero-cost path
});

// Variant 2: Just dedup
const dedupClient = makeLifecycleClient({
  ...baseConfig,
  dedup: { dedupInflight: true },
});

// Variant 3: Just cache
const cacheClient = makeLifecycleClient({
  ...baseConfig,
  cache: { ttlMs: 60_000, maxSize: 1000 },
});

// Variant 4: Just priority
const priorityClient = makeLifecycleClient({
  ...baseConfig,
  priority: { maxConcurrency: 100 },
});

// Variant 5: All layers (full proxy preset)
const fullClient = makeLifecycleClient({
  ...baseConfig,
  dedup: { dedupInflight: true },
  cache: { ttlMs: 60_000, maxSize: 1000 },
  priority: { maxConcurrency: 100 },
});

// Variant 6: Default client (with all defaults)
const defaultClient = makeDefaultHttpClient({
  ...baseConfig,
  preset: "proxy",
});

function runLoad(client: any, calls: number, useGetJson = false): Promise<{ p50: number; p99: number }> {
  return new Promise((resolve) => {
    let next = 0, inFlight = 0, completed = 0;
    const latencies = new Array<number>(calls);
    const launch = () => {
      while (inFlight < CONCURRENCY && next < calls) {
        const idx = next++;
        inFlight++;
        const start = performance.now();
        const eff = useGetJson
          ? client.getJson(`/t?i=${idx}`)
          : client({ method: "GET", url: `/t?i=${idx}` });
        rt.unsafeRunAsync(eff, () => {
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
  await runLoad(wireClient, WARMUP);
  await runLoad(dedupClient, WARMUP);
  await runLoad(cacheClient, WARMUP);
  await runLoad(priorityClient, WARMUP);
  await runLoad(fullClient, WARMUP);
  await runLoad(defaultClient, WARMUP, true);
  if (gc) { gc(); await new Promise(r => setTimeout(r, 50)); }

  // Measure
  const wire = await runLoad(wireClient, CALLS);
  if (gc) { gc(); await new Promise(r => setTimeout(r, 20)); }
  const dedup = await runLoad(dedupClient, CALLS);
  if (gc) { gc(); await new Promise(r => setTimeout(r, 20)); }
  const cache = await runLoad(cacheClient, CALLS);
  if (gc) { gc(); await new Promise(r => setTimeout(r, 20)); }
  const priority = await runLoad(priorityClient, CALLS);
  if (gc) { gc(); await new Promise(r => setTimeout(r, 20)); }
  const full = await runLoad(fullClient, CALLS);
  if (gc) { gc(); await new Promise(r => setTimeout(r, 20)); }
  const def = await runLoad(defaultClient, CALLS, true);

  console.log("\n── Lifecycle Middleware Overhead ──\n");
  console.log(`  Wire only (zero-cost):    p50=${wire.p50.toFixed(3)}ms  p99=${wire.p99.toFixed(3)}ms`);
  console.log(`  + dedup:                  p50=${dedup.p50.toFixed(3)}ms  p99=${dedup.p99.toFixed(3)}ms  (+${(dedup.p50 - wire.p50).toFixed(3)}ms)`);
  console.log(`  + cache:                  p50=${cache.p50.toFixed(3)}ms  p99=${cache.p99.toFixed(3)}ms  (+${(cache.p50 - wire.p50).toFixed(3)}ms)`);
  console.log(`  + priority:               p50=${priority.p50.toFixed(3)}ms  p99=${priority.p99.toFixed(3)}ms  (+${(priority.p50 - wire.p50).toFixed(3)}ms)`);
  console.log(`  + all 3 (dedup+cache+pri):p50=${full.p50.toFixed(3)}ms  p99=${full.p99.toFixed(3)}ms  (+${(full.p50 - wire.p50).toFixed(3)}ms)`);
  console.log(`  Default client (proxy):   p50=${def.p50.toFixed(3)}ms  p99=${def.p99.toFixed(3)}ms`);
}

main().catch(console.error);
