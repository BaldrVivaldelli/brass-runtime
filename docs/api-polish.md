# API Polish Notes

First-release DX pass.

## Public API audit

- Kept existing exports for compatibility.
- Added small aliases/helpers instead of renaming established APIs.
- Kept optional subsystems on subpaths: `http`, `schema`, `observability`,
  `perf`, and `agent`.
- Added a public API release snapshot test for the most important first-release
  symbols.

## Happy paths

- Runtime: `runPromise`, `runExit`, `makeRuntime`.
- Layers: `defineService`, `getService`, `provide`, `provideContext`,
  `formatLayerError`.
- HTTP server: `HttpServer` discoverability object over route/router/listen
  and response helpers.
- Config/schema: `formatConfigError`, `isConfigValidationError`.
- Performance: `perf:history`, named baselines, and release recipes.

## Type inference

Type tests cover:

- HTTP client request/response schema inference.
- HTTP server path param and schema override inference.
- Schema `InferSchema`.
- Layer service tags and provide aliases.
- Runtime `runPromise` / `runExit` return types.

## Release posture

The first-release gate is `npm run release:check`. A GC-aware HTTP memory lab is
still recommended manually on the release machine before publishing.
