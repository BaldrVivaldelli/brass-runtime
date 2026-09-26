# API v2 preview

The v2 API is the package root. `brass-runtime/next` is kept as an alias so
preview code keeps resolving, and the frozen v1 surface moved to
`brass-runtime/v1`. The package declares Node `>=20` and is validated on Node
20, 22, and 24: Node 20 is compatibility-only because it is upstream EOL, while
Node 22 and 24 are the security-supported LTS lines.

The performance profiler and the WASM engine are separate installs
(`@brass/perf`, `@brass/engine-wasm`) rather than embedded payloads.

## Contract

The v2 root should expose concepts, not every implementation helper. Its runtime
surface currently has 20 values:

- `Effect`, `Cause`, and `Exit` for describing results and computations.
- `Runtime`, `makeRuntime`, `runPromise`, and `runExit` for execution.
- `Scope`, `ScopeFinalizerError`, and `withScopeAsync` for owned concurrency.
- `Resource`, `Layer`, and `Schedule` as discoverable domain namespaces.
- `Stream` and `Pipeline` for the small stream facade.
- `LayerContext`, `MissingLayerServiceError`, and `formatCause` for actionable
  diagnostics at application boundaries.
- `pipe` and `dual` for composition.

## Composition

Effects compose two ways, and both are first-class.

`Effect.gen` is the default for sequential programs. It keeps multi-step code
flat and infers a distinct type per step:

```ts
import { Effect, runPromise } from "brass-runtime";

const program = Effect.gen(function* ($) {
  const user = yield* $(fetchUser(id));
  const orders = yield* $(fetchOrders(user.id));
  return { user, orders };
});
```

Nothing runs until the effect is interpreted, each execution gets its own
iterator, and every `yield*` becomes an ordinary `FlatMap` node, so
interruption between steps behaves exactly as it does in a hand-written chain.
Environments accumulate as an intersection and failures as a union, matching
`flatMap`.

`pipe` is for linear transformation chains. Every transformation combinator on
the `Effect` namespace is dual, so it accepts both calling conventions:

```ts
import { Effect, pipe } from "brass-runtime";

// data-last, inside pipe
pipe(
  fetchUser(id),
  Effect.map((user) => user.name),
  Effect.catchAllWith(() => "anonymous"),
  Effect.timeout(1_000),
);

// data-first, unchanged from v1
Effect.map(fetchUser(id), (user) => user.name);
```

`dual` is exported so application code can build combinators with the same
convention. The v1 data-first functions in `core/types/effect` are untouched.

The root does not expose scheduler queues, concrete fiber interpreters, engine
bridges, WASM ABI helpers, benchmark controls, or registry implementation
details. Those remain available through v1 compatibility entrypoints while the
v2 migration is prepared.

## Migration shape

| v1 style | v2 preview |
| --- | --- |
| `succeed(value)` / `asyncSucceed(value)` | `Effect.succeed(value)` |
| `flatMap(effect, next)` / `asyncFlatMap(...)` | `Effect.flatMap(effect, next)` |
| nested `flatMap` chains | `Effect.gen(function* ($) { ... })` |
| manual combinator nesting | `pipe(effect, Effect.map(f))` |
| `toPromise(effect, env)` | `runPromise(effect, env)` |
| `sleep(ms)` | `Effect.sleep(ms)` |
| `retry(effect, policy)` | `Effect.retry(effect, policy)` |
| `layerValue(tag, value)` | `Layer.value(tag, value)` |
| `resource(acquire, release)` | `Resource.make(acquire, release)` |
| `fixed(ms)` | `Schedule.fixed(ms)` |
| `fromArray(values)` | `Stream.from(values)` |

Existing v1 imports remain supported. New documentation should prefer the
preview only when it can state clearly that the entrypoint is experimental.
The step-by-step and rollback path is in
[`migration-v1-to-v2.md`](./migration-v1-to-v2.md).

## Promotion gates

These were the conditions for promoting the facade to the root, and all of them hold:

1. The runtime value export count stays at or below 40.
2. The exact value surface and generated declaration contract are release-gated.
3. Core cancellation, scope, finalizer, and type-inference tests pass.
4. A packed-package smoke test validates Node, CJS, ESM, and browser imports.
5. A migration guide covers every removed or renamed v1 root export.

Gate 5 is machine-enforced by the generated
[`v1-to-v2-export-map.json`](./v1-to-v2-export-map.json): a build fails if any
v1 root symbol lacks either a v2 target or a stable `/core` compatibility
owner.

Agent, performance tooling, and editor integration are intentionally absent
from this facade. Agent and performance tooling have independently built
packages, and WASM is an optional `@brass/engine-wasm` peer in the beta.
