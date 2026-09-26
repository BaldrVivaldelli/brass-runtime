# Migrating from v1 to the v2 preview

## Inventory imports first

Run the read-only migration analyzer against application source before changing
imports:

```bash
npm run migrate:v2:analyze -- src
npm run migrate:v2:analyze -- --json src > brass-v2-migration.json
npm run migrate:v2:analyze -- --check src
```

The analyzer reports documented namespace mappings, exports that can move to
`brass-runtime/next` unchanged, and imports or re-exports that require a manual
decision. `--check` exits non-zero while any v1 root or `/core` reference
remains, which makes it suitable for a migration branch CI gate. It never edits
application files.

The exhaustive generated disposition for all v1 root exports lives in
[`v1-to-v2-export-map.json`](./v1-to-v2-export-map.json). It is declaration-
fingerprinted and release-gated: every symbol must map to a direct v2 export, a
v2 namespace member, or the supported `brass-runtime/core` compatibility
owner. Regenerate it only after reviewing an intentional declaration change:

```bash
npm run api:v2-map:update
npm run validate:v2-map
```

There is no forced migration in v1. `brass-runtime/next` is additive, and the
existing root and subpaths remain the compatibility contract. The safest path
is incremental and reversible.

For an installed `2.0.0-beta` candidate, the package root is the v2 facade and
`brass-runtime/next` is an alias for it. The previous root remains available at
`brass-runtime/v1` as a short-lived migration bridge. Pin the exact beta rather
than using an open prerelease range.

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
| `toPromise(effect, env)` | `runPromise(effect, env)` |
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
the repository also produces the `@brass/perf` candidate
packages with their own executable bundles and declarations. The beta does not
export `/agent` or `/perf`. Install those packages explicitly if needed.

The v2 beta also excludes the embedded WASM binary. TypeScript execution is
the default, `engine: "auto"` falls back safely when the optional engine is not
installed, and strict WASM use requires `@brass/engine-wasm`.

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

For a packed beta rehearsal, install the tarball produced by
`npm run validate:v2-beta`, point the local facade at `brass-runtime`, and
retain the known-good v1 lockfile. Roll back by restoring that lockfile and the
single facade commit, then rerun the same type, package-condition, behavior,
and workload checks. The candidate validator itself covers ESM, CJS,
declarations, browser resolution, `/v1`, companion products, and execution
with and without the optional WASM package.

Before v2 promotion, the final release proposal must publish a generated
disposition for every v1 value and type export: direct replacement, owning
subpath, deprecation window, or removal rationale. That exhaustive inventory is
deliberately not frozen while the preview is experimental.
