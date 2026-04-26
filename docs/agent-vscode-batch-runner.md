# VS Code batch runner

P22 adds a VS Code surface for Brass Agent batch runs.

The extension remains a thin client:

```txt
VS Code command
  -> brass-agent --protocol-json --batch-file ...
  -> protocol JSON Lines
  -> OutputChannel progress
  -> Runs TreeView history
```

The extension does not interpret batch policy, approvals, validation, patches, or
rollback rules. Those remain inside `brass-agent` and `src/agent`.

## Commands

The extension contributes two batch commands:

- `Brass Agent: Run Batch File`
- `Brass Agent: Run Configured Batch`

`Run Batch File` opens a VS Code file picker and passes the selected file to the
CLI:

```bash
brass-agent --protocol-json --protocol-full-patches --cwd <workspace> --batch-file <file>
```

`Run Configured Batch` runs the workspace config batch, if the project has one:

```json
{
  "batch": {
    "stopOnFailure": true,
    "goals": [
      { "preset": "inspect" },
      { "preset": "typecheck" },
      { "preset": "lint" },
      { "preset": "fix-tests", "mode": "propose" }
    ]
  }
}
```

## History representation

Batch runs are stored as a parent run in the `Brass Agent` activity-bar view.
Each `final-state` message emitted by the CLI becomes a child run under that
batch entry.

```txt
Brass Agent
  Runs
    ✓ batch: brass-agent.batch.json
      ✓ inspect this workspace
      ✓ run typecheck discovery and fix type errors if possible
      ! run lint discovery and fix lint errors if possible
      Batch completed: 3/4
      Batch failed: 1
```

Child runs can still expose summaries, errors, patches, and details using the
same run-history UI from P11.

## Rerun behavior

Rerunning a batch history entry launches the batch again:

- batch entries created from a file rerun the same file path
- configured-batch entries rerun the current workspace config batch

As with every other VS Code flow, the editor does not execute agent logic
directly. It always calls the CLI protocol boundary.

## Packaging the extension

From the extension folder:

```bash
cd extensions/vscode-brass-agent
npm install
npm run compile
npm run package:vsix
```

That creates a `.vsix` file that can be installed locally in VS Code.

The extension expects the `brass-agent` CLI to be available on PATH, or for the
workspace/user setting `brassAgent.command` to point to the built CLI.

Example local setting:

```json
{
  "brassAgent.command": "/absolute/path/to/brass-runtime/dist/agent/cli/main.cjs"
}
```
