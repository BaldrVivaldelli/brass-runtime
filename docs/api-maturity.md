# API maturity

This table prevents the compatibility root from becoming the default home for
new APIs. Maturity applies to documented package entrypoints, not arbitrary
source-file imports.

| Surface | Maturity | Import guidance |
| --- | --- | --- |
| Core effects/runtime/resources/layers/schedules | Stable | Prefer `brass-runtime/core`; browser builds use the TS engine. |
| Root `brass-runtime` | Compatibility | Existing exports remain supported; do not add optional-subsystem APIs here by default. |
| Schema | Stable | Use `brass-runtime/schema`. |
| HTTP client/server/testing | Stable | Browser condition exposes the client; Node condition also exposes server and Node transport. |
| Observability | Stable | Use `brass-runtime/observability`. |
| Performance profiler | Stable tooling surface | Use `brass-runtime/perf`; benchmark thresholds can evolve independently. |
| Agent library and CLI | Experimental | Use `brass-runtime/agent`; protocol changes require versioning. |
| Rust/WASM engine internals | Experimental, versioned ABI | `wasm` is strict; `auto` is the explicit observable TS-fallback policy. |
| Files below `src/**` not exported by a package entrypoint | Internal | No compatibility guarantee. |

New public APIs first go to the narrowest relevant subpath. A root export needs
a compatibility rationale, public documentation, CJS/ESM/type validation, and
a migration note. Deprecation requires a documented replacement and at least
one migration path before removal.

Every published entrypoint also has an exact export fingerprint in
`src/__tests__/public-api-snapshot.test.ts`. Any addition or removal requires an
intentional compatibility review and snapshot update.

TypeScript quality policy is deliberately `tsc` plus focused/unit/property and
integration tests; no repository-wide ESLint/Biome gate is currently adopted.
Rust uses rustfmt, Clippy with warnings denied, native tests, and the real WASM
build. This policy may change through an explicit tooling decision, not an
undeclared local requirement.
