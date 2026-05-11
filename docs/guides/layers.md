# Layers (Dependency Injection)

Layers describe how to build services, wire dependencies, and release resources.
They are lazy values: acquisition happens only when a runtime evaluates
`provideLayer`, `provideLayerContext`, `buildLayer`, or the `Layer.*` aliases.

Layer 2.0 adds three pieces on top of the original API:

- typed `ServiceTag<A>` keys
- immutable `LayerContext` service maps
- scoped builds with memoization and idempotent finalizers

## Typed Contexts

Use tags when a layer graph needs more than one service or when a service should
be retrieved by capability instead of object shape.

```ts
import { type Async, Layer, Runtime, asyncSucceed, asyncSync } from "brass-runtime";

const finalizer = (run: () => void): Async<unknown, never, void> =>
  asyncSync(() => run()) as Async<unknown, never, void>;

type Config = { readonly dbUrl: string };
type Db = { readonly query: (sql: string) => string };

const Config = Layer.tag<Config>("Config");
const Db = Layer.tag<Db>("Db");

const ConfigLayer = Layer.value(Config, { dbUrl: "postgres://local" });

const DbLayer = Layer.effect(
  Db,
  (ctx) => {
    const config = ctx.unsafeGet(Config);
    return asyncSucceed({
      query: (sql) => `${sql} on ${config.dbUrl}`,
    });
  },
  (db) => finalizer(() => {
    db.query("close");
  }),
);

const AppLayer = Layer.compose(ConfigLayer, DbLayer);

const runtime = Runtime.make({});
const result = await runtime.toPromise(
  Layer.provideContext(AppLayer, (ctx) =>
    asyncSucceed(ctx.unsafeGet(Db).query("select 1")),
  ),
);
```

`LayerContext` is immutable. `add` and `merge` return new contexts, and
right-hand services win when two contexts contain the same tag.

## Plain Services

The original layer API is still supported for simple service shapes.

```ts
import { layer, layerFrom, composeLayer, provideLayer, asyncSucceed, asyncSync } from "brass-runtime";

type Config = { readonly dbUrl: string };
type Db = { readonly query: (sql: string) => string };

const ConfigLayer = layer(() => asyncSucceed<Config>({
  dbUrl: "postgres://local",
}));

const DbLayer = layerFrom<Config>()(
  (config) => asyncSucceed<Db>({
    query: (sql) => `${sql} on ${config.dbUrl}`,
  }),
  () => asyncSync(() => {
    // close the connection pool here
  }),
);

const AppLayer = composeLayer(ConfigLayer, DbLayer);

await runtime.toPromise(
  provideLayer(AppLayer, (db) => asyncSucceed(db.query("select 1"))),
);
```

## Merging

`mergeLayer` combines independent layers. Plain object services are merged with
object spread; `LayerContext` services are merged by tag.

```ts
import { Layer, mergeLayer, asyncSucceed } from "brass-runtime";

const Db = Layer.tag<{ readonly query: (sql: string) => string }>("Db");
const Cache = Layer.tag<{ readonly get: (key: string) => string | undefined }>("Cache");

const DbLayer = Layer.effect(Db, () => asyncSucceed({ query: (sql) => sql }));
const CacheLayer = Layer.effect(Cache, () => asyncSucceed({ get: () => undefined }));

const InfraLayer = mergeLayer(DbLayer, CacheLayer);

await runtime.toPromise(
  Layer.provideContext(InfraLayer, (ctx) =>
    asyncSucceed({
      db: ctx.unsafeGet(Db),
      cache: ctx.unsafeGet(Cache),
    }),
  ),
);
```

## Scoped Builds

Use `buildLayer` or `Layer.build` when a caller wants manual lifecycle control.
The returned scope memoizes shared layer instances during a build, releases in
reverse acquisition order, and makes `close()` idempotent.

```ts
import { Layer, asyncSucceed } from "brass-runtime";

const built = await runtime.toPromise(Layer.build(InfraLayer));

try {
  await runtime.toPromise(
    built.use((ctx) => asyncSucceed(ctx.unsafeGet(Db).query("select 1"))),
  );
} finally {
  await runtime.toPromise(built.close());
}
```

For advanced graph assembly, create an explicit scope:

```ts
const scope = Layer.scope();

const db = await runtime.toPromise(scope.get(DbLayer));
const sameDb = await runtime.toPromise(scope.get(DbLayer));

db === sameDb; // true for the same layer object within the same scope

await runtime.toPromise(scope.close());
```

After a scope is closed, further `scope.get(...)` calls fail.

## Patterns

### Singleton Service

```ts
const Logger = Layer.tag<Console>("Logger");
const LoggerLayer = Layer.value(Logger, console);
```

### Service With Health Check

```ts
const DbLayer = Layer.effect(
  Db,
  () => asyncSync(() => {
    const pool = createPool();
    pool.query("select 1");
    return pool;
  }),
  (pool) => asyncSync(() => {
    pool.close();
  }),
);
```

### Test Doubles

```ts
const RealDbLayer = Layer.effect(Db, () => asyncSucceed(createPool()));

const MockDbLayer = Layer.value(Db, {
  query: (sql: string) => `mock:${sql}`,
});

const result = await runtime.toPromise(
  Layer.provideContext(
    process.env.NODE_ENV === "test" ? MockDbLayer : RealDbLayer,
    (ctx) => asyncSucceed(ctx.unsafeGet(Db).query("select *")),
  ),
);
```
