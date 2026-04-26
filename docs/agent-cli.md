# Brass Agent CLI

## Initialize a workspace

```bash
brass-agent --init
```

This creates `.brass-agent.json`, `brass-agent.batch.json`, `.env.example`, and `BRASS_AGENT.md` in the workspace. Existing files are skipped unless `--force` is passed.

Useful variants:

```bash
brass-agent --init --init-dry-run
brass-agent --init --init-profile google
brass-agent --init --init-profile fake --force
```

See [Agent init](./agent-init.md) for the generated config and recommended first-run flow.


`brass-agent` is the development CLI for the experimental `src/agent` module.
It wires the agent environment together, runs `runAgent(...)`, and prints either a
human-readable run summary, streamed event JSON, protocol JSON Lines, or the raw `AgentState` JSON.

The CLI is intentionally thin:

```txt
CLI
  -> parse flags
  -> load .brass-agent.json if present
  -> choose LLM provider
  -> choose context discovery budget
  -> choose approval strategy
  -> create AgentEnv
  -> create Runtime
  -> runAgent(...)
  -> print result
```

The runtime and agent invariants still live below the CLI. The CLI must not run
side effects directly except for reading process arguments/environment, prompting
for approvals, and printing output.

## Install/build entry

The package exposes a binary after build:

```bash
npm run build
npm run agent:link
brass-agent "fix the failing tests"
```

For local development without building:

```bash
npm run agent:dev -- "fix the failing tests"
# or
npx tsx src/agent/cli/main.ts "fix the failing tests"
```

## Usage

```bash
brass-agent [options] "goal"
```

Options:

```txt
--mode read-only|propose|write|autonomous
    Agent permission mode. Default: propose.

--apply
    Alias for --mode write.

--cwd PATH
    Starting directory for workspace discovery. Default: current directory.

--where, --print-workspace
    Print the resolved workspace root and exit.

--no-discover-workspace
    Use --cwd exactly instead of searching upward for package.json, .brass-agent.json, workspace markers, or .git.

--config PATH
    Load a specific .brass-agent.json policy/config file.

--batch-file PATH
    Run multiple goals sequentially from a JSON or line-based file.

--batch-stop-on-failure
    Stop a batch after the first failed run.

--batch-continue-on-failure
    Continue a batch even when one run fails.

--no-config
    Do not discover or load an agent config file.

--json
    Print the full AgentState JSON instead of human-readable output.

--events-json
    Stream compact AgentEvent objects as JSON Lines and do not print final AgentState.

--protocol-json
    Stream Brass Agent protocol JSON Lines. This includes event messages and a final-state message for editor integrations.

--yes, -y
    Auto-approve approval prompts. Useful for CI and smoke tests.

--no-input
    Do not prompt; reject any action that requires approval.

--approval auto|interactive|approve|deny
    Approval strategy. Default: auto.

--help, -h
    Show help.
```


## Batch runs

P21 adds sequential batch execution:

```bash
brass-agent --batch-file ./brass-agent.batch.json --ci
```

Batch files can be JSON arrays, JSON objects with a `goals` array, or line-based
text files. Each item becomes a normal `runAgent(...)` invocation, so policy,
approvals, redaction, rollback safety, and CI exit code handling still apply.

See [Agent batch runs](./agent-batch.md).

## Config files

By default, the CLI first resolves a workspace root by searching upward from `--cwd` for:

```txt
.brass-agent.json
brass-agent.config.json
package.json
pnpm-workspace.yaml
turbo.json
nx.json
.git
```

Then it searches upward from that resolved workspace root for config files:

```txt
.brass-agent.json
brass-agent.config.json
```

Use `brass-agent --where` to see the resolved root.

Use `--config PATH` to force a specific file, or `--no-config` to run with
only built-in defaults and environment variables. Config can set default mode,
approval strategy, LLM provider/model, project command discovery, context discovery,
shell command policy, patch apply policy, and tool timeouts/retries.

Precedence is:

```txt
CLI flags > environment variables > .brass-agent.json > built-in defaults
```

See [Agent config and policy files](./agent-config.md).

## Context discovery

Before calling the LLM, the CLI-driven agent now runs a bounded context pass by
default. It extracts paths and identifiers from the goal and validation output,
then uses `fs.searchText` / `fs.readFile` to gather likely relevant files.

Tune it in config:

```json
{
  "context": {
    "maxSearchQueries": 3,
    "maxFiles": 4
  }
}
```

Or disable it:

```json
{
  "context": {
    "enabled": false
  }
}
```

See [Agent context discovery](./agent-context-discovery.md).

## Modes

### `propose`

Default mode. The agent can inspect the workspace, discover project-aware
validation commands from `package.json`/lockfiles/config, run whitelisted
validation commands, discover a bounded set of relevant context files, ask the
LLM, and record `patch.proposed`. It does not
apply changes.

```bash
brass-agent "fix the failing tests"
```

### `write`

