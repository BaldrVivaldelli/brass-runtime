# @brass/perf

Independently versioned release candidate for Brass performance tooling. This
repository does not auto-publish the package; obtain the tarball from the
`Perf` workflow or pack it locally.

```bash
npm pack ./packages/perf
npm install brass-runtime ./brass-perf-0.1.0-alpha.0.tgz
```

```ts
import { runBrassPerformanceProfile } from "@brass/perf";
```

The `brass-perf` executable is included. The package owns its ESM, CJS, CLI,
and bundled TypeScript declarations while consuming the runtime, HTTP, and
observability entrypoints from `brass-runtime` as peers. During the v1
compatibility period, its exports stay in parity with `brass-runtime/perf`. It
remains alpha while that contract is exercised in real projects.
