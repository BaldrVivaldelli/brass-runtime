# Release checklist

This is the release gate for public `brass-runtime` releases.

## Release command

```bash
npm run release:check
```

`release:check` covers:

- Pinned Rust formatting, Clippy, and native workspace tests.
- A real WASM build from the pinned toolchain.
- TypeScript API/type checks.
- Exhaustive 546-symbol v1-to-v2 export disposition with zero uncovered names.
- Full Vitest suite.
- Whole-repository coverage baseline over shipped executable source.
- Independent coverage floors for stable core, HTTP, schema, and observability
  surfaces, so experimental Agent/Perf totals cannot mask a stable regression.
- TS bundle build.
- CJS compatibility validation.
- Conditional browser bundle validation.
- npm tarball validation for Node, browser, declaration, and WASM artifacts.
- Installed-tarball validation for `@brass/agent`, `@brass/perf`, and
  `@brass/engine-wasm`, covering ESM, CJS, declarations, v1 export parity or
  ABI compatibility, real execution, and CLI startup where applicable.
- A separate `npm run validate:v2-beta` gate builds the prospective v2 package
  root, `/v1` bridge, browser/CJS/ESM/declaration conditions, independent
  products, package-size target, and optional-WASM behavior. It is exercised by
  the `V2 Beta` workflow on Node 20, 22, and 24.
- Packed Express lighthouse validation covering strict types, HTTP behavior,
  incoming trace propagation, health, metrics, and graceful `SIGTERM` shutdown.
- Integrity validation for the committed production-like evidence record.
- Consent and count validation for committed adoption/migration evidence.
- Runtime profiler budget.
- Runtime benchmark budget.
- Versioned fork/suspend/resume/fairness/suspended-heap budget.
- HTTP benchmark budget.
- Observability benchmark budget.
- Cross-runner semantic conformance and bounded fault corpus.
- Weekly retained-memory, observed HTTP, and adaptive-limiter stability soaks.

## Manual release notes

Before publishing:

- Review `README.md` and `docs/recipes/`.
- Run a GC-aware HTTP memory lab on the release machine:

```bash
node --expose-gc --import tsx src/perf/cli.ts --profile http-memory --calls 100000 --concurrency 512 --delay-ms 2 --force-gc
```

- Save a local perf baseline:

```bash
npm run perf -- --profile runtime-ab --record-history --save-baseline first-release-runtime
npm run perf -- --profile http-memory --calls 20000 --concurrency 512 --record-history --save-baseline first-release-http-memory
```

- Confirm `npm run validate:package` reports the expected tarball contents.
  The command also enforces the versioned compressed, unpacked, file-count, and
  top-level group ceilings in `scripts/package-size-budget.json`, and rejects
  the unpublished duplicate `.js` ESM artifacts. Raw operational records and
  repository-only planning, ADR, AI-context, case-study intake, and native
  pilot documents stay versioned in GitHub instead of shipping in the npm
  tarball. The validator rejects those paths and requires the linked migration,
  production-evidence, and support documentation. Public ESM entrypoints use
  `.mjs`; CommonJS and bin entrypoints use `.cjs`.
- Confirm `npm run validate:evidence` passes and rerun the relevant benchmark
  budget when a hot path or threshold changed.
- The committed `package.json` and lockfile version must match the latest stable
  Git tag. Semantic Release updates both files and commits the release version
  with `[skip ci]` before tagging and publishing. Never publish a local dry-run
  tarball as a release artifact.
- Build and package the promoted read-only editor-search companion, then
  generate release provenance:

```bash
npm run native:build
npm run native:package
npm run release:artifacts
```

The last command emits an SPDX 2.3 SBOM, complete npm/Cargo license inventory,
SHA-256 checksums, and a compact release manifest under `artifacts/release`.
Generated artifacts are not committed. CI publishes native editor bundles for
Linux, macOS, and Windows plus their per-platform manifests/checksums. The
native binary remains separate from the generic npm runtime package because it
is editor-specific. Its promotion result is `adopt-native-search`; the default
`auto` selection retains the TS fallback and `ts` remains an immediate reversal.

