# 🛑 Cancellation & Interruption

This document explains **how cancellation works** in `brass-runtime`, what `Interrupted` means, and which rules `Async` effects must follow to be truly cancellable.

> TL;DR: if an `Async` blocks on external work (timers, fetch, streams, sockets), it **must be cancellable**. Cancellation propagates through **Scope** and via **Fiber.interrupt()**.

---

## Vocabulary

- **Fiber**: cooperative unit of execution (similar to a “green thread”).
- **Scope**: lifetime container that **owns fibers** and **finalizers**.
- **Interrupted**: cancellation signal. A *value* in the error channel (not a thrown JS exception).
- **Finalizer**: action executed when a scope closes (success, failure, or interruption).

---

## Semantic rules

### 1) What triggers interruption?

A fiber can be interrupted by:

- `fiber.interrupt()`
- `scope.close(...)` (interrupts all child fibers registered in that scope)
- closing a parent scope (propagates to subscopes)

### 2) How do you observe interruption?

Interruption is observed as:

- an `Exit` with `_tag: "Failure"` and `error: { _tag: "Interrupted" }`.

### 3) When does work actually stop?

Cancellation is **cooperative**:

- CPU-only work is interrupted at **checkpoints** (between interpreter steps).
- IO/timers/promises are interrupted **only if** the underlying `Async` supports cancellation (next section).

---

## Cancellable Async: the contract

An `Async<R, E, A>` that performs IO must be able to “detach” that IO when interrupted:

- **Timers**: `clearTimeout`, `clearInterval`
- **Fetch**: `AbortController` / `AbortSignal`
- **Streams**: `reader.cancel()`, `controller.abort()`, etc.

### Recommended primitive: `fromPromiseAbortable`

If your runtime provides `fromPromiseAbortable`, use it as the canonical way to wrap `Promise` + `AbortSignal` APIs.

Example: cancellable `sleep(ms)`

```ts
import type { Async } from "../core/types/asyncEffect";
import type { Interrupted } from "../core/runtime/fiber";
import { fromPromiseAbortable } from "../core/runtime/runtime";

export function sleep(ms: number): Async<unknown, Interrupted, void> {
  return fromPromiseAbortable<Interrupted, void>(
    (signal) =>
      new Promise<void>((resolve, reject) => {
        const id = setTimeout(resolve, ms);

        const onAbort = () => {
          clearTimeout(id);
          reject({ _tag: "Interrupted" } satisfies Interrupted);
        };

        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    (e) =>
      typeof e === "object" && e !== null && (e as any)._tag === "Interrupted"
        ? (e as Interrupted)
        : ({ _tag: "Interrupted" } as Interrupted)
  );
}
```

---

## Scope: finalizers and closing

### What does `scope.close()` do?

A `Scope` typically:

1) Marks the scope as closed
2) Interrupts child fibers registered in this scope
3) Runs finalizers (LIFO order)
4) Prevents new forks in this scope (depending on your implementation)

### Finalizers are guaranteed

A finalizer runs even when the scope closes due to:

- success
- failure
- interruption

This is the foundation of resource safety (ZIO-style):

- acquire
- use
- release

---

## Recommended deterministic test

This demonstrates that closing a scope interrupts timers:

```ts
import { Runtime } from "../core/runtime/runtime";
import { withScope } from "../core/runtime/scope";
import type { Exit } from "../core/types/effect";

const runtime = new Runtime({ env: {} });

withScope(runtime, (scope) => {
  const f = scope.fork(sleep(10_000));

  setTimeout(() => scope.close(), 50);

  f.join((ex: Exit<any, any>) => {
    console.log("fiber exit:", ex); // -> Failure(Interrupted)
  });
});
```

If the timer does not stop, verify:

- the runtime actually propagates cancellation to `fromPromiseAbortable`
- combinators are composing cancellation (e.g. `asyncFlatMap` / `asyncFold`)

---

## Common anti-patterns

### ❌ “sleep” implemented only with setTimeout (no cancellation)
If you don’t clear the timer on interrupt, the fiber can still complete with success after a scope closes.

### ❌ Creating “detached” scopes inside combinators
Avoid `new Scope(runtime)` inside operators when it breaks the parent/child relationship.
Prefer `parentScope.subScope()` or a “current scope” inherited by the fiber.

### ❌ Mixing HTTP “Abort” and runtime “Interrupted” without a rule
At the HTTP layer it’s fine to map interruption to `{ _tag: "Abort" }`, but document that convention.

---

## Implementation checklist

- [ ] `Scope.close()` interrupts child fibers
- [ ] `Fiber.interrupt()` results in `Exit.Failure(Interrupted)`
- [ ] `fromPromiseAbortable` is aborted when the fiber is interrupted
- [ ] combinators (`asyncFlatMap`, `asyncFold`, etc.) compose cancellation
- [ ] finalizers always run (Success / Failure / Interrupted)
