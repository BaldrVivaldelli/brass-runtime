# VS Code run history

P11 adds a persistent VS Code sidebar for Brass Agent runs.

The extension remains a thin client:

```txt
brass-agent CLI --protocol-json
  -> VS Code process runner
  -> workspace run history
  -> TreeView / patch preview / rerun commands
```

The extension does not reimplement planning, permissions, approvals, patch
application, or validation. Those still live behind the CLI and `src/agent`.

## Sidebar

The extension contributes a `Brass Agent` activity-bar view with a `Runs`
TreeView.

Each run entry shows:

- goal
- mode
- status
- start time
- workspace
- duration
- step count
- patch stats when a patch was proposed or applied

Selecting a run opens a Markdown details document. Runs with stored patches can
reopen the patch preview webview.

## Commands

New commands:

```txt
Brass Agent: Open Run Details
Brass Agent: Show History Patch
Brass Agent: Rerun History Run
Brass Agent: Refresh History
Brass Agent: Clear History
```

The view title includes refresh and clear actions. Run items expose context-menu
commands for details, patch preview, and rerun.

## Persistence

History is stored in VS Code `workspaceState` under a versioned key. This keeps
history local to the workspace and avoids adding persistence concerns to the
runtime or agent core.

Configuration:

```json
{
  "brassAgent.historyLimit": 50,
  "brassAgent.storePatchesInHistory": true
}
```

`historyLimit` controls how many runs are retained.

`storePatchesInHistory` controls whether unified diff payloads are stored in VS
Code workspace storage. Disable it if you do not want patch contents persisted
by the editor client.

## Rerun behavior

Rerunning a normal run invokes the same goal and mode through the CLI again.

Rerunning an `apply-approved-patch` history entry reapplies the stored patch via
`brass-agent --apply-patch-file`, preserving the invariant that VS Code never
applies patches directly.

## Boundary rule

The sidebar is editor state, not agent state.

```txt
src/core                     no knowledge of VS Code
src/agent                    no knowledge of VS Code history
brass-agent CLI protocol     stable boundary
VS Code extension            client-side history and UX
```

If a future UX needs richer history, prefer extending the CLI protocol before
teaching the VS Code extension about internal agent implementation details.
