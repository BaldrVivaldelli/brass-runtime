# Production evidence

Brass separates three evidence levels so benchmark results are useful without
being oversold.

| Level | What it proves | Current evidence |
| --- | --- | --- |
| Contract | Package shape, types, compatibility, cancellation semantics | CI tests, API fingerprint, packed-consumer smoke tests |
| Production-like | Behavior under controlled runtime, HTTP, memory, and observability workloads | [`production-like-baseline-2026-09-19.json`](./evidence/production-like-baseline-2026-09-19.json) |
| External production | Outcomes in an identifiable, consenting user workload | Not yet claimed |

Public discovery signals are recorded in
[`adoption-discovery-2026-09-20.json`](./evidence/adoption-discovery-2026-09-20.json).
They show package reach and two GitHub dependency-graph repositories. Both are
first-party: this repository and `create-brass`, the verified template consumer.
No external public consumer is currently identifiable, and these signals must
not be converted into active-user or production-workload counts.

The `create-brass` entry now points to a commit-pinned, machine-checked
[public readiness record](https://github.com/BaldrVivaldelli/create-brass/blob/6e09a9754a4f55b4fd73c2f20c2a9368d6b5f6dd/docs/evidence/beta-readiness-2026-09-20.json).
It retains the merged migration, four validation modes across two templates
(8/8 builds), protected controls, the historical token failure, and the exact
post-hardening OIDC candidate. Audit, build, and both rollback paths passed;
publication was skipped and npm stayed unchanged pending Trusted Publisher
confirmation. This is first-party evidence, not an
independent adopter, production deployment, or publishable case study.

Users can provide a workload and choose an explicit evidence-consent level
through the repository's **Brass adoption report** issue form. The form warns
against posting private traces, credentials, or restricted customer data.

The v2 package and registry state are captured in
[`v2-beta-readiness-2026-09-20.json`](./evidence/v2-beta-readiness-2026-09-20.json).
It records the protected OIDC publication, npm integrity and provenance, the
public registry tarball replay, and rollback controls. npm currently resolves
`next` to `2.0.0-beta.0` while `latest` remains `1.22.0`.
It also records successful push and manual-dispatch runs on the protected
`next` branch for the Node 20/22 matrix. Both runs rebuilt WASM, validated the
beta package and core lighthouse, and retained a digest-addressed package
artifact.

The first v2 import inventory is recorded as
[`v2-migration-assessment-2026-09-20.json`](./evidence/v2-migration-assessment-2026-09-20.json).
Its completed, anonymized migration is recorded separately as
[`v2-migration-lighthouse-1-2026-09-20.json`](./evidence/v2-migration-lighthouse-1-2026-09-20.json).
The migration built both template variants against the packed 1.22.0 artifact
and retained `zipPar` as its single distinct v1 fallback. Both variants also
build unchanged after replacing only the local facade with its stable-v1
adapter, proving the recorded rollback. Consent covers this internal anonymized
evidence, not a public case study, and one consumer does not justify changing
the v2 API.

The second internal migration,
[`v2-migration-lighthouse-2-2026-09-20.json`](./evidence/v2-migration-lighthouse-2-2026-09-20.json),
moves the shared Express runtime, Layer, and LayerContext imports to the preview.
Its packed smoke verifies types, HTTP, incoming trace propagation, health,
metrics, and `SIGTERM` shutdown. `RuntimeService` and `makeConfigLayer` remain
measured v1 fallbacks; this internal example is not external-production proof.

The third internal migration,
[`v2-migration-lighthouse-3-2026-09-20.json`](./evidence/v2-migration-lighthouse-3-2026-09-20.json),
promotes the core Effect and Stream example from `/next` to the beta package
root. It produces identical results after rollback to the beta `/next` facade
and to the exact published `brass-runtime@1.22.0` tarball. Its timestamped
follow-up repeats those checks against the public beta registry tarball. This
completes the three internal lighthouse records without changing the count of
external adopters or publishable case studies.

## Documented internal use cases

The master adoption objective permits consented internal or external use-case
evidence. The following internal records meet the reproducibility and consent
requirements without being relabeled as external production or public adopter
case studies:

| Workload | Consent boundary | Reproducible evidence |
| --- | --- | --- |
| React and vanilla workspace templates | anonymized internal migration evidence plus a public first-party verification | two packed builds, stable rollback, beta root, `/v1` bridge, and the commit-pinned `create-brass` readiness record |
| Express HTTP and observability example | internal repository example | strict types, three routes, trace propagation, metrics, health, and graceful shutdown |
| Core Effect and Stream example | internal repository example | public beta root, `/next`, and stable-v1 execution with identical results |

The first record explicitly does not authorize a public case study, and the
other two remain internal evidence. Consequently the project still reports
zero external-production adopters and zero publishable adopter case studies.

The committed production-like baseline was recorded on a Ryzen 9 8945HS with
Node 22.23.2. It contains seven runtime measurements, eleven local HTTP
variants with explicit GC and zero errors, and five observability measurements.
Every recorded result is stored next to its predeclared budget. Run the
integrity check with:

```bash
npm run validate:evidence
```

A full local execution of the scheduled stability budgets is recorded in
[`stability-local-2026-09-20.json`](./evidence/stability-local-2026-09-20.json):
ten runtime retained-memory rounds, 100,000 observed HTTP calls with zero
errors, and 100,000 samples each for stable and saturation/recovery limiter
scenarios. The record includes hashes for the Git-ignored raw reports and is
explicitly local production-like evidence.

The corresponding cross-runner execution is recorded in
[`stability-ci-2026-09-20.json`](./evidence/stability-ci-2026-09-20.json). GitHub
Actions run `35525819646` passed the semantic/fault corpus, ten runtime rounds,
100,000 observed HTTP calls with zero errors, and both 100,000-sample limiter
scenarios. Its retained artifact has an ID, expiry, byte count, and SHA-256 for
each raw report; the validator can optionally re-hash a downloaded artifact
directory rather than trusting the summary alone.

## Reproduce the workloads

Run on an otherwise quiet machine. Absolute throughput will vary; the budget
result and semantic invariants are the release decisions.

```bash
npm run benchmark:runtime:budget
npm run benchmark:http:budget
npm run benchmark:observability:budget
```

For raw JSON:

```bash
npm run benchmark:json -- runtime-performance-track
npm run benchmark:json -- observability-overhead
BRASS_HTTP_BENCH_MODE=compare \
BRASS_HTTP_BENCH_CALLS=1000 \
BRASS_HTTP_BENCH_CONCURRENCY=64 \
BRASS_HTTP_BENCH_DELAY_MS=1 \
node --expose-gc --import tsx src/benchmarks/runner.ts --json http-concurrent
```

Record the OS, CPU, logical CPU count, memory, Node version, exact workload,
warmup, GC mode, thresholds, errors, and all material negative findings. Do not
compare an explicit-GC heap delta with a non-GC run.

## Turning usage into a case study

External adoption is tracked under [`case-studies`](./case-studies/README.md).
A case study requires consent, a reproducible workload or operational trace,
before/after data, and limitations. Anonymous or unverifiable anecdotes may
inform the backlog but are not labeled production evidence.
