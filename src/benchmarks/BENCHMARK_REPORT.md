# Benchmark Report — Runtime Performance Optimization

**Date:** 2026-05-01
**Platform:** linux-x64
**Node:** v25.9.0
**All tests passing:** 194/194 ✅

---

## Results vs Targets

| Benchmark | Target | Actual (per-op) | p50 | p99 | Status |
|-----------|--------|-----------------|-----|-----|--------|
| FlatMap chain (1000 effects) | < 1ms/chain | **0.289ms** | 0.237ms | 0.704ms | ✅ PASS |
| Scheduler sequential (100k tasks) | < 50ms total | **1.295ms/iter** (64.7ms total / 50 iters) | 1.229ms | 3.155ms | ✅ PASS |
| Scheduler fan-out (100×1k tasks) | < 50ms total | **1.321ms/iter** (66.1ms total / 50 iters) | 1.311ms | 1.503ms | ✅ PASS |
| Queue sequential offer+take (10k) | < 10ms total | **12.4ms/iter** | 11.6ms | 20.0ms | ⚠️ ABOVE TARGET |
| Queue ping-pong (10k) | < 10ms total | **11.5ms/iter** | 11.1ms | 15.4ms | ⚠️ ABOVE TARGET |
| Queue sliding (10k, cap 64) | < 10ms total | **5.9ms/iter** | 5.5ms | 8.4ms | ✅ PASS |
| Stream map pipeline (10k) | < 50ms total | **90.4ms/iter** | 88.5ms | 106.0ms | ⚠️ ABOVE TARGET |
| Stream filter pipeline (10k) | < 50ms total | **30.2ms/iter** | 30.0ms | 33.5ms | ✅ PASS |
| Stream map+filter pipeline (10k) | < 50ms total | **19.1ms/iter** | 18.8ms | 25.0ms | ✅ PASS |

**Summary: 6 of 9 benchmarks meet targets.**

---

## Run-over-Run Stability

Comparison between the previous captured run and this fresh run to confirm results are stable and reproducible:

| Benchmark | Previous (per-op) | Current (per-op) | Delta |
|-----------|-------------------|-------------------|-------|
| FlatMap chain (1000) | 0.307ms | 0.289ms | -5.9% |
| Scheduler sequential (100k) | 1.269ms | 1.295ms | +2.0% |
| Scheduler fan-out (100×1k) | 1.363ms | 1.321ms | -3.1% |
| Queue sequential (10k) | 13.356ms | 12.401ms | -7.1% |
| Queue ping-pong (10k) | 11.897ms | 11.549ms | -2.9% |
| Queue sliding (10k) | 6.005ms | 5.922ms | -1.4% |
| Stream map (10k) | 91.673ms | 90.424ms | -1.4% |
| Stream filter (10k) | 29.890ms | 30.156ms | +0.9% |
| Stream map+filter (10k) | 19.063ms | 19.144ms | +0.4% |

All deltas are within normal run-to-run variance (< 8%), confirming stable, reproducible results.

---

## Analysis

### Benchmarks Meeting Targets (6/9)

1. **FlatMap chain** — 0.289ms per 1000-effect chain, well under the 1ms target (Req 11.1). The fiber interpreter optimizations (sync Async detection, cached boundStep, increased DEFAULT_BUDGET, FlatMap reassociation) deliver strong results. The p99 at 0.704ms still comfortably meets the target.

2. **Scheduler throughput** — Both sequential and fan-out scenarios complete 100k tasks in ~1.3ms per iteration (Req 11.2). The cached `boundFlush`, parallel arrays, and inline fast-paths are effective. Per-iteration time represents a single full run of 100k tasks through the scheduler.

3. **Queue sliding** — 5.9ms for 10k sliding operations, under the 10ms target (Req 11.3). The sliding strategy benefits from the RingBuffer optimizations (bitwise index, no-fill clear).

4. **Stream filter pipeline** — 30.2ms for 10k elements, under the 50ms target (Req 11.4).

5. **Stream map+filter composed pipeline** — 19.1ms for 10k elements through a composed map+filter pipeline, well under 50ms (Req 11.4). The pipeline combinator optimizations (reduced closures in mapP/filterP) are effective.

### Benchmarks Above Targets (3/9)

1. **Queue sequential & ping-pong** — 12.4ms and 11.5ms respectively, above the 10ms target. These scenarios build very long FlatMap chains (10k offer + 10k take = 20k effects chained) which stress the fiber interpreter. The overhead is in the effect chain construction and interpretation, not the queue data structure itself. The sliding benchmark (which uses the same queue internals but with a simpler access pattern) meets the target.

2. **Stream map-only pipeline** — 90.4ms, above the 50ms target. The map-only pipeline processes all 10k elements (no filtering), so every element goes through the full uncons→emit→transform→re-wrap cycle. The filter and map+filter pipelines are faster because they reduce the number of elements flowing through downstream stages. This suggests the per-element overhead in the stream pull machinery (scope management, effect interpretation per element) is the bottleneck for high-throughput pure-map scenarios.

### Key Observations

- **Effect interpretation is fast**: The core FlatMap chain benchmark shows the fiber interpreter is highly optimized at 0.289ms for 1000 effects.
- **Scheduler is efficient**: 100k tasks in ~1.3ms demonstrates minimal per-task overhead.
- **Stream per-element cost**: The stream pipeline overhead is dominated by the per-element pull cycle (uncons, scope, effect interpretation), not the pipeline combinators themselves. The composed map+filter is faster than map-only because filter reduces downstream work.
- **Queue overhead is chain-length dependent**: The queue benchmarks build 20k-effect chains, so the ~12ms result is consistent with the FlatMap chain benchmark (20k effects × ~0.289ms/1000 ≈ 5.8ms for interpretation alone, plus queue data structure operations).
- **Results are stable**: Run-over-run variance is within normal bounds, confirming the optimizations produce consistent performance.

---

## Raw JSON Results

See `results-post-optimization.json` for the full structured output.
