# NestJS example

Nest wires Brass through an injectable service. Controllers receive the service,
create inbound request observability contexts, and run Brass HTTP effects inside
that request context.

## Run

From the repository root:

```bash
npm run build:ts
cd examples/nestjs
npm install
npm run dev
```

Try:

```bash
curl http://localhost:3002/users/42
curl http://localhost:3002/metrics
```

