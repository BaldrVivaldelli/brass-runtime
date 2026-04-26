# Agent approvals

P6 adds interactive approvals to `brass-agent` without moving prompt logic into
`src/core`.

The boundary remains:

```txt
src/core
  ↑
src/agent PermissionService / ApprovalService
  ↑
src/agent/cli prompt UX
```

## Decision flow

Every action still goes through the same policy pipeline:

```txt
AgentAction
  -> PermissionService.check(...)
  -> allow | deny | ask
  -> ApprovalService.request(...) when ask
  -> ToolPolicy timeout/retry
  -> Async tool effect
  -> Observation
```

`PermissionService` decides whether an action needs approval. `ApprovalService`
decides how to obtain that approval: prompt the human, auto-approve, auto-deny,
or integrate with another UI.

## Built-in approvals

The agent exports:

```ts
autoApproveApprovals
makeAutoDenyApprovals(reason?)
```

The CLI also provides an interactive implementation that prompts on stderr.

## CLI behavior

```bash
brass-agent --apply "fix tests"             # prompts when interactive
brass-agent --apply --yes "fix tests"       # auto-approve
brass-agent --apply --no-input "fix tests"  # auto-deny
brass-agent --approval interactive --apply "fix tests"
```

Environment variables:

```bash
BRASS_AGENT_APPROVAL=approve|deny|interactive|auto
BRASS_AGENT_AUTO_APPROVE=true
```

`auto` is conservative:

```txt
human TTY session -> interactive prompts
json/events-json or non-TTY -> deny approval-required actions
```

Use `--yes` explicitly for non-interactive smoke tests or CI flows that are
allowed to mutate the workspace.

## Events

Approvals emit typed events:

```txt
agent.approval.requested
agent.approval.resolved
```

These events are available in human output and `--events-json`. They are emitted
before and after the approval service runs.

## Safety invariants

- Approval prompts are a capability of `src/agent`, not `src/core`.
- An action that requires approval must not run unless approval is granted.
- Missing approval service means approval-required actions are rejected.
- Observability is best-effort and must not change approval semantics.
- Non-interactive runs deny by default unless explicitly configured to approve.

## Config defaults

P7 allows a project config file to set the default CLI approval strategy:

```json
{
  "approval": "auto"
}
```

CLI flags still win over config:

```bash
brass-agent --approval deny "inspect"
brass-agent --yes --apply "fix tests"
```

`permissions.patchApply` can also tune whether `patch.apply` is allowed, denied,
or routed through approval in `write` and `autonomous` modes. See
[Agent config and policy files](./agent-config.md).
