# Brass Agent Copilot-like DX

Brass Agent started as a CLI-first coding agent. That is still the canonical execution surface, but VS Code users should not need to remember flags or switch to a terminal for normal usage.

P29 adds a Copilot-like VS Code surface around the existing CLI protocol.

## Mental model

Brass Agent is not an inline autocomplete engine yet.

It is a task agent:

```txt
you ask for a goal
  -> brass-agent inspects the workspace
  -> runs allowed validation commands
  -> discovers context
  -> calls the configured LLM
  -> proposes a patch
  -> VS Code previews the exact diff
  -> you approve before writing
```

The VS Code chat view makes that flow feel like a normal editor assistant.

## Chat view

Open the Brass Agent activity bar and use the **Chat** view.

You can ask things like:

```txt
inspect this workspace
fix the failing tests
explain the current type errors
refactor this module to reduce duplication
add tests for the selected function
```

The chat has three modes:

| Mode | What it does |
| --- | --- |
| Ask | `read-only`; no shell writes, no patch apply |
| Propose patch | generates a plan and patch preview, but does not write |
| Apply after preview | still generates a proposal first; writes only after you approve the exact diff |

## Selection-aware commands

Select code in an editor and right-click. Brass Agent contributes:

```txt
Ask About Selection
Explain Selection
Fix Selection
```

These commands open the chat with a prefilled prompt containing:

```txt
file path
language id
selected code
```

They do not directly edit the selection. `Fix Selection` asks the agent to generate a workspace patch and then uses the normal patch preview / approval flow.

## Why not inline autocomplete first?

Inline autocomplete is useful for short completions while typing. Brass Agent's strongest path is different:

```txt
multi-file context
validation commands
typed permissions
patch preview
rollback safety
run history
```

That maps better to chat + code actions than to token-by-token inline completion.

A future inline completion provider can still be added, but it should be a separate lightweight layer for small edits, not the main agent loop.

## Architecture

The boundary remains unchanged:

```txt
src/core
  ↑
src/agent
  ↑
brass-agent CLI protocol
  ↑
VS Code Chat / TreeView / Webview clients
```

The chat view does not reimplement agent planning, permissions, approvals, context discovery, patch apply, or rollback. It calls:

```bash
brass-agent --protocol-json --protocol-full-patches --cwd <workspace> <goal>
```

and renders protocol events.

## Recommended daily flow

1. Open the Brass Agent sidebar.
2. Use **Chat** for normal questions.
3. Select code and use **Ask About Selection** or **Fix Selection**.
4. Review patch previews before applying.
5. Check **Run History** for past runs, details, patches, and reruns.

## Safety notes

- `Apply after preview` still applies only after exact diff approval.
- Secrets should live in `.env`, `.env.local`, or `.brass-agent.env`; doctor verifies provider setup.
- Redaction and context exclude globs still run before LLM prompts.
- VS Code does not apply patches directly; it delegates back to `brass-agent`.

## P30: sessions and slash commands

The Chat view now stores a workspace-local conversation, supports slash commands such as `/inspect`, `/fix-tests`, `/explain-last`, and `/apply-last`, and composes follow-up goals using the previous run summary, latest validation output, and patch stats.

See [Chat sessions and slash commands](./agent-chat-sessions.md).
