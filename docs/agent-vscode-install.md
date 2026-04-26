# Installing the VS Code extension locally

> For the end-to-end setup flow, see [Brass Agent install and configure](./agent-install-and-configure.md).

The easiest local path for developing inside the `brass-runtime` checkout is:

```bash
npm run agent:vscode:install
```

That builds the CLI, packages the VSIX, installs it into VS Code, and writes a local `.vscode/settings.json` pointing `brassAgent.command` at `dist/agent/cli/main.cjs`.

If you want to use the same agent from many projects, prefer the global-command flow:

```bash
npm run agent:vscode:install:global
```

That command links the CLI globally and installs the extension configured to call `brass-agent`. It writes:

```json
{
  "brassAgent.command": "brass-agent"
}
```

To remove that global setup:

```bash
npm run agent:vscode:uninstall:global
```

See [Agent global usage and workspace discovery](./agent-global-usage.md) and [Agent local install and doctor](./agent-local-install.md) for details.


The VS Code extension is designed to be installed as a `.vsix` while the project
is still pre-marketplace.

## Build the CLI first

From the repository root:

```bash
npm install
npm run build
```

This should produce the CLI entrypoint used by the extension:

```txt
dist/agent/cli/main.cjs
```

You can either put the `brass-agent` binary on PATH, or configure the extension
to call this file directly.

## Package the extension

From the extension folder:

```bash
cd extensions/vscode-brass-agent
npm install
npm run compile
npm run package:vsix
```

This creates a file like:

```txt
vscode-brass-agent-0.0.1.vsix
```

The extension manifest includes `repository`, `homepage`, and `bugs` metadata so
`vsce` can package it without the missing-repository warning. If you publish from
a fork, update those fields in `extensions/vscode-brass-agent/package.json` first.

## Install in VS Code

Using the command line:

```bash
code --install-extension vscode-brass-agent-0.0.1.vsix
```

Or from VS Code:

```txt
Extensions view
  -> Views and More Actions...
  -> Install from VSIX...
```

## Configure the CLI path

For local development, point the extension to the built CLI:

```json
{
  "brassAgent.command": "/absolute/path/to/brass-runtime/dist/agent/cli/main.cjs"
}
```

For a globally installed package, keep the default:

```json
{
  "brassAgent.command": "brass-agent"
}
```


## If the UI is missing or stale

After installing, run:

```txt
Developer: Reload Window
```

Then open the Brass Agent activity-bar icon. You should see:

```txt
Chat
Run History
```

If you only see `Run History`, or the toolbar looks like an older build, run:

```bash
npm run agent:vscode:reinstall
```

See [VS Code full clean and reinstall](./agent-vscode-clean-install.md).

## Doctor

After installing, run:

```bash
npm run agent:doctor
```

or from the VS Code command palette:

```txt
Brass Agent: Doctor
```

## Notes

The VS Code extension is a client for the CLI. Installing the extension alone is
not enough unless `brass-agent` is also available to the editor process.

## Initialize a workspace first

For a new project, bootstrap local config before deeper DX setup:

```bash
brass-agent --init
brass-agent --doctor
```

The VS Code extension also contributes `Brass Agent: Initialize Workspace`, which runs the same init flow from the command palette.


## VS Code auto-discovery

The VS Code extension can now use `brassAgent.command = "auto"` and prefer its bundled CLI, so you can open any repo and use Brass Agent without linking the CLI globally. See [VS Code auto-discovery](./agent-vscode-auto-discovery.md).


## Configure the model from VS Code

After installing the extension, run `Brass Agent: Configure Model` or `/model` from the Chat view. API keys are stored in VS Code Secret Storage and injected into VS Code-launched agent runs. See [VS Code model setup](./agent-vscode-model-setup.md).

## Node used by the bundled CLI

When the extension uses its bundled CLI, it launches `main.cjs` with `node` by default. If your Node executable has a custom path, set:

```json
{
  "brassAgent.nodeCommand": "/absolute/path/to/node"
}
```

If `node` cannot be found, the extension falls back to VS Code Electron-as-Node automatically.
