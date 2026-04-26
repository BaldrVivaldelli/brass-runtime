# Brass Agent VS Code Extension

This is a thin VS Code client for the `brass-agent` CLI.

The extension intentionally does not duplicate agent logic. It launches the CLI
with `--protocol-json`, parses JSON Lines, and renders progress in a VS Code
output channel and sidebar history view.

## Development

From this folder:

```bash
npm install
npm run compile
```

Then open this folder in VS Code and run the extension host.

## Local install as VSIX

From the repository root:

```bash
npm run agent:vscode:install
```

That builds the local `brass-agent` CLI, bundles the built CLI into the extension, packages the extension as a `.vsix`, installs it into VS Code, and writes `.vscode/settings.json` with `brassAgent.command = "auto"`.

Package without installing:

```bash
npm run agent:vscode:package
```

By default, the extension uses CLI auto-discovery. It prefers the bundled CLI, then workspace `node_modules/.bin`, then a nearby `brass-runtime` checkout, then `brass-agent` on PATH.

You can inspect or change this from VS Code:

```txt
Brass Agent: Configure CLI
```

During local development you can also point directly to the built CLI:

```json
{
  "brassAgent.command": "/absolute/path/to/brass-runtime/dist/agent/cli/main.cjs"
}
```


## Model setup from VS Code

Run:

```txt
Brass Agent: Configure Model
```

or use `/model` from the Chat view. The extension can store Gemini or OpenAI-compatible API keys in VS Code Secret Storage and inject them only into `brass-agent` processes launched from VS Code. Keys are not written to `.brass-agent.json`, `.env`, or settings.

After setup, run:

```txt
Brass Agent: Doctor
```

Doctor launched from VS Code can see the extension-stored secrets. A terminal `brass-agent --doctor` needs shell env or `.env` separately.

## Project dashboard

The sidebar includes a **Project** view that summarizes the current workspace: resolved CLI, model status, `.brass-agent.json`, response language, validation command, package manager, and detected project profile.

Open it from the sidebar, Command Palette (`Brass Agent: Open Project Dashboard`), or Chat with `/project`.

Use **Configure Workspace** from the dashboard when the repo needs a validation command like `npm run repo:check` or a forced response language like Spanish.


## Chat layout / focus mode

For longer sessions, use:

```txt
Brass Agent: Open Chat in Editor
```

or type `/focus` in the Chat view. The editor chat shares the same session as the sidebar chat, but gives you much more space and can be split beside code.

You can make the editor chat the default:

```json
{
  "brassAgent.chat.defaultLocation": "editor"
}
```

Use `Brass Agent: Open Project Dashboard in Editor` when the Project dashboard needs more room.

## Chat flow

P29 adds a persistent **Chat** view in the Brass Agent sidebar. It is the easiest way to use the agent without memorizing CLI flags.

Use it for:

- workspace questions
- failing tests
- typecheck/lint fixes
- patch proposals
- apply-after-preview flows

The chat modes are:

| Mode | Behavior |
| --- | --- |
| Ask | read-only run |
| Propose patch | generates a patch preview without writing |
| Apply after preview | generates a proposal and applies only after exact diff approval |

Select code in the editor and use the context menu:

- `Brass Agent: Ask About Selection`
- `Brass Agent: Explain Selection`
- `Brass Agent: Fix Selection`

These commands prefill the Chat view with file path, language id, and selected code.

## Chat sessions and slash commands

