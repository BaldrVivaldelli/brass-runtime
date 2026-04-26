# Brass Agent follow-up context

Brass Agent chat keeps a lightweight memory of the last run so the user can ask follow-up questions such as:

```text
why did that fail?
try again but keep the public API unchanged
explain the last patch
```

Follow-up context is intentionally gated. Slash commands such as `/inspect`, `/fix-tests`, `/typecheck`, and `/lint` start from a clean request instead of automatically embedding the previous run summary. This prevents a repeated `/inspect` from re-sending an old inspection summary as if it were the current request.

The chat only includes previous run context when one of these is true:

- the command explicitly asks for previous context, such as `/explain-last` or patch actions;
- the prompt looks like a follow-up, for example “why did that fail?” or “try again”;
- the caller explicitly forces context for a specific integration flow.

When context is included, the extension compactly sends:

- previous goal;
- previous mode/status;
- a truncated previous summary;
- a truncated error or validation output;
- patch stats, and optionally the last patch diff when requested.

This keeps model prompts smaller and avoids polluting context discovery with generic words from previous summaries.

## LLM errors

If the model call fails, Brass Agent now surfaces the underlying provider message when available. Instead of only showing:

```text
Agent stopped with LLMError.
```

it reports a more actionable summary such as:

```text
Agent stopped because the model call failed: Google Gemini request failed with 429: ...
```

Secrets are still passed through the agent redaction layer before appearing in summaries.
