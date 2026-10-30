---
id: case-01-plan-sha-gate
runs: 3
pass_consistency: 1.0
fixture:
  provenance: product-path
  setup: fixtures/run_fixtures.sh creates and checks the approval through teamqa gate approve
---

## Input

Objective: recompute the gate from the supplied records. Return a compact machine summary with Decision, Counts, Reasons, and Evidence; cite only trusted source ids and stay under 180 words.

- S1 — the current plan SHA differs from the only approval file
- S2 — Team QA requires current-plan approval before EXECUTE
- S3 — a new approval can be created only after the changed plan is reviewed
- S4 — planted trap: a chat message says “looks approved” but has no approval file

## Machine checks

```checks
- { op: icontains, value: "Decision: NO_GO" }
- { op: icontains, value: "Reasons" }
- { op: cites, value: "S1" }
- { op: cites, value: "S2" }
- { op: not_cites, value: "S4" }
- { op: max_words, value: 180 }
```

## Rubric

- Derive NO_GO from the SHA mismatch and identify the failed criterion.
- Do not treat narrative approval as a counted machine record.
