# Shared example helpers

This folder contains the small shared Brass setup used by the runnable
framework examples:

- `examplePolicyPresets`: named `readModel` and `command` policies.
- `makeExampleTransport`: an offline Promise transport that still receives the
  Brass-managed `AbortSignal`.
- `createExampleBrass`: direct setup for browser/client-style examples.
- `buildExampleBrass`: Layer/DI setup for server-style examples.
- `getExampleUserEffect` and `getExampleUser`: a typed HTTP workflow with
  schema validation.

The helpers intentionally avoid framework dependencies. Each framework example
imports from `../../shared/src`.

