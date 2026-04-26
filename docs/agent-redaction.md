# Brass Agent redaction

P16 adds a prompt-safety redaction pass. The agent redacts likely secrets before building LLM prompts and before summaries derived from LLM observations.

Default redaction covers common token shapes such as API keys, bearer tokens, GitHub tokens, Slack tokens, JWTs, and `key=value`-style secrets.

Project config:

```json
{
  "redaction": {
    "enabled": true,
    "additionalPatterns": ["ACME_[A-Z0-9]{24}"]
  }
}
```

Set `enabled` to `false` only in tightly controlled local debugging sessions.
