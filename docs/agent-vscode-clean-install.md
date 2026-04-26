# VS Code full clean and reinstall

Use this when the Brass Agent sidebar looks stale, the Chat view is missing, or
VS Code still shows an older extension after rebuilding.

## Where the UI is

After installing the extension, reload VS Code:

```txt
Developer: Reload Window
```

Then open the Brass Agent activity-bar icon.

The expected layout is:

```txt
Brass Agent
  Chat
  Run History
```

If you only see `Run History`, or the toolbar still looks like an older build,
you are probably running an old VSIX. Do a full clean reinstall.

You can also open the chat directly from the Command Palette:

```txt
Brass Agent: Open Chat
```

## Full clean reinstall

From the repository root:

```bash
npm run agent:vscode:reinstall
```

That runs:

```txt
agent:vscode:clean
agent:vscode:install
```

Then reload VS Code again:

```txt
Developer: Reload Window
```

## Clean only

```bash
npm run agent:vscode:clean
```

This removes:

```txt
- the installed VS Code extension
- installed extension folders under ~/.vscode*/extensions when present
- VS Code globalStorage for the extension when present
- generated .vsix files
- brassAgent.* keys from workspace .vscode/settings.json
```

It intentionally keeps the root build output and source files.

## Uninstall only

```bash
npm run agent:vscode:uninstall
```

This only asks VS Code to uninstall the extension. It does not delete generated
VSIX packages, workspace settings, or extension storage.

## Global uninstall

If you installed the extension in global-command mode:

```bash
npm run agent:vscode:install:global
```

use the matching global uninstall:

```bash
npm run agent:vscode:uninstall:global
```

That runs the VS Code clean flow and then removes the global `brass-runtime` npm link/install, so `brass-agent` should no longer resolve from `PATH`.

For a full clean reinstall in global-command mode:

```bash
npm run agent:vscode:reinstall:global
```

## Preview the cleanup

```bash
node scripts/clean-vscode-extension.mjs --dry-run
```

The script refuses destructive file deletion unless you pass `--yes`; the npm
scripts include `--yes` because they are explicit clean/uninstall scripts.

## Useful variants

Clean a different workspace settings file:

```bash
node scripts/clean-vscode-extension.mjs --yes --workspace ../other-project
```

Use VS Code Insiders:

```bash
node scripts/clean-vscode-extension.mjs --yes --code code-insiders
node scripts/install-vscode-extension.mjs --code code-insiders
```

Delete the compiled extension output too:

```bash
node scripts/clean-vscode-extension.mjs --yes --extension-build
```

## After reinstall

Run:

```txt
Brass Agent: Doctor
```

Then try:

```txt
Brass Agent: Open Chat
/help
/inspect
```
