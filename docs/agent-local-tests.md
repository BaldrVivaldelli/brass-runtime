# Brass Agent local tests

P36 adds local smoke-test scripts for dogfooding without CI.

These tests are intentionally local-first. They do not publish artifacts, do not require a real LLM provider, and do not need GitHub Actions.

## Smoke test

Build first, then run:

```bash
npm run agent:test:smoke
```

Or run the full local flow:

```bash
npm run agent:test:local
```

`agent:test:local` runs:

```txt
npm run build
node scripts/agent-local-smoke.mjs
```

## What the smoke test validates

The smoke test creates a temporary project and checks:

```txt
- the built CLI exists
- read-only inspect can finish with fake LLM
- apply mode can use fake LLM diff output
- patch preview/apply plumbing can update a file through the CLI
- validation can pass after the patch
```

It uses:

```txt
BRASS_LLM_PROVIDER=fake
BRASS_FAKE_LLM_RESPONSE=<controlled unified diff>
```

No real API key is required.

## Why no CI yet

This is a local stabilization step only. CI and release automation remain intentionally deferred until the agent UX has been dogfooded more heavily.
