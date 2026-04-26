# 🛠️ brass-runtime — Mini ZIO-like runtime in TypeScript

A small experimental runtime inspired by **ZIO 2**, implemented in vanilla TypeScript and intentionally built without using `Promise` / `async`/`await` as the **primary semantic primitive**.

`brass-runtime` is the foundation: it provides an effect system, fibers, scheduler, scopes, and streams.
Higher-level modules (HTTP, streaming utilities, integrations) are built **on top of the runtime**, not baked into it.

> You can still interop with the outside world (timers, fetch, Node APIs) via explicit, cancellable bridges such as `fromPromiseAbortable`.

---

## Philosophy

- **Effects are values** — lazy, composable, referentially transparent
- **Async is explicit** — no hidden Promise semantics
- **Concurrency is structured** — fibers, scopes, finalizers
- **Side effects are interpreted** — not executed eagerly
- **Higher-level APIs are libraries, not magic**

If you like ZIO’s separation between `zio-core`, `zio-streams`, and `zio-http`, this project follows the same spirit.

---

## Core concepts

- Sync core effect: `Effect<R, E, A>` and `Exit<E, A>`
- Algebraic async representation: `Async<R, E, A>`
- Cooperative `Scheduler` (observable / testable)
- Lightweight `Fiber`s with interruption & finalizers
- Structured `Scope`s for resource safety
- ZStream-style streams with backpressure

---

## Install

```bash
npm i brass-runtime
```

---

## Quick start

### Run an effect

```ts
import { Runtime, succeed, toPromise } from "brass-runtime";

const runtime = new Runtime({ env: {} });

const value = await toPromise(succeed(123), runtime.env);
console.log(value); // 123
```

### Structured concurrency with Scope

```ts
import { Runtime, withScope } from "brass-runtime";

const runtime = new Runtime({ env: {} });

withScope(runtime, (scope) => {
  const f = scope.fork(/* Async effect */);
  // later...
  scope.close(); // interrupts child fibers + runs finalizers
});
```

> `toPromise` is just a convenience bridge for examples/DX. The runtime semantics remain explicit.

---

## Modules built on top of brass-runtime

These are optional layers, implemented using the runtime primitives.

### 🌐 HTTP client (brass-http layer)

A ZIO-style HTTP client built on top of fibers and `Async`.

- Lazy & cancelable HTTP requests
- Explicit wire/content separation
- Middleware-friendly (logging, retry, timeout, etc.)
- Integrated with fiber interruption via `AbortController`

👉 **Docs:** [HTTP module](./docs/http.md)

Example:

```ts
import { Runtime, toPromise } from "brass-runtime";
import { httpClientStream } from "brass-runtime/http";

type Post = { id: number; title: string; body: string };

const runtime = new Runtime({ env: {} });

const client = httpClientStream({ baseUrl: "https://jsonplaceholder.typicode.com" });

const res = await toPromise(client.getJson<Post>("/posts/1"), runtime.env);
console.log(res.status, res.value.title);
```

---

### 🤖 Brass Agent (experimental)

A CLI-first coding agent built on top of the runtime. Brass Agent is currently experimental: it can inspect a workspace, discover validation commands, gather bounded context, ask an LLM for a patch, apply/rollback patches through explicit policies, and expose a thin VS Code extension over the CLI protocol.

Start here:

- [Install and configure Brass Agent](./docs/agent-install-and-configure.md)
- [Declarative optimized planning roadmap](./docs/agent-declarative-optimized-planning.md)
- [Brass Agent CLI](./docs/agent-cli.md)
- [Project intelligence](./docs/agent-project-intelligence.md)
- [Global usage and workspace discovery](./docs/agent-global-usage.md)
- [VS Code local install](./docs/agent-vscode-install.md)
- [VS Code auto-discovery](./docs/agent-vscode-auto-discovery.md)
- [VS Code model setup](./docs/agent-vscode-model-setup.md)
- [VS Code chat layout / focus mode](./docs/agent-vscode-chat-layout.md)

```bash
npm run agent:vscode:install
# then open any repo in VS Code and use Brass Agent -> Chat

npm run build
npm run agent:link
brass-agent --where
brass-agent --doctor
brass-agent --init
brass-agent --preset inspect
```

---

### 🌊 Streams (ZStream-like)

Pull-based, resource-aware streams with backpressure.

- `ZStream<R, E, A>`
- `Pull` semantics
- Bounded buffers
- Deterministic resource cleanup

Examples:
- `src/examples/fromPromise.ts`
- `src/examples/mergeStreamSync.ts`

---

## Docs

- [Getting Started](./docs/getting-started.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Cancellation & Interruption](./docs/cancellation.md)
- [Observability: Hooks & Tracing](./docs/observability.md)
- [HTTP module](./docs/http.md)
- [Modules overview](./docs/modules.md)
- [Install and configure Brass Agent](./docs/agent-install-and-configure.md)
- [Declarative optimized planning roadmap](./docs/agent-declarative-optimized-planning.md)

---

## What’s new (recent changes)

- Stream buffering with backpressure (`buffer`)
- Abortable async integration (`fromPromiseAbortable`)
- Fiber-safe `toPromise` for examples & DX
- HTTP client module built on top of the runtime

---

## Features (status)

### Runtime (core)
- [x] Sync core: `Effect`
- [x] Async algebra: `Async`
- [x] Cooperative `Scheduler`
- [x] Fibers with interruption & finalizers
- [x] Structured `Scope`
- [x] Resource safety (`acquireRelease`)

### Concurrency & Streams
- [x] `race`, `zipPar`, `collectAllPar`
- [x] ZStream-like core
- [x] Bounded buffers & backpressure
- [x] Stream merge / zip
- [x] Hubs / Broadcast
- [x] Pipelines (`ZPipeline`-style)

### Libraries
- [x] HTTP client
- [ ] Retry / timeout middleware
- [ ] Logging / metrics layers

---

## Design notes

- **No hidden Promises**: async is always modeled explicitly
- **Deterministic execution**: scheduler is observable & testable
- **Resource safety is structural**: scopes guarantee cleanup
- **Libraries compose via functions**: middleware, not inheritance

---

## Contributing

- Runtime invariants matter — avoid sneaking Promises into semantics
- Prefer libraries on top of the runtime over changes in the core
- Small, focused PRs are welcome (your repo may enforce PR-only changes)

---

## License

MIT License © 2025


## Brass Agent local smoke tests

Run local smoke tests without CI or a real LLM provider:

```bash
npm run agent:test:local
```

This builds the project and runs a fake-LLM smoke test against the `brass-agent` CLI.

See also: [Agent language and workspace setup UX](docs/agent-language-workspace-ux.md).
