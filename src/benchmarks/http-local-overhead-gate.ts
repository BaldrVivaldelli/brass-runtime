#!/usr/bin/env tsx
// Feature: http-p99-consolidation, Benchmark regression gate
/**
 * Standalone entry point for the P99/P50 ratio regression gate.
 *
 * Runs the gated benchmark variants with GC forcing between variants
 * for stable P99 measurements. Uses --expose-gc when available.
 *
 * Usage:
 *   node --expose-gc node_modules/.bin/tsx src/benchmarks/http-local-overhead-gate.ts
 *   npx tsx src/benchmarks/http-local-overhead-gate.ts
 *   npm run perf
 */

import { runP99Assertions, assertP99Ratio } from "./http-local-overhead.bench";

const gc = (globalThis as any).gc as (() => void) | undefined;

async function main(): Promise<void> {
  const hasGC = typeof gc === "function";
  console.log("🏋️  P99/P50 Ratio Regression Gate");
  console.log("   Variants: default-proxy-effect-transport, default-proxy-effect-timeout-pool");
  console.log(`   Config: 2000 calls, 2000 warmup, concurrency 8`);
  console.log(`   GC control: ${hasGC ? "enabled (--expose-gc)" : "unavailable (run with node --expose-gc for best results)"}`);
  console.log();

  // Force GC before starting to reduce initial heap pressure
  if (hasGC) {
    gc!();
    gc!();
    await new Promise((r) => setTimeout(r, 100));
  }

  const results = await runP99Assertions();
  assertP99Ratio(results);
}

main().catch((err) => {
  console.error("P99 regression gate failed:", err);
  process.exit(1);
});
