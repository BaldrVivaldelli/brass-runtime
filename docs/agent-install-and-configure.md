# Brass Agent install and configuration

This guide is the shortest path from a fresh checkout to a working local
`brass-agent` CLI and VS Code extension.

`brass-agent` is still an experimental module that lives on top of
`brass-runtime`. Treat this as an alpha install flow: good for local dogfooding,
not yet a stable release process.

## What gets installed

There are two pieces:

```txt
brass-agent CLI
  The canonical runner. It owns config loading, policy, approvals, LLM adapters,
  patch application, rollback safety, context discovery, and batch execution.

VS Code extension
  A thin client. It calls the CLI through --protocol-json, renders progress,
  patch previews, history, and batch runs. It does not apply patches directly.
```

The boundary remains:

```txt
src/core
  ↑
src/agent
  ↑
brass-agent CLI
  ↑
VS Code extension / editor clients
```

## Prerequisites

You need these available locally:

```txt
Node.js + npm
Git
ripgrep (`rg`) for context search
```

Optional but recommended:

```txt
VS Code CLI (`code`) if you want one-command VS Code extension installation
A Gemini or OpenAI-compatible API key if you want a real model
```

Check your machine with:

```bash
brass-agent --doctor
```

or, before globally linking the CLI:

```bash
npm run agent:doctor
```

## Install the CLI from source

From the `brass-runtime` checkout:

```bash
npm install
npm run build
```

Smoke test the built CLI directly:

```bash
node dist/agent/cli/main.cjs --doctor
```

To expose `brass-agent` on your shell path during local development:

```bash
npm run agent:link
brass-agent --doctor
```

This lets you run `brass-agent` from any project, not just the
`brass-runtime` checkout. To verify which project root will be used:

```bash
cd /path/to/my-project/some/subfolder
brass-agent --where
```

The CLI auto-discovers the nearest workspace root by searching upward for
`.brass-agent.json`, `brass-agent.config.json`, `package.json`, workspace
markers, or `.git`. Use `--no-discover-workspace` when you intentionally want
`--cwd` to be exact.

To remove only the global CLI link/install:

```bash
npm run agent:unlink
```

To remove the VS Code global-command setup and the global CLI link/install together:

```bash
npm run agent:vscode:uninstall:global
```

If you do not want to link it globally, use one of these instead:

```bash
npm run agent:dev -- --doctor
node /absolute/path/to/brass-runtime/dist/agent/cli/main.cjs --doctor
```

## Initialize a workspace

In the project where you want to use the agent:

```bash
cd /path/to/my-project
brass-agent --init
```

This creates:

```txt
.brass-agent.json
brass-agent.batch.json
.env.example
BRASS_AGENT.md
```

Existing files are skipped. To preview without writing:

```bash
brass-agent --init --init-dry-run
```

To overwrite generated files intentionally:

```bash
brass-agent --init --force
```

### Provider-specific init

For Gemini / Google:

```bash
brass-agent --init --init-profile google
```

For OpenAI-compatible APIs:

```bash
brass-agent --init --init-profile openai-compatible
```

For offline smoke tests:

```bash
brass-agent --init --init-profile fake
```

## Configure an LLM provider

Secrets should live in environment variables, not in `.brass-agent.json`.
The config file should reference the variable name through `apiKeyEnv`.

### Google / Gemini

`.brass-agent.json`:

```json
{
  "llm": {
    "provider": "google",
    "model": "gemini-2.5-flash",
    "apiKeyEnv": "GEMINI_API_KEY"
  }
}
```

Shell:

```bash
export GEMINI_API_KEY="..."
brass-agent --doctor
```

Or `.env` / `.brass-agent.env` in the workspace:

```bash
BRASS_LLM_PROVIDER=google
GEMINI_API_KEY="..."
BRASS_GOOGLE_MODEL=gemini-2.5-flash
```

`brass-agent --doctor` auto-loads supported agent keys from those files.

### OpenAI-compatible

`.brass-agent.json`:

```json
{
  "llm": {
    "provider": "openai-compatible",
    "endpoint": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-4.1",
    "apiKeyEnv": "BRASS_LLM_API_KEY"
  }
}
```

Shell:

```bash
export BRASS_LLM_API_KEY="..."
brass-agent --doctor
```

Or `.env` / `.brass-agent.env` in the workspace:

```bash
BRASS_LLM_PROVIDER=openai-compatible
BRASS_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
BRASS_LLM_API_KEY="..."
BRASS_LLM_MODEL=gpt-4.1
```

### Fake / offline

`.brass-agent.json`:

```json
{
  "llm": {
    "provider": "fake",
    "fakeResponse": "Fake plan from local config."
  }
}
```

or per command:

```bash
BRASS_LLM_PROVIDER=fake brass-agent --preset inspect
```

## Recommended `.brass-agent.json`

A conservative starting point:

