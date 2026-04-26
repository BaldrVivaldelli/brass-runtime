# VS Code problems-aware chat

P33 teaches the VS Code client to use the editor's current diagnostics as first-class context.

The agent still runs through the normal `brass-agent` CLI boundary. VS Code only gathers diagnostics and includes them in the chat prompt; it does not bypass permissions, approvals, patch preview, rollback, or validation.

## Chat slash commands

The Chat view supports these problem-aware commands:

```txt
/problems
/explain-problems
/fix-problems
/current-file-problems
/explain-current-file
/fix-current-file
```

Examples:

```txt
/fix-problems
```

```txt
/fix-current-file prefer a minimal patch
```

`/fix-problems` uses diagnostics from the whole workspace. `/fix-current-file` only uses diagnostics from the active editor.

## Command Palette

The extension also contributes:

```txt
Brass Agent: Explain Workspace Problems
Brass Agent: Fix Workspace Problems
Brass Agent: Fix Current File Problems
```

These commands open the Chat view with a prompt that includes VS Code diagnostics.

## Context chips

The Chat view shows diagnostic count chips when VS Code has problems available:

```txt
problems 12
file problems 3
```

These counts come from `vscode.languages.getDiagnostics()` and update when diagnostics or the active editor change.

## Configuration

Limit how many diagnostics are included in a prompt:

```json
{
  "brassAgent.problemContextLimit": 40
}
```

If there are more diagnostics, the prompt includes the first `problemContextLimit` diagnostics and notes how many were omitted.

## Safety

Diagnostics are treated as context only. A problem-aware run still follows:

```txt
VS Code diagnostics
  -> Chat prompt
  -> brass-agent --protocol-json
  -> PermissionService
  -> ApprovalService when needed
  -> Patch preview
  -> exact patch apply via CLI
```
