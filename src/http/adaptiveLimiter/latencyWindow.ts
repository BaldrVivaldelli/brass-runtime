// src/http/adaptiveLimiter/latencyWindow.ts

/**
 * A fixed-size circular buffer that stores latency samples and supports
 * efficient min and percentile computation using the nearest-rank method.
 */
export class LatencyWindow {
  private readonly buffer: number[];
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
    this.buffer[this.head] = latencyMs;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  /**
   * Returns the minimum latency in the current window, or undefined if empty.
   */
  min(): number | undefined {
    if (this.count === 0) return undefined;
    let minVal = Infinity;
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - this.count + i + this.size) % this.size;
      if (this.buffer[idx] < minVal) minVal = this.buffer[idx];
    }
    return minVal;
  }

  /**
   * Computes the percentile using the nearest-rank method.
   * Returns undefined if fewer than 2 samples are present.
   * @param p - Percentile value in [0, 100]
   */
  percentile(p: number): number | undefined {
    if (this.count < 2) return undefined;
    const sorted = this.samples().sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(rank, sorted.length) - 1];
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
  private samples(): number[] {
    const result: number[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - this.count + i + this.size) % this.size;
      result[i] = this.buffer[idx];
    }
    return result;
  }
}
