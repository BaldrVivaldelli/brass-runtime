# Agent language and workspace setup UX

Brass Agent supports two setup paths:

- **Model setup**: stored by the VS Code extension in Secret Storage.
- **Workspace setup**: stored in the repository as `.brass-agent.json`.

The VS Code extension exposes both from the Chat view:

```txt
/model       configure the LLM provider and API keys
/workspace   create or update .brass-agent.json
/config      alias for /workspace
```

## Response language

By default, Brass Agent tries to answer in the same language as the user's latest goal. For example, Spanish prompts should get Spanish explanations.

The behavior can be forced per workspace:

```json
{
  "language": {
    "response": "es"
  }
}
```

Supported values:

```txt
auto        infer from the latest user goal
match-user  same intent as auto, explicit in config
en          English
es          Spanish
pt          Portuguese
fr          French
de          German
it          Italian
custom      custom language name, via language.custom
```

When Brass Agent is launched from VS Code, the extension can also pass a language preference through the `brassAgent.language.response` setting. Workspace config still remains the best place when a project should consistently answer in one language.

Language policy only affects natural-language responses. Code, identifiers, paths, shell commands, logs, and unified diffs are kept unchanged.

## Create `.brass-agent.json` from VS Code

Use either:

```txt
Brass Agent: Configure Workspace
```

or in the Chat view:

```txt
/workspace
```

The wizard asks for:

1. response language
2. validation command behavior

For validation commands, it can:

- auto-discover from `package.json`
- disable validation commands
- choose a detected script, such as `npm run repo:check`
- accept a custom command

When a specific validation command is selected, the extension adds it to:

```json
{
  "project": {
    "validationCommands": ["npm run repo:check"]
  },
  "permissions": {
    "shell": {
      "allow": ["npm run repo:check"]
    }
  }
}
```

That means future runs can execute the command through the normal Brass Agent permission pipeline.

## CLI usage

The CLI also accepts a temporary language override:

```bash
brass-agent --language es "explicame este repo"
```

This does not modify config. For persistent behavior, use `.brass-agent.json`.