- Check `docs/native-compatibility-changelog.md` whenever ABI, IPC, boundary
  event, host, or persistence contracts change.

## Current release scope

- Core runtime, fibers, scopes, `Cause`, interruptibility, `FiberRef`.
- Layer 2.0 and Schedule 2.0.
- Streams and pipelines.
- HTTP client/server, schema validation, lifecycle middleware.
- Observability and runtime health/readiness.
- Performance profiler, budgets, history, and baselines.
- Brass Agent CLI/library surface.

## Companion product candidates

Agent, Perf, and VS Code have separate path-scoped workflows. They validate
their own type/test lane and upload a package candidate without publishing it:

- `Agent` produces the `@brass/agent` tarball.
- `Perf` produces the `@brass/perf` tarball.
- `Engine WASM` produces the optional `@brass/engine-wasm` tarball.
- `VS Code` compiles the extension and produces a VSIX.
- `V2 Beta` produces the installable `brass-runtime@2.0.0-beta.0` candidate;
  the protected publisher has promoted it to npm's `next` channel.

The registry snapshot in
[`evidence/product-registry-readiness-2026-09-20.json`](https://github.com/BaldrVivaldelli/brass-runtime/blob/main/docs/evidence/product-registry-readiness-2026-09-20.json)
records that the three scoped npm products do not yet exist. Their first
publication is currently deferred. If it is resumed later, it uses `Publish
Companion Product Alpha` from `main`. It requires an
exact manifest version and `npm-products` approval, checks bootstrap identity,
runs the release and dry-run gates, rejects reused versions, publishes only to
`alpha` with provenance, and proves `latest` did not move.

All three first attempts reached npm, which rejected package creation with
`E404` without registry mutation. Confirm the publishing user's `brass`
membership and create the `NPM_PRODUCT_BOOTSTRAP_TOKEN` environment secret in
`npm-products` with a short-lived token that has organization read access and
`@brass` package-scope publish access. Do not replace the repository-level
`NPM_TOKEN`: it belongs only to the stable unscoped `brass-runtime` release.
Select `bootstrap=true` only for each package's first version. Once it exists,
the workflow rejects token bootstrap and requires its npm Trusted Publisher;
after all three first versions, retire the product bootstrap secret. Never
expose either credential in source or logs.
Configure each package with GitHub owner `BaldrVivaldelli`, repository
`brass-runtime`, workflow `publish-product-alpha.yml`, environment
`npm-products`, and direct `npm publish` enabled.

Bootstrap run `35544680926` authenticated as `avivaldelli` but got `E403`
reading `brass` membership. It stopped before build or publication with no
registry mutation. The product workflow now uses only the environment-scoped
`NPM_PRODUCT_BOOTSTRAP_TOKEN`, preventing a scoped bootstrap credential from
breaking or broadening the stable publisher. If companion publication is
resumed, its remaining prerequisites are the new secret plus membership or
organization-read permission; scope write remains required. These are future
publication prerequisites, not blockers for independent packaging readiness.

`npm run validate:product-publish-dry-run` reproduces all three npm dry-runs
locally and compares package identity, exact version, and file count with the
committed readiness evidence. Compressed and unpacked byte counts are checked
against the reviewed product budgets because optimized WASM bytes can differ
slightly across supported build hosts; the recorded counts remain a dated
measurement, not a cross-platform checksum. The validator also fails if npm
would silently normalize a product manifest. The command runs inside
`release:check` after packed-consumer validation has rebuilt each product.

The 2026-09-20 remote-control audit now confirms protected `main` and `next`
branches, enforced `validate`, `audit`, `examples`, and `CodeQL` checks, and required-reviewer gates
on `npm-next` and `npm-products`. The beta was published through `npm-next`;
the product attempts were explicitly approved through `npm-products`. The
dated readiness records preserve both the enforced controls and the remaining
npm organization-access failure instead of treating workflow YAML as operational
proof.

The reviewed desired state is machine-readable in
`.github/release-guardrails.json`; `npm run validate:release-policy` checks its
verified status-check app IDs, branch protections, environment reviewer, and
single-maintainer limitations. The remote audit is the evidence that GitHub is
enforcing that desired state.
Run that read-only comparison with `npm run audit:release-guardrails`; a
non-zero exit lists every missing or divergent remote control.

Actual beta publication is dispatched through the trusted `Release` workflow
from the `next` branch with `channel=v2-beta`, the exact version, and the
boolean publish confirmation. That entrypoint calls the reusable `Publish V2
Beta` workflow. Keeping `release.yml` as the caller lets npm validate the same
short-lived OIDC trusted publisher used by the stable train; the beta publisher
does not receive a long-lived npm write token. The job pins npm `11.5.1` and
verifies it before continuing because npm's OIDC exchange is unavailable in
the npm 10 CLI bundled with Node 22. It still requires approval of the
`npm-next` environment, reruns `release:check`, rebuilds the exact requested
beta version, executes an npm publication dry-run, rejects an already-published
version, retains the tarball, and publishes only with the `next` dist-tag and
npm provenance. After publication it allows up to five minutes for asynchronous
registry indexing, verifies that `next` resolves to the requested version, and proves that
`latest` did not move. Semantic Release remains restricted to `main` and cannot
accidentally publish the v1 package on the beta channel.
The publication, registry integrity, provenance, artifact, and rollback snapshot is recorded in
[`evidence/v2-beta-readiness-2026-09-20.json`](https://github.com/BaldrVivaldelli/brass-runtime/blob/main/docs/evidence/v2-beta-readiness-2026-09-20.json).
The normal evidence gate validates that immutable snapshot without inspecting
unrelated local builds. To re-hash a downloaded copy of the exact retained
candidate, opt in with:

```bash
npm run validate:v2-beta-readiness -- --artifact artifacts/v2-beta/brass-runtime-2.0.0-beta.0.tgz
```

Before approving the `npm-next` environment, record the current tags and the
last known-good beta in the release notes:

```bash
npm view brass-runtime dist-tags --json
npm view brass-runtime@next version
```

If the new beta is broken, move only `next` back to that exact known-good
version and deprecate the bad beta with an actionable message. Do not move
`latest` and do not unpublish except when required by registry or security
policy:

```bash
npm dist-tag add brass-runtime@<known-good-beta> next
npm deprecate brass-runtime@<broken-beta> "Use <known-good-beta>; see <incident-url>"
```

For a local Agent or Perf candidate, build the runtime first and then run
`npm run validate:product:agent` or `npm run validate:product:perf`. The v1
runtime entrypoints and bin names remain supported throughout this transition.

Do not publish `.brass/perf-history`; it is intentionally local evidence.

## Scheduled stability evidence

The Saturday `Stability` workflow builds WASM before running
`npm run test:stability`, so the same semantic cases execute through the
TypeScript fiber interpreter, native top-level fast path, direct adapter, and
WASM engine. Its selected fault suites cover interruption/canceler ownership,
scope/finalizer ordering, lifecycle shutdown, queue timeouts and bounds, and
observability shutdown.

The same workflow runs three explicitly bounded workloads:

- ten runtime profiling rounds with forced GC and recorded heap/RSS history;
- 100,000 observed HTTP calls at concurrency 128;
- adaptive-limiter stable and saturation/recovery scenarios over 100,000
  samples and 64 keys.

The versioned thresholds live in `scripts/stability-budgets.json`. They fail on
HTTP errors, excessive retained heap, missing limiter recovery signals,
unbounded limiter state, insufficient throughput, or an incomplete runtime
sample. Every successful run writes `stability-run-manifest.json` with the
workflow identity, source SHA, exact environment, budget decisions, metrics,
byte counts, and SHA-256 identities for all three raw reports. Logs, reports,
and the manifest are retained as workflow artifacts for 90 days. These runs are
regression evidence, not external production-adoption evidence.

Two retained green manual runs are recorded in
[`evidence/stability-ci-2026-09-20.json`](https://github.com/BaldrVivaldelli/brass-runtime/blob/main/docs/evidence/stability-ci-2026-09-20.json).
They identify each source SHA, workflow/job and artifact IDs, report byte
counts and SHA-256 hashes, runner metrics, budget decisions, and 30-day expiry.
The second artifact was downloaded and re-hashed independently. These same-day
runs prove repeatability, not a weekly trend. `npm run
validate:stability-evidence` checks both remote snapshots and the independent
local run.

A weekly trend is established only from at least four successful `schedule`
manifests covering at least 21 days, with consecutive samples 5–10 days apart,
one Node major/platform, the current budget version, and raw reports matching
every recorded byte count and SHA-256. Each scheduled run downloads up to the
three preceding successful scheduled artifacts and validates them with the
current run. Histories with one to three valid samples stay green as pending;
the fourth sample must produce `stability-trend.json` or fail the workflow.
Replay the same check manually with:

```bash
gh run download <run-id> --name brass-stability-<run-id> --dir artifacts/stability-history/<run-id>
npm run stability:trend -- artifacts/stability-history
```

Set `BRASS_STABILITY_TREND_REPORT_PATH` to retain the generated comparison
summary. Manual same-day runs remain useful repeatability evidence but cannot
qualify as a weekly trend.

## Release cadence and channels

- Stable releases run from `main` on the weekly Monday release train or by an
  explicit manual dispatch with `channel=stable` and `publish=true`. Multiple
  fixes can therefore ship as one reviewed release rather than producing a new
  version for every merge.
- A manual dispatch with `publish=false` runs the complete stable validation
  matrix and native-artifact build but skips both publishing jobs. Use this to
  qualify Node compatibility or release policy without contacting npm:

  ```bash
  gh workflow run release.yml --ref main \
    -f channel=stable -f version=2.0.0-beta.0 -f publish=false
  ```

  The release-policy gate rejects a workflow where manual stable publication
  does not explicitly require `publish=true`. The first retained execution of
  this path is [run `35547826504`](https://github.com/BaldrVivaldelli/brass-runtime/actions/runs/35547826504):
  Node 18/20/22/24 and all three native platforms passed while both publisher
  jobs were skipped. Its immutable job and artifact metadata is checked by
  `npm run validate:evidence` from
  `docs/evidence/stable-release-validation-2026-09-21.json`.
- The publishing job is branch-locked to `main`; dispatching the stable
  workflow from `next` cannot publish the v1 package as a prerelease by mistake.
- The `next` branch builds and retains prerelease candidates on push. Publishing
  is a deliberate, separately approved maintainer action through the
  `npm-next` environment and must use npm's `next` tag; prereleases must never
  move `latest`.
- `feat` changes produce a minor release; `fix`, `perf`, and behavior-changing
  `refactor` changes produce a patch. Documentation, tests, CI, build, style,
  and maintenance-only commits do not publish a package.
- Breaking changes require an explicit breaking-change footer and a major
  release. Stable v1 surfaces remain frozen until the documented v2 promotion.

## Node support

The v1 package declares Node `>=18`, matching its compatibility smoke lane.
Full stable release validation runs on Node 20, 22, and 24. The v2 beta declares
Node `>=20` and its candidate workflow validates the same three majors. Node 18
and 20 are compatibility-only because they are upstream EOL; Node 22 and 24 are
the security-supported LTS lines. Node 26 is Current and will be reviewed at
its scheduled LTS transition. The dated, machine-readable decision lives in
`scripts/node-support-policy.json`. Any further minimum-version change requires
migration and rollback guidance.

The support windows, v2 reversal procedure, release-owner duties, and path to a
second release-capable maintainer are defined in
[`support-and-maintenance.md`](./support-and-maintenance.md). The project remains
single-maintainer for release purposes until that qualification process is
actually completed.
