# Angular example

Angular exposes Brass through `InjectionToken` providers. Components inject the
same Brass object and can call typed HTTP workflows without owning transport or
observability setup.

Requires Node `^20.19.0` or `>=22.12.0`.

## Run

From the repository root:

```bash
npm run build:ts
cd examples/angular
npm ci
npm run dev
```

Open:

```txt
http://localhost:4200
```