Writable mode. The agent can apply an extracted unified diff through the
`PatchService`, then rerun validation. If a generated patch fails to apply or
validation still fails, P13 can ask `llm.patch` for a bounded repair diff and
validate again. Applying a patch still requires approval.
In an interactive terminal the CLI prompts by default; in CI/non-interactive
contexts use `--yes` to approve or `--no-input` to reject.

```bash
brass-agent --apply "fix the failing tests"
# equivalent:
brass-agent --mode write "fix the failing tests"
# non-interactive approval:
brass-agent --apply --yes "fix the failing tests"
```

### `read-only`

Inspection mode. The agent reads workspace context, checks project metadata such
as lockfiles, and asks the LLM without running shell validation or applying
patches.

```bash
brass-agent --mode read-only "inspect this repo"
```

### `autonomous`

Reserved for future work. It currently has the broadest policy surface, but P6
still routes sensitive actions such as `patch.apply` through approvals.

## Output

Human-readable output is the default:

```txt
brass-agent propose
workspace: /repo
goal: fix the failing tests

✓ read package.json
! pnpm test exited 1
✓ llm.plan responded
✓ patch proposed
✓ done

phase: done
steps: 5
patch: proposed only; rerun with --apply to apply it

summary:
...
```

Use `--json` when debugging the state machine or tests:

```bash
brass-agent --json "fix the failing tests"
```

Use `--events-json` for quick event-only streams:

```bash
brass-agent --events-json "fix the failing tests"
```

Use `--protocol-json` for editor integrations and other clients that need both live events and the final compact state:

```bash
brass-agent --protocol-json "fix the failing tests"
```

The protocol is newline-delimited JSON:

```jsonl
{"protocol":"brass-agent","version":1,"type":"event","event":{"type":"agent.run.started"}}
{"protocol":"brass-agent","version":1,"type":"final-state","state":{"phase":"done"}}
```

See [Agent DX surfaces](./agent-dx.md).

## Project command discovery

The CLI passes `config.project` into `runAgent(...)`. The agent uses it to
select validation commands instead of hardcoding `npm test`.

Default discovery reads `package.json`, checks common lockfiles, infers
`npm`/`pnpm`/`yarn`/`bun`, and selects scripts like `test`,
`test:ci`, `typecheck`, or `lint` when relevant.

Examples:

```json
{
  "project": {
    "packageManager": "pnpm",
    "validationCommands": ["pnpm run test:unit", "pnpm run typecheck"]
  }
}
```

See [Agent project command discovery](./agent-project-commands.md).

## Approvals

Actions can be allowed, denied, or marked as requiring approval by
`PermissionService`. In P6, `patch.apply` requires approval in `write` and
`autonomous` modes.

Approval strategy is chosen by CLI flags/environment:

```txt
--approval auto         Interactive only when stdin/stderr/stdout are TTYs; otherwise deny.
--approval interactive  Always prompt on stderr.
--approval approve      Auto-approve all approval requests.
--approval deny         Auto-reject all approval requests.
--yes, -y               Alias for --approval approve.
--no-input              Alias for --approval deny.
```

Environment knobs:

```bash
BRASS_AGENT_APPROVAL=approve|deny|interactive|auto
BRASS_AGENT_AUTO_APPROVE=true
```

Prompts are written to stderr, so `--json --approval interactive` can still keep
final JSON on stdout. The default remains conservative: non-interactive runs deny
approval-required actions unless `--yes` or `BRASS_AGENT_AUTO_APPROVE=true` is
set.

## LLM providers

The CLI chooses a provider from environment variables.

Fake/offline:

```bash
BRASS_LLM_PROVIDER=fake brass-agent "inspect"
```

Google Gemini:

```bash
BRASS_LLM_PROVIDER=google \
GEMINI_API_KEY="..." \
BRASS_GOOGLE_MODEL="gemini-2.5-flash" \
brass-agent "fix the failing tests"
```

OpenAI-compatible:

```bash
BRASS_LLM_PROVIDER=openai-compatible \
BRASS_LLM_ENDPOINT="https://api.openai.com/v1/chat/completions" \
BRASS_LLM_API_KEY="..." \
BRASS_LLM_MODEL="gpt-4.1" \
brass-agent "fix the failing tests"
```

If `BRASS_LLM_PROVIDER` is not set, the CLI tries Google, then
OpenAI-compatible, then falls back to the fake LLM.

The CLI also auto-loads supported agent environment keys from `.brass-agent.env`,
`.env.local`, and `.env` in `--cwd`. Use `--env-file PATH` to choose a specific
file, or `--no-env-file` to disable this behavior. The loader never prints secret
values and ignores non-agent keys. See [Agent env files](./agent-env-files.md).

## Applying a reviewed patch file

Editor integrations can apply an already-reviewed unified diff without asking
the model to regenerate it. This exact patch-file path does not run the patch
quality repair loop, so the diff being applied is the diff the user reviewed:

```bash
brass-agent --apply-patch-file ./approved.diff --yes "apply approved patch"
```

For preview integrations, use:

```bash
brass-agent --protocol-json --protocol-full-patches "fix the failing tests"
```

`--protocol-full-patches` is intended for trusted local clients that need the
full `patch.proposed` payload. Other large payloads remain compacted.
