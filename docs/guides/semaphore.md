# Semaphore & Rate Limiting

Control concurrency with counting semaphores.

## Basic usage

```ts
import { makeSemaphore } from "brass-runtime";

// Allow at most 5 concurrent operations
const sem = makeSemaphore(5);

// Automatic acquire/release
const result = await run(sem.withPermit(callExternalApi()));
```

## Rate limiting API calls

```ts
const apiLimiter = makeSemaphore(10); // max 10 concurrent requests

async function fetchAll(urls: string[]) {
  return Promise.all(
    urls.map(url => run(apiLimiter.withPermit(fetch(url))))
  );
}
```

## Database connection limiting

```ts
const connPool = makeSemaphore(20); // max 20 DB connections

const query = (sql: string) =>
  connPool.withPermit(
    bracket(
      openConnection(),
      (conn) => conn.execute(sql),
      (conn) => conn.release()
    )
  );
```

## Manual acquire/release

```ts
const sem = makeSemaphore(1); // mutex

await run(sem.acquire());
try {
  // Critical section — only one fiber at a time
  await doExclusiveWork();
} finally {
  sem.release();
}
```

## Monitoring

```ts
const sem = makeSemaphore(10);

console.log(sem.available()); // permits left (0-10)
console.log(sem.waiting());   // fibers waiting for a permit
console.log(sem.capacity);    // total permits (10)
```
