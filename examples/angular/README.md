# Angular example

Angular exposes Brass through `InjectionToken` providers. Components inject the
same Brass object and can call typed HTTP workflows without owning transport or
observability setup.

## Run

From the repository root:

```bash
npm run build:ts
cd examples/angular
npm install
npm run dev
```

Open:

```txt
http://localhost:4200
```

