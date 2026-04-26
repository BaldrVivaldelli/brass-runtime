# Brass Agent init

> For the end-to-end setup flow, see [Brass Agent install and configure](./agent-install-and-configure.md).

`brass-agent --init` bootstraps a workspace for local Brass Agent usage without adding CI or release automation.

It creates these files in `--cwd`:

- `.brass-agent.json` — project-local policy/config.
- `brass-agent.batch.json` — sample multi-goal workflow for `--batch-file`.
- `.env.example` — example LLM environment variables; real secrets must stay outside git.
- `BRASS_AGENT.md` — short local usage note for the repository.

The command never writes real secrets and does not overwrite existing files unless `--force` or `--init-force` is passed.

## Basic usage

```bash
brass-agent --init
brass-agent --doctor
```

For development from the repository:

```bash
npm run agent:init
npm run agent:init:dry-run
```

Initialize a different workspace:

```bash
brass-agent --init --cwd ../my-project
```

Preview without writing:

```bash
brass-agent --init --init-dry-run
```

Overwrite previously generated files:

```bash
brass-agent --init --force
```

## Profiles

`--init-profile` selects how much LLM config is written.

```bash
brass-agent --init --init-profile default
brass-agent --init --init-profile google
brass-agent --init --init-profile openai-compatible
brass-agent --init --init-profile fake
```

Profiles:

- `default` leaves `config.llm` unset, so the CLI keeps its normal provider auto-detection and can fall back to fake mode.
- `google` writes Gemini config using `GEMINI_API_KEY` and `gemini-2.5-flash`.
- `openai-compatible` writes `/chat/completions` config using `BRASS_LLM_API_KEY` and `BRASS_LLM_ENDPOINT`.
- `fake` writes an offline fake provider config for smoke tests.

`--init-provider` is an alias for provider-oriented profiles:

```bash
brass-agent --init --init-provider google
brass-agent --init --init-provider auto
```

`auto` maps to the `default` profile.

## Generated config shape

The generated `.brass-agent.json` is intentionally conservative:

- default mode is `propose`;
- approval mode is `auto`;
- patch apply requires approval;
- redaction is enabled;
- context discovery excludes `.env*`, private keys, `node_modules`, build outputs, and `secrets/**`;
- rollback safety is enabled for generated patches;
- shell permissions inherit the built-in validation allowlist and explicitly deny dangerous commands like `rm *`, `git push *`, `git reset *`, and `git clean *`.

The initializer also inspects `package.json` when present:

- package manager is inferred from `packageManager` or lockfiles;
- `includeTypecheck` is enabled only when common typecheck scripts exist;
- `includeLint` is enabled only when common lint scripts exist;
- the sample batch file includes only presets that make sense for the scripts it finds.

## Recommended flow

```bash
brass-agent --init
brass-agent --doctor
brass-agent --preset inspect
brass-agent --batch-file brass-agent.batch.json
```

For VS Code, run the local installer after init:

```bash
npm run agent:vscode:install
```

or install the `.vsix` manually from `extensions/vscode-brass-agent`.
