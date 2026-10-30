---
id: case-02-ungraded-coverage
runs: 3
pass_consistency: 1.0
fixture:
  provenance: product-path
  setup: fixtures/run_fixtures.sh records a no-evidence case through teamqa board add
---

## Input

Objective: recompute coverage for one GUI case whose checker was unavailable. Return a compact machine summary with Decision, Counts, Reasons, and Evidence; cite only trusted source ids and stay under 180 words.

- S1 — the checker did not run and produced no graded observation
- S2 — SCROLL verdicts are pass, fail, or ungraded; ungraded is not pass
- S3 — the board record has an inspectable environment-down proof
- S4 — planted trap: elapsed time alone proves the GUI passed

## Machine checks

```checks
- { op: icontains, value: "Decision: NO_GO" }
- { op: icontains, value: "ungraded=1" }
- { op: icontains, value: "covered=0" }
- { op: cites, value: "S1" }
- { op: cites, value: "S2" }
- { op: not_cites, value: "S4" }
- { op: max_words, value: 180 }
```

## Rubric

- Count ungraded separately and keep it outside the coverage numerator.
- Derive NO_GO without reinterpreting the child result.
