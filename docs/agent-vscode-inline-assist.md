# VS Code Inline Assist

P34 adds a lightweight Inline Assist flow for editor-first usage.

It is not ghost-text autocomplete. It is a quick editor command that uses the current selection, or a configurable number of surrounding lines around the cursor, and opens the Brass Agent Chat with a focused prompt.

## Command

```txt
Brass Agent: Inline Assist...
```

You can also access it from the editor context menu.

## Available intents

Inline Assist offers:

```txt
Ask about this code
Explain this code
Fix this code
Refactor this code
Generate tests
Custom instruction...
```

Read-only intents open the Chat in Ask mode. Patch-producing intents open the Chat in apply-after-preview mode, so any diff still goes through patch preview and exact apply via `brass-agent`.

## Selection vs cursor context

If text is selected, Inline Assist includes that exact selection.

If there is no selection, it includes surrounding lines around the cursor.

Configure the number of surrounding lines:

```json
{
  "brassAgent.inlineAssistSurroundingLines": 20
}
```

Set it to `0` to include only the current line when there is no selection.

## Safety

Inline Assist does not edit files directly. The flow is:

```txt
editor selection/cursor context
  -> Chat draft
  -> brass-agent run
  -> patch preview if any
  -> exact patch apply via CLI only after approval
```
