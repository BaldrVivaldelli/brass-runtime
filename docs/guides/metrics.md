# Metrics

Lightweight metrics collection with counters, gauges, and histograms.

## Setup

```ts
import { makeMetrics } from "brass-runtime";

const metrics = makeMetrics();
```

## Counters

Monotonically increasing values (requests, errors, events):

```ts
const requestCount = metrics.counter("http_requests_total", { method: "GET" });
requestCount.increment();
requestCount.increment(5); // increment by 5

console.log(requestCount.value()); // 6
```

## Gauges

Values that go up and down (connections, queue depth):

```ts
const activeConns = metrics.gauge("active_connections");
activeConns.set(10);
activeConns.increment();   // 11
activeConns.decrement(3);  // 8

console.log(activeConns.value()); // 8
```

## Histograms

Distribution of values (latency, sizes):

```ts
const latency = metrics.histogram("request_duration_ms", [1, 5, 10, 25, 50, 100, 250, 500, 1000]);

latency.observe(42.5);
latency.observe(3.2);
latency.observe(150);

// Get percentiles
console.log(latency.percentile(50));  // p50
console.log(latency.percentile(95));  // p95
console.log(latency.percentile(99));  // p99

// Get bucket distribution
const buckets = latency.buckets();
// { boundaries: [...], counts: [...], sum: 195.7, count: 3, min: 3.2, max: 150 }
```

## Snapshot (export all metrics)

```ts
const snapshot = metrics.snapshot();
// {
//   counters: [{ name: "http_requests_total", labels: { method: "GET" }, value: 6 }],
//   gauges: [{ name: "active_connections", labels: {}, value: 8 }],
//   histograms: [{ name: "request_duration_ms", labels: {}, buckets: {...} }],
// }

// Export to Prometheus format, CloudWatch, etc.
```

## With effects

```ts
const requestCounter = metrics.counter("requests");
const latencyHist = metrics.histogram("latency_ms");

const instrumented = <R, E, A>(name: string, effect: Async<R, E, A>): Async<R, E, A> => {
  const start = performance.now();
  requestCounter.increment();
  
  return asyncFold(
    effect,
    (error) => {
      latencyHist.observe(performance.now() - start);
      metrics.counter("errors", { operation: name }).increment();
      return asyncFail(error);
    },
    (value) => {
      latencyHist.observe(performance.now() - start);
      return asyncSucceed(value);
    }
  );
};
```

## Reset (for testing)

```ts
metrics.reset(); // clears all counters, gauges, histograms
```
