# Brass next-level roadmap

This roadmap turns product maturity into three evidence-backed workstreams.
It is intentionally outcome-based: a completed implementation without adopter,
compatibility, or operational evidence does not close a workstream.

## Current baseline

- Stable v1 surfaces: runtime/core, schema, HTTP, and observability.
- Experimental surfaces: v2 preview, Rust/WASM internals, Agent, Perf candidate,
  and VS Code integration.
- The v2 preview exposes 18 runtime values and keeps v1 compatible.
- Controlled production-like evidence exists; external production adoption is
  not yet claimed.
- One anonymized workspace template lighthouse migrated in 6 minutes 19 seconds:
  both variants build against the packed 1.22.0 artifact, root v1 references
  fell from 4 files to 2 facades, and the only distinct compatibility fallback
  is `zipPar` (`/core` in the beta candidate).
  This is internal migration evidence, not a public case study or production
  adoption claim.
- Public discovery currently shows 8,760 npm downloads in the last year but
  only 1 in the last week; public manifest search found no external repository.
  These are reach signals, not users. A Git-ignored private adopter inventory
  is defined for consented workload, retention, and upgrade-lag observations.
- A second internal lighthouse moved the shared Express example to the v2
  facade in 3 minutes 2 seconds. Its packed smoke passes strict types, user,
  health, metrics, trace propagation, and graceful shutdown; `RuntimeService`
  and `makeConfigLayer` are its two measured v1 fallbacks.
- A third internal lighthouse promotes the core Effect and Stream preview from
  `/next` to the beta package root. Strict types and identical outputs pass on
  the v2 root, its `/next` rollback, and the published npm 1.22.0 rollback.
- Lighthouse progress is 3 of 3 migrations and 0 of 2 publishable external case
  studies. The migration-count target is closed with internal workloads; both
  external reports still require consenting adopters and are not inferred from
  these examples.
- The shared semantic corpus now exercises the TypeScript fiber interpreter,
  native top-level fast path, direct adapter, and the WASM engine when built.
- A bounded weekly stability lane runs that corpus plus cancellation, finalizer,
  shutdown, timeout/queue, retained-memory, HTTP, and limiter saturation checks.
- The v1 tarball no longer ships a duplicate unpublished ESM build: the measured
  artifact remains roughly 18% smaller compressed and unpacked and more than
  12% smaller by file count while all package-condition and independent-product
  smoke tests stay green and generated evidence remains included.
- Agent, Perf, and Engine WASM build as independently versioned candidates.
  Agent and Perf now own bundled declarations as well as executable output.
  Their v1 compatibility entrypoints/artifact remain in `brass-runtime`.
  Registry checks confirm that none of the three scoped packages exists yet;
  a manual protected `alpha` publisher is ready, but first publication and npm
  namespace authorization remain open external steps.
- A distinct `2.0.0-beta.0` tarball shape is generated and installed locally:
  v2 owns the root, `/v1` is the bridge, optional products are absent, and the
  WASM engine is installed separately. Both variants of the first lighthouse
  build on the beta and through its `/v1` rollback bridge; the Express
  lighthouse also passes types, HTTP, observability, and graceful shutdown on
  that candidate. The core lighthouse additionally proves root promotion plus
  beta `/next` and published-v1 rollback. External-production adoption remains
  explicitly unclaimed.
- `brass-runtime@2.0.0-beta.0` is published with npm provenance on the `next`
  tag. The registry tarball has 75 files, 619,144 compressed bytes, and
  2,975,406 unpacked bytes, below every v2 budget; `latest` remains `1.22.0`.
  The protected run, artifact, integrity, attestation, propagation interval,
  and rollback commands are recorded in the dated beta evidence.

## 1. Adoption and real evidence

### Deliverables

1. Maintain a private adopter inventory containing owner, workload, Brass
   version, entrypoints used, deployment stage, upgrade lag, and consent state.
   Do not commit organization names or contact data without permission.
2. Select at least three lighthouse workloads: one core/runtime workload, one
   HTTP workload, and one application using observability or graceful shutdown.
