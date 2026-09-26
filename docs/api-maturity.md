# API maturity

This table prevents the compatibility root from becoming the default home for
new APIs. Maturity applies to documented package entrypoints, not arbitrary
source-file imports.

| Surface | Maturity | Import guidance |
| --- | --- | --- |
| Core effects/runtime/resources/layers/schedules | Stable | Prefer `brass-runtime/core`; browser builds use the TS engine. |
| Root `brass-runtime` | Compatibility | Existing exports remain supported; do not add optional-subsystem APIs here by default. |
| `brass-runtime/next` | Experimental v2 preview | Small additive facade; do not treat it as stable until the next major release. |
| Schema | Stable | Use `brass-runtime/schema`. |
| HTTP client/server/testing | Stable | Browser condition exposes the client; Node condition also exposes server and Node transport. |
| Observability | Stable | Use `brass-runtime/observability`. |
| Performance profiler | Stable v1 tooling surface | Use `brass-runtime/perf`; `@brass/perf` is an alpha release candidate and benchmark thresholds can evolve independently. |
| VS Code Agent extension | Experimental, separately packaged | Built and uploaded by its path-scoped workflow; no runtime release is implied. |
| Rust/WASM engine internals | Experimental, versioned ABI | `wasm` is strict; `auto` is the explicit observable TS-fallback policy. |
| Files below `src/**` not exported by a package entrypoint | Internal | No compatibility guarantee. |

New public APIs first go to the narrowest relevant subpath. A root export needs
a compatibility rationale, public documentation, CJS/ESM/type validation, and
a migration note. Deprecation requires a documented replacement and at least
one migration path before removal.

The v1 root and `brass-runtime/core` are frozen compatibility surfaces: their
export sets must not grow. Candidate root-level APIs are exercised first in
`brass-runtime/next`, whose target contract is documented in `docs/api-v2.md`.

Every published entrypoint also has an exact export fingerprint in
`src/__tests__/public-api-snapshot.test.ts`. Any addition or removal requires an
intentional compatibility review and snapshot update.

Generated declaration fingerprints live in `docs/ai/api-contract.v1.json`.
`npm run validate:api` rejects signature changes after a build; update the
contract with `npm run api:contract:update` only after reviewing the `.d.ts`
change and its semantic-versioning impact.

TypeScript quality policy is deliberately `tsc` plus focused/unit/property and
integration tests; no repository-wide ESLint/Biome gate is currently adopted.
Rust uses rustfmt, Clippy with warnings denied, native tests, and the real WASM
build. This policy may change through an explicit tooling decision, not an
undeclared local requirement.
