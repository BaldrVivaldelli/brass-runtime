# Brass Agent

This workspace was initialized with `brass-agent --init`.

Generated files:

- `.brass-agent.json` — local policy/config for Brass Agent.
- `brass-agent.batch.json` — sample multi-goal batch workflow.
- `.env.example` — example environment variables. Keep real secrets out of git.

Recommended first commands:

```bash
brass-agent --doctor
brass-agent --preset inspect
brass-agent --batch-file brass-agent.batch.json
```

Apply mode is intentionally approval-gated:

```bash
brass-agent --apply "fix the failing tests"
```
