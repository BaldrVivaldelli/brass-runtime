# Error Handling

brass-runtime provides typed error handling with discriminated unions, enabling exhaustive pattern matching and type-safe recovery.

## Tagged Errors

Define errors as discriminated unions:

```ts
type AppError =
  | { _tag: "NetworkError"; url: string; status: number }
  | { _tag: "TimeoutError"; ms: number }
  | { _tag: "NotFound"; id: string };
```

## catchTag — Handle specific errors

```ts
import { catchTag } from "brass-runtime";

const result = catchTag(
  fetchUser(id),          // Async<R, AppError, User>
  "NotFound",             // catch only NotFound
  (e) => asyncSucceed(defaultUser)  // e is narrowed to { _tag: "NotFound"; id: string }
);
// Result type: Async<R, NetworkError | TimeoutError, User>
// NotFound is removed from the error type!
```

## catchTags — Handle multiple errors at once

```ts
import { catchTags } from "brass-runtime";

const result = catchTags(fetchUser(id), {
  NotFound: (e) => asyncSucceed(defaultUser),
  TimeoutError: (e) => retryWithBackoff(fetchUser(id)),
});
// Only NetworkError remains in the error channel
```

## tagError — Wrap untyped errors

```ts
import { tagError } from "brass-runtime";

// Wrap a fetch error with a tag
const typed = tagError(
  rawFetch(url),
  "NetworkError",
  (e) => ({ url, message: String(e) })
);
// Error type: { _tag: "NetworkError"; url: string; message: string }
```

## orElse — Fallback on any error

```ts
import { orElse } from "brass-runtime";

const result = orElse(
  primaryDataSource(),
  (error) => fallbackDataSource()
);
```

## mapError — Transform errors

```ts
import { mapError } from "brass-runtime";

const wrapped = mapError(
  effect,
  (e) => ({ _tag: "ServiceError" as const, cause: e })
);
```

## Combining with retry

```ts
import { catchTag, retryWithBackoff } from "brass-runtime";

const resilient = catchTag(
  retryWithBackoff(fetchData(), {
    maxRetries: 3,
    shouldRetry: (e) => e._tag === "NetworkError",
  }),
  "TimeoutError",
  () => asyncSucceed(cachedData)
);
```
