# @brass/engine-wasm

Optional, independently versioned WASM engine for `brass-runtime`.

Install it next to a compatible Brass runtime when strict WASM execution is
required:

```bash
npm install brass-runtime @brass/engine-wasm
```

The runtime discovers this package before its v1 embedded compatibility copy.
`engine: "wasm"` remains strict and fails if no compatible engine is available;
`engine: "auto"` records a fallback and uses TypeScript when it is absent.

This package is an alpha candidate. Its ABI is checked against the runtime
before work begins.
