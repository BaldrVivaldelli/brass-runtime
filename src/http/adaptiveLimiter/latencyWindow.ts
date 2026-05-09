// src/http/adaptiveLimiter/latencyWindow.ts

/**
 * A fixed-size circular buffer that stores latency samples and supports
 * efficient min and percentile computation using the nearest-rank method.
 *
 * The ring preserves eviction order while `sorted` keeps an exact sorted view.
 * Recording is O(windowSize) because it removes/inserts by binary search +
 * splice, but percentile reads are O(1) and avoid sorting on every call.
 */
export class LatencyWindow {
  private readonly buffer: Array<number | undefined>;
  private readonly sorted: number[] = [];
  private readonly size: number;
  private head = 0;
  private count = 0;

  constructor(size: number) {
    this.size = Math.max(2, Math.floor(size));
    this.buffer = new Array(this.size);
  }

  /**
   * Record a latency sample. Discards non-positive, NaN, and Infinity values.
   * Evicts the oldest sample when the buffer is full.
   */
  record(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) return;
    const evicted = this.buffer[this.head];
    if (evicted !== undefined && this.count === this.size) {
      this.removeSorted(evicted);
    }

    this.buffer[this.head] = latencyMs;
    this.insertSorted(latencyMs);
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  /**
   * Returns the minimum latency in the current window, or undefined if empty.
   */
  min(): number | undefined {
    return this.sorted[0];
  }

  /**
   * Computes the percentile using the nearest-rank method.
   * Returns undefined if fewer than 2 samples are present.
   * @param p - Percentile value in [0, 100]
   */
  percentile(p: number): number | undefined {
    if (this.count < 2) return undefined;
    const rank = Math.ceil((p / 100) * this.sorted.length);
    return this.sorted[Math.min(rank, this.sorted.length) - 1];
  }

  /**
   * Computes a percentile where newer samples receive exponentially higher
   * weight. A decay of 1 is identical to `percentile`; lower values adapt
   * faster to recent latency shifts.
   */
  weightedPercentile(p: number, decay: number): number | undefined {
    if (this.count < 2) return undefined;
    if (!Number.isFinite(decay) || decay >= 1) return this.percentile(p);

    const samples = this.samples();
    const weighted = samples.map((value, index) => ({
      value,
      weight: Math.pow(decay, samples.length - 1 - index),
    }));
    weighted.sort((a, b) => a.value - b.value);

    const total = weighted.reduce((sum, sample) => sum + sample.weight, 0);
    const target = (Math.max(0, Math.min(100, p)) / 100) * total;
    let cumulative = 0;
    for (const sample of weighted) {
      cumulative += sample.weight;
      if (cumulative >= target) return sample.value;
    }
    return weighted[weighted.length - 1]?.value;
  }

  /** Number of samples currently in the window. */
  get length(): number {
    return this.count;
  }

  /** Maximum capacity of the window. */
  get capacity(): number {
    return this.size;
  }

  /** Returns a copy of the current samples (oldest to newest). */
  samples(): number[] {
    const result: number[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - this.count + i + this.size) % this.size;
      result[i] = this.buffer[idx]!;
    }
    return result;
  }

  private insertSorted(value: number): void {
    const idx = this.lowerBound(value);
    this.sorted.splice(idx, 0, value);
  }

  private removeSorted(value: number): void {
    let idx = this.lowerBound(value);
    while (idx < this.sorted.length && this.sorted[idx] === value) {
      this.sorted.splice(idx, 1);
      return;
    }
  }

  private lowerBound(value: number): number {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
