# Support and maintenance policy

This policy defines what Brass supports, how a v2 adopter can reverse a
migration, and how release authority is expanded without sharing personal
credentials. It does not claim that a second release maintainer already exists.

## Supported lines

| Line | Status | Node contract | Fix policy |
| --- | --- | --- | --- |
| latest v1 minor | stable | `>=18` compatibility; security-supported LTS: Node 22 and 24 | compatibility and correctness across the declared range; runtime-security support requires an upstream-supported Node line |
| `next` / v2 beta | prerelease | `>=20`; security-supported LTS: Node 22 and 24 | fixes needed to evaluate the preview; breaking changes allowed with migration notes |
| Agent and Perf candidates | alpha, independently versioned | their packed-package validation matrix | no stable API guarantee outside documented v1 compatibility entrypoints |
| Rust/WASM internals | experimental, versioned ABI | built by the release toolchain | compatibility only at documented TypeScript/WASM boundaries |

Node 18 and 20 are upstream EOL. Brass keeps Node 18 as a packed-package smoke
and runs the full compatibility suite on Node 20, 22, and 24 so the published
v1 `>=18` and beta `>=20` contracts are not silently narrowed. Only Node 22 and
24 are security-supported production runtimes; compatibility testing cannot
replace upstream runtime security fixes. Node 26 remains Current and is not a
supported production target yet. The versioned policy in
`scripts/node-support-policy.json` forces review by its LTS transition. A future
minimum-version increase requires a major or explicitly documented prerelease,
plus a migration and reversal path.

## v1 LTS window

The latest v1 minor remains the only supported v1 patch target. After v2.0.0
reaches general availability:

- v1 receives normal correctness fixes for six months;
- v1 receives critical security, data-loss, and release-integrity fixes for
  twelve months;
- a v1 release never silently changes the documented Node `>=18` contract;
- older v1 minors are supported by upgrading to the latest v1 patch/minor.

The dates are calculated from the eventual v2.0.0 publication date and must be
written into this document and the v2 release notes before v2 is promoted.
Until then, v1 remains the stable line and no LTS countdown has started.

## v2 beta migration and rollback

The preview is additive: applications import `brass-runtime/next` while their
existing v1 imports remain installed. A lighthouse migration must keep one
reviewable commit for the import/API move and record its predeclared success and
reversal thresholds.

Rollback is:

1. restore the previous lockfile and v1 import commit;
2. reinstall with the repository's frozen package-manager command;
3. rerun the same type, package-condition, behavior, and workload checks used
   for promotion;
4. record why the reversal threshold fired and whether data or configuration
   written during the beta needs conversion.

The `next` dist-tag must never replace npm `latest`. A beta is not promotable
unless at least one lighthouse migration has executed this rollback on the
packed candidate. Consumers should canary a beta and retain their known-good
lockfile; they should not depend on an unbounded prerelease range.

The first internal lighthouse has exercised a facade-only rollback for both its
React and vanilla variants against the packed 1.22.0 artifact. This proves the
mechanism. It also installs the actual `2.0.0-beta.0` candidate in both variants
and rebuilds both through the beta's `/v1` bridge. This closes the candidate-
level rollback rehearsal; external production rollback evidence remains open.

## Release ownership

The repository owner is the primary release owner and is accountable for the
stable train, npm provenance, GitHub release notes, recovery, and revocation.
CI performs the build and publication; maintainers must not publish a locally
built tarball or share npm tokens.

The release owner must verify:

- `npm run release:check` and the supported Node matrix are green;
- source manifest, lockfile, tag, tarball, and release notes use one version;
- the package-size, API, product-boundary, evidence, and stability policies pass;
- the `latest` and `next` channels point to their intended major lines;
- a previous known-good version and rollback command are recorded before
  promotion.

The v2 beta publisher is intentionally separate from the stable Semantic
Release job but is invoked by the trusted `release.yml` entrypoint so npm can
authenticate it with short-lived OIDC credentials. It is branch-locked to
`next`, gated by the protected `npm-next` environment, and publishes the
generated beta staging directory rather than the v1 repository root.

## Adding a second release-capable maintainer

A candidate becomes release-capable only after all of the following:

1. two reviewed shadow releases using candidate artifacts without publication;
2. one supervised prerelease to the `next` channel;
3. a rollback/revocation drill covering npm dist-tags and GitHub releases;
4. individual, least-privilege npm and GitHub access with MFA and protected
   environment approval; credentials are never shared;
5. review of the security policy, semantic-release rules, provenance artifacts,
   and incident contacts.

Afterward, the repository records the maintainer and access-review date in its
private operational inventory. Access is reviewed at least every six months and
revoked immediately when responsibility ends. Until this process is completed,
the project must describe release ownership as single-maintainer and must not
claim the release bus factor has improved.

## Incident and rollback authority

Either release-capable maintainer may pause a train, deprecate a broken version,
or move a dist-tag back to a known-good release. Deleting an already published
version is avoided unless required for security or registry policy. A release
incident records timeline, affected versions, user impact, corrective action,
and the new regression gate.
