// src/core/runtime/layer.ts
// Layer — composable dependency injection with lifecycle management.
//
// A Layer<RIn, E, ROut> describes how to build a service ROut from
// dependencies RIn, with possible failure E. Layers manage the lifecycle
// of services (acquire on build, release on close).

import { Async, async, asyncFlatMap, asyncFold, asyncSucceed, asyncFail, unit } from "../types/asyncEffect";
import { Exit } from "../types/effect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A Layer describes how to build a service.
 *
 * - RIn: dependencies required to build this service
 * - E: possible failure during construction
 * - ROut: the service produced
 */
export type Layer<RIn, E, ROut> = {
  readonly _tag: "Layer";
  readonly build: (deps: RIn) => Async<unknown, E, { service: ROut; release: () => Async<unknown, never, void> }>;
};

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Creates a Layer from an acquire/release pair.
 *
 * ```ts
 * const DbLayer = layer(
 *   () => createPool({ max: 10 }),
 *   (pool) => pool.close()
 * );
 * ```
 */
export function layer<ROut, E = never>(
  acquire: () => Async<unknown, E, ROut>,
  release?: (service: ROut) => Async<unknown, never, void>
): Layer<unknown, E, ROut> {
  return {
    _tag: "Layer",
    build: (_deps) => asyncFlatMap(acquire(), (service) => asyncSucceed({
      service,
      release: release ? () => release(service) : () => unit() as Async<unknown, never, void>,
    })),
  };
}

/**
 * Creates a Layer that depends on another service.
 *
 * ```ts
 * const RepoLayer = layerFrom<DbPool>()(
 *   (pool) => createRepo(pool),
 *   (repo) => repo.close()
 * );
 * ```
 */
export function layerFrom<RIn>() {
  return <ROut, E = never>(
    acquire: (deps: RIn) => Async<unknown, E, ROut>,
    release?: (service: ROut) => Async<unknown, never, void>
  ): Layer<RIn, E, ROut> => ({
    _tag: "Layer",
    build: (deps: RIn) => asyncFlatMap(acquire(deps), (service) => asyncSucceed({
      service,
      release: release ? () => release(service) : () => unit() as Async<unknown, never, void>,
    })),
  });
}

/**
 * Creates a Layer from a pure value (no lifecycle).
 *
 * ```ts
 * const ConfigLayer = layerSucceed({ port: 3000, host: "localhost" });
 * ```
 */
export function layerSucceed<ROut>(value: ROut): Layer<unknown, never, ROut> {
  return {
    _tag: "Layer",
    build: () => asyncSucceed({ service: value, release: () => unit() as Async<unknown, never, void> }),
  };
}

/**
 * Creates a Layer that always fails.
 */
export function layerFail<E>(error: E): Layer<unknown, E, never> {
  return {
    _tag: "Layer",
    build: () => asyncFail(error) as any,
  };
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

/**
 * Compose two layers: the output of `from` feeds into `to`.
 *
 * ```ts
 * const AppLayer = compose(DbLayer, RepoLayer);
 * // DbLayer produces DbPool → RepoLayer consumes DbPool → produces Repo
 * ```
 */
export function compose<R1, E1, Mid, E2, ROut>(
  from: Layer<R1, E1, Mid>,
  to: Layer<Mid, E2, ROut>
): Layer<R1, E1 | E2, ROut> {
  return {
    _tag: "Layer",
    build: (deps: R1) => asyncFlatMap(
      from.build(deps) as Async<unknown, E1 | E2, { service: Mid; release: () => Async<unknown, never, void> }>,
      ({ service: mid, release: releaseMid }) =>
        asyncFold(
          to.build(mid) as Async<unknown, E1 | E2, { service: ROut; release: () => Async<unknown, never, void> }>,
          (error: E1 | E2) => asyncFlatMap(releaseMid(), () => asyncFail(error) as any),
          ({ service: out, release: releaseOut }) => asyncSucceed({
            service: out,
            release: () => asyncFlatMap(releaseOut(), () => releaseMid()),
          })
        )
    ),
  };
}

/**
 * Merge two independent layers into one that produces both services.
 *
 * ```ts
 * const AppLayer = merge(DbLayer, CacheLayer);
 * // Produces { db: DbPool, cache: CacheClient }
 * ```
 */
export function merge<R1, E1, A, R2, E2, B>(
  left: Layer<R1, E1, A>,
  right: Layer<R2, E2, B>
): Layer<R1 & R2, E1 | E2, A & B> {
  return {
    _tag: "Layer",
    build: (deps: R1 & R2) => asyncFlatMap(
      left.build(deps) as Async<unknown, E1 | E2, { service: A; release: () => Async<unknown, never, void> }>,
      ({ service: a, release: releaseA }) =>
        asyncFold(
          right.build(deps) as Async<unknown, E1 | E2, { service: B; release: () => Async<unknown, never, void> }>,
          (error: E1 | E2) => asyncFlatMap(releaseA(), () => asyncFail(error) as any),
          ({ service: b, release: releaseB }) => asyncSucceed({
            service: { ...a, ...b } as A & B,
            release: () => asyncFlatMap(releaseB(), () => releaseA()),
          })
        )
    ),
  };
}

/**
 * Map the output of a layer.
 */
export function mapLayer<RIn, E, A, B>(
  l: Layer<RIn, E, A>,
  f: (a: A) => B
): Layer<RIn, E, B> {
  return {
    _tag: "Layer",
    build: (deps: RIn) => asyncFlatMap(
      l.build(deps),
      ({ service, release }) => asyncSucceed({ service: f(service), release })
    ),
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Builds a layer, runs an effect with the produced service, and releases.
 *
 * ```ts
 * const result = await run(
 *   provideLayer(AppLayer, (services) => services.db.query("SELECT 1"))
 * );
 * ```
 */
export function provideLayer<RIn, E, ROut, E2, A>(
  l: Layer<RIn, E, ROut>,
  use: (service: ROut) => Async<unknown, E2, A>,
  deps?: RIn
): Async<unknown, E | E2, A> {
  return asyncFlatMap(
    l.build(deps ?? ({} as RIn)) as Async<unknown, E | E2, { service: ROut; release: () => Async<unknown, never, void> }>,
    ({ service, release }) =>
      asyncFold(
        use(service) as Async<unknown, E | E2, A>,
        (error: E | E2) => asyncFlatMap(release() as any, () => asyncFail(error) as any),
        (value: A) => asyncFlatMap(release() as any, () => asyncSucceed(value) as any)
      )
  );
}
