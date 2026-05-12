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

The baseline gate is per executable file: 90% statements, 90% functions, and
90% lines. Pure re-export barrels and type-only compile checks are excluded
from the coverage gate because V8 reports them as 0% despite having no runtime
behavior to exercise.

```bash
npm run test:coverage:100
```

Runs the strict target gate: 100% statements, branches, functions, and lines per
file. This is intentionally separate until the uncovered modules have tests.

## Current Baseline

The current full-report baseline is:

| Metric | Coverage |
| --- | ---: |
| Statements | 95.06% |
| Branches | 86.98% |
| Functions | 97.31% |
| Lines | 97.10% |

Do not raise or exclude coverage to make the number look better. Prefer focused
tests for uncovered behavior, then raise the baseline.
