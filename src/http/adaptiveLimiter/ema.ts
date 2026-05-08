// src/http/adaptiveLimiter/ema.ts

/**
 * Exponential Moving Average computer.
 * Smooths latency samples using the formula: ema = α * sample + (1 - α) * previous_ema
 */
export class EmaComputer {
  private readonly alpha: number;
  private current: number | undefined = undefined;

  /**
   * @param alpha - Smoothing factor in (0, 1]. Higher values weight recent samples more.
   */
  constructor(alpha: number) {
    this.alpha = alpha;
  }

  /**
   * Update the EMA with a new sample and return the new EMA value.
   * On the first sample, the EMA is initialized to that sample.
   */
  update(sample: number): number {
    if (this.current === undefined) {
      this.current = sample;
    } else {
      this.current = this.alpha * sample + (1 - this.alpha) * this.current;
    }
    return this.current;
  }

  /** Returns the current EMA value, or undefined if no samples have been recorded. */
  get value(): number | undefined {
    return this.current;
  }

  /** Resets the EMA state. */
  reset(): void {
    this.current = undefined;
  }
}
