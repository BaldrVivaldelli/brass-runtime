# VS Code Project Dashboard

P44 adds a **Project** view to the Brass Agent VS Code sidebar.

The dashboard answers the question:

```txt
What does Brass Agent know about this workspace right now?
```

It is intentionally read-mostly. The view does not run the full agent loop unless you click **Inspect Workspace**. It uses `brass-agent --doctor --json` plus VS Code settings and workspace config to show a compact readiness summary.

## What it shows

The dashboard shows:

```txt
Status
  Ready: ok | warn | fail
  Workspace path
  Doctor status
  Resolved CLI

Model
  Provider/model
  Whether a key is configured for VS Code-launched runs

Workspace config
  .brass-agent.json path, if present
  Response language
  Validation command
  Package manager

Project profile
  Detected stacks and markers
  Likely validation command
  Env file status

Warnings
  Important doctor warnings/failures
```

For a mixed workspace, this might look like:

```txt
Profile: stacks: node, rust, tauri, desktop, bridge, monorepo
Validation: npm run repo:check
Model: Google/Gemini (gemini-2.5-flash)
Language: es
Config: .brass-agent.json
```

## Opening it

From the sidebar:

```txt
Brass Agent → Project
```

From Command Palette:

```txt
Brass Agent: Open Project Dashboard
```

From Chat:

```txt
/project
```

## Actions

The Project view includes quick actions:

```txt
Refresh
Run Doctor
Open Chat
Configure Model
Configure Workspace
Open Config
Inspect Workspace
Show Output
```

`Configure Workspace` is the quickest way to create or update `.brass-agent.json` from VS Code. Use it when the dashboard shows no validation command or the wrong language.

## Boundary

The dashboard is still a thin VS Code UI:

```txt
VS Code Project view
  -> brass-agent --doctor --json
  -> VS Code settings / Secret Storage
  -> .brass-agent.json summary
```

It does not duplicate project intelligence, patching, permissions, or validation logic. Those remain in the CLI/agent layer.


## Larger dashboard layout

Use `Brass Agent: Open Project Dashboard in Editor` to inspect the same dashboard in a wider editor tab. This keeps the sidebar available for Chat or Explorer while reviewing model, validation, config, and project profile details.
