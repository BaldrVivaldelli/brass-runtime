# Brass Agent global usage and workspace discovery

`brass-agent` is meant to run from **any project**, not only from the `brass-runtime` checkout.

The runtime checkout is where the CLI is built. The workspace is whichever project you run the CLI against.

```txt
brass-runtime checkout
  -> builds/installs brass-agent

any other project
  -> run brass-agent here
  -> agent discovers that project as the workspace
```

## Install the CLI globally for local development

From the `brass-runtime` checkout:

```bash
npm run agent:link
```

This runs:

```bash
npm run build
npm link
```

After that, `brass-agent` should be available on your `PATH` from any folder:

```bash
brass-agent --where
brass-agent --doctor
brass-agent --preset inspect
```

To remove the global CLI link/install:

```bash
npm run agent:unlink
```

This command is idempotent: it is okay if the package is not currently linked or installed globally.

## Use it in another project

```bash
cd /path/to/another-project
brass-agent --where
brass-agent --init --init-profile google
brass-agent --doctor
brass-agent --preset inspect
```

`--where` prints the workspace root the agent will use.

## Workspace auto-discovery

By default, `brass-agent` treats `--cwd` as a **starting directory**, not necessarily the final workspace root.

It searches upward for the nearest workspace marker:

```txt
.brass-agent.json
brass-agent.config.json
package.json
pnpm-workspace.yaml
turbo.json
nx.json
.git
```

Examples:

```bash
cd /repo/packages/api/src/routes
brass-agent --where
```

May resolve to:

```txt
workspace: /repo/packages/api
marker: package.json
```

Then config discovery, env-file loading, package-manager detection, validation commands, context discovery, and patch application all use that resolved workspace.

## Disable workspace discovery

If you intentionally want the exact current folder:

```bash
brass-agent --no-discover-workspace --where
```

or:

```bash
brass-agent --no-discover-workspace --cwd ./some/subdir "inspect this folder"
```

## VS Code with a global CLI

If the CLI is globally linked, the VS Code extension can just use:

```json
{
  "brassAgent.command": "brass-agent"
}
```

To install the extension and write that setting into the current workspace:

```bash
npm run agent:vscode:install:global
```

That script now links the CLI globally first, then installs the VS Code extension with `brassAgent.command = "brass-agent"`.

To remove the global VS Code setup and the global CLI link/install:

```bash
npm run agent:vscode:uninstall:global
```

To force a full clean global reinstall:

```bash
npm run agent:vscode:reinstall:global
```

For a different workspace:

```bash
node scripts/install-vscode-extension.mjs \
  --use-global-command \
  --workspace /path/to/another-project
```

This is the best setup when you want one local Brass Agent installation and many workspaces.

## Absolute local CLI path

For development of the agent itself, the installer may write an absolute command:

```json
{
  "brassAgent.command": "/path/to/brass-runtime/dist/agent/cli/main.cjs"
}
```

That works too, but it is less portable than `brass-agent`.

## Recommended daily workflow

Once globally linked:

```bash
cd /path/to/project
brass-agent --where
brass-agent --doctor
brass-agent --preset inspect
brass-agent --preset typecheck
brass-agent "fix the failing tests"
```

From VS Code:

```txt
Brass Agent -> Chat -> /inspect
Brass Agent -> Chat -> /fix-tests
```


## VS Code auto-discovery

The VS Code extension can now use `brassAgent.command = "auto"` and prefer its bundled CLI, so you can open any repo and use Brass Agent without linking the CLI globally. See [VS Code auto-discovery](./agent-vscode-auto-discovery.md).