The Chat view persists a workspace-local session and understands slash commands:

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
/clear
/help
```

Follow-up messages use the previous run summary, latest validation output, and patch stats as context when relevant. Patch contents are persisted only when `brassAgent.storePatchesInHistory` is enabled.




## Inline Assist

Use `Brass Agent: Inline Assist...` from the Command Palette or editor context menu. It uses the current selection, or surrounding lines around the cursor if nothing is selected, and opens the Chat with a focused prompt.

Available intents include ask, explain, fix, refactor, generate tests, and custom instruction. Patch-producing intents still go through preview and exact apply.

## Problems-aware chat

The Chat view can use VS Code diagnostics as context:

```txt
/problems
/explain-problems
/fix-problems
/current-file-problems
/fix-current-file
```

`/fix-problems` uses workspace diagnostics. `/fix-current-file` uses diagnostics from the active editor. The number of available diagnostics is shown in the Chat context chips.

## Code actions / lightbulb

The extension contributes native VS Code code actions. When the editor has diagnostics, the lightbulb can offer:

- `Fix problem with Brass Agent`
- `Explain problem with Brass Agent`

When text is selected, it can also offer:

- `Explain selection with Brass Agent`
- `Fix selection with Brass Agent`
- `Refactor selection with Brass Agent`
- `Generate tests with Brass Agent`

These actions open the Chat view with the relevant file, language, diagnostics, and selected code. Patches still go through preview/approval and are applied only via the `brass-agent` CLI.

## Commands

The main entrypoint is `Brass Agent: New Run...`. It opens a guided Quick Pick for inspect, propose, apply, presets, batches, doctor, init, and output.

The Run History toolbar intentionally shows only the primary actions: New Run, Cancel while running, and Refresh. Less common actions live in the overflow menu.

- `Brass Agent: Open Chat` — opens the persistent chat view for Copilot-like usage.
- `Brass Agent: New Run...` — guided launcher for the common workflows.
- `Brass Agent: Propose Fix` — runs `brass-agent --protocol-json --protocol-full-patches --mode propose` and opens a patch preview when the agent proposes a diff.
- `Brass Agent: Apply Fix` — first proposes a diff, then opens a webview preview. Applying happens only after the user approves the exact displayed patch.
- `Brass Agent: Inspect Workspace` — runs `brass-agent --protocol-json --mode read-only`.
- `Brass Agent: Fix Tests` — runs the apply-preview flow with the built-in failing-tests goal.
- `Brass Agent: Typecheck` — runs the apply-preview flow with a typecheck-focused goal.
- `Brass Agent: Lint` — runs the apply-preview flow with a lint-focused goal.
- `Brass Agent: Run Batch File` — selects a batch file and runs it through `brass-agent --batch-file`.
- `Brass Agent: Run Configured Batch` — runs `config.batch.goals` from `.brass-agent.json` / `brass-agent.config.json`.
- `Brass Agent: Show Last Patch Preview` — reopens the most recent patch preview for this extension session.
- `Brass Agent: Doctor` — checks local CLI, workspace, VS Code, package manager, and LLM setup.
- `Brass Agent: Configure CLI` — switches between auto-discovery, bundled CLI, global `brass-agent`, or a selected file.
- `Brass Agent: Show Output` — opens the output channel.
- `Brass Agent: Cancel Current Run` — sends SIGTERM to the active CLI process.


## Enhanced patch preview

Patch previews group unified diffs by file, show per-file stats, support expand/collapse, and provide actions to open a file or copy a single file patch. Applying still goes through `brass-agent --apply-patch-file` after explicit approval.

## Patch preview flow

```txt
VS Code
  -> brass-agent --protocol-json --protocol-full-patches --mode propose
  -> patch.proposed
  -> webview preview
  -> user clicks Apply Patch
  -> brass-agent --apply-patch-file <temp.diff> --yes
```

The extension never applies a patch directly. The final apply still goes through
Brass Agent permissions, `PatchService`, `git apply --check`, `git apply`, and
validation discovery.

## Batch flow

```txt
VS Code
  -> brass-agent --protocol-json --protocol-full-patches --batch-file <file>
  -> protocol events / final states / batch summary
  -> Runs sidebar parent entry with child runs
```

Batch entries can be reopened, inspected, and rerun from the history sidebar.

## Empty state and history

When the history is empty, the Run History view shows links for New Run, Initialize Workspace, and Doctor. Runs are persisted in VS Code workspace storage and can be reopened, rerun, or used to reopen a stored patch preview.

## Settings

```json
{
  "brassAgent.command": "brass-agent",
  "brassAgent.extraArgs": [],
  "brassAgent.environment": {},
  "brassAgent.historyLimit": 50,
  "brassAgent.storePatchesInHistory": true
}
```

The workspace can still use `.brass-agent.json` for model selection, command
policy, approvals, batch defaults, and tool timeouts.

Disable `storePatchesInHistory` if you do not want unified diff contents stored
in VS Code workspace storage.

## Initialize a workspace first

For a new project, bootstrap local config before deeper DX setup:

```bash
brass-agent --init
brass-agent --doctor
```

The VS Code extension also contributes `Brass Agent: Initialize Workspace`, which runs the same init flow from the command palette.

## Seeing the UI

Open the Brass Agent activity-bar icon. The expected views are:

```txt
Chat
Run History
```

You can also run `Brass Agent: Open Chat` from the Command Palette. If the Chat
view is missing after reinstalling, run this from the repo root and reload VS Code:

```bash
npm run agent:vscode:reinstall
```

## Workspace setup

Use **Brass Agent: Configure Workspace** or `/workspace` in the Chat view to create or update `.brass-agent.json` with response language and validation-command settings.
