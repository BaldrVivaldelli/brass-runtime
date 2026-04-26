# Agent context discovery

P12 adds a small context discovery pass before the first LLM planning call.
The goal is to give the model the files that are most likely connected to the
failure, instead of sending only `package.json` and validation output.

The boundary remains unchanged:

```txt
src/core
  ↑
src/agent context discovery
  ↑
src/agent/cli config loading
```

Context discovery is pure agent logic. It inspects existing observations and
chooses normal `AgentAction` values:

```txt
fs.searchText
fs.readFile
```

It does not bypass `PermissionService`, does not run shell commands directly,
and does not require changes to the runtime core.

## Flow

Before `llm.complete`, the agent now does this:

```txt
read package.json
check package-manager lockfiles
discover validation commands
run allowed validation commands
extract path and identifier signals from goal + validation output
read direct files mentioned by failures
search likely identifiers with rg through fs.searchText
read top matched files
ask LLM with command + context discovery summary
```

Examples of signals:

```txt
src/user/UserService.ts:12:3
Cannot find name AuthClient
Expected getUserById to return ...
```

From those, the agent may read `src/user/UserService.ts`, search for
`AuthClient`, and read the most relevant matches.

## Defaults

```txt
enabled: true
maxSearchQueries: 3
maxFiles: 4
maxSearchResults: 40
globs: TypeScript, JavaScript, JSON, Markdown, YAML files
```

The step budget was raised to leave room for the extra discovery work.

## Config

You can tune or disable context discovery from `.brass-agent.json`:

```json
{
  "context": {
    "enabled": true,
    "maxSearchQueries": 3,
    "maxFiles": 4,
    "maxSearchResults": 40,
    "globs": ["*.ts", "*.tsx", "*.json"]
  }
}
```

Disable it entirely:

```json
{
  "context": {
    "enabled": false
  }
}
```

Use smaller budgets for very large repositories:

```json
{
  "context": {
    "maxSearchQueries": 1,
    "maxFiles": 2
  }
}
```

## Search semantics

The Node filesystem adapter uses ripgrep in fixed-string mode:

```txt
rg --fixed-strings --line-number --no-heading --max-count 5 ...
```

This keeps generated searches safe and predictable. Query strings are derived
from simple path and identifier signals; they are not treated as regexes.

## Prompting

The planning prompt now includes a context summary alongside the project command
summary:

```txt
Project commands: ...
Context discovery: searched queries: ...
Discovered paths: ...
Read context files: ...
```

Large observations are compacted before prompting. Search results are capped in
prompt context so a broad query cannot flood the model.

## Safety

Context discovery is intentionally bounded:

```txt
- fixed number of searches
- fixed number of files read
- ignored generated/vendor directories
- workspace-relative paths only
- no direct shell execution from discovery logic
```

`fs.searchText` is still interpreted by the configured `FileSystem` service, and
`fs.readFile` still goes through the same workspace path validation used by other
agent actions.


## Excluding sensitive paths

P17 adds `context.excludeGlobs`. Excluded paths are filtered from direct error-path reads and are also passed to `rg` as negative globs.

```json
{
  "context": {
    "excludeGlobs": [".env*", "secrets/**", "*.pem", "*.key"]
  }
}
```

This is a context-discovery guard. It does not replace redaction, shell permissions, or workspace path validation.
