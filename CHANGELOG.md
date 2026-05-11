# Changelog

## 1.14.0 - First Public Release Candidate

- Added mature core runtime features: structured concurrency, `Cause`,
  interruptibility, `FiberRef`, Layer 2.0, Schedule 2.0, TestRuntime, streams,
  and runtime observability.
- Added HTTP client/server surface with schema validation, lifecycle
  middleware, adaptive limiter, retry, compression, health/readiness, and
  observability hooks.
- Added `brass-runtime/perf` with runtime A/B, soak profiling, HTTP memory lab,
  benchmark budgets, and local perf history/baseline storage.
- Added DX helpers: `runPromise`, `runExit`, `makeRuntime`, `defineService`,
  `getService`, `provide`, `formatLayerError`, `formatConfigError`, and
  `HttpServer`.
- Added first-release recipes under `docs/recipes/` and release validation via
  `npm run release:check`.
