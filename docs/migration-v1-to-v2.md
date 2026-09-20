# Migrating from v1 to the v2 preview

There is no forced migration in v1. `brass-runtime/next` is additive, and the
existing root and subpaths remain the compatibility contract. The safest path
is incremental and reversible.

## 1. Move optional domains to their explicit subpaths

Keep runtime code in `brass-runtime/core`; import HTTP, schema, observability,
Agent, and Perf only from their own entrypoints. This exposes accidental
coupling before changing effect syntax.

```ts
import { Runtime } from "brass-runtime/core";
import { makeDefaultHttpClient } from "brass-runtime/http";
import { s } from "brass-runtime/schema";
import { makeObservability } from "brass-runtime/observability";
```

## 2. Introduce one application facade

Re-export the Brass concepts your application actually uses from a local file.
Call sites then have one reversible boundary instead of hundreds of direct
package imports.

```ts
// app/brass.ts
export { Effect, Layer, Runtime, Schedule, Stream, runPromise } from "brass-runtime/next";
```

## 3. Translate constructors to namespaces

| v1 | v2 preview |
| --- | --- |
| `asyncSucceed(value)` or `succeed(value)` | `Effect.succeed(value)` |
| `asyncFail(error)` or `fail(error)` | `Effect.fail(error)` |
| `asyncSync(thunk)` or `sync(thunk)` | `Effect.sync(thunk)` |
| `asyncMap(fa, f)` or `map(fa, f)` | `Effect.map(fa, f)` |
| `asyncFlatMap(fa, f)` or `flatMap(fa, f)` | `Effect.flatMap(fa, f)` |
| `asyncCatchAll(fa, f)` or `catchAll(fa, f)` | `Effect.catchAll(fa, f)` |
| `mapError(fa, f)` | `Effect.mapError(fa, f)` |
| `async(register)` | `Effect.async(register)` |
| `sleep(ms)` | `Effect.sleep(ms)` |
| `timeout(effect, ms)` | `Effect.timeout(effect, ms)` |
| `retry(effect, policy)` | `Effect.retry(effect, policy)` |
| `fromPromiseAbortable(make)` | `Effect.fromPromiseAbortable(make)` |
| `layerValue(tag, value)` | `Layer.value(tag, value)` |
| `resource(acquire, release)` | `Resource.make(acquire, release)` |
| `fixed(ms)` | `Schedule.fixed(ms)` |
| `fromArray(values)` | `Stream.from(values)` |

Use the namespace members as the source of truth; this table documents common
renames, not a promise that every v1 helper will move to the v2 root.

## 4. Keep advanced machinery on v1 subpaths

Scheduler queues, engine/WASM controls, registries, worker pools, testing
clocks, low-level stream queues, and diagnostics are intentionally absent from
the v2 root. Keep those imports on `brass-runtime/core` or the owning stable
subpath. Do not build a private deep import under `dist` or `src`.

Agent and Perf are not runtime-root concepts. Their v1 paths stay supported;
the repository also produces `@brass/agent` and `@brass/perf` candidate
packages for independent adoption testing.

## 5. Verify and roll back

```bash
npm run build
npm run validate:api
npm run validate:cjs
npm run validate:browser
cd examples/v2-preview
npm install
npm run typecheck
npm run dev
```

The example's `paths` mapping points TypeScript at the built preview
declarations. If a preview change blocks adoption, switch the local application
facade back to `brass-runtime/core`; no data or runtime-state migration is
involved.

Before v2 promotion, the final release proposal must publish a generated
disposition for every v1 value and type export: direct replacement, owning
subpath, deprecation window, or removal rationale. That exhaustive inventory is
deliberately not frozen while the preview is experimental.
