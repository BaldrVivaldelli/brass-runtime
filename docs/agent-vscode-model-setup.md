# Brass Agent VS Code model setup

The VS Code extension can configure the model used by `brass-agent` without requiring a terminal or a repository-local `.env` file.

## Why configure from VS Code?

When the extension launches the bundled `brass-agent` CLI, it can inject provider environment variables into that child process. This means you can open any workspace and use the Brass Agent Chat without first exporting keys in your shell.

Secrets are stored with VS Code Secret Storage, not in `.brass-agent.json`, `.env`, `settings.json`, or source control. VS Code exposes `ExtensionContext.secrets` for sensitive information; the implementation stores secrets encrypted and does not sync them across machines. [VS Code docs](https://code.visualstudio.com/api/extension-capabilities/common-capabilities)

## First run

Open the Brass Agent sidebar and run:

```txt
Brass Agent: Configure Model
```

Or from the Chat view:

```txt
/model
```

You can choose:

- **Google / Gemini** — stores a Gemini API key and model name.
- **OpenAI-compatible** — stores an API key plus endpoint/model settings.
- **Fake / offline** — no API key; useful for smoke tests and UI testing.
- **Auto-detect** — lets workspace config/env decide, while still injecting stored VS Code secrets when available.

## Google / Gemini

The extension stores the key in VS Code Secret Storage and passes these variables only to runs launched from VS Code:

```txt
BRASS_LLM_PROVIDER=google
GEMINI_API_KEY=<secret>
GOOGLE_API_KEY=<secret>
BRASS_GOOGLE_API_KEY=<secret>
BRASS_GOOGLE_MODEL=gemini-2.5-flash
```

The key value is not printed in Doctor output and is not written to the workspace.

## OpenAI-compatible

For OpenAI-compatible providers, the extension passes:

```txt
BRASS_LLM_PROVIDER=openai-compatible
BRASS_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
BRASS_LLM_API_KEY=<secret>
BRASS_LLM_MODEL=gpt-4.1
```

Use a custom endpoint/model when configuring the provider.

## Doctor

After setup, run:

```txt
Brass Agent: Doctor
```

or in Chat:

```txt
/doctor
```

Doctor runs through the extension, so it can see secrets stored by the extension. A terminal command like `brass-agent --doctor` will not see VS Code Secret Storage unless the same key is also exported in your shell or configured via `.env`.

## Clearing stored keys

Run:

```txt
Brass Agent: Configure Model
```

and choose:

```txt
Clear stored model secrets
```

This deletes the keys stored by the Brass Agent extension.

## Recommended daily flow

1. Install/reinstall the extension.
2. Open any repository in VS Code.
3. Run `Brass Agent: Configure Model` once.
4. Run `Brass Agent: Doctor`.
5. Use `Brass Agent → Chat` with `/inspect`, `/fix-tests`, `/fix-problems`, or natural language.
