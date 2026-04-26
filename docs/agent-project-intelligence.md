# Brass Agent project intelligence

Brass Agent tries to understand the shape of the workspace before asking the LLM for a plan.

This is separate from VS Code UI. It runs in the agent core and works from CLI, VS Code, batch runs, and any future client.

## What it detects

The agent now probes common project markers after reading `package.json` and lockfiles:

- Node package markers: `package.json`, npm/pnpm/yarn/bun lockfiles
- Rust markers: `Cargo.toml`, `Cargo.lock`
- Tauri markers: `src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/tauri.conf.json`
- Workspace markers: `apps/`, `packages/`, `bridges/`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`
- Bridge markers: `bridges/whatsmeow-bridge/Cargo.toml`, `bridges/whatsmeow-bridge/package.json`

From those markers it builds a compact profile such as:

```text
Project profile: tauri; workspace: mixed; stacks: node, rust, tauri, desktop, bridge, monorepo
```

The profile is included in planning and patch-repair prompts, so the model can reason about real workspaces instead of assuming a single npm package.

## Better validation discovery

Before this change, validation discovery was mostly based on scripts like:

```text
test
typecheck
lint
```

Real repos often use names like:

```text
repo:check
bridge:doctor
health
verify
validate
ci
```

The agent now classifies these as health/check scripts and can pick them as validation commands when no usable test script exists.

Example:

```json
{
  "scripts": {
    "repo:check": "npm run desktop:build && npm run bridge:doctor"
  }
}
```

Can produce:

```text
Validation commands: npm run repo:check
```

If a Rust root is detected and no package scripts are useful, the agent can fall back to:

```bash
cargo check
```

## Permissions

The built-in safe validation allowlist now includes common health checks:

```text
npm run *check*
npm run *doctor*
npm run *health*
npm run *verify*
npm run *validate*
npm run repo:check
cargo check
cargo test
cargo fmt --check
cargo clippy
```

The same patterns exist for `pnpm`, `yarn`, and `bun` where applicable.

Projects can still override this with `.brass-agent.json`:

```json
{
  "permissions": {
    "shell": {
      "inheritDefaults": false,
      "allow": ["npm run repo:check"]
    }
  }
}
```

## Recommended config for mixed repos

For a workspace with Node + Rust + Tauri, a good starting point is:

```json
{
  "language": {
    "response": "es"
  },
  "project": {
    "packageManager": "npm",
    "validationCommands": ["npm run repo:check"],
    "maxValidationCommands": 1
  },
  "permissions": {
    "shell": {
      "inheritDefaults": true,
      "allow": [
        "npm run repo:check",
        "npm run bridge:doctor",
        "cargo check"
      ]
    },
    "patchApply": {
      "decision": "ask",
      "risk": "high",
      "defaultAnswer": "reject"
    }
  }
}
```

## Why this matters

For a repo like:

```text
apps/desktop/
bridges/whatsmeow-bridge/
Cargo.toml
package.json
package-lock.json
```

The agent should not blindly say “no test script found”. It should understand that the repo may be validated through a repo-level check, bridge doctor, Tauri build, or Cargo check.

Project intelligence keeps that knowledge in the agent core so every surface benefits:

```text
CLI
VS Code Chat
Code Actions
Batch runs
Run History
```
