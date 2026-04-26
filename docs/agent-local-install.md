# Brass Agent local install and doctor

> For the end-to-end setup flow, see [Brass Agent install and configure](./agent-install-and-configure.md).

P23 intentionally avoids CI/release automation. It focuses on making local DX
boring: build the CLI, package/install the VS Code extension, point the extension
at the local CLI, and diagnose the setup.

## One-command local VS Code install

From the repository root:

```bash
npm run agent:vscode:install
```

That script performs the local install flow:

```txt
npm install                 # only if root node_modules is missing
npm run build               # builds dist/agent/cli/main.cjs
npm install                 # inside extensions/vscode-brass-agent, if needed
npm run compile             # extension TypeScript
npm run package:vsix        # creates vscode-brass-agent-*.vsix
code --install-extension    # installs the VSIX locally
write .vscode/settings.json # points brassAgent.command at the built local CLI
```

The setting it writes is:

```json
{
  "brassAgent.command": "/absolute/path/to/brass-runtime/dist/agent/cli/main.cjs"
}
```

That means the extension can run the exact local CLI build without requiring a
global npm install.

## Global CLI for many projects

To use `brass-agent` outside the `brass-runtime` checkout:

```bash
npm run agent:link
```

Then from any project:

```bash
brass-agent --where
brass-agent --doctor
brass-agent --preset inspect
```

To make VS Code work through that global command instead of an absolute local path:

```bash
npm run agent:vscode:install:global
```

That command runs the global link flow and installs the VS Code extension with `brassAgent.command = "brass-agent"`.

To remove only the global CLI link/install:

```bash
npm run agent:unlink
```

To remove the VS Code extension, workspace settings/storage, generated VSIX files, and the global CLI link/install:

```bash
npm run agent:vscode:uninstall:global
```

To do a clean global reinstall:

```bash
npm run agent:vscode:reinstall:global
```

## Package only

To build/package the extension without installing it into VS Code:

```bash
npm run agent:vscode:package
```

This is useful when you want to manually install from VS Code via:

```txt
Extensions view
  -> Views and More Actions...
  -> Install from VSIX...
```

## Install script options

The underlying script is:

```bash
node scripts/install-vscode-extension.mjs
```

Useful options:

```bash
node scripts/install-vscode-extension.mjs --dry-run
node scripts/install-vscode-extension.mjs --no-code-install
node scripts/install-vscode-extension.mjs --no-settings
node scripts/install-vscode-extension.mjs --workspace ../some-project
node scripts/install-vscode-extension.mjs --use-global-command
node scripts/install-vscode-extension.mjs --command brass-agent
node scripts/install-vscode-extension.mjs --code "code-insiders"
```

Use `--workspace` when you want the script to write `.vscode/settings.json` into
a different project than the `brass-runtime` checkout. Use `--use-global-command`
when `brass-agent` is available on PATH and you do not want workspace settings to
point at an absolute `dist/agent/cli/main.cjs` path.

## Doctor

Run:

```bash
npm run agent:doctor
```

or after building/installing:

```bash
brass-agent --doctor
```

The doctor checks:

```txt
Node.js / npm
git
ripgrep / rg
workspace package.json and scripts
inferred package manager
LLM provider environment
.brass-agent.json / brass-agent.config.json discovery
VS Code `code` CLI
VS Code workspace setting brassAgent.command
local CLI build artifact
VS Code extension build / VSIX package
```

JSON output is available for scripts:

```bash
brass-agent --doctor --json
```

## Why this is not CI

This is deliberately local-first. It gives us repeatable commands that a person
can run before we add workflows:

```bash
npm run agent:vscode:install
npm run agent:doctor
```

Later, CI can reuse the same install/build/doctor concepts, but P23 does not add
GitHub Actions or release automation.

## Initialize a workspace first

For a new project, bootstrap local config before deeper DX setup:

```bash
brass-agent --init
brass-agent --doctor
```

The VS Code extension also contributes `Brass Agent: Initialize Workspace`, which runs the same init flow from the command palette.

## Env files

`brass-agent --doctor` auto-loads supported agent keys from `.brass-agent.env`, `.env.local`, and `.env` in the workspace. Use `--env-file PATH` to choose a file or `--no-env-file` to disable this behavior. See [Agent env files](./agent-env-files.md).


## VS Code auto-discovery

The VS Code extension can now use `brassAgent.command = "auto"` and prefer its bundled CLI, so you can open any repo and use Brass Agent without linking the CLI globally. See [VS Code auto-discovery](./agent-vscode-auto-discovery.md).
