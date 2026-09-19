# Coverage

Coverage is measured with Vitest and the V8 provider.

## Commands

```bash
npm run test:coverage:report
```

Builds the text, HTML, JSON, JSON summary, and LCOV reports without enforcing
thresholds. Open `coverage/index.html` for the browsable report.

```bash
npm run test:coverage
```

Runs the same report with the current honest baseline gate. This should pass in
normal development and should only move upward when new tests improve real
coverage.

The baseline gate covers the repository's shipped executable source, including
the agent and schema packages: 80% statements, 65% branches, 80% functions,
and 80% lines. Pure re-export barrels and type-only compile checks are excluded
because V8 reports them as 0% despite having no runtime behavior to exercise.

```bash
npm run test:coverage:100
```

Runs the strict target gate: 100% statements, branches, functions, and lines per
file. This is intentionally separate until the uncovered modules have tests.

## Current Baseline

The baseline thresholds are:

| Metric | Minimum |
| --- | ---: |
| Statements | 80% |
| Branches | 65% |
| Functions | 80% |
| Lines | 80% |

These are whole-repository thresholds rather than per-file thresholds. Focused
module tests and the exact public-API snapshot catch local regressions while
allowing deliberately thin platform adapters and command-line entry points.
Do not exclude executable code to make the number look better. Prefer focused
tests for uncovered behavior, then raise the baseline.
