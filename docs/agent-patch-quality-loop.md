# Agent patch quality loop

P13 adds a bounded repair loop for generated patches.

The previous apply flow was one-shot:

```txt
llm.plan
  -> patch.apply
  -> validation commands
  -> finish
```

The new flow can perform one or more repair attempts when the generated patch
fails to apply or when validation still fails after apply:

```txt
llm.plan
  -> patch.apply
  -> validation commands
  -> if validation fails: llm.patch
  -> patch.apply
  -> validation commands
  -> finish
```

The loop is intentionally small and bounded. It is a quality pass, not an
unbounded autonomous edit loop.

## Exact patch safety

Runs started with an explicit patch file stay exact:

```bash
brass-agent --apply-patch-file ./approved.diff --yes "apply approved patch"
```

For these runs, repair is disabled. That preserves the VS Code patch preview
invariant:

```txt
preview patch A
  -> approve patch A
  -> apply exactly patch A
```

The agent must not silently generate and apply patch B after the user approved
patch A. To allow the agent to repair its own generated patches, use normal
write mode instead:

```bash
brass-agent --apply "fix the failing tests"
```

## Configuration

Configure the loop in `.brass-agent.json`:

```json
{
  "patchQuality": {
    "enabled": true,
    "maxRepairAttempts": 1
  }
}
```

Defaults:

```txt
enabled: true
maxRepairAttempts: 1
```

Disable repairs entirely:

```json
{
  "patchQuality": {
    "enabled": false
  }
}
```

Allow two repair calls after the initial generated patch:

```json
{
  "patchQuality": {
    "maxRepairAttempts": 2
  }
}
```

A value of `0` means “apply once, validate once, do not ask for repairs.”

## What counts as a repair attempt?

Only LLM calls with purpose `patch` count as repair attempts.

The initial planning call is still `llm.plan`:

```txt
llm.plan      # initial diagnosis / patch proposal
llm.patch     # repair attempt 1
llm.patch     # repair attempt 2, if configured
```

## What triggers a repair?

A repair can be requested when all of these are true:

1. the agent is in `write` or `autonomous` mode
2. the patch came from the agent, not from `--apply-patch-file`
3. `patchQuality.enabled` is not `false`
4. remaining repair budget is greater than zero
5. either:
   - `patch.apply` failed, or
   - validation commands ran after `patch.applied` and at least one failed

Permission denials, approval rejections, and non-patch tool failures do not
trigger patch repair.

## Boundaries

The repair loop does not change the core runtime boundary:

```txt
src/core
  ↑
src/agent decides llm.patch / patch.apply
  ↑
src/agent/cli configures patchQuality
```

Repair is just more agent logic expressed as normal actions:

```txt
AgentAction(llm.complete purpose=patch)
  -> LLM capability
  -> Observation(llm.response purpose=patch)
  -> AgentAction(patch.apply)
  -> PermissionService / ApprovalService
  -> PatchService
  -> validation commands
```

No side effects are executed outside the `Async` tool pipeline.


## Relationship with rollback safety

P14 runs after the patch quality loop. If validation still fails and no repair
attempts remain, rollback safety can reverse generated patches through
`patch.rollback`. This keeps repair and restore as separate decisions:

```txt
repair budget remains -> llm.patch
repair budget exhausted -> optional patch.rollback
```

See [Agent automatic rollback safety](./agent-rollback-safety.md).
