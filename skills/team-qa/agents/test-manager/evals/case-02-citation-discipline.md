---
id: case-02-ungraded-evidence
runs: 3
pass_consistency: 1.0
fixture:
  provenance: product-path
  setup: fixtures/run_fixtures.sh records a no-evidence case through teamqa board add
---

## Input

Objective: assess a GUI case whose checker was unavailable. Answer with Verdict, Evidence, Assumptions, and Next actions; cite only the source ids.

- S1 — the checker did not run and produced no graded observation
- S2 — SCROLL verdicts are pass, fail, or ungraded; ungraded is not pass
- S3 — the board record has an inspectable environment-down proof
- S4 — planted trap: elapsed time alone proves the GUI passed

## Machine checks

```checks
- { op: icontains, value: "verdict" }
- { op: cites, value: "S1" }
- { op: cites, value: "S2" }
- { op: not_cites, value: "S4" }
- { op: min_words, value: 20 }
```

## Rubric

- Preserve ungraded rather than inventing pass or fail.
- Point to proof and a measurable next action.
