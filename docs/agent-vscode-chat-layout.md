# VS Code Chat layout / focus mode

Brass Agent can run in two VS Code layouts:

- **Sidebar chat** — compact, good for quick prompts and slash commands.
- **Editor chat** — larger focus-mode webview tab, good for long sessions, patch review follow-ups, or keeping code visible in another editor group.

The agent logic is the same in both layouts. Both surfaces share the same chat session, last run context, last patch preview, model configuration, and slash commands.

## Open chat in the editor

From VS Code:

```txt
Brass Agent: Open Chat in Editor
```

Or from the Chat view:

```txt
/focus
```

You can also use the **Open in editor** button in the Chat header.

The editor chat opens as a normal editor tab, so you can move it between editor groups, split it beside code, or keep it open while the left sidebar shows Explorer.

## Recommended layout

A comfortable layout is:

```txt
Left sidebar:
  Explorer

Editor area:
  Code tab + Brass Agent Chat tab / split group

Bottom panel:
  Terminal, Problems, Output

Brass Agent sidebar:
  Project and Run History collapsed unless needed
```

This avoids stacking Project, Chat, and Run History in one narrow sidebar.

## Make editor chat the default

You can make `Brass Agent: Open Chat` and selection/code-action flows open the larger editor chat by default:

```json
{
  "brassAgent.chat.defaultLocation": "editor"
}
```

Use `sidebar` to keep the previous behavior:

```json
{
  "brassAgent.chat.defaultLocation": "sidebar"
}
```

## Project dashboard in the editor

The Project dashboard can also open as a larger editor tab:

```txt
Brass Agent: Open Project Dashboard in Editor
```

This is useful when inspecting a repo profile, validation command, model state, and warnings without compressing the Chat view.

## Focus Chat Layout

`Brass Agent: Focus Chat Layout` opens the editor chat and focuses the editor group. It is a quick way to move from the sidebar into a larger working area.

## Safety

Changing the layout does not change agent behavior:

```txt
VS Code UI
  -> brass-agent CLI protocol
  -> permissions / approvals / patch preview / apply / rollback
```

The extension still does not apply patches directly. Apply and rollback continue to go through the `brass-agent` CLI.
