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
  the `V2 Beta` workflow on Node 20 and 22.
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
  the unpublished duplicate `.js` ESM artifacts. Public ESM entrypoints use
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
- `V2 Beta` produces the installable `brass-runtime@2.0.0-beta.0` candidate
  tarball without publishing it.

The registry snapshot in
[`evidence/product-registry-readiness-2026-09-20.json`](./evidence/product-registry-readiness-2026-09-20.json)
records that the three scoped npm products do not yet exist. Their first
publication uses the separate `Publish Companion Product Alpha` workflow from
`main`. It accepts one fixed product choice, requires an exact manifest version
and `npm-products` approval, performs a dry-run, rejects an existing version,
publishes only to `alpha` with provenance, and verifies that `latest` remains
unchanged. This is a prepared route, not a claim that those packages are
already public.

`npm run validate:product-publish-dry-run` reproduces all three npm dry-runs
locally and compares package identity, exact version, and file count with the
committed readiness evidence. Compressed and unpacked byte counts are checked
against the reviewed product budgets because optimized WASM bytes can differ
slightly across supported build hosts; the recorded counts remain a dated
measurement, not a cross-platform checksum. The validator also fails if npm
would silently normalize a product manifest. The command runs inside
`release:check` after packed-consumer validation has rebuilt each product.

The 2026-09-20 remote-control audit found the repository-level `NPM_TOKEN`, but
no GitHub environments, no remote `next` branch, and no protection on `main`.
Consequently neither manual publisher is considered approval-protected yet.
Before first use, protect `main`, create and protect `next`, and configure
required-reviewer gates on `npm-next` and `npm-products`. The dated readiness
records preserve this negative finding rather than treating workflow YAML as
proof of an operational approval boundary.

The reviewed desired state is machine-readable in
`.github/release-guardrails.json`; `npm run validate:release-policy` checks its
verified status-check app IDs, branch protections, environment reviewer, and
single-maintainer limitations. The file is a plan until a separate remote
audit proves GitHub is enforcing it.
Run that read-only comparison with `npm run audit:release-guardrails`; a
non-zero exit lists every missing or divergent remote control.

Actual beta publication is dispatched through the trusted `Release` workflow
from the `next` branch with `channel=v2-beta`, the exact version, and the
boolean publish confirmation. That entrypoint calls the reusable `Publish V2
Beta` workflow. Keeping `release.yml` as the caller lets npm validate the same
short-lived OIDC trusted publisher used by the stable train; the beta publisher
does not receive a long-lived npm write token. It still requires approval of
the `npm-next` environment, reruns `release:check`, rebuilds the exact requested
beta version, executes an npm publication dry-run, rejects an already-published
version, retains the tarball, and publishes only with the `next` dist-tag and
npm provenance. After publication it tolerates brief registry propagation
delay, verifies that `next` resolves to the requested version, and proves that
`latest` did not move. Semantic Release remains restricted to `main` and cannot
accidentally publish the v1 package on the beta channel.
The latest pre-publication registry and artifact snapshot is recorded in
[`evidence/v2-beta-readiness-2026-09-20.json`](./evidence/v2-beta-readiness-2026-09-20.json).

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
sample. Logs and all three machine-readable reports are retained as workflow
artifacts for 30 days. These runs are regression evidence, not external
production-adoption evidence.

## Release cadence and channels

- Stable releases run from `main` on the weekly Monday release train or by an
  explicit manual dispatch. Multiple fixes can therefore ship as one reviewed
  release rather than producing a new version for every merge.
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
Full stable release validation runs on Node 20 and 22. The v2 beta declares
Node `>=20` and its candidate workflow validates Node 20 and 22. Any further
minimum-version change requires migration and rollback guidance.

The support windows, v2 reversal procedure, release-owner duties, and path to a
second release-capable maintainer are defined in
[`support-and-maintenance.md`](./support-and-maintenance.md). The project remains
single-maintainer for release purposes until that qualification process is
actually completed.
