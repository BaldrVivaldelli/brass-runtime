# Agent Module Boundaries

These rules keep the experimental agent layer useful without letting it leak into the runtime core.

## Dependency direction

```txt
core runtime
  ↑
agent module
  ↑
cli / UX
```

Rules:

1. `src/core` must not know that `src/agent` exists.
2. `src/agent` may depend on `src/core` runtime primitives.
3. Agent-specific shortcuts must not be added to `Runtime`, `Fiber`, `Scope`, or the scheduler.
4. If the agent reveals a missing semantic in the core, fix the core as a runtime invariant first.
5. Keep the agent as an experimental consumer of the runtime until the shape is stable.

## Agent execution model

The agent does not perform side effects directly.

It must follow this pipeline:

```txt
Goal
  -> decideNextAction
  -> PermissionService
  -> ApprovalService when permission decision is ask
  -> ToolPolicy
  -> AgentAction interpreted as Async
  -> Observation
  -> reducer
  -> next AgentState
```

Rules:

1. The planner produces `AgentAction` values.
2. Every `AgentAction` is interpreted into `Async<AgentEnv, AgentError, Observation>`.
3. All external work goes through capabilities in `AgentEnv`.
4. All tool execution goes through permissions first.
5. Approval-required actions must be approved before tool execution.
6. All tool execution goes through timeout/retry policy.
7. No detached background work by default.
8. Every async tool that touches external work must be cancellable.
9. Any patch-application path must validate that every target path stays inside the workspace.


## Configuration boundary

Project policy may be loaded from `.brass-agent.json`, but config is still an
agent-layer concern:

```txt
src/core
  ↑
src/agent policy/config
  ↑
src/agent/cli Node config loader
```

Rules:

1. Config loading must not move into `src/core`.
2. Config is resolved before constructing `AgentEnv`.
3. Config may tune permissions, approvals, LLM provider/model, and tool policies.
4. Config must not store secrets; adapters should read API keys from environment variables.
5. Config must not bypass the `AgentAction -> PermissionService -> ApprovalService -> ToolPolicy -> Async -> Observation` pipeline.

## Runtime invariants the agent relies on

The agent assumes these runtime semantics:

1. `Scope.close()` interrupts child fibers.
2. `Scope.closeAsync(...)` can be awaited.
3. Closing a parent scope propagates to subscopes.
4. Interrupted fibers run their finalizers exactly once.
5. `Async` work that registers external IO returns a canceler.
6. Race-like operators close their internal scopes and cancel losing branches.
7. If a tool cannot be cancelled, it is a bug in the tool adapter.

## Safety defaults

Initial agent modes should be conservative:

1. `read-only`: read/search/model only.
2. `propose`: read/search/model plus whitelisted read-only commands and patch proposals.
3. `write`: may apply patches only after approval.
4. `autonomous`: reserved for later; sensitive actions still require approval.

The initial CLI should default to `propose`.

## Extraction rule

Keep the agent in `src/agent` while validating the vertical slice.
Extract to packages only after the design stabilizes:

```txt
packages/
  brass-runtime/
  brass-agent/
  brass-node/
  brass-llm/
  brass-cli/
```

Until then, `src/agent` is allowed to be experimental, but `src/core` is not.
