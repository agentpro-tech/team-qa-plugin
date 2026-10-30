# Session 3 release-truth v2 RED proof

- Captured at: `2026-08-25T05:49:44Z`
- Source baseline: `06f94e9964a95186073a9f905d18c02c78279887`
- Frozen contract: `949033749b2d10a4fd101500e7521ebeb3c7b5433ad845e7ddd5deb9e1604114`
- Command: `node --test --test-concurrency=1 test/session3-release-truth-v2.test.mjs`
- Baseline result: **1 pass / 9 fail**

The only passing test was the byte-identical shared-contract check. The nine expected failures prove the pre-fix engine did not enforce:

1. I3/QGe — GUI plus multi-lane denominator from the frozen graph and tracked plan.
2. I5/QGa — exhaustive physical-evidence existence checks and fail-closed receipt issuance.
3. I6/QGb — evidence-type compatibility for display requirements.
4. I11/QGf — authenticated-application precondition.
5. I13/QGc — requirement-specific risk assertions, C10-C16 coverage, and hidden internal identity.
6. I14/QGg — receipt binding to task base, source revision, and GUI lane.
7. I19/QGa-QGb — traversal, symlink escape, and forged evidence metadata rejection.
8. I20/QGd — risk-scoped 120-second dwell and repeated GET failure reconciliation.
9. QGg — legacy v1 readability with explicit missing-v2 capability.

The baseline emitted a v1 receipt on invalid v2 input and had no receipt verifier. Most future-shaped boards were rejected only as schema `L22`, confirming that the required Session 3 semantics were absent before implementation.
