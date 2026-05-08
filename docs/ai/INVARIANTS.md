# Invariants

These are the rules that make `brass-runtime` understandable. Treat them as
stronger than local convenience.

## Core effect invariants

- Effects are values. Constructing an effect must not run the side effect.
- `Async<R, E, A>` is the semantic async representation.
- `Promise` is an interop boundary, not the runtime primitive.
- Public helpers may expose `toPromise` for DX, but execution still belongs to
  the runtime/fiber interpreter.
- Synchronous loops must respect fiber/scheduler budgets.
- Failure must remain typed where the API promises typed errors.

## Cancellation and scopes

- Async operations should be cancelable whenever the host API allows it.
- If a host operation returns a canceler, the fiber must detach it when the
  operation completes.
- Child fibers belong to a scope or parent relationship.
- Closing a scope interrupts owned children and runs finalizers.
- Finalizers run exactly once and in reverse registration order.
- Await `closeAsync` when completion matters; `close` is fire-and-forget.

## Scheduler and fibers

- All async resumption goes back through the scheduler/fiber machinery.
- Fibers must not notify joiners more than once.
- Interrupt must be cooperative and idempotent.
- Runtime hooks must observe events without changing semantics.
- Lane/caller scheduling is metadata for fairness and observability, not a
  behavior change for user effects.

## Streams

- Streams are pull-based and lazy.
- End-of-stream is modeled separately from failure.
- Buffering must preserve the selected backpressure/drop strategy.
- Stream finalizers must cancel readers/producers.
- Fusion optimizations must not change ordering, failure, or cancellation.

## HTTP

- HTTP is built on top of runtime primitives; it is not part of the core.
- Request construction must stay lazy.
- Fetch cancellation must be wired to fiber interruption through
  `AbortController`.
- Keep wire, content, and metadata layers separate.
- Middleware transforms clients; it should not execute requests while being
  composed.
- Retry must respect method safety, retry budgets, aborts, pool rejection, and
  explicit per-request overrides.
- Compression/decompression must keep headers and body semantics explicit.
- Lifecycle cache/dedup/priority code must preserve cancellation ownership.

## WASM

- WASM mode is strict. If WASM is requested and unavailable, fail clearly.
- TypeScript and WASM engines should have parity tests for shared behavior.
- Generated `wasm/pkg` output is build output; source changes live in `crates/`
  and TypeScript bridge files.

## Agent

- `src/agent` may depend on runtime primitives.
- Core runtime must not depend on agent code.
- Discovery and patch application go through agent services and permission
  policies.
- Workspace reads/writes stay workspace-relative and policy-aware.
- Prompt/context helpers should be bounded and redaction-aware.

## When unsure

Before changing behavior, answer these:

- What owns this async operation?
- What cancels it?
- Which scope/fiber runs its finalizer?
- Is this public API or internal plumbing?
- Which tests encode the invariant I am touching?

