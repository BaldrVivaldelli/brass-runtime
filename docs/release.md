# First Release Checklist

This is the release gate for the first public `brass-runtime` release.

## Release command

```bash
npm run release:check
```

`release:check` covers:

- TypeScript API/type checks.
- Full Vitest suite.
- TS bundle build.
- CJS compatibility validation.
- Runtime profiler budget.
- Runtime benchmark budget.
- HTTP benchmark budget.
- Observability benchmark budget.

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

- Confirm `npm pack --dry-run` includes only package files expected by
  `package.json`.

## First-release scope

- Core runtime, fibers, scopes, `Cause`, interruptibility, `FiberRef`.
- Layer 2.0 and Schedule 2.0.
- Streams and pipelines.
- HTTP client/server, schema validation, lifecycle middleware.
- Observability and runtime health/readiness.
- Performance profiler, budgets, history, and baselines.
- Brass Agent CLI/library surface.

Do not publish `.brass/perf-history`; it is intentionally local evidence.
