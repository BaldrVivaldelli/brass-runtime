// src/core/runtime/layer.ts
// Layer — composable dependency injection with lifecycle management.
//
// A Layer<RIn, E, ROut> describes how to build a service ROut from
// dependencies RIn, with possible failure E. Layers manage the lifecycle
// of services (acquire on build, release on close).

import { Async, asyncFlatMap, asyncFold, asyncSucceed, asyncFail, asyncSync, unit } from "../types/asyncEffect";
import { ensuring } from "./resource";

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
  readonly buildScoped?: (deps: RIn, scope: LayerScope) => Async<unknown, E, ROut>;
};

export type ServiceTag<A> = {
  readonly _tag: "ServiceTag";
  readonly key: symbol;
  readonly name: string;
};

export class MissingLayerServiceError extends Error {
  readonly _tag = "MissingLayerService" as const;
  readonly serviceName: string;

  constructor(serviceName: string) {
    super(`Missing layer service '${serviceName}'. Add a layer that provides this ServiceTag or pass a LayerContext containing it.`);
    this.name = "MissingLayerServiceError";
    this.serviceName = serviceName;
  }
}

export function formatLayerError(error: unknown): string {
  if (error instanceof MissingLayerServiceError) return error.message;
  if (isObjectRecord(error) && (error as any)._tag === "MissingLayerService" && typeof (error as any).serviceName === "string") {
    return `Missing layer service '${(error as any).serviceName}'. Add the provider layer before using the service.`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function makeServiceTag<A>(name: string): ServiceTag<A> {
  return {
    _tag: "ServiceTag",
    key: Symbol(name),
    name,
  };
}

export const serviceTag = makeServiceTag;
export const defineService = makeServiceTag;

export class LayerContext<Services = unknown> {
  private readonly services: Map<symbol, unknown>;

  constructor(entries?: Iterable<readonly [ServiceTag<any>, unknown]> | Map<symbol, unknown>) {
    if (entries instanceof Map) {
      this.services = new Map(entries);
      return;
    }
    this.services = new Map();
    if (!entries) return;
    for (const [tag, service] of entries) this.services.set(tag.key, service);
  }

  static empty(): LayerContext<unknown> {
    return new LayerContext();
  }

  get<A>(tag: ServiceTag<A>): A | undefined {
    return this.services.get(tag.key) as A | undefined;
  }

  unsafeGet<A>(tag: ServiceTag<A>): A {
    if (!this.services.has(tag.key)) {
      throw new MissingLayerServiceError(tag.name);
    }
    return this.services.get(tag.key) as A;
  }

  has(tag: ServiceTag<unknown>): boolean {
    return this.services.has(tag.key);
  }

  add<A>(tag: ServiceTag<A>, service: A): LayerContext<Services & A> {
    const next = new Map(this.services);
    next.set(tag.key, service);
    return new LayerContext(next) as LayerContext<Services & A>;
  }

  merge<Other>(other: LayerContext<Other>): LayerContext<Services & Other> {
    const next = new Map(this.services);
    for (const [key, service] of other.services) next.set(key, service);
    return new LayerContext(next) as LayerContext<Services & Other>;
  }

  size(): number {
    return this.services.size;
  }
}

export type LayerScope = {
  readonly get: <RIn, E, ROut>(layer: Layer<RIn, E, ROut>, deps?: RIn) => Async<unknown, E, ROut>;
  readonly close: () => Async<unknown, never, void>;
  readonly size: () => number;
};

type MutableLayerScope = LayerScope & {
  readonly addFinalizer: (release: () => Async<unknown, never, void>) => Async<unknown, never, void>;
};

export type BuiltLayer<ROut> = {
  readonly service: ROut;
  readonly scope: LayerScope;
  readonly close: () => Async<unknown, never, void>;
  readonly use: <E, A>(body: (service: ROut) => Async<unknown, E, A>) => Async<unknown, E, A>;
};

export function makeLayerScope(): LayerScope {
  const cache = new WeakMap<object, unknown>();
  const finalizers: Array<() => Async<unknown, never, void>> = [];
  let closed = false;

  const scope: MutableLayerScope = {
    get: <RIn, E, ROut>(l: Layer<RIn, E, ROut>, deps?: RIn): Async<unknown, E, ROut> => {
      if (closed) return asyncFail(new Error("LayerScope is closed")) as Async<unknown, E, ROut>;
      if (cache.has(l)) return asyncSucceed(cache.get(l) as ROut) as Async<unknown, E, ROut>;

      const built = l.buildScoped
        ? l.buildScoped(deps as RIn, scope)
        : asyncFlatMap(
            l.build(deps as RIn),
            ({ service, release }) =>
              asyncFlatMap(scope.addFinalizer(release), () => asyncSucceed(service))
          );

      return asyncFlatMap(
        built as Async<unknown, E, ROut>,
        (service) => asyncSync(() => {
          cache.set(l, service);
          return service;
        }) as Async<unknown, never, ROut>
      );
    },
    close: () => {
      if (closed) return unit() as Async<unknown, never, void>;
      closed = true;
      return releaseAll(finalizers);
    },
    size: () => finalizers.length,
    addFinalizer: (release) => asyncSync(() => {
      if (!closed) finalizers.push(release);
    }) as Async<unknown, never, void>,
  };

  return scope;
}

function releaseAll(finalizers: Array<() => Async<unknown, never, void>>): Async<unknown, never, void> {
  const next = finalizers.pop();
  if (!next) return unit() as Async<unknown, never, void>;
  return asyncFold(
    next(),
    () => releaseAll(finalizers),
    () => releaseAll(finalizers),
  ) as Async<unknown, never, void>;
}

function mergeServices<A, B>(a: A, b: B): A & B {
  if (a instanceof LayerContext && b instanceof LayerContext) {
    return a.merge(b) as A & B;
  }
  if (isObjectRecord(a) && isObjectRecord(b)) {
    return { ...a, ...b } as A & B;
  }
  return Object.assign({}, a, b) as A & B;
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

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

export function layerValue<A>(tag: ServiceTag<A>, value: A): Layer<LayerContext, never, LayerContext> {
  return layerEffect(tag, () => asyncSucceed(value));
}

export function layerEffect<E, A>(
  tag: ServiceTag<A>,
  acquire: (deps: LayerContext) => Async<unknown, E, A>,
  release?: (service: A) => Async<unknown, never, void>
): Layer<LayerContext, E, LayerContext> {
  return {
    _tag: "Layer",
    build: (deps: LayerContext = LayerContext.empty()) => asyncFlatMap(acquire(deps), (service) => asyncSucceed({
      service: deps.add(tag, service),
      release: release ? () => release(service) : () => unit() as Async<unknown, never, void>,
    })),
  };
}

export const layerFromContext = layerEffect;
export const defineLayer = layerEffect;

export function getService<A>(tag: ServiceTag<A>): Async<LayerContext, MissingLayerServiceError, A> {
  return asyncSync((context: LayerContext) => context.unsafeGet(tag)) as Async<LayerContext, MissingLayerServiceError, A>;
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
    buildScoped: (deps: R1, scope) => asyncFlatMap(
      scope.get(from, deps) as Async<unknown, E1 | E2, Mid>,
      (mid) => scope.get(to, mid) as Async<unknown, E1 | E2, ROut>
    ),
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
    buildScoped: (deps: R1 & R2, scope) => asyncFlatMap(
      scope.get(left, deps) as Async<unknown, E1 | E2, A>,
      (a) => asyncFlatMap(
        scope.get(right, deps) as Async<unknown, E1 | E2, B>,
        (b) => asyncSucceed(mergeServices(a, b))
      )
    ),
    build: (deps: R1 & R2) => asyncFlatMap(
      left.build(deps) as Async<unknown, E1 | E2, { service: A; release: () => Async<unknown, never, void> }>,
      ({ service: a, release: releaseA }) =>
        asyncFold(
          right.build(deps) as Async<unknown, E1 | E2, { service: B; release: () => Async<unknown, never, void> }>,
          (error: E1 | E2) => asyncFlatMap(releaseA(), () => asyncFail(error) as any),
          ({ service: b, release: releaseB }) => asyncSucceed({
            service: mergeServices(a, b),
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
    buildScoped: (deps: RIn, scope) => asyncFlatMap(
      scope.get(l, deps) as Async<unknown, E, A>,
      (service) => asyncSucceed(f(service))
    ),
    build: (deps: RIn) => asyncFlatMap(
      l.build(deps),
      ({ service, release }) => asyncSucceed({ service: f(service), release })
    ),
  };
}

export function buildLayer<RIn, E, ROut>(
  l: Layer<RIn, E, ROut>,
  deps?: RIn
): Async<unknown, E, BuiltLayer<ROut>> {
  const scope = makeLayerScope();
  return asyncFold(
    scope.get(l, deps),
    (error: E) => asyncFlatMap(scope.close(), () => asyncFail(error) as Async<unknown, E, BuiltLayer<ROut>>),
    (service: ROut) => asyncSucceed({
      service,
      scope,
      close: scope.close,
      use: (body) => body(service),
    })
  );
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
    buildLayer(l, deps ?? ({} as RIn)) as Async<unknown, E | E2, BuiltLayer<ROut>>,
    ({ service, close }) => ensuring(
      use(service) as Async<unknown, E | E2, A>,
      () => close()
    ) as Async<unknown, E | E2, A>
  );
}

export function provideLayerContext<E, E2, A>(
  l: Layer<LayerContext, E, LayerContext>,
  use: (context: LayerContext) => Async<unknown, E2, A>,
  deps: LayerContext = LayerContext.empty()
): Async<unknown, E | E2, A> {
  return provideLayer(l, use, deps);
}

export const provide = provideLayer;
export const provideContext = provideLayerContext;

export const Layer = Object.freeze({
  make: layer,
  from: layerFrom,
  succeed: layerSucceed,
  fail: layerFail,
  value: layerValue,
  effect: layerEffect,
  define: defineLayer,
  fromContext: layerFromContext,
  compose,
  merge,
  map: mapLayer,
  provide: provideLayer,
  provideContext: provideLayerContext,
  build: buildLayer,
  scope: makeLayerScope,
  context: LayerContext.empty,
  tag: makeServiceTag,
  service: getService,
});
