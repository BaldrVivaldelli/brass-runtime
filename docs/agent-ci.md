# Brass Agent CI mode

P19 adds explicit CI-oriented exit codes.

```bash
brass-agent --ci --json "fix the failing tests"
```

Exit codes:

```txt
0  run completed and latest validation command passed
1  agent error or latest validation command failed
2  patch was proposed but not applied, when --fail-on-patch-proposed is set
```

`--ci` does not force an output format. Combine it with `--json`, `--events-json`, or `--protocol-json` depending on the consumer.
