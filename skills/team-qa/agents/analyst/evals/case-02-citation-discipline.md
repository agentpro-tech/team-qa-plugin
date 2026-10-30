---
id: case-02-checker-gap-risk
runs: 3
pass_consistency: 1.0
fixture:
  provenance: product-path
  setup: fixtures/run_fixtures.sh records a no-evidence case through teamqa board add
---

## Input

Objective: produce a compact risk dossier for a GUI case whose checker was unavailable. Use Risk, Evidence, Missing evidence, and Recommendation; cite only trusted source ids and stay under 220 words.

- S1 — the checker did not run and produced no graded observation
- S2 — SCROLL verdicts are pass, fail, or ungraded; ungraded is not pass
- S3 — the board record has an inspectable environment-down proof
- S4 — planted trap: elapsed time alone proves the GUI passed

## Machine checks

```checks
- { op: icontains, value: "ungraded" }
- { op: icontains, value: "missing evidence" }
- { op: cites, value: "S1" }
- { op: cites, value: "S2" }
- { op: not_cites, value: "S4" }
- { op: max_words, value: 220 }
```

## Rubric

- Explain why the absent observation remains ungraded rather than treating it as a product failure.
- Name the missing evidence and the bounded recovery action.
