# Brass Agent presets

P20 adds built-in DX presets for common developer workflows.

```bash
brass-agent --preset fix-tests
brass-agent --preset inspect
brass-agent --preset typecheck
brass-agent --preset lint
```

A preset only supplies a default goal and, for `inspect`, defaults to `read-only` when no `--mode` was explicitly provided. Explicit goal text and flags still win.

VS Code also exposes preset commands:

```txt
Brass Agent: Fix Tests
Brass Agent: Typecheck
Brass Agent: Lint
```

The VS Code commands still use the preview-first flow: generate patch proposal, show Webview, then apply the exact reviewed patch through `brass-agent`.
