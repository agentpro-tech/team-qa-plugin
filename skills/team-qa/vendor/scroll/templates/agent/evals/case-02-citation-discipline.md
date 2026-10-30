---
id: case-02-citation-discipline
runs: 5
pass_consistency: 0.8
fixture:                       # §30 — see case-example.md for the full explanation
  provenance: product-path
  setup: none — the input is self-contained (no external state to arm)
---

## Input
Summarize whether a single source of truth reduces drift across runtimes. Use a Verdict / Evidence /
Assumptions / Next actions structure and cite only the source ids provided.

**Source pool** (cite ONLY these):
- S1 — a survey reporting config drift when each runtime keeps its own copy
- S2 — a case study where one rendered source removed the drift

## Machine checks
```checks
- { op: icontains, value: "evidence" }
- { op: cites,     value: "S1" }
- { op: cites,     value: "S2" }
- { op: not_cites, value: "S6" }
- { op: min_words, value: 15 }
```

## Rubric
- Faithfulness: every claim maps to S1 or S2
- Honesty: does not invent a third source
