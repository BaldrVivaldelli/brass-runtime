# Brass Agent rollback patches

P15 adds a manual rollback path for approved unified diffs.

```bash
brass-agent --rollback-patch-file ./approved.diff --yes "rollback approved patch"
```

The CLI does not edit files directly. It passes the supplied diff through the same `PatchService` boundary used by normal apply mode:

```txt
initialPatch
  -> patch.rollback
  -> PermissionService
  -> ApprovalService
  -> PatchService.rollback
  -> git apply --reverse --check
  -> git apply --reverse
```

This intentionally supports exact rollback of a patch that was previously previewed/applied.

P14 builds on the same primitive for automatic rollback safety when generated patches still fail validation after repair attempts are exhausted. See [Agent automatic rollback safety](./agent-rollback-safety.md).
