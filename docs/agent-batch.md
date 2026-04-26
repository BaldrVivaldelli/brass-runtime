# Agent batch runs

P21 adds sequential batch execution to `brass-agent`.

The goal is to make common DX/CI workflows composable without introducing a new
scheduler or breaking the existing boundary:

```txt
src/core
  ↑
src/agent runAgent(...)
  ↑
brass-agent CLI batch runner
```

A batch run is just multiple normal agent runs executed one after another. Each
run still goes through the same pipeline:

```txt
AgentAction
  -> PermissionService
  -> ApprovalService when ask
  -> ToolPolicy timeout/retry
  -> Async tool effect
  -> Observation
```

Batch mode does not bypass policy, approvals, redaction, rollback safety, CI exit
codes, or artifact export.

## CLI

Run a batch from a file:

```bash
brass-agent --batch-file ./brass-agent.batch.json
```

In CI:

```bash
brass-agent --batch-file ./brass-agent.batch.json --ci --batch-stop-on-failure
```

`--batch-stop-on-failure` stops after the first run whose CI status is non-zero.
`--batch-continue-on-failure` forces the opposite.

When neither flag is provided, the default is:

```txt
--ci      -> stop on failure
not --ci  -> continue
```

## Batch file formats

### JSON array

```json
[
  "inspect this workspace",
  { "preset": "typecheck" },
  { "preset": "lint" },
  { "preset": "fix-tests", "mode": "propose" }
]
```

### JSON object

```json
{
  "goals": [
    { "preset": "inspect" },
    { "goal": "explain the failing tests", "mode": "read-only" },
    { "goal": "fix the failing tests", "mode": "propose" }
  ]
}
```

### Plain text

If the file is not valid JSON, `brass-agent` treats it as a line-based goal file.
Blank lines and `#` comments are ignored.

```txt
# brass-agent.batch.txt
inspect this workspace
run typecheck discovery and explain failures
fix the failing tests
```

## Per-goal fields

JSON batch items support:

```ts
{
  goal?: string;
  preset?: "fix-tests" | "inspect" | "typecheck" | "lint";
  mode?: "read-only" | "propose" | "write" | "autonomous";
  cwd?: string;
  patchFile?: string;
  patchFileMode?: "apply" | "rollback";
  saveRunDir?: string;
}
```

`preset` fills in a standard goal. `goal` wins when both are present.

`cwd` lets one batch file target multiple workspaces, but the same loaded config
and CLI environment are reused for the full batch. Use separate invocations when
different workspaces need different config files.

## Config default batch

A project can define a default batch:

```json
{
  "batch": {
    "stopOnFailure": true,
    "goals": [
      { "preset": "inspect" },
      { "preset": "typecheck" },
      { "preset": "lint" }
    ]
  }
}
```

Then run:

```bash
brass-agent --ci
```

The config batch is used only when the CLI does not receive an explicit goal,
`--preset`, `--patch-file`, or `--batch-file`.

## Outputs

Human output prints each normal run and then a final batch summary:

```txt
batch summary:
completed: 3/3
failed: 0
exit code: 0
```

`--json` prints a batch object:

```json
{
  "type": "batch",
  "summary": {
    "total": 3,
    "completed": 3,
    "failed": 0,
    "exitCode": 0,
    "stoppedEarly": false
  },
  "results": []
}
```

`--protocol-json` emits normal event messages and a `final-state` message per
run, followed by a `batch-summary` message.

## Exit codes

In `--ci` mode, batch exit code is aggregated from individual runs:

```txt
1 if any run failed or latest validation failed
2 if no run failed but at least one run proposed an unapplied patch with --fail-on-patch-proposed
0 otherwise
```

## VS Code

P22 adds a VS Code command, `Brass Agent: Run Batch File`, which invokes the CLI
with `--protocol-json --batch-file`. The extension stores the batch as a parent
history entry and each CLI `final-state` message as a child run. See
[VS Code batch runner](./agent-vscode-batch-runner.md).
