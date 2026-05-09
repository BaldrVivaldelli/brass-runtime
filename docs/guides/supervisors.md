# Supervisors

Supervisors let a runtime own groups of child fibers with explicit restart and
escalation policy. Use them for long-lived workers, polling loops, connection
refreshers, and other background work that should fail in a predictable shape.

```ts
import { Runtime, fixed, joinSupervised, makeSupervisor } from "brass-runtime";

const runtime = Runtime.make({});
const supervisor = makeSupervisor(runtime, {
  strategy: "one-for-one",
  restart: {
    mode: "on-failure",
    maxRestarts: 5,
    withinMs: 60_000,
    schedule: fixed(250),
  },
});

const worker = supervisor.start({
  name: "token-refresh",
  effect: () => refreshTokenLoop(),
});

await runtime.toPromise(joinSupervised(worker));
```

## Strategies

- `one-for-one`: restart only the child that failed.
- `all-for-one`: interrupt and restart siblings when one child fails.

## Restart Policy

`restart` can be `"never"`, `"always"`, `"on-failure"`, or an object:

```ts
const supervisor = makeSupervisor(runtime, {
  restart: {
    mode: "on-failure",
    maxRestarts: 10,
    withinMs: 30_000,
    delayMs: ({ restartCount }) => Math.min(1_000, restartCount * 100),
  },
});
```

For reusable timing behavior, pass a `Schedule`:

```ts
import { exponential, jitter, makeSupervisor } from "brass-runtime";

const supervisor = makeSupervisor(runtime, {
  restart: {
    mode: "on-failure",
    schedule: jitter(exponential(100, 5_000), { factor: 0.2 }),
  },
});
```

## Escalation

When the restart budget is exhausted, escalation controls what happens next:

- `shutdown` interrupts sibling fibers.
- `ignore` completes only the failed child and leaves siblings running.

```ts
const supervisor = makeSupervisor(runtime, {
  strategy: "all-for-one",
  restart: { mode: "on-failure", maxRestarts: 3 },
  escalation: "shutdown",
});
```

## Observability

Supervisors emit runtime events through the existing `RuntimeHooks` pipeline:

- `supervisor.child.start`
- `supervisor.child.end`
- `supervisor.child.restart`
- `supervisor.child.escalate`
- `supervisor.shutdown`

Attach an `EventBus`, metrics sink, structured logger, or observability preset
the same way you do for fibers/scopes.

## Shutdown

Call `shutdown()` during graceful process termination. It cancels pending
restart timers, interrupts running children, and completes when current child
fibers have observed interruption.

```ts
await runtime.toPromise(supervisor.shutdown());
```
