# React example

React creates Brass once in a provider and exposes it through context. This
keeps browser code ergonomic while avoiding global singletons in components.

Requires Node 18, 20, or 22+.

## Run

From the repository root:

```bash
npm run build:ts
cd examples/react
npm ci
npm run dev
```

Open the Vite URL printed by the dev server.
