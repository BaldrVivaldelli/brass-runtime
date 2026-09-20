# Express example

Express wires Brass once at startup and uses an inbound request observability
context per route. The HTTP client uses the shared fake transport so the example
runs offline while still exercising policy, schema validation, metrics, and
trace propagation.

## Run

From the repository root:

```bash
npm run build:ts
cd examples/express
npm install
npm run dev
```

Try:

```bash
curl http://localhost:3000/users/42
curl http://localhost:3000/metrics
```

The release-candidate lighthouse check stages this example, type-checks it,
executes the user, health, and metrics routes, and sends `SIGTERM` to verify
graceful shutdown:

```bash
npm run validate:example:express -- --runtime-tarball /path/to/brass-runtime.tgz
```

Omit `--runtime-tarball` to pack and validate the current built worktree.
