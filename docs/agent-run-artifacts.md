# Brass Agent run artifacts

P18 adds a small persistence surface for local DX and CI debugging.

```bash
brass-agent --save-run .brass-agent/runs "fix the failing tests"
```

The CLI writes two files:

```txt
.brass-agent/runs/<run-id>-<goal>.json
.brass-agent/runs/<run-id>-<goal>.md
```

The JSON artifact uses the same compacted state representation used by protocol output, so large file contents, shell output, and patches are bounded unless a future trusted mode opts into full payloads.
