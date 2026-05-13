# Vanilla example

Plain TypeScript wiring with no framework lifecycle. This is the smallest
example for Brass Layer/DI, HTTP policy presets, observability, and shutdown.

## Run

From the repository root:

```bash
npm run build:ts
cd examples/vanilla
npm install
npm run dev
```

Expected output includes the fake upstream user, HTTP stats, and a small
Prometheus metrics preview.

