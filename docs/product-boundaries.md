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

core -----------------> agent -----------------> VS Code
```

The diagram shows allowed high-level dependencies, not mandatory ones. The
automated `npm run validate:boundaries` gate enforces the important absences:

- Core cannot import HTTP, observability, performance tooling, or Agent.
- Schema is dependency-free inside the repository.
- Agent can use core but cannot couple to HTTP, observability, or Perf.
- Perf can measure runtime/HTTP/observability but no shipped subsystem depends
  on Perf.
- No runtime subsystem depends on Agent.

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
   new runtime artifact. Source remains co-located in this repository to avoid
   duplicate implementations.
5. Keep `brass-runtime/agent` and `brass-runtime/perf` supported for all of v1;
   deprecate or remove them only with a documented major-version migration.

Physical extraction must not begin until the dependency gate passes and packed
package smoke tests exist for both the old and new import paths.

Current independent validation lanes:

```bash
npm run test:types:runtime && npm run test:runtime
npm run test:types:agent && npm run test:agent
npm run test:types:perf && npm run test:perf
npm run validate:product:agent
npm run validate:product:perf
```

The package build configs are `tsup.agent.config.ts` and
`tsup.perf.config.ts`. Packed-consumer validation requires exact runtime export
parity, type resolution against the v1 declarations, real library execution,
and CLI startup.

The repository intentionally does not auto-publish any of the three companion
products. The `Agent`, `Perf`, and `VS Code` workflows create independently
downloadable release-candidate artifacts; publishing requires a deliberate
maintainer action after namespace, changelog, and compatibility review.