3. Predeclare success and reversal thresholds before each migration.
4. Publish at least two consented case studies under `docs/case-studies/` with
   reproducible or redacted evidence.
5. Update `docs/production-evidence.md` so its external-production row points to
   those reports without turning npm downloads into a user count.

### Required metrics

- Adoption: active workloads, version distribution, 30/90-day retention, and
  median upgrade lag.
- Reliability: error rate, cancellation completion, graceful shutdown time,
  leaked fiber/scope count, and rollback count.
- Performance: p50/p95/p99 latency, throughput, CPU, heap/RSS, and event-loop
  delay for the workload being evaluated.
- Experience: migration time, unsupported imports, and the number of escape
  hatches or v1-only APIs required.

### Exit evidence

- Three lighthouse migration records and two publishable case studies.
- Every report names its Brass version, workload, thresholds, negative findings,
  decision, and rollback path.
- No case study is generated from package-download or local benchmark data.

## 2. Product and v2 API

### Deliverables

1. Run the v2 preview against the lighthouse workloads and record every missing
   operation. Add APIs only when migration evidence demonstrates a recurring
   need and the value surface remains within its documented cap.
2. Provide migration tooling that inventories v1 imports, maps supported names
   to v2 namespaces, and reports manual migrations without modifying files by
   default.
3. Maintain the published `2.0.0-beta` on the `next` prerelease channel with packed-package
   Node, browser, ESM, CJS, declaration, and rollback validation.
4. Publish Agent and Perf under independent versions. Preserve the v1
   `brass-runtime/agent` and `/perf` compatibility paths until the documented
   major-version boundary.
5. **Decision implemented:** WASM is an optional independently versioned engine
   candidate. It accounts for 315,792 unpacked bytes and no verified adopter
   requires it; v1 retains the embedded artifact while the v2 beta validates
   installation with and without `@brass/engine-wasm`.

### Exit evidence

- Three real migration reports, a generated API/declaration contract, migration
  tooling tests, and a complete v1-to-v2 mapping.
- A beta tarball proven through every supported package condition.
- Agent and Perf install and execute independently without private source-tree
  imports.

## 3. Operational maturity and distribution

### Deliverables

1. Use quiet stable release trains and a separate `next` prerelease channel.
   Keep repository, tag, tarball, and lockfile versions synchronized.
2. Publish and test an explicit Node support matrix.
3. Record package file-count and compressed/unpacked-size budgets. Reduce the
   stable runtime package by extracting optional products without breaking v1.
4. Run one semantic conformance corpus across the TypeScript fiber interpreter,
   native top-level fast path, direct HTTP effect runner, and WASM engine.
5. Add scheduled soak/fault runs covering cancellation, finalizer order,
   shutdown, timeout storms, bounded queues, and retained memory.
6. Apply coverage thresholds by product maturity. Stable modules must not be
   masked by lower coverage in experimental Agent or Perf code.
7. Document an LTS window for v1, v2 rollback, release ownership, and the path
   for a second release-capable maintainer.

Items 4 and 5 are implemented as gates. They remain open as operational exit
evidence until the scheduled workflow has produced and retained a green run.
All three versioned soak budgets have also passed once locally with hashed raw
reports; that closes local execution risk but does not substitute for retained
cross-runner CI history.
Item 7 is documented in `support-and-maintenance.md`; the second-maintainer
outcome remains open until a real maintainer completes that qualification path.

### Exit evidence

- A tagged release whose source manifest and lockfile have the same version.
- Green release, conformance, soak/fault, package-size, and per-product coverage
  gates on the documented Node matrix.
- A tested migration and rollback between the supported v1 line and v2.

## Decision order

Work proceeds in this order:

1. Gather adopter evidence and repair release hygiene.
2. Validate and adjust the small v2 surface through real migrations.
3. Extract optional products and promote v2 only after compatibility,
   operational, and rollback gates pass.

New feature work that does not close an observed adopter gap or a promotion
gate should wait until these workstreams are complete.
