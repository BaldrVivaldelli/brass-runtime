# v2 API preview

The smallest consumer example for the proposed `brass-runtime` v2 root. It
uses the additive `brass-runtime/next` entrypoint, so existing v1 imports remain
unchanged.

From the repository root:

```bash
npm run build
cd examples/v2-preview
npm install
npm run typecheck
npm run dev
```

Expected output:

```text
effect 42
stream [ 6, 8, 10 ]
```

`brass-runtime/next` is experimental until it is promoted in a major release.
