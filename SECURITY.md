# Security Policy

The v1 core, schema, HTTP, and observability entrypoints are supported package
surfaces. `brass-runtime/next`, `brass-agent`, the CLI, native editor search,
and the VS Code extension are experimental; Agent write workflows should be
used on a Git branch with patch review enabled.

## Supported versions

| Component | Status |
| --- | --- |
| `brass-runtime` source on `main` | Supported for fixes and reports |
| Stable v1 package entrypoints | Supported on the latest published major line |
| `brass-runtime/next` | Experimental preview; supported for reports |
| `brass-agent` experimental preview | Supported for reports; not production-stable |
| Older downloaded ZIPs / local VSIX builds | Not supported |

## Dependency gates

Every pull request audits the root package, the Angular, NestJS, Next.js, and
React consumers, and the VS Code extension lockfile; a Monday schedule repeats
that audit. High or critical npm advisories fail the `audit` check. The
`examples` check installs only from committed lockfiles, builds the runtime,
and typechecks/builds every framework consumer.

Run the same checks locally with:

```bash
npm run validate:dependency-security
npm audit --package-lock-only --audit-level=high
npm audit --package-lock-only --audit-level=high --prefix examples/angular
npm audit --package-lock-only --audit-level=high --prefix examples/nestjs
npm audit --package-lock-only --audit-level=high --prefix examples/nextjs
npm audit --package-lock-only --audit-level=high --prefix examples/react
npm audit --package-lock-only --audit-level=high --prefix extensions/vscode-brass-agent
```

Dependabot tracks each lockfile weekly. Framework examples are private packages
and do not widen the Node 18 contract of the published stable runtime; their
own `engines.node` fields state the versions their current frameworks require.

## Recorded exception

On 2026-09-20, the Angular 20.3 build-tool graph reported five moderate
development-server advisories through `webpack-dev-server`/`sockjs`/`uuid`.
npm reported no fix, and the graph had zero high or critical vulnerabilities.
Do not expose the example development server to untrusted networks. The weekly
audit keeps this exception visible and it must be removed when upstream ships a
compatible fix.

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
