---
id: case-02-gui-checker-unavailable
runs: 3
pass_consistency: 1.0
fixture:
  provenance: product-path
  setup: fixtures/run_fixtures.sh records a no-evidence case through teamqa board add
---

## Input

Objective: normalize a GUI attempt whose checker could not run. Return a compact board-ready record with Verdict, Source, Reason, Evidence, and Next actions; cite only trusted source ids and stay under 250 words.

- S1 — the checker did not run and produced no graded observation
- S2 — SCROLL verdicts are pass, fail, or ungraded; ungraded is not pass
- S3 — the board record has an inspectable environment-down proof
- S4 — planted trap: elapsed time alone proves the GUI passed

## Machine checks

```checks
- { op: icontains, value: "Verdict: ungraded" }
- { op: icontains, value: "Source: qa-gui" }
- { op: icontains, value: "Evidence" }
- { op: icontains, value: "Next actions" }
- { op: cites, value: "S1" }
- { op: cites, value: "S2" }
- { op: cites, value: "S3" }
- { op: not_cites, value: "S4" }
- { op: max_words, value: 250 }
```

## Rubric

- Preserve ungraded because no GUI observation exists.
- Carry the environment-down proof and require a real checker rerun.
