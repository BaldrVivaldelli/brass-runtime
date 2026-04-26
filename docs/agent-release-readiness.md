# Agent release readiness

The current Brass Agent work is suitable for an experimental branch or alpha
release. It is not yet a stable release candidate. CI/release automation is intentionally deferred until the end; local install and doctor commands are the current readiness path.

## Good enough to publish to a repo

The code is organized around stable boundaries:

```txt
src/core
  ↑
src/agent
  ↑
brass-agent CLI protocol
  ↑
VS Code extension
```

It is reasonable to push it to a repository as an experimental feature branch,
for example:

```txt
feat/brass-agent-alpha
```

or tag it as:

```txt
0.1.0-alpha.0
```


## GitHub source checklist

Before the first public push, keep the repository source-first:

- commit `.gitignore`, `README.md`, `SECURITY.md`, docs, `src/`, `scripts/`, and extension source,
- do not commit `node_modules/`, root `dist/`, extension `out/`, extension `bundled/`, or generated `.vsix` files,
- keep real secrets out of `.env`; commit only `.env.example`,
- package VSIX artifacts from a release process or local packaging command, not from source control,
- use an explicit preview version such as `0.1.0-alpha.0` for the VS Code extension.

## Stable release checklist

Before calling it stable, the project should have:

- boring local install via `npm run agent:vscode:install`
- clean local diagnostics via `npm run agent:doctor`
- clean, repeatable `npm ci && npm run build` in CI, added later
- unit tests for `src/agent/core` decisions, patch extraction, rollback, config,
  redaction, batch parsing, and CI exit codes
- integration tests for CLI flows with fake LLM and temporary git workspaces
- extension compile/package CI for `extensions/vscode-brass-agent`
- `.vsix` artifact generation in GitHub Releases
- documented security model for command allowlists, approvals, redaction,
  context exclusions, patch storage, and rollback
- config schema validation with helpful errors
- a public compatibility statement for Node.js, VS Code, package managers, and
  model providers
- a release workflow for runtime package, CLI, and VS Code extension versioning
- marketplace readiness only after local `.vsix` installs are boring and reliable

## Recommended versioning

Suggested path:

```txt
0.1.0-alpha.0  internal alpha / local VSIX
0.1.0-alpha.1  dogfood in real repos
0.1.0-beta.0   CI + tests + release artifacts
0.1.0          first stable CLI + VSIX release
```

Stable should mean the tool fails safely, can be installed repeatedly, has docs
for the happy path and recovery path, and has tests covering the risky flows.
