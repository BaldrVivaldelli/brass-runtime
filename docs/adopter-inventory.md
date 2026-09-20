# Private adopter inventory

Package downloads and public code search are discovery signals, not adopter
records. Real adoption tracking lives in `.brass-private/adopters.json`, which
is ignored by Git and must not contain credentials, raw production payloads, or
unredacted traces.

Start from this shape:

```json
{
  "schemaVersion": 1,
  "updatedAt": "<ISO timestamp>",
  "adopters": [
    {
      "id": "adopter-001",
      "identityReference": "<private CRM/contact reference>",
      "owner": "<responsible maintainer>",
      "workload": "<runtime, HTTP, observability, or shutdown>",
      "brassVersion": "<exact version>",
      "entrypoints": ["brass-runtime/http"],
      "deploymentStage": "evaluation|staging|canary|production",
      "firstVerifiedAt": "<ISO timestamp>",
      "lastVerifiedAt": "<ISO timestamp>",
      "upgradeLagDays": 0,
      "active30Days": true,
      "active90Days": true,
      "consent": "not-requested|denied|internal-only|publishable",
      "evidenceReference": "<redacted artifact or migration record>",
      "nextReviewAt": "<ISO timestamp>"
    }
  ]
}
```

Only `publishable` consent permits naming the adopter or committing its
workload data. Aggregate retention and upgrade-lag metrics require current
`lastVerifiedAt` observations; do not derive them from npm download counts.

For public projects, use the repository's **Brass adoption report** issue form.
It records the exact version, deployment stage, surfaces, workload, evidence,
migration gaps, and one of three explicit consent levels. Public issues are not
a substitute for private handoff when evidence contains restricted data.
