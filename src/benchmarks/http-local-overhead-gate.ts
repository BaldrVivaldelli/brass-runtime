#!/usr/bin/env tsx
// Feature: http-p99-consolidation, Benchmark regression gate
/**
 * Standalone entry point for the P99/P50 ratio regression gate.
 *
 * Runs the gated benchmark variants (1000 calls, 500 warmup, concurrency 8)
 * and asserts P99/P50 ≤ 4.0x for each. Exits non-zero on failure.
 *
 * Usage:
 *   npx tsx src/benchmarks/http-local-overhead-gate.ts
 *   npm run perf
 */

import { runP99Assertions, assertP99Ratio } from "./http-local-overhead.bench";

async function main(): Promise<void> {
  console.log("🏋️  P99/P50 Ratio Regression Gate");
  console.log("   Variants: default-proxy-effect-transport, default-proxy-effect-timeout-pool, axios-brass-promise-pool-timeout");
  console.log(`   Config: 1000 calls, 500 warmup, concurrency 8`);
  console.log();

  const results = await runP99Assertions();
  assertP99Ratio(results);
}

main().catch((err) => {
  console.error("P99 regression gate failed:", err);
  process.exit(1);
});
