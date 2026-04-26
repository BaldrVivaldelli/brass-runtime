# Agent automatic rollback safety

P14 adds automatic rollback safety for generated patches.

This is different from the manual exact rollback command from P15:

```bash
brass-agent --rollback-patch-file ./approved.diff --yes "rollback approved patch"
```

P14 is part of the normal generated-patch loop:

```txt
llm.plan
  -> patch.apply
  -> validation commands
  -> optional llm.patch repair attempts
  -> if validation still fails: patch.rollback
  -> optional validation after rollback
```

## Boundary rule

Rollback safety lives in `src/agent`, not in `src/core`:

```txt
src/core
  ↑
src/agent rollback policy / patch ledger
  ↑
src/agent/cli config
```

The core runtime still only owns effects, fibers, scopes, cancellation, and
resource safety. The agent owns policy and workspace semantics.

## What is rolled back

When `patch.apply` succeeds, the resulting `patch.applied` observation now keeps
an internal copy of the exact unified diff that was applied. If the final
validation still fails and the repair budget is exhausted, the agent can schedule
`patch.rollback` with that same diff.

Rollback uses the existing `PatchService.rollback(...)` primitive, which runs:

```txt
git apply --reverse --check
git apply --reverse
```

So rollback still uses the same path checks, approval flow, policy flow, and
cancellable shell execution as normal patch application.

## Defaults

Rollback safety is enabled by default for generated patches:

```json
{
  "rollback": {
    "enabled": true,
    "onFinalValidationFailure": true,
    "strategy": "all",
    "maxRollbackDepth": 8,
    "runValidationAfterRollback": true,
    "allowForSuppliedPatches": false
  }
}
```

The default strategy is `all`, meaning the agent restores the generated patch
stack in reverse order. For a more conservative single-step rollback:

```json
{
  "rollback": {
    "strategy": "last"
  }
}
```

To disable automatic rollback:

```json
{
  "rollback": {
    "enabled": false
  }
}
```

## Exact supplied patches

Automatic rollback is disabled by default for exact patch-file flows:

```bash
brass-agent --apply-patch-file ./approved.diff --yes "apply approved patch"
```

That preserves the VS Code patch-preview guarantee:

```txt
preview patch A
  -> user approves patch A
  -> brass-agent applies exactly patch A
```

The agent will not silently generate a new patch or automatically reverse the
approved patch unless the project explicitly opts in:

```json
{
  "rollback": {
    "allowForSuppliedPatches": true
  }
}
```

## Approvals still apply

Automatic rollback schedules a `patch.rollback` action. It does not bypass
permissions or approvals:

```txt
patch.rollback
  -> PermissionService
  -> ApprovalService when policy asks
  -> ToolPolicy timeout/retry
  -> PatchService.rollback
```

In an interactive terminal this can prompt. In CI/non-interactive output, the
approval strategy controls whether the rollback is allowed. For example:

```bash
brass-agent --apply --yes "fix the failing tests"
```

allows both apply and rollback prompts. Without `--yes`, non-interactive runs
will reject approval-required rollback actions by default.

## Validation after rollback

By default, the agent re-runs discovered validation commands after rollback:

```json
{
  "rollback": {
    "runValidationAfterRollback": true
  }
}
```

Disable it when rollback should be a pure restore step:

```json
{
  "rollback": {
    "runValidationAfterRollback": false
  }
}
```
