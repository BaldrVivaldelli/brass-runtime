# Layers (Dependency Injection)

Layers provide composable dependency injection with automatic lifecycle management.

## Basic Layer

```ts
import { layer, provideLayer, asyncSucceed } from "brass-runtime";

// Define a service layer
const DbLayer = layer(
  () => asyncSucceed(createPool({ host: "localhost", max: 10 })),
  (pool) => { pool.end(); return unit(); }
);

// Use it
const result = await run(
  provideLayer(DbLayer, (pool) => pool.query("SELECT 1"))
);
// Pool is automatically closed after use
```

## Layer with dependencies

```ts
import { layerFrom, compose } from "brass-runtime";

// Config layer (no dependencies, no cleanup)
const ConfigLayer = layerSucceed({ dbUrl: "postgres://...", port: 3000 });

// DB layer depends on Config
const DbLayer = layerFrom<{ dbUrl: string }>()(
  (config) => asyncSucceed(createPool(config.dbUrl)),
  (pool) => pool.close()
);

// Compose: Config → DB
const AppLayer = compose(ConfigLayer, DbLayer);

// Use the composed layer
await run(provideLayer(AppLayer, (db) => db.query("...")));
```

## Merging independent layers

```ts
import { merge, provideLayer } from "brass-runtime";

const DbLayer = layer(() => asyncSucceed(createPool()), (p) => p.close());
const CacheLayer = layer(() => asyncSucceed(createRedis()), (r) => r.quit());
const StorageLayer = layer(() => asyncSucceed(createS3()), (s) => s.destroy());

// Merge produces all three services
const InfraLayer = merge(merge(DbLayer, CacheLayer), StorageLayer);

await run(provideLayer(InfraLayer, (services) => {
  // services has all three: db + cache + storage
  return processRequest(services);
}));
// All released in reverse order
```

## Layer patterns

### Singleton service

```ts
const LoggerLayer = layerSucceed(console); // no lifecycle needed
```

### Service with health check

```ts
const DbLayer = layer(
  async () => {
    const pool = createPool();
    await pool.query("SELECT 1"); // health check on acquire
    return asyncSucceed(pool);
  },
  (pool) => pool.end()
);
```

### Test doubles

```ts
// Production
const RealDbLayer = layer(() => asyncSucceed(createPool()), (p) => p.close());

// Test
const MockDbLayer = layerSucceed({
  query: (sql: string) => asyncSucceed([{ id: 1, name: "test" }]),
  close: () => unit(),
});

// Same code, different layer
const result = await run(provideLayer(
  process.env.NODE_ENV === "test" ? MockDbLayer : RealDbLayer,
  (db) => db.query("SELECT *")
));
```
