# Product boundaries

`brass-runtime` currently publishes several products from one repository. The
v2 direction keeps the repository while separating compatibility and release
responsibility.

## Dependency direction

```text
schema        core
   \           |
    +--> http <+--> observability
          |             |
          +------> perf |
```

The diagram shows allowed high-level dependencies, not mandatory ones. The
automated `npm run validate:boundaries` gate enforces the important absences:

- Core cannot import HTTP, observability, or performance tooling.
- Schema is dependency-free inside the repository.
- Perf can measure runtime/HTTP/observability but no shipped subsystem depends
  on Perf.

## Extraction sequence and current state

1. **Done:** keep the current v1 entrypoints as frozen compatibility surfaces.
2. **Done:** give Runtime, Agent, Perf, and VS Code independent type/test lanes
   and candidate-artifact workflows.
3. **Done:** add independently versioned `@brass/agent` and `@brass/perf`
   packages. Their ESM, CJS, types, and CLIs are installed and exercised from
   tarballs by `npm run validate:products`.
4. **Done:** make each candidate own its executable ESM, CJS, and CLI bundles.
   Builds externalize the stable runtime/HTTP/observability surfaces to the
   `brass-runtime` peer, so Agent or Perf candidates can be produced without a
   new runtime artifact. Their bundled declarations no longer forward through
   the monolith's `/agent` or `/perf` paths. Source remains co-located in this
   repository to avoid duplicate implementations.
5. Keep `brass-runtime/agent` and `brass-runtime/perf` supported for all of v1;
   deprecate or remove them only with a documented major-version migration.
6. **Done:** add the independently versioned `@brass/engine-wasm` alpha
   candidate. The v1 package retains its embedded WASM paths for compatibility;
   the loader prefers the optional package when both are installed.
7. **Done:** build a separate v2 beta package shape. Its root owns the small v2
   facade, `/v1` is an explicit bridge, Agent/Perf subpaths and bins are absent,
   and WASM is an optional peer rather than embedded payload.
8. **Done:** move Brass Agent out of this repository entirely. Steps 1-7 left
   its source co-located to avoid duplicate implementations; that tradeoff no
   longer paid for itself, because the agent's source, docs, CI lanes, and
   coverage floors were shaping a repository whose product is the runtime. It
   now lives at
   [BaldrVivaldelli/brass-agent](https://github.com/BaldrVivaldelli/brass-agent)
   with its git history, consuming `brass-runtime` as a peer. The v1 `/agent`
   subpath and the `brass-agent` bin are removed in 2.0; v1.x keeps them.

The v1 compatibility package no longer produces an unused second ESM build
with `.js` extensions. All public Node imports already resolve to `.mjs`, all
CommonJS imports and bins resolve to `.cjs`, and browser exports resolve to
browser `.mjs` files. Removing the unpublished duplicate reduced the packed v1
artifact from its 269-file, approximately 1.392 MB compressed and 5.973 MB
unpacked baseline. The current candidate is 215 files, approximately 1.118 MB
compressed and 4.793 MB unpacked, below the versioned 220-file, 1.15 MB
compressed, and 4.875 MB unpacked ceilings. Repository-only operational,
planning, ADR, AI-context, case-study intake, and native-pilot documents remain
available in GitHub but are excluded from the consumer tarball. Packed consumer
tests prove that the legacy Agent/Perf entrypoints and independent candidates
still execute.

The generated 546-symbol v1-to-v2 disposition is intentionally shipped as
migration documentation. Its repetitive JSON adds documentation bytes without
restoring executable duplication; the separate docs ceiling accounts for it
while the total compressed, unpacked, file-count, dist, and WASM ceilings stay
unchanged.

The v2 beta candidate is smaller still and remains below the versioned 180-file,
900,000-byte compressed, and 4,000,000-byte unpacked targets.
Agent, Perf, and Engine WASM also have individual compressed, unpacked, and
file-count ceilings in the same budget file. Their first npm publication
dry-runs are retained in the product-registry readiness evidence.

Physical extraction must not begin until the dependency gate passes and packed
package smoke tests exist for both the old and new import paths.

Current independent validation lanes:

```bash
npm run test:types:runtime && npm run test:runtime
npm run test:types:perf && npm run test:perf
npm run validate:product:perf
```

The package build configs are `tsup.perf.config.ts` and
`tsup.v2-beta.config.ts`. Packed-consumer validation requires exact v1 runtime
export parity where promised, self-contained type resolution, real library
execution, CLI startup, and all documented beta package conditions.

Companion products are never auto-published. Their workflows create independent
release candidates; a manual workflow publishes one reviewed product from
`main` to `alpha` after `npm-products` approval. It rejects reused versions,
retains the tarball, uses provenance, and proves `latest` did not move. A
short-lived token is allowed only when the package does not exist; later alphas
require its Trusted Publisher. Namespace and compatibility review remain
required before first publication.
