# Agent apply mode

P3 adds a conservative write path for the experimental agent.

## Goal

Keep the default CLI behavior safe:

- default mode remains `propose`
- `write` mode must be explicit
- patch application remains policy-gated and approval-gated
- patch targets must stay inside the workspace
- discovered validation commands still go through `PermissionService`

## New pieces

`src/agent` now includes:

- `PatchService`
- `patch.apply` / `patch.applied`
- unified-diff extraction helpers
- a Node patch adapter built on `git apply`
- CLI flags for `--mode`, `--apply`, and approval strategy

## Modes

```bash
brass-agent "fix the failing tests"            # propose (default)
brass-agent --apply "fix the failing tests"         # write, prompts when interactive
brass-agent --apply --yes "fix the failing tests"   # write, auto-approve
brass-agent --mode write "fix the failing tests"
```

## Safety rules

1. The agent only applies unified diffs.
2. All patch target paths are validated as workspace-relative before apply.
3. `propose` mode may emit `patch.proposed`, but never `patch.apply`.
4. `write` mode may apply patches only after approval.
5. Shell commands remain whitelisted.
6. After `patch.applied`, the agent re-runs the same discovered validation commands.

## Patch adapter

The Node adapter uses `git apply --check` before the actual apply step.

That gives us a conservative path with a dry-run check first, while keeping the runtime invariant intact:
all external work is still represented as cancellable `Async`.

## Offline smoke tests

You can drive the fake LLM with a deterministic response:

~~~bash
export BRASS_LLM_PROVIDER=fake
export BRASS_FAKE_LLM_RESPONSE='Here is a patch.

```diff
--- a/hello.txt
+++ b/hello.txt
@@ -1 +1 @@
-old
+new
```'

brass-agent --apply --yes --cwd ./tmp/repro "apply the inferred patch"
~~~

## Patch quality loop

P13 adds an optional repair loop for normal generated patches in `write` mode.
After a generated patch is applied, the agent re-runs discovered validation
commands. If validation fails and repair budget remains, it calls `llm.patch` to
request an incremental repair diff, applies that diff, and validates again.

The default repair budget is one attempt:

```json
{
  "patchQuality": {
    "enabled": true,
    "maxRepairAttempts": 1
  }
}
```

Exact patch-file flows remain exact. `--apply-patch-file` does not trigger
repair attempts, because clients such as the VS Code extension use that path
after the user approved a specific previewed diff.

See [Agent patch quality loop](./agent-patch-quality-loop.md).


## Automatic rollback safety

P14 adds automatic rollback safety for generated patches. If generated patches
still fail validation after the configured repair attempts are exhausted, the
agent can schedule `patch.rollback` actions to reverse the generated patch stack.

Rollback is still policy-gated and approval-gated. Exact patch-file flows remain
protected by default so a VS Code-approved patch is not silently reversed unless
the project opts in with `rollback.allowForSuppliedPatches`.

See [Agent automatic rollback safety](./agent-rollback-safety.md).
