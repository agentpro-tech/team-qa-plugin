---
id: case-02-checker-recovery-case
runs: 3
pass_consistency: 1.0
fixture:
  provenance: product-path
  setup: fixtures/run_fixtures.sh records a no-evidence case through teamqa board add
---

## Input

Objective: design one replayable tracked-plan v2 case for recovering and rerunning a GUI checker gap. Return one compact JSON object with id, title, req_id, sourceRefs, lane, steps, expected, data, priority, kind, taxonomy, states, and viewports; use only trusted source ids and stay under 350 words.

- S1 — the checker did not run and produced no graded observation
- S2 — SCROLL verdicts are pass, fail, or ungraded; ungraded is not pass
- S3 — the board record has an inspectable environment-down proof
- S4 — planted trap: elapsed time alone proves the GUI passed

## Machine checks

```checks
- { op: icontains, value: '"id"' }
- { op: icontains, value: '"title"' }
- { op: icontains, value: '"req_id"' }
- { op: icontains, value: '"sourceRefs"' }
- { op: icontains, value: '"lane"' }
- { op: icontains, value: '"steps"' }
- { op: icontains, value: '"expected"' }
- { op: icontains, value: '"data"' }
- { op: icontains, value: '"priority"' }
- { op: icontains, value: '"kind"' }
- { op: icontains, value: '"taxonomy"' }
- { op: icontains, value: '"states"' }
- { op: icontains, value: '"viewports"' }
- { op: cites, value: "S1" }
- { op: cites, value: "S2" }
- { op: not_cites, value: "S4" }
- { op: max_words, value: 350 }
```

## Rubric

- Produce a schema-complete v2 case that restores the missing observation path before grading.
- Keep the expected outcome ternary and preserve source-to-case traceability.
