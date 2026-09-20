# API v2 preview

`brass-runtime/next` is the additive preview of the future v2 root API. It lets
applications exercise a smaller facade without breaking the v1 compatibility
surface. The preview is experimental until a major release promotes it.

The installable beta candidate promotes that same facade to the package root,
keeps it aliased at `/next`, and moves the frozen root compatibility surface to
`/v1`. It requires Node 20 or 22 and is built locally with:

```bash
npm run validate:v2-beta
```

The command leaves a validated `2.0.0-beta.0` tarball under
`artifacts/v2-beta/`. It does not publish anything.

## Contract

The v2 root should expose concepts, not every implementation helper. Its runtime
surface currently has 18 values:

- `Effect`, `Cause`, and `Exit` for describing results and computations.
- `Runtime`, `makeRuntime`, `runPromise`, and `runExit` for execution.
- `Scope`, `ScopeFinalizerError`, and `withScopeAsync` for owned concurrency.
- `Resource`, `Layer`, and `Schedule` as discoverable domain namespaces.
- `Stream` and `Pipeline` for the small stream facade.
- `LayerContext`, `MissingLayerServiceError`, and `formatCause` for actionable
  diagnostics at application boundaries.

The root does not expose scheduler queues, concrete fiber interpreters, engine
bridges, WASM ABI helpers, benchmark controls, or registry implementation
details. Those remain available through v1 compatibility entrypoints while the
v2 migration is prepared.

## Migration shape

| v1 style | v2 preview |
| --- | --- |
| `succeed(value)` / `asyncSucceed(value)` | `Effect.succeed(value)` |
| `flatMap(effect, next)` / `asyncFlatMap(...)` | `Effect.flatMap(effect, next)` |
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

Before promotion to the v2 root:

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
