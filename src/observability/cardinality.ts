import type { Counter, Gauge, Histogram, MetricSnapshot, MetricsRegistry } from "../core/runtime/metrics";

export type CardinalityLimiterOptions = {
  readonly maxValuesPerLabel?: number;
  readonly overflowValue?: string;
};

export type CardinalityConfig = false | CardinalityLimiterOptions;

export function makeCardinalityLimitedMetrics(
  registry: MetricsRegistry,
  options: CardinalityLimiterOptions = {}
): MetricsRegistry {
  const maxValuesPerLabel = Math.max(1, Math.floor(options.maxValuesPerLabel ?? 100));
  const overflowValue = options.overflowValue ?? "__overflow__";
  const seen = new Map<string, Set<string>>();

  const limitLabels = (metricName: string, labels: Record<string, string> = {}): Record<string, string> => {
    const out: Record<string, string> = {};

    for (const [label, value] of Object.entries(labels)) {
      const key = `${metricName}:${label}`;
      let values = seen.get(key);
      if (!values) {
        values = new Set();
        seen.set(key, values);
      }

      if (values.has(value) || values.size < maxValuesPerLabel) {
        values.add(value);
        out[label] = value;
      } else {
        out[label] = overflowValue;
      }
    }

    return out;
  };

  return {
    counter: (name: string, labels?: Record<string, string>): Counter =>
      registry.counter(name, limitLabels(name, labels)),
    gauge: (name: string, labels?: Record<string, string>): Gauge =>
      registry.gauge(name, limitLabels(name, labels)),
    histogram: (name: string, boundaries?: number[], labels?: Record<string, string>): Histogram =>
      registry.histogram(name, boundaries, limitLabels(name, labels)),
    snapshot: (): MetricSnapshot => registry.snapshot(),
    reset: () => {
      seen.clear();
      registry.reset();
    },
  };
}

export function normalizeHttpRoute(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const withoutQuery = path.split("?", 1)[0] ?? path;
  const normalized = withoutQuery
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ":id")
    .replace(/\b\d+\b/g, ":id");
  return normalized || "/";
}

export function sanitizeHttpTarget(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, "http://local");
    return `${parsed.pathname}${parsed.search ? "?[REDACTED]" : ""}`;
  } catch {
    const [withoutHash] = url.split("#", 1);
    const queryIndex = withoutHash.indexOf("?");
    return queryIndex < 0 ? withoutHash : `${withoutHash.slice(0, queryIndex)}?[REDACTED]`;
  }
}
