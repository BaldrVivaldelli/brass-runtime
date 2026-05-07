# Tracing

OpenTelemetry-compatible span generation for effects.

## Setup

```ts
import { makeTracer } from "brass-runtime";

const tracer = makeTracer({
  serviceName: "my-api",
  sampleRate: 1.0, // sample everything (use 0.1 for 10% in production)
  onSpanEnd: (span) => {
    // Export to your backend (Jaeger, Zipkin, etc.)
    console.log(`[${span.status}] ${span.name}: ${span.endTime! - span.startTime}ms`);
  },
});
```

## Wrapping effects in spans

```ts
// Wrap any effect in a span
const result = await run(
  tracer.span("fetchUser", fetchUser(userId), { userId })
);

// Nested spans
const result = await run(
  tracer.span("handleRequest", asyncFlatMap(
    tracer.span("validateInput", validate(input)),
    (valid) => tracer.span("processData", process(valid))
  ))
);
```

## Attributes

```ts
tracer.span("db.query", dbQuery(sql), {
  "db.system": "postgresql",
  "db.statement": sql,
  "db.name": "users",
});
```

## Inspecting spans (testing)

```ts
const tracer = makeTracer({ serviceName: "test" });

await run(tracer.span("myOp", asyncSucceed(42)));

const spans = tracer.spans();
expect(spans[0].name).toBe("myOp");
expect(spans[0].status).toBe("ok");
expect(spans[0].endTime! - spans[0].startTime).toBeLessThan(10);

tracer.clear(); // reset for next test
```

## Error spans

```ts
await run(tracer.span("failingOp", asyncFail("oops"))).catch(() => {});

const span = tracer.spans()[0];
expect(span.status).toBe("error");
expect(span.events[0].name).toBe("error");
expect(span.events[0].attributes!["error.message"]).toBe("oops");
```
