# Resource Management

brass-runtime guarantees resource cleanup even when effects fail or fibers are interrupted.

## bracket — Acquire/Use/Release

The fundamental pattern for safe resource management:

```ts
import { bracket } from "brass-runtime";

const result = await run(
  bracket(
    // Acquire: open the resource
    openDatabaseConnection(),
    
    // Use: work with the resource
    (conn) => conn.query("SELECT * FROM users"),
    
    // Release: always runs, even on failure/interruption
    (conn, exit) => conn.close()
  )
);
```

**Guarantees:**
- If `acquire` fails, `release` is never called
- If `use` fails or is interrupted, `release` still runs
- Errors in `release` are swallowed (the `use` result propagates)

## ensuring — Attach a finalizer

```ts
import { ensuring } from "brass-runtime";

const result = await run(
  ensuring(
    doWork(),
    (exit) => {
      // Always runs after doWork completes
      if (exit._tag === "Success") logSuccess(exit.value);
      else logFailure(exit.cause);
      return unit();
    }
  )
);
```

## managed — Reusable resource descriptors

Define a resource once, use it many times:

```ts
import { managed, useManaged } from "brass-runtime";

// Define the resource (acquire + release)
const dbPool = managed(
  asyncSucceed(createPool({ max: 10 })),
  (pool) => { pool.close(); return unit(); }
);

// Use it — each call acquires a fresh instance
const users = await run(useManaged(dbPool, (pool) => pool.query("SELECT *")));
const orders = await run(useManaged(dbPool, (pool) => pool.query("SELECT *")));
```

## Resource — Composable scoped resources

`Resource` is the higher-level acquire/use/release descriptor. It composes with
`map`, `flatMap`, `zip`, and `Resource.all`, and releases nested resources in
reverse acquisition order.

```ts
import { Resource, makeResource, useResource } from "brass-runtime";

const db = makeResource(
  openDatabasePool(),
  (pool, _exit) => pool.close()
);

const cache = makeResource(
  openCacheClient(),
  (client, _exit) => client.disconnect()
);

const services = Resource.all([db, cache] as const);

const users = await run(
  useResource(services, ([pool, client]) =>
    loadUsers(pool, client)
  )
);
```

`Resource.fromManaged(managedValue)` bridges older `managed` descriptors into
the composable API.

## managedAll — Compose multiple resources

Acquire in order, release in reverse (LIFO):

```ts
import { managedAll, useManaged } from "brass-runtime";

const dbPool = managed(createPool(), (p) => p.close());
const cache = managed(createRedis(), (r) => r.disconnect());
const storage = managed(createS3Client(), (s) => s.destroy());

// All three acquired in order, released in reverse
const resources = managedAll([dbPool, cache, storage]);

const result = await run(
  useManaged(resources, ([db, redis, s3]) => {
    // Use all three services
    return processData(db, redis, s3);
  })
);
// s3 released first, then redis, then db
```

## With Semaphore (connection limiting)

```ts
import { makeSemaphore, bracket } from "brass-runtime";

const poolSem = makeSemaphore(10); // max 10 connections

const withConnection = (work: (conn: Connection) => Async<any, any, any>) =>
  poolSem.withPermit(
    bracket(
      openConnection(),
      work,
      (conn) => conn.close()
    )
  );

// At most 10 concurrent connections
await Promise.all(
  userIds.map(id => run(withConnection(conn => conn.query(id))))
);
```
