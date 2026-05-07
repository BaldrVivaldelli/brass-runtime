// src/core/runtime/metrics.ts
// Metrics — counters, gauges, and histograms for runtime observability.
//
// Provides lightweight metrics collection that can be exported to
// Prometheus, CloudWatch, or any monitoring backend.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricType = "counter" | "gauge" | "histogram";

export type MetricValue = {
  readonly name: string;
  readonly type: MetricType;
  readonly value: number;
  readonly labels: Record<string, string>;
  readonly timestamp: number;
};

export type HistogramBuckets = {
  readonly boundaries: readonly number[];
  counts: number[];
  sum: number;
  count: number;
  min: number;
  max: number;
};

export type MetricsRegistry = {
  /** Create or get a counter. */
  readonly counter: (name: string, labels?: Record<string, string>) => Counter;
  /** Create or get a gauge. */
  readonly gauge: (name: string, labels?: Record<string, string>) => Gauge;
  /** Create or get a histogram. */
  readonly histogram: (name: string, boundaries?: number[], labels?: Record<string, string>) => Histogram;
  /** Get all current metric values. */
  readonly snapshot: () => MetricSnapshot;
  /** Reset all metrics. */
  readonly reset: () => void;
};

export type Counter = {
  readonly increment: (n?: number) => void;
  readonly value: () => number;
};

export type Gauge = {
  readonly set: (value: number) => void;
  readonly increment: (n?: number) => void;
  readonly decrement: (n?: number) => void;
  readonly value: () => number;
};

export type Histogram = {
  readonly observe: (value: number) => void;
  readonly buckets: () => HistogramBuckets;
  readonly percentile: (p: number) => number;
};

export type MetricSnapshot = {
  readonly counters: Array<{ name: string; labels: Record<string, string>; value: number }>;
  readonly gauges: Array<{ name: string; labels: Record<string, string>; value: number }>;
  readonly histograms: Array<{ name: string; labels: Record<string, string>; buckets: HistogramBuckets }>;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_BOUNDARIES = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000];

/**
 * Creates a metrics registry.
 *
 * ```ts
 * const metrics = makeMetrics();
 *
 * const requestCount = metrics.counter("http_requests_total", { method: "GET" });
 * requestCount.increment();
 *
 * const latency = metrics.histogram("http_request_duration_ms");
 * latency.observe(42.5);
 *
 * const activeConns = metrics.gauge("active_connections");
 * activeConns.set(10);
 *
 * console.log(metrics.snapshot());
 * ```
 */
export function makeMetrics(): MetricsRegistry {
  const counters = new Map<string, { labels: Record<string, string>; value: number }>();
  const gauges = new Map<string, { labels: Record<string, string>; value: number }>();
  const histograms = new Map<string, { labels: Record<string, string>; data: HistogramBuckets; boundaries: number[] }>();

  const key = (name: string, labels?: Record<string, string>) =>
    labels ? `${name}|${Object.entries(labels).sort().map(([k, v]) => `${k}=${v}`).join(",")}` : name;

  const counter = (name: string, labels: Record<string, string> = {}): Counter => {
    const k = key(name, labels);
    if (!counters.has(k)) counters.set(k, { labels, value: 0 });
    const entry = counters.get(k)!;
    return {
      increment: (n = 1) => { entry.value += Math.max(0, n); },
      value: () => entry.value,
    };
  };

  const gauge = (name: string, labels: Record<string, string> = {}): Gauge => {
    const k = key(name, labels);
    if (!gauges.has(k)) gauges.set(k, { labels, value: 0 });
    const entry = gauges.get(k)!;
    return {
      set: (v) => { entry.value = v; },
      increment: (n = 1) => { entry.value += n; },
      decrement: (n = 1) => { entry.value -= n; },
      value: () => entry.value,
    };
  };

  const histogram = (name: string, boundaries: number[] = DEFAULT_BOUNDARIES, labels: Record<string, string> = {}): Histogram => {
    const k = key(name, labels);
    if (!histograms.has(k)) {
      const sorted = [...boundaries].sort((a, b) => a - b);
      histograms.set(k, {
        labels,
        boundaries: sorted,
        data: { boundaries: sorted, counts: new Array(sorted.length + 1).fill(0), sum: 0, count: 0, min: Infinity, max: -Infinity },
      });
    }
    const entry = histograms.get(k)!;
    return {
      observe: (value) => {
        entry.data.sum += value;
        entry.data.count++;
        entry.data.min = Math.min(entry.data.min, value);
        entry.data.max = Math.max(entry.data.max, value);
        // Find bucket
        let placed = false;
        for (let i = 0; i < entry.boundaries.length; i++) {
          if (value <= entry.boundaries[i]!) {
            entry.data.counts[i]!++;
            placed = true;
            break;
          }
        }
        if (!placed) entry.data.counts[entry.boundaries.length]!++;
      },
      buckets: () => ({ ...entry.data }),
      percentile: (p) => {
        const target = Math.ceil(entry.data.count * (p / 100));
        let cumulative = 0;
        for (let i = 0; i < entry.boundaries.length; i++) {
          cumulative += entry.data.counts[i]!;
          if (cumulative >= target) return entry.boundaries[i]!;
        }
        return entry.data.max;
      },
    };
  };

  return {
    counter,
    gauge,
    histogram,
    snapshot: () => ({
      counters: Array.from(counters.entries()).map(([k, v]) => ({ name: k.split("|")[0]!, labels: v.labels, value: v.value })),
      gauges: Array.from(gauges.entries()).map(([k, v]) => ({ name: k.split("|")[0]!, labels: v.labels, value: v.value })),
      histograms: Array.from(histograms.entries()).map(([k, v]) => ({ name: k.split("|")[0]!, labels: v.labels, buckets: v.data })),
    }),
    reset: () => { counters.clear(); gauges.clear(); histograms.clear(); },
  };
}
