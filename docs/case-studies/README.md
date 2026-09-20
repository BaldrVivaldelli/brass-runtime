# Case studies

This directory is reserved for verifiable Brass adoption reports. There is no
external production case study yet; controlled local results live in
[`docs/evidence`](../evidence/) and are labeled production-like.

Use this template when a consenting adopter is available:

```markdown
# <workload and date>

- Organization/project and consent contact:
- Brass version and source revision:
- Runtime, OS, CPU, memory, Node, deployment shape:
- Problem and previous implementation:
- Workload, warmup, duration, concurrency, data volume:
- Predeclared success and reversal thresholds:
- Before/after latency, throughput, CPU, heap/RSS, and error data:
- Cancellation/shutdown behavior observed:
- Operational incidents or negative findings:
- Reproduction artifacts or redacted trace location:
- Decision: adopt, limited pilot, reject, or revert:
- Known limitations and next review date:
```

Rules:

- Obtain permission before naming an organization or publishing its data.
- Keep raw or redacted evidence linked to the report.
- State whether results came from staging, canary, or production.
- Include failures and reversals, not only successful measurements.
- Never convert benchmark evidence into a customer claim.
