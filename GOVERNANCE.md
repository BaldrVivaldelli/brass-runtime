# Governance

Brass uses explicit API maturity and evidence gates so a broad repository can
ship a small, dependable runtime.

## Product status

- `brass-runtime`, `/core`, `/schema`, `/http`, and `/observability` are
  supported v1 compatibility surfaces.
- `brass-runtime/next` is the experimental candidate for the next major root.
- Agent, Perf, native editor search, and VS Code integration evolve as separate
  products even while they share this repository.
- `@brass/agent` and `@brass/perf` are alpha, independently versioned adoption
  packages. Their v1 export/type parity and executable behavior are tested from
  packed tarballs.
- Rust/WASM internals are experimental behind a versioned ABI.

## Change policy

A change to a stable surface requires:

1. An issue, ADR, or release note explaining the user-level need.
2. A reviewed generated declaration diff (`npm run validate:api`).
3. Compatibility tests, or a documented deprecation and migration path.
4. Package validation for CJS, ESM, browser conditions, and the npm tarball.
5. Performance evidence when the runtime, scheduler, HTTP hot path, or
   observability path changes.

The v1 root and `/core` export sets are frozen. Additions must go to the
narrowest existing subpath or the experimental `/next` facade. Removing or
renaming a stable API requires a major release.

Runtime, Agent, Perf, and VS Code candidates are produced by separate CI
workflows. Publishing remains a maintainer decision; a green candidate artifact
does not grant automatic publication or change package maturity.
The v2 beta has a distinct reusable publisher protected by the `npm-next`
environment and invoked through the npm-trusted `release.yml` workflow; stable
Semantic Release cannot publish from `next`.

## Decision making

The maintainer has final release responsibility. Non-trivial architecture,
compatibility, security, or product-boundary decisions are recorded under
`docs/adr/`. Pull requests should prefer a small decision with evidence over a
large collection of unrelated changes.

Reviewers evaluate, in order:

1. Runtime semantics and ownership: who runs, cancels, and finalizes work.
2. Compatibility and package shape.
3. Correctness and regression evidence.
4. Performance and operational cost.
5. Implementation style.

## Evidence

Committed performance evidence must include the machine, toolchain, workload,
raw measurements, thresholds, and decision. Thresholds are declared before a
promotion run. A benchmark is not presented as production adoption, and a
production case study is not claimed without an identifiable consenting user.
The evidence levels and current controlled baseline are defined in
`docs/production-evidence.md`; case studies use the template under
`docs/case-studies/`.

## Security and support

Security reports follow `SECURITY.md`. Stable surfaces receive compatibility
and security fixes on the latest major line. Experimental surfaces may change
between minor releases but still require protocol/version negotiation where
they cross process, WASM, or persistence boundaries.

The supported Node matrix, v1 LTS window after v2 general availability, v2 beta
rollback, release ownership, and second-maintainer qualification are specified
in `docs/support-and-maintenance.md`.
