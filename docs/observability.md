# 🔭 Observability: Hooks, Events, and Tracing

`brass-runtime` exposes **RuntimeHooks** to emit runtime events (fibers, scopes, logs) and connect sinks (console, in-memory, exporters).

This doc covers:

- which events exist
- what `RuntimeEmitContext` is
- how to fan-out sinks without blocking the runtime
- practical patterns for tracing (`traceId`, `spanId`) and structured logging

---

## Mental model: “emit is a controlled side-effect”

In a ZIO-style runtime the computation core aims to stay pure, but we still need:

- logs
- tracing
- latency / spans / scope lifecycle visibility

So we route side-effects through a small interface:

```ts
export interface RuntimeHooks {
  emit(ev: RuntimeEvent, ctx: RuntimeEmitContext): void;
}
```

The runtime calls `hooks.emit(...)` at well-defined points (fiber start/end, scope open/close, etc).

---

## RuntimeEvent + RuntimeEmitContext

A good split is:

- `RuntimeEvent`: what happened (the “what”)
- `RuntimeEmitContext`: current contextual info (the “where/with what trace”)

Useful context fields:

- `fiberId`, `scopeId`
- `traceId`, `spanId`

Most sinks want the **merged** view, so it’s convenient to define a record:

```ts
export type RuntimeEventRecord = RuntimeEvent & RuntimeEmitContext & {
  seq: number;
  wallTs: number;
  ts: number;
};
```

---

## EventBus: fan-out without blocking

If you have multiple sinks (console, in-memory tracer, exporter), avoid calling each sink inline from the runtime—slow sinks can stall execution.

Recommended pattern:

1) `EventBus` implements `RuntimeHooks`
2) `emit()` enqueues events (ring buffer)
3) `flush()` drains with a budget (microtask) and calls subscribers

This decouples runtime execution from sink speed.

---

## Should hooks be centralized or split?

✅ Centralizing is a good idea when you want:

- a single configuration point
- fan-out to multiple sinks
- backpressure / dropping policies
- global correlation (`seq`, etc.)

This doesn’t conflict with ZIO. In ZIO you “compose” logging/tracing via the environment; here `RuntimeHooks` is the equivalent boundary.

---

## Structured JSON log sink

Example sink printing JSON:

```ts
import type { RuntimeEvent } from "../core/runtime/events";

export const consoleJsonSink = () => (ev: RuntimeEvent) => {
  if (ev.type !== "log") return;
  const level = ev.level ?? "info";
  const out = { level, message: ev.message, fields: ev.fields ?? {} };
  if (level === "error") console.error(JSON.stringify(out));
  else console.log(JSON.stringify(out));
};
```

Recommendations:
- include `traceId/spanId` if available in context
- prefer structured data over free-form strings

---

## Tracing: propagating traceId/spanId

### Recommended fiber context model

- `traceId`: stable for a “request / operation”
- `spanId`: changes per sub-operation (e.g. fork child or scope span)

Simple policy:

- when forking, if parent has trace:
  - `traceId` = same
  - `spanId` = new
  - `parentSpanId` = parent’s span

### Where to store it

- in a per-fiber `FiberContext`
- and when emitting events, copy into `RuntimeEmitContext`

---

## InMemoryTracer (for tests)

Very useful for tests:

- store spans in memory
- verify they close
- export only finished spans

Recommendation: choose one mapping strategy:
- span per `scope.open/close`
- or span per `fiber.start/end`

---

## Practical recipes

### 1) Enabling observability in a Runtime

- create an `EventBus`
- subscribe sinks
- pass `hooks: eventBus` to the Runtime constructor

```ts
const bus = new EventBus();
bus.subscribe(consoleJsonSink());

const runtime = new Runtime({
  env: {},
  hooks: bus
});
```

### 2) Drop policy / budget
To avoid memory blowups:

- ring buffer per sink
- `flush()` budget
- emit a periodic “bus.dropped” warning

---

## Checklist

- [ ] `Runtime` accepts optional `hooks`
- [ ] `emit` is non-blocking (enqueue + microtask flush)
- [ ] at least one “official” log sink exists
- [ ] tracing propagates through fiber/scope context
- [ ] tests cover “spans close” and “no leaks”
