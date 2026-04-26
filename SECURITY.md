# Security Policy

`brass-runtime` is an experimental TypeScript effect runtime. `brass-agent`, the
CLI and VS Code extension built on top of it, is also experimental and should be
used on a Git branch with patch review enabled.

## Supported versions

| Component | Status |
| --- | --- |
| `brass-runtime` source on `main` | Supported for fixes and reports |
| `brass-agent` experimental preview | Supported for reports; not production-stable |
| Older downloaded ZIPs / local VSIX builds | Not supported |

## Reporting vulnerabilities

Please do **not** put secrets, API keys, tokens, private repository contents, or
exploit details in a public issue.

For now, report security issues directly to the maintainer. If a private GitHub
security advisory channel is available for the repository, prefer that. Include:

- affected component (`runtime`, `agent CLI`, or `VS Code extension`),
- reproduction steps,
- expected impact,
- relevant logs with secrets redacted.

## Secrets and model keys

- Do not commit `.env`, `.brass-agent.env`, provider API keys, or tokens.
- The VS Code extension stores model keys in VS Code Secret Storage.
- Workspace config files such as `.brass-agent.json` should reference API key
  environment variable names, not raw secret values.
- `brass-agent` includes redaction and context exclusion helpers, but users must
  still review prompts, run artifacts, and patches before sharing them.

## Agent safety model

`brass-agent` is designed to route work through explicit boundaries:

```txt
AgentAction
  -> PermissionService
  -> ApprovalService when required
  -> ToolPolicy timeout/retry
  -> Async tool effect
  -> Observation
```

The agent should not bypass approval for patch application, rollback, or shell
commands outside the configured allowlist. If you find a bypass, report it as a
security issue.
