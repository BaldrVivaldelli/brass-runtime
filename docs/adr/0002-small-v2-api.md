# ADR 0002: Small additive v2 API preview

- Status: Accepted
- Date: 2026-09-19

## Context

The v1 package root exposes 323 runtime values and `/core` exposes 213. Exact
snapshots protect compatibility, but the number of public names makes the API
hard to learn and turns implementation details into long-term commitments.

Removing exports in v1 would break consumers. Merely documenting a smaller
subset would not prove that the subset builds, typechecks, or works through the
published package conditions.

## Decision

Add `brass-runtime/next` as an experimental, additive preview with at most 40
runtime values. Start with 18 values organized around `Effect`, `Resource`,
`Layer`, `Schedule`, `Stream`, and `Pipeline` namespaces plus execution and
diagnostic concepts.

Freeze the v1 root and `/core` export sets. Validate all generated declaration
entrypoints by fingerprint in CI. Keep existing imports supported until a major
release can promote the preview and publish a complete migration guide.

## Consequences

- Consumers can evaluate the smaller API without a breaking release.
- The repository temporarily maintains a compatibility surface and a preview.
- New root-level capabilities require deliberate placement instead of another
  wildcard export.
- Declaration changes become explicit review events.
- Agent, Perf, and editor tooling remain outside the proposed v2 root and move
  toward independent release surfaces.
