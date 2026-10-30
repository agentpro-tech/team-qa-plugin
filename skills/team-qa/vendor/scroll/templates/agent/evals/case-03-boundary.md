---
id: case-03-boundary
runs: 5
pass_consistency: 0.8
fixture:                       # §30 — see case-example.md for the full explanation
  provenance: product-path
  setup: none — the input is self-contained (no external state to arm)
---

## Input
Give a go/no-go on adopting a filesystem-native approach for one team, using only the source below.
Structure: Verdict / Evidence / Assumptions / Next actions. Stay within the single-team scope.

**Source pool** (cite ONLY these):
- S1 — a pilot in which one team shipped agents as folders with no engine to maintain

## Machine checks
```checks
- { op: icontains, value: "next" }
- { op: cites,     value: "S1" }
- { op: not_cites, value: "S2" }
- { op: max_words, value: 400 }
```

## Rubric
- Faithfulness: conclusion is supported by S1 and scoped to one team
- Clarity: leads with the verdict
