# Brass Agent chat sessions

P30 turns the VS Code Chat view from a one-shot launcher into a lightweight
conversation surface.

The CLI remains the canonical execution boundary. The VS Code extension still
calls:

```bash
brass-agent --protocol-json --protocol-full-patches --cwd <workspace> <goal>
```

The new session behavior lives entirely in the extension.

## What is stored

The VS Code extension stores a compact chat session in `workspaceState`:

```txt
messages
last run summary
last validation output
last patch stats
last patch body, only when brassAgent.storePatchesInHistory is true
```

This is editor-local state. It is not written to the repository and it is not
owned by `src/core` or `src/agent`.

The message history length is controlled by:

```json
{
  "brassAgent.chatHistoryLimit": 80
}
```

Disable patch persistence with:

```json
{
  "brassAgent.storePatchesInHistory": false
}
```

## Follow-up context

After a run, follow-up messages can use the previous run as context.

For example:

```txt
fix the failing tests
why did that fail?
try again but do not change the public API
explain the patch
```

The extension composes the next agent goal with a compact context block that may
include:

```txt
previous goal
previous status
previous summary/error
latest validation command output
last patch stats
last patch diff, only for explicit explain-last style requests
```

The agent is instructed to ignore previous context if the new request is
unrelated.

## Slash commands

The chat supports slash commands to avoid menus and flags:

```txt
/inspect
/fix-tests
/typecheck
/lint
/ask <question>
/propose <task>
/apply <task>
/explain-last
/apply-last
/rollback-last
/doctor
/output
/clear
/help
```

### Safety behavior

`/apply <task>` still uses the safe apply-preview flow:

```txt
chat request
  -> propose run
  -> patch preview
  -> user approval
  -> brass-agent --apply-patch-file <exact diff>
```

`/apply-last` reopens the last patch preview. It does not silently write.

`/rollback-last` calls the CLI rollback path:

```bash
brass-agent --rollback-patch-file <temp.diff> --yes ...
```

It asks for VS Code confirmation first, and the CLI still goes through the normal
patch rollback service.

## Quick actions

Assistant messages can include buttons such as:

```txt
Open patch preview
Explain last
Rollback last
Show output
```

These buttons send slash commands back through the same chat handler.

## Boundary

The boundary remains unchanged:

```txt
src/core
  ↑
src/agent
  ↑
brass-agent CLI protocol
  ↑
VS Code chat session UI
```

The extension owns conversation memory and UX. The agent owns execution,
permissions, validation, redaction, patch application, rollback, and protocol
semantics.

## Explain last behavior

`/explain-last` is intentionally local and deterministic. It summarizes the last
stored run from VS Code workspace state instead of launching a new agent run.

That keeps the button useful even when the previous run stopped before the LLM
step, for example because a context file disappeared or a tool returned `FsError`.
For an AI follow-up using the same context, use:

```txt
/ask why did that fail?
```
