# Private adopter inventory

Downloads and code search are discovery signals, not adopters. Keep real
observations in Git-ignored `.brass-private/adopters.json`; never store secrets,
raw production payloads, or unredacted traces.

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

Validate and aggregate locally without emitting identity, owner, or evidence
references:

```bash
BRASS_ADOPTION_REPORT_PATH=.brass-private/adoption-report.json npm run adoption:report
```

It derives 30/90-day activity from observation dates, rejects stale flags, and
reports version distribution plus median upgrade lag. Only `publishable`
consent permits naming or committing a workload. Use the **Brass adoption
report** issue form for public data and private handoff for restricted evidence;
never infer retention from downloads.
