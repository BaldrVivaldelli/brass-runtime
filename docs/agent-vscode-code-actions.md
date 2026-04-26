# VS Code Code Actions / Lightbulb

Brass Agent can expose native VS Code code actions so common workflows are available from the editor lightbulb and Quick Fix menu.

This keeps the editor UX closer to Copilot-style usage without changing the architecture:

```txt
VS Code CodeAction
  -> Brass Agent Chat draft
  -> brass-agent CLI protocol
  -> patch preview / approval
```

The extension still does not apply patches directly.

## Problem actions

When VS Code reports diagnostics for the current range, the lightbulb can show:

```txt
Fix problem with Brass Agent
Explain problem with Brass Agent
```

These actions open the Brass Agent Chat with a prompt containing:

```txt
file path
language id
range
diagnostics
relevant code snippet
```

`Fix problem` uses apply-after-preview mode, so any generated diff is shown before it can be applied.

## Selection actions

When text is selected, the lightbulb can show:

```txt
Explain selection with Brass Agent
Fix selection with Brass Agent
Refactor selection with Brass Agent
Generate tests with Brass Agent
```

These actions prefill the Chat view with the selected code and an appropriate task.

## Slash commands still work

The Chat view still supports:

```txt
/inspect
/fix-tests
/typecheck
/lint
/explain-last
/apply-last
/rollback-last
```

Use code actions for local editor context, and slash commands for workspace-level tasks.

## Notes

- Code actions are registered for `file` documents.
- Patch application remains mediated by `brass-agent`.
- Problem actions depend on diagnostics from installed language extensions, such as TypeScript or ESLint.
