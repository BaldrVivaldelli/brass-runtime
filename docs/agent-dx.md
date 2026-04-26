# Brass Agent DX surfaces

This document defines how `brass-agent` should be exposed to developers without
letting UI concerns leak into the runtime or agent core.

## Decision

Start with a strong CLI and make editor integrations thin clients over a stable
machine protocol.

```txt
src/core
  ↑
src/agent
  ↑
brass-agent CLI
  ↑
VS Code / other IDE clients
```

The VS Code extension should not reimplement the agent loop. It should call the
CLI with `--protocol-json`, parse JSON Lines, and render the run in editor UI.

## Why CLI-first

The CLI is the canonical developer surface because it is:

- easy to run in any repo
- easy to use in CI and smoke tests
- easy to debug with `--json` and `--protocol-json`
- independent of a particular editor
- the best place to stabilize permissions, approvals, config, and event output

The CLI remains thin. It wires Node capabilities, config, approvals, LLM adapters,
and output formatting around `runAgent(...)`.

## Why the VS Code extension is a thin client

The extension should use VS Code for editor-native UX:

- Command Palette commands
- workspace folder discovery
- input boxes for goals
- modal confirmation before write/apply runs
- output channel rendering
- cancellation from VS Code progress UI
- status bar updates

But the extension should not own:

- planning logic
- tool policy
- approvals semantics
- patch extraction/application
- project command discovery
- LLM adapter behavior

Those stay in `src/agent` and the CLI.

## Protocol

Use:

```bash
brass-agent --protocol-json "fix the failing tests"
```

The CLI prints newline-delimited protocol messages:

```jsonl
{"protocol":"brass-agent","version":1,"type":"event","event":{"type":"agent.run.started"}}
{"protocol":"brass-agent","version":1,"type":"event","event":{"type":"agent.action.started"}}
{"protocol":"brass-agent","version":1,"type":"final-state","state":{"phase":"done"}}
```

`--events-json` remains useful for quick event-only streams. Integrations should
prefer `--protocol-json` because it includes both events and the final compact
state.

## Current VS Code scaffold

The first extension scaffold lives in:

```txt
extensions/vscode-brass-agent/
```

It contributes commands:

```txt
Brass Agent: Propose Fix
Brass Agent: Apply Fix
Brass Agent: Inspect Workspace
Brass Agent: Show Output
Brass Agent: Cancel Current Run
```

The extension invokes the configured CLI command, defaulting to:

```txt
brass-agent
```

Settings:

```json
{
  "brassAgent.command": "brass-agent",
  "brassAgent.extraArgs": [],
  "brassAgent.environment": {}
}
```

Development:

```bash
cd extensions/vscode-brass-agent
npm install
npm run compile
```

Then open the extension folder in VS Code and run the Extension Development Host.

## Apply behavior

The VS Code `Apply Fix` command intentionally asks for one editor-level
confirmation before launching the CLI with:

```bash
brass-agent --protocol-json --apply --yes ...
```

That means the agent can apply a valid patch only after the user confirms in VS
Code. Deeper per-action approvals can be added later by extending the protocol
with request/response messages, but the first scaffold keeps the extension simple
and safe.

## Future DX slices

Recommended next DX slices:

1. Rich sidebar TreeView for run history and current actions.
2. Webview panel for patch preview and approval.
3. Chat Participant integration so users can invoke `@brass` from VS Code chat.
4. Language Model Tool integration so VS Code/Copilot agent mode can call Brass tools.
5. Import-mode extension that calls `runAgent(...)` directly with VS Code-native
   file system, terminal, and approval services.

The invariant stays the same: editor integrations are consumers of the agent,
not owners of the agent semantics.

## P10: VS Code patch preview

The VS Code extension now previews proposed diffs in a webview before applying
anything. The apply path uses a second CLI invocation with `--apply-patch-file`,
so the extension never applies patches itself. P13 patch repair is disabled for this exact apply path, preserving preview approval semantics.

```txt
propose run -> patch.proposed -> webview preview -> approve -> apply supplied patch
```

For trusted local clients, `--protocol-full-patches` keeps only patch payloads
untruncated in protocol output.

## P11: VS Code run history

The VS Code extension now contributes a `Brass Agent` activity-bar view with a
persistent `Runs` TreeView. The view stores compact run metadata in VS Code
`workspaceState`, can reopen stored patch previews, can rerun previous goals,
and can clear history for the current workspace.

This remains client-side UX over the CLI protocol. The runtime and agent core do
not know about VS Code, TreeViews, or editor persistence.

## VS Code batch runner

The VS Code extension can run batch files through the same CLI protocol boundary:

```txt
VS Code
  -> brass-agent --protocol-json --protocol-full-patches --batch-file <file>
  -> protocol events / final states / batch summary
  -> sidebar history parent with child runs
```

This keeps batching in the CLI and keeps the extension as a UI client. See
[VS Code batch runner](./agent-vscode-batch-runner.md).

## P23: local install and doctor

CI/release automation is intentionally deferred. The current DX path is local:

```bash
npm run agent:vscode:install
npm run agent:doctor
```

The VS Code extension also exposes:

```txt
Brass Agent: Doctor
```

This keeps the workflow human-driven while the CLI, protocol, VS Code client,
configuration, and safety model continue to stabilize.

## Initialize a workspace first

For a new project, bootstrap local config before deeper DX setup:

```bash
brass-agent --init
brass-agent --doctor
```

The VS Code extension also contributes `Brass Agent: Initialize Workspace`, which runs the same init flow from the command palette.

## Copilot-like chat surface

See [Copilot-like VS Code DX](./agent-copilot-like-dx.md) for the chat view, selection-aware commands, and why Brass Agent uses chat/code actions before inline autocomplete.

## P30: chat sessions

The VS Code chat view now persists a lightweight workspace-local session, supports slash commands, and composes follow-up prompts from the last run summary, validation output, and patch stats. See [Chat sessions and slash commands](./agent-chat-sessions.md).
