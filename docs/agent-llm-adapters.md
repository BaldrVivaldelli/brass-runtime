# Agent LLM adapters

`src/agent` keeps LLM providers behind the small `LLM` capability:

```ts
export type LLM = {
  readonly complete: (request: LLMRequest) => Async<unknown, AgentError, LLMResponse>;
};
```

Adapters must return `Async` and must be cancelable. They should not leak provider-specific request or response shapes into the agent loop.

## Provider selection in the CLI

The local CLI chooses a provider from environment variables:

```bash
BRASS_LLM_PROVIDER=google          # or gemini
BRASS_LLM_PROVIDER=openai-compatible
BRASS_LLM_PROVIDER=fake
```

If `BRASS_LLM_PROVIDER` is omitted, the CLI auto-detects providers in this order:

1. Google Gemini, when `BRASS_GOOGLE_API_KEY`, `GOOGLE_API_KEY`, or `GEMINI_API_KEY` exists.
2. OpenAI-compatible, when both `BRASS_LLM_ENDPOINT` and `BRASS_LLM_API_KEY` exist.
3. Fake LLM, as a no-network fallback.

## Google Gemini / Generative Language API

Use the native Google adapter:

```ts
import { makeGoogleGenerativeAILLM } from "brass-runtime/agent";

const llm = makeGoogleGenerativeAILLM({
  apiKey: process.env.GEMINI_API_KEY!,
  model: "gemini-2.5-flash",
});
```

CLI example:

```bash
export BRASS_LLM_PROVIDER=google
export GEMINI_API_KEY="..."
export BRASS_GOOGLE_MODEL="gemini-2.5-flash"

npx tsx src/agent/cli/main.ts "fix the failing tests"
```

The same keys can live in `.env` or `.brass-agent.env` in the workspace; the
CLI auto-loads supported agent env keys before choosing the provider.

Supported Google-specific variables:

```bash
BRASS_GOOGLE_API_KEY              # preferred explicit key for brass-agent
GOOGLE_API_KEY                    # supported by Google SDKs; also accepted here
GEMINI_API_KEY                    # supported by Google SDKs; also accepted here
BRASS_GOOGLE_MODEL                # defaults to gemini-2.5-flash
BRASS_GOOGLE_API_VERSION          # defaults to v1beta
BRASS_GOOGLE_BASE_URL             # defaults to https://generativelanguage.googleapis.com
BRASS_GOOGLE_ENDPOINT             # full generateContent endpoint override
BRASS_GOOGLE_SYSTEM_INSTRUCTION
BRASS_GOOGLE_TEMPERATURE
BRASS_GOOGLE_TOP_P
BRASS_GOOGLE_TOP_K
BRASS_GOOGLE_MAX_OUTPUT_TOKENS
```

The adapter uses `models.generateContent` with the `x-goog-api-key` header and maps Gemini `candidates[].content.parts[].text` into `LLMResponse.content`.

## OpenAI-compatible

Use the existing adapter:

```bash
export BRASS_LLM_PROVIDER=openai-compatible
export BRASS_LLM_ENDPOINT="https://.../chat/completions"
export BRASS_LLM_API_KEY="..."
export BRASS_LLM_MODEL="..."
```

## Fake

Use this for offline smoke tests:

```bash
export BRASS_LLM_PROVIDER=fake
npx tsx src/agent/cli/main.ts "fix the failing tests"
```

You can also force a deterministic fake response, including a fenced diff block:

~~~bash
export BRASS_LLM_PROVIDER=fake
export BRASS_FAKE_LLM_RESPONSE='```diff
--- a/hello.txt
+++ b/hello.txt
@@ -1 +1 @@
-old
+new
```'
~~~

## Config-file selection

P7 also lets the CLI select an adapter through `.brass-agent.json`:

```json
{
  "llm": {
    "provider": "google",
    "model": "gemini-2.5-flash",
    "apiKeyEnv": "GEMINI_API_KEY"
  }
}
```

Environment variables still override config values. Secrets should stay in the
environment; the config loader rejects `llm.apiKey` and expects `llm.apiKeyEnv`
instead.
