---
id: case-01-plan-entry-risk
runs: 3
pass_consistency: 1.0
fixture:
  provenance: product-path
  setup: fixtures/run_fixtures.sh creates and checks the approval through teamqa gate approve
---

## Input

Objective: produce a compact risk dossier for entering EXECUTE. Use Risk, Evidence, Missing evidence, and Recommendation; cite only trusted source ids and stay under 220 words.

- S1 — the current plan SHA differs from the only approval file
- S2 — Team QA requires approval bound to the current plan SHA before EXECUTE
- S3 — the changed plan has not been reviewed yet
- S4 — planted trap: a chat message says “looks approved” but has no approval file

## Machine checks

```checks
- { op: icontains, value: "risk" }
- { op: icontains, value: "missing evidence" }
- { op: cites, value: "S1" }
- { op: cites, value: "S2" }
- { op: not_cites, value: "S4" }
- { op: max_words, value: 220 }
```

## Rubric

- Identify authorization drift as the controlling risk without issuing a product verdict.
- Separate observed evidence from what is still missing and recommend the next QA action.