```json
{
  "mode": "propose",
  "approval": "auto",
  "llm": {
    "provider": "google",
    "model": "gemini-2.5-flash",
    "apiKeyEnv": "GEMINI_API_KEY"
  },
  "project": {
    "packageManager": "auto",
    "includeTypecheck": true,
    "includeLint": true,
    "maxValidationCommands": 2
  },
  "context": {
    "enabled": true,
    "maxSearchQueries": 3,
    "maxFiles": 4,
    "maxSearchResults": 40,
    "excludeGlobs": [
      ".env*",
      "secrets/**",
      "*.pem",
      "*.key",
      "node_modules/**",
      "dist/**",
      "build/**"
    ]
  },
  "redaction": {
    "enabled": true
  },
  "patchQuality": {
    "enabled": true,
    "maxRepairAttempts": 1
  },
  "rollback": {
    "enabled": true,
    "onFinalValidationFailure": true,
    "strategy": "all",
    "runValidationAfterRollback": true,
    "allowForSuppliedPatches": false
  },
  "permissions": {
    "patchApply": {
      "decision": "ask",
      "reason": "Apply generated code changes to this workspace.",
      "risk": "high",
      "defaultAnswer": "reject"
    },
    "shell": {
      "inheritDefaults": true,
      "deny": [
        "rm *",
        "git push *",
        "git reset *",
        "git clean *"
      ]
    }
  }
}
```

Important defaults:

```txt
mode: propose
  The agent can inspect, validate, and propose patches, but does not write by default.

approval: auto
  Interactive terminal prompts when possible; non-interactive runs reject approval-required actions unless --yes is used.

patchApply: ask
  Generated patches require approval before being applied.

redaction.enabled: true
  Prompt context is redacted before LLM calls.
```

## First commands to run

After `--init` and provider setup:

```bash
brass-agent --doctor
brass-agent --preset inspect
brass-agent --preset typecheck
brass-agent --preset lint
brass-agent --preset fix-tests
```

Default runs are safe/propose-oriented. To allow writes:

```bash
brass-agent --apply "fix the failing tests"
```

In an interactive terminal, approval is requested before `patch.apply`.
For local smoke tests where you intentionally want to auto-approve:

```bash
brass-agent --apply --yes "fix the failing tests"
```

## Batch runs

`--init` creates `brass-agent.batch.json`. Run it with:

```bash
brass-agent --batch-file brass-agent.batch.json
```

For a configured batch in `.brass-agent.json`:

```bash
brass-agent
```

only uses the configured batch when no explicit goal, preset, patch file, or
batch file is provided.

## Save run artifacts

To keep a local JSON and Markdown record of a run:

```bash
brass-agent --save-run .brass-agent/runs --preset fix-tests
```

Generated artifacts are local files and may include compacted observations and
summaries. Review before committing them.

## Use the same CLI in many projects

For many projects, the easiest setup is:

```bash
cd /path/to/brass-runtime
npm run agent:vscode:install:global
```

To remove or reinstall that setup later:

```bash
npm run agent:vscode:uninstall:global
npm run agent:vscode:reinstall:global
```

Then any VS Code workspace can use:

```json
{
  "brassAgent.command": "brass-agent"
}
```

See [Agent global usage and workspace discovery](./agent-global-usage.md).

## Install the VS Code extension locally

From the `brass-runtime` checkout:

```bash
npm run agent:vscode:install
```

This packages and installs the local extension and writes workspace settings so
VS Code knows which `brass-agent` command to call.

Manual packaging:

```bash
npm run agent:vscode:package
```

Then install the generated `.vsix` from VS Code with **Extensions: Install from
VSIX...**.

Useful VS Code commands:

```txt
Brass Agent: Initialize Workspace
Brass Agent: Doctor
Brass Agent: Inspect Workspace
Brass Agent: Propose Fix
Brass Agent: Apply Fix
Brass Agent: Fix Tests
Brass Agent: Typecheck
Brass Agent: Lint
Brass Agent: Run Batch File
Brass Agent: Run Configured Batch
```

If VS Code cannot find the CLI, set:

```json
{
  "brassAgent.command": "/absolute/path/to/brass-runtime/dist/agent/cli/main.cjs"
}
```

or use the global linked command:

```json
{
  "brassAgent.command": "brass-agent"
}
```

## Common troubleshooting

Run:

```bash
brass-agent --doctor
```

Common fixes:

| Symptom | Fix |
|---|---|
| `brass-agent: command not found` | Run `npm run build && npm link`, or use `node dist/agent/cli/main.cjs`. |
| VS Code cannot run the agent | Set `brassAgent.command` to the absolute CLI path. |
| Context discovery does not find files | Install `ripgrep` and confirm `rg --version` works. |
| LLM calls use fake provider unexpectedly | Check `brass-agent --doctor` and verify provider env vars. |
| Writes are rejected in scripts/CI | Use interactive approval locally, or pass `--yes` intentionally. |
| Patch apply fails | Check `git apply --check` output in the run details; the agent does not force patches. |
| Secrets appear in repo files | Add globs to `context.excludeGlobs` and keep `redaction.enabled: true`. |

## Safety checklist before dogfooding

Before using `--apply` on a real project:

```txt
- commit or stash your current work
- run brass-agent --doctor
- review .brass-agent.json permissions
- keep mode=propose as the default
- use VS Code patch preview or CLI approval before applying changes
- avoid --yes except for local smoke tests or intentional automation
```

## Related docs

- [Brass Agent CLI](./agent-cli.md)
- [Agent init](./agent-init.md)
- [Agent config and policy files](./agent-config.md)
- [Agent local install and doctor](./agent-local-install.md)
- [VS Code local install](./agent-vscode-install.md)
- [Agent LLM adapters](./agent-llm-adapters.md)
- [Agent approvals](./agent-approvals.md)
- [Agent automatic rollback safety](./agent-rollback-safety.md)


## VS Code auto-discovery

The VS Code extension can now use `brassAgent.command = "auto"` and prefer its bundled CLI, so you can open any repo and use Brass Agent without linking the CLI globally. See [VS Code auto-discovery](./agent-vscode-auto-discovery.md).
