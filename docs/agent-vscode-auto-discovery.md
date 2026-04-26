# VS Code auto-discovery for `brass-agent`

The VS Code extension can now run Brass Agent from any workspace without requiring you to manually set an absolute CLI path in each repo.

The recommended setting is:

```json
{
  "brassAgent.command": "auto",
  "brassAgent.preferBundledCli": true
}
```

With `auto`, the extension resolves the CLI in this order:

1. `BRASS_AGENT_COMMAND`, if set in the VS Code extension host environment.
2. The CLI bundled inside the installed VSIX, when available.
3. `node_modules/.bin/brass-agent` inside the current workspace.
4. A nearby `brass-runtime` checkout with `dist/agent/cli/main.cjs`, useful for extension development.
5. `brass-agent` from `PATH` as a fallback.

When the resolved CLI is a JavaScript entrypoint such as `main.cjs`, the extension prefers launching it with `node`. If `node` is not discoverable, it falls back to VS Code Electron-as-Node with `ELECTRON_RUN_AS_NODE=1`.

The extension still passes `--cwd <workspace>` to the CLI. The CLI then runs its own workspace discovery, so you can open any repo or package folder and the agent will resolve the actual workspace root.

## Install flow

From the `brass-runtime` checkout:

```bash
npm run agent:vscode:install
```

That flow now:

```txt
builds the root CLI
bundles dist/ into the VS Code extension
packages the VSIX
installs the VSIX
writes brassAgent.command = auto
```

After installation:

```txt
Developer: Reload Window
Brass Agent -> Chat
/inspect
```

## Use in any repo

Open any project in VS Code and use the Brass Agent sidebar:

```txt
Brass Agent -> Chat -> /inspect
Brass Agent -> Chat -> /fix-tests
Brass Agent -> Chat -> /fix-problems
```

No terminal setup is required as long as the extension has a bundled CLI.

## Configure from VS Code

Use:

```txt
Brass Agent: Configure CLI
```

Options:

```txt
Auto-discover CLI
Prefer bundled CLI
Use global brass-agent
Select CLI file...
Show resolved CLI
```

If you want to force a global command:

```json
{
  "brassAgent.command": "brass-agent",
  "brassAgent.preferBundledCli": false
}
```

If you want to force a local checkout:

```json
{
  "brassAgent.command": "/path/to/brass-runtime/dist/agent/cli/main.cjs"
}
```

## Debugging

Open the Output panel:

```txt
Brass Agent: Show Output
```

Each run logs the resolved CLI, for example:

```txt
CLI: node /home/me/.vscode/extensions/.../bundled/dist/agent/cli/main.cjs (bundled VS Code extension CLI)
```

You can also run:

```txt
Brass Agent: Doctor
```

or:

```txt
Brass Agent: Configure CLI -> Show resolved CLI
```

## Node command

If your Node binary is not named `node`, configure it from VS Code settings:

```json
{
  "brassAgent.nodeCommand": "/absolute/path/to/node"
}
```

This only affects JavaScript CLI entrypoints bundled with the extension or selected manually. Global commands such as `brass-agent` still run directly.

When the extension launches the CLI, it passes `BRASS_AGENT_VSCODE_EXTENSION=1` and `BRASS_AGENT_VSCODE_CLI_SOURCE` so `brass-agent --doctor` can explain that no workspace-level `brassAgent.command` setting is required.
