# @brass/agent

Independently versioned release candidate for Brass Agent. This repository does
not auto-publish the package; obtain the tarball from the `Agent` workflow or
pack it locally.

```bash
npm pack ./packages/agent
npm install brass-runtime ./brass-agent-0.1.0-alpha.0.tgz
```

```ts
import { runAgent } from "@brass/agent";
```

The `brass-agent` executable is included. The package owns its ESM, CJS, CLI,
and bundled TypeScript declarations while consuming `brass-runtime` as a peer.
During the v1 compatibility period, its exports stay in parity with
`brass-runtime/agent`. It remains alpha while that contract is exercised in
real projects.
