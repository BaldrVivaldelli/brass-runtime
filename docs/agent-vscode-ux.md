# Brass Agent VS Code UX

The VS Code extension is intentionally a thin client over the `brass-agent` CLI, but the editor surface should still feel guided and uncluttered.

## Runs sidebar

The Activity Bar contributes a **Brass Agent** container with a **Run History** view.

When the history is empty, the view shows a welcome state with links to:

- **New Run** — guided quick pick for common actions.
- **Initialize Workspace** — writes `.brass-agent.json`, `brass-agent.batch.json`, `.env.example`, and `BRASS_AGENT.md`.
- **Doctor** — checks CLI, workspace, model, package manager, and VS Code setup.

## Toolbar design

The view title toolbar is intentionally small:

- **New Run** — primary action.
- **Cancel Current Run** — only visible while a run is active.
- **Refresh History** — always visible.

Everything else lives in the overflow menu:

- Show Output
- Initialize Workspace
- Doctor
- Run Configured Batch
- Run Batch File
- Show Last Patch Preview
- Clear History

This prevents the toolbar from turning into a row of long command labels.

## New Run flow

`Brass Agent: New Run...` opens a Quick Pick with the most common workflows:

- Inspect Workspace
- Propose Fix
- Apply Fix
- Fix Tests
- Typecheck
- Lint
- Run Configured Batch
- Run Batch File
- Doctor
- Initialize Workspace
- Show Output

`Apply Fix`, `Fix Tests`, `Typecheck`, and `Lint` still use the safe patch preview flow. VS Code never applies patches directly.

## Running state

While a CLI process is active, the extension sets the `brassAgent.running` VS Code context key. That controls whether the cancel action appears in the Run History toolbar.

The Status Bar also shows run state and links to the output channel.

## Command Palette

Command Palette commands are grouped under the `Brass Agent` category, so users see names such as:

```txt
Brass Agent: New Run...
Brass Agent: Doctor
Brass Agent: Initialize Workspace
```

Argument-only commands such as `Open Run Details`, `Show History Patch`, and `Rerun History Run` are hidden from the Command Palette because they are meant to be invoked from the Run History tree context menu.

## Chat view

P29 adds a persistent Chat view to the Brass Agent sidebar. It provides a lower-friction, Copilot-like way to ask questions, request patch proposals, and run apply-after-preview flows without memorizing CLI commands. See [Copilot-like VS Code DX](./agent-copilot-like-dx.md).
