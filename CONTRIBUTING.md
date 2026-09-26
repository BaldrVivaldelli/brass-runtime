# Contributing

Start with `AGENTS.md`, then run:

```bash
npm ci
npm run validate:boundaries
npm run test:types
npm test
```

Changes to package exports or public types also require:

```bash
npm run build
npm run validate:api
npm run validate:cjs
npm run validate:browser
npm run validate:package
npm run validate:products
```

Do not update `docs/ai/api-contract.v1.json` merely to make CI green. Review
the generated declaration change and its semantic-versioning impact first,
then use `npm run api:contract:update` for an intentional change.

New APIs belong in the narrowest domain. The v1 root and `/core` export sets
are frozen; proposed next-major root concepts belong in `/next`. Architecture
decisions use the template and precedent under `docs/adr/`.

Agent, Perf, and the VS Code extension have independent CI workflows. Use the
smallest matching lane while iterating:

```bash
npm run test:types:agent && npm run test:agent
npm run test:types:perf && npm run test:perf
```

Changes under `packages/agent` or `packages/perf` must preserve parity with
their v1 public export and type contract until a major-version migration
explicitly ends that contract. Runtime object identity is not required: each
candidate owns its executable bundle and consumes `brass-runtime` as a peer.

Bug reports should include a minimal reproduction, Node version, engine mode,
and whether cancellation, scopes, HTTP middleware, or WASM are involved.

Real adopters can use the **Brass adoption report** issue form to share a
workload, migration gap, or redacted operational result with an explicit
consent level. Never post secrets, proprietary payloads, or private traces.
