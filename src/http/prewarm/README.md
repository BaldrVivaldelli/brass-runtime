# HTTP Connection Pre-warming

Proactively establish TCP+TLS connections to known origins before actual requests are needed, eliminating handshake latency from the critical path.

## Quick Start

```typescript
import { makePrewarmManager } from "brass-runtime/http";

const manager = makePrewarmManager({
  origins: ["https://api.example.com", "https://cdn.example.com"],
  keepAliveDurationMs: 55000,
  budget: 4,
  autoRefresh: true,
});

// Warm all configured origins
const results = await manager.warmAll();

// Check if a specific origin is warm
if (manager.isWarm("https://api.example.com")) {
  // Connection is ready — next request will skip TCP+TLS handshake
}

// Clean up when done
manager.dispose();
```

## API

### `makePrewarmManager(config: PrewarmConfig): PrewarmManager`

Creates a new PrewarmManager instance.

#### Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `origins` | `string[]` | (required) | Origins to pre-warm (scheme + host + optional port) |
| `keepAliveDurationMs` | `number` | `55000` | Duration a connection is considered warm |
| `budget` | `number` | `4` | Max concurrent in-flight probes |
| `probeTimeoutMs` | `number` | `5000` | Timeout for each probe request |
| `autoRefresh` | `boolean` | `false` | Automatically re-probe before expiry |
| `useClientPool` | `boolean` | `false` | Route probes through the Wire_Client pool |
| `client` | `HttpClientFn` | `undefined` | Wire_Client to use when `useClientPool` is true |
| `onEvent` | `(event: PrewarmEvent) => void` | `undefined` | Event observer callback |

#### PrewarmManager Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `warm(origin)` | `Promise<PrewarmResult>` | Warm a single origin (skips if already warm) |
| `warmAll()` | `Promise<PrewarmResult[]>` | Warm all configured origins |
| `isWarm(origin)` | `boolean` | Check if an origin has an active warm connection |
| `cancel(origin)` | `void` | Cancel in-flight probe for a specific origin |
| `cancelAll()` | `void` | Cancel all in-flight and queued probes |
| `status()` | `PrewarmStatusSnapshot` | Get snapshot of all managed origins |
| `dispose()` | `void` | Cancel all, stop timers, release resources |

### PrewarmResult

```typescript
type PrewarmResult = {
  origin: string;
  status: "warmed" | "already-warm" | "failed" | "cancelled";
  durationMs: number;
  error?: string;
};
```

### PrewarmEvent

```typescript
type PrewarmEvent = {
  type: "connection-warmed" | "connection-expired" | "connection-failed" | "connection-cancelled";
  origin: string;
  timestamp: number;
  durationMs?: number;
  error?: string;
};
```

## Lifecycle Client Integration

Pre-warming integrates with `makeLifecycleClient` for automatic warming based on response patterns:

```typescript
import { makeLifecycleClient } from "brass-runtime/http";

const client = makeLifecycleClient({
  baseUrl: "https://api.example.com",
  prewarm: {
    origins: ["https://cdn.example.com", "https://auth.example.com"],
    autoRefresh: true,
    afterResponse: (response, request) => {
      // Warm related origins after successful responses
      if (request.url.includes("/login")) {
        return ["https://dashboard-api.example.com"];
      }
      return [];
    },
    onEvent: (event) => {
      console.log(`[prewarm] ${event.type} ${event.origin}`);
    },
  },
});
```

When `prewarm` is configured on the lifecycle client:
- A PrewarmManager is created internally at construction time
- The `afterResponse` hook is called after each successful HTTP response
- Origins returned by the hook are warmed automatically
- `cancelAll()` on the lifecycle client also cancels all prewarm operations

## Auto-Refresh

When `autoRefresh: true`, the manager schedules a re-probe at 80% of `keepAliveDurationMs` after each successful probe. This keeps connections warm without waiting for them to expire.

```
Timeline (keepAliveDurationMs = 55000):
  t=0ms       probe succeeds, origin marked warm
  t=44000ms   auto-refresh triggers new probe (0.8 * 55000)
  t=55000ms   original warm connection would have expired
```

In Node.js, auto-refresh timers use `.unref()` to avoid keeping the process alive.

## Pool Awareness

By default, probes use a dedicated `fetch` call governed only by the budget semaphore. Set `useClientPool: true` to route probes through the same Wire_Client pool as regular requests:

```typescript
const manager = makePrewarmManager({
  origins: ["https://api.example.com"],
  useClientPool: true,
  client: wireClient, // Your existing Wire_Client instance
});
```

## Cross-Platform

The module works in both Node.js 18+ and modern browsers:
- **Node.js**: Standard HEAD requests via global `fetch`
- **Browser**: Uses `mode: "no-cors"` for cross-origin probes to avoid CORS preflight failures

Throws a descriptive error at construction time if `fetch` or `AbortController` is unavailable.

## Error Handling

Probe failures are never propagated as exceptions. All errors are captured in `PrewarmResult.error`:

```typescript
const result = await manager.warm("https://unreachable.example.com");
if (result.status === "failed") {
  console.warn(`Prewarm failed: ${result.error}`);
}
```

After `dispose()`, all subsequent calls return immediately with status `"cancelled"`.
