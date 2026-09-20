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

| Surface | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Whole repository | 80% | 65% | 80% | 80% |
| Stable core | 94% | 85% | 95% | 95% |
| Stable HTTP | 88% | 82% | 90% | 91% |
| Stable schema | 88% | 75% | 85% | 90% |
| Stable observability | 75% | 63% | 80% | 78% |

The repository-wide floor includes experimental Agent and Perf code, while the
four path-scoped floors prevent that experimental surface from masking a
regression in a stable product. Focused module tests and the exact public-API
snapshot catch more local regressions while allowing deliberately thin
platform adapters and command-line entry points. Do not exclude executable code
to make the number look better. Prefer focused tests for uncovered behavior,
then raise the relevant floor.
