# Brass Agent observability

`brass-agent` emits a typed event stream while the agent loop runs.

The event stream is intentionally modeled as a capability of the agent environment:

```ts
type AgentEnv = {
  fs: FileSystem;
  shell: Shell;
  llm: LLM;
  patch: PatchService;
  permissions: PermissionService;
  approvals?: ApprovalService;
  events?: AgentEventSink;
};
```

The core runtime does not know about the agent. The agent depends on the runtime and exposes its own higher-level observability events.

## Invariant

Observability must never change agent semantics.

If an event sink throws, the agent ignores the sink failure and continues. Event sinks are best-effort and should not be used for control flow.

## Event lifecycle

A normal run emits events in this order:

```txt
agent.run.started
agent.action.started
agent.action.completed
agent.observation.recorded
...
agent.run.completed
```

If a tool fails, the action emits:

```txt
agent.action.started
agent.action.failed
agent.observation.recorded
```

Some important failures also emit specialized events:

```txt
agent.tool.timeout
agent.permission.denied
agent.approval.requested
agent.approval.resolved
```

Approval events are emitted around `ApprovalService.request(...)`. They report
that an action asked for human or policy approval and whether that approval was
granted or rejected.

When a patch is applied, the stream also emits:

```txt
agent.patch.applied
```

## CLI output

Human output now uses the live event stream by default:

```bash
brass-agent "fix the failing tests"
```

Example shape:

```txt
brass-agent propose
workspace: /repo
goal: fix the failing tests

→ read package.json
✓ read package.json 3ms
→ check pnpm-lock.yaml
✓ found pnpm-lock.yaml 2ms
→ pnpm test
! pnpm test exited 1 1234ms
→ llm.plan
✓ llm.plan responded 2400ms
→ propose patch
✓ patch proposed 1ms
→ finish
✓ done 1ms

phase: done
steps: 5
```

The old full-state debug output is still available:

```bash
brass-agent --json "fix the failing tests"
```

For quick machine-readable streaming, use event-only JSON Lines:

```bash
brass-agent --events-json "fix the failing tests"
```

This prints one compact `AgentEvent` per line.

For editor integrations and other clients, prefer the protocol stream:

```bash
brass-agent --protocol-json "fix the failing tests"
```

This prints newline-delimited messages with `protocol: "brass-agent"`, `version: 1`, event messages, and a final-state message. See [Agent DX surfaces](./agent-dx.md).

## Programmatic usage

```ts
import {
  runAgent,
  type AgentEnv,
  type AgentEventSink,
} from "brass-runtime/agent";

const events: AgentEventSink = {
  emit(event) {
    console.log(event.type, event);
  },
};

const env: AgentEnv = {
  fs,
  shell,
  patch,
  llm,
  permissions,
  approvals,
  events,
};
```

## Privacy and output size

The CLI compacts large payloads in `--events-json` mode, including file contents, LLM prompts, LLM responses, shell output, and patches.

Programmatic event sinks receive the typed event values directly. If you forward them to logs, apply your own redaction policy.

## Boundary rule

`src/core` must not import agent events. Agent observability lives in `src/agent` and is built on top of runtime semantics.
