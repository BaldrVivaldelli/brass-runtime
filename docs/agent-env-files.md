# Brass Agent env files

`brass-agent` can read local environment files for agent-specific variables.
This is useful for VS Code and local dogfooding because editor-launched commands do
not always inherit the same shell environment as your terminal.

## Load order

By default, the CLI checks these files in `--cwd`:

```txt
.brass-agent.env
.env.local
.env
```

All existing files are parsed in that order. Exported shell variables win: the
loader never overwrites keys that are already present in `process.env`.

To load a specific file:

```bash
brass-agent --env-file .env --doctor
```

To disable env-file loading completely:

```bash
brass-agent --no-env-file --doctor
```

## What gets loaded

For safety, the loader only imports known Brass Agent keys, plus the custom
`config.llm.apiKeyEnv` key when configured. Other application secrets in `.env`
are ignored and are not copied into `process.env` by the loader.

Supported built-in keys include:

```txt
BRASS_LLM_PROVIDER
BRASS_FAKE_LLM_RESPONSE

GEMINI_API_KEY
GOOGLE_API_KEY
BRASS_GOOGLE_API_KEY
BRASS_GOOGLE_MODEL
BRASS_GOOGLE_API_VERSION
BRASS_GOOGLE_BASE_URL
BRASS_GOOGLE_ENDPOINT
BRASS_GOOGLE_SYSTEM_INSTRUCTION
BRASS_GOOGLE_TEMPERATURE
BRASS_GOOGLE_TOP_P
BRASS_GOOGLE_TOP_K
BRASS_GOOGLE_MAX_OUTPUT_TOKENS

BRASS_LLM_ENDPOINT
BRASS_LLM_API_KEY
BRASS_LLM_MODEL

BRASS_AGENT_APPROVAL
BRASS_AGENT_AUTO_APPROVE
BRASS_CODE_CMD
```

The doctor prints key names only, never values.

## Google / Gemini example

`.brass-agent.json`:

```json
{
  "llm": {
    "provider": "google",
    "model": "gemini-2.5-flash",
    "apiKeyEnv": "GEMINI_API_KEY"
  }
}
```

`.env` or `.brass-agent.env`:

```bash
BRASS_LLM_PROVIDER=google
GEMINI_API_KEY=...
BRASS_GOOGLE_MODEL=gemini-2.5-flash
```

Then:

```bash
brass-agent --doctor
```

Expected doctor output includes:

```txt
✓ Agent env file: Loaded ... keys: BRASS_LLM_PROVIDER, GEMINI_API_KEY, BRASS_GOOGLE_MODEL
✓ LLM provider: Google/Gemini provider is configured (google).
```

## Why `.env` alone used to fail

A shell does not automatically export variables from a `.env` file. Before the
env-file loader, this worked only when you did something like:

```bash
set -a
source .env
set +a
brass-agent --doctor
```

With the loader, keeping agent keys in `.env` or `.brass-agent.env` is enough for
the CLI and VS Code extension.

## Safety notes

- Do not commit real API keys.
- Prefer `.brass-agent.env` when you want to keep agent credentials separate from
  app/runtime `.env` files.
- The loader ignores non-agent keys in `.env` so app secrets are not imported
  just because the agent is running.
- If a key was exposed publicly or pasted into a chat/log, revoke it and create a
  new one.
