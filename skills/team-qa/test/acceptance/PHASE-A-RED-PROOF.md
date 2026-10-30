# Phase A RED-proof

- Yardstick SHA-256: 2ccb627b376b85556be6da241f2267e455e5343d51bc3f1ce8e07306e736d19a
- Yardstick files: 41
- Node 24: v24.14.0 — 50 RED, 2 GREEN controls, 0 mismatch.
- Node 26: v26.0.0 — 50 RED, 2 GREEN controls, 0 mismatch.
- Product entry during proof: absent (scripts/teamqa.mjs does not exist).
- Freeze state: not tagged; awaiting the owner's approval.

| Case | Group | Expected failure message/behavior | Base Node 24 | Base Node 26 | Explanation if GREEN | Provenance |
|---|---|---|---|---|---|---|
| G2-PLAN-VALID | G2 | exit 0 three times; verdict=pass | RED | RED |  | synthetic |
| G2-PLAN-MISSING-COVERAGE | G2 | exit 2; PLAN_MISSING_FIELD exit_criteria.coverage_low_pct | RED | RED |  | synthetic |
| G2-PLAN-P0-WRONG-TYPE | G2 | exit 2; PLAN_TYPE exit_criteria.p0_max | RED | RED |  | synthetic |
| G2-PLAN-MISSING-END-MARKER | G2 | exit 2; PLAN_MARKER TEAMQA_PLAN_END | RED | RED |  | synthetic |
| G2-PLAN-UNKNOWN-FIELD | G2 | exit 2; PLAN_UNKNOWN_FIELD unexpected | RED | RED |  | synthetic |
| G2-PLAN-PARALLEL-NO-REASON | G2 | exit 2; PLAN_PARALLEL_REASON lanes[0].vi_sao | RED | RED |  | synthetic |
| G2-PLAN-MALFORMED-JSON | G2 | exit 2; PLAN_JSON_INVALID | RED | RED |  | synthetic |
| G2-PLAN-MISSING-FILE | G2 | exit 2; INPUT_MISSING test-plan.md | RED | RED |  | synthetic |
| G2-PLAN-UNREADABLE-FILE | G2 | exit 1; INPUT_UNREADABLE test-plan.md | RED | RED |  | synthetic |
| G3-GATE-UNSIGNED | G3 | exit 3; GATE_UNSIGNED | RED | RED |  | synthetic |
| G3-GATE-SIGNED-MATCH | G3 | exit 0; verdict=pass | RED | RED |  | synthetic |
| G3-GATE-STALE-SIGNATURE | G3 | exit 3; the exact message plan changed after signing | RED | RED |  | synthetic |
| G3-PUBLISH-DOC-COLAB-FALLBACK | G3 | exit 0; mirror=doc-colab; read-back confirmed | RED | RED |  | product-path |
| G3-PUBLISH-NOTION-CONFIRMED | G3 | exit 0; mirror=notion; effect=confirmed | RED | RED |  | product-path |
| G3-PUBLISH-READBACK-MISMATCH | G3 | exit 1; EFFECT_UNCONFIRMED | RED | RED |  | product-path |
| G3-APPROVAL-MALFORMED-JSON | G3 | exit 2; APPROVAL_JSON_INVALID | RED | RED |  | synthetic |
| G3-APPROVAL-UNKNOWN-FIELD | G3 | exit 2; APPROVAL_UNKNOWN_FIELD unexpected | RED | RED |  | synthetic |
| G3-GATE-UNREADABLE-PLAN | G3 | exit 1; INPUT_UNREADABLE test-plan.md | RED | RED |  | synthetic |
| G3-CONTROL-GREEN | G3 | exit 0 on a known-good control | GREEN | GREEN | Test-only control proves the acceptance harness can record a known-good gate result. | synthetic |
| G4-DESIGN-VALID | G4 | exit 0; verdict=pass; cases=6 | RED | RED |  | synthetic |
| G4-DESIGN-MISSING-EXPECTED | G4 | exit 2; CASE_FIELD CASE-002 expected | RED | RED |  | synthetic |
| G4-DESIGN-MISSING-STEPS | G4 | exit 2; CASE_FIELD CASE-001 steps | RED | RED |  | synthetic |
| G4-RTM-EXPOSES-GAP | G4 | exit 0; rtm.md contains REQ-UNTESTED and the bold empty marker | RED | RED |  | product-path |
| G4-DESIGN-MISSING-FILE | G4 | exit 2; INPUT_MISSING tracked-plan.json | RED | RED |  | synthetic |
| G4-DESIGN-MALFORMED-JSON | G4 | exit 2; CASE_JSON_INVALID | RED | RED |  | synthetic |
| G4-DESIGN-UNKNOWN-FIELD | G4 | exit 2; CASE_UNKNOWN_FIELD CASE-UNKNOWN unexpected | RED | RED |  | synthetic |
| G4-DESIGN-UNREADABLE-FILE | G4 | exit 1; INPUT_UNREADABLE tracked-plan.json | RED | RED |  | synthetic |
| G5-BOARD-NO-EVIDENCE-DOWNGRADE | G5 | exit 1; verdict=ungraded; board record rewritten and confirmed | RED | RED |  | synthetic |
| G5-BOARD-MISSING-EVIDENCE-PATH | G5 | exit 1; BOARD_EVIDENCE_UNREADABLE | RED | RED |  | synthetic |
| G5-BOARD-BLOCKED-NORMALIZES-UNGRADED | G5 | exit 1; verdict=ungraded; reason=ENV_DOWN | RED | RED |  | synthetic |
| G5-BOARD-EVIDENCE-PASS | G5 | exit 0; verdict=pass | RED | RED |  | synthetic |
| G5-BOARD-ADD-PRODUCT-PATH | G5 | exit 0; one record; effect=confirmed | RED | RED |  | product-path |
| G5-SMOKE-SCHEMA-MATCH | G5 | exit 0; verdict=pass | RED | RED |  | synthetic |
| G5-SMOKE-QA-CODE-MAJOR-MISMATCH | G5 | exit 4; SCHEMA_MAJOR_MISMATCH qa-code | RED | RED |  | synthetic |
| G5-SMOKE-SCHEMA-MISSING | G5 | exit 5; verdict=ungraded; SKILL_SCHEMA_MISSING qa-code | RED | RED |  | synthetic |
| G5-BOARD-MALFORMED-JSONL | G5 | exit 2; BOARD_JSON_INVALID line=1 | RED | RED |  | synthetic |
| G5-BOARD-UNKNOWN-FIELD | G5 | exit 2; BOARD_UNKNOWN_FIELD unexpected | RED | RED |  | synthetic |
| G5-BOARD-UNREADABLE-FILE | G5 | exit 1; INPUT_UNREADABLE board.jsonl | RED | RED |  | synthetic |
| G5-CONTROL-GREEN | G5 | exit 0 on a known-good control | GREEN | GREEN | Test-only control proves the acceptance harness can record a known-good board result. | synthetic |
| G6-REPORT-GO | G6 | exit 0; GO; high=100; low=100; P0=0; P1=0 | RED | RED |  | synthetic |
| G6-REPORT-HIGH-COVERAGE-NO-GO | G6 | exit 1; NO_GO; coverage_high_pct 50 < 100 | RED | RED |  | synthetic |
| G6-REPORT-LOW-COVERAGE-NO-GO | G6 | exit 1; NO_GO; coverage_low_pct 50 < 70 | RED | RED |  | synthetic |
| G6-REPORT-P0-NO-GO | G6 | exit 1; NO_GO; p0_count 1 > 0 | RED | RED |  | synthetic |
| G6-REPORT-P1-NO-WAIVER | G6 | exit 1; NO_GO; P1 case id appears in reason | RED | RED |  | synthetic |
| G6-REPORT-P1-WAIVER-GO | G6 | exit 0; GO; waived_p1 includes CASE-HIGH-1 | RED | RED |  | synthetic |
| G6-REPORT-UNGRADED-NOT-COVERED | G6 | exit 1; NO_GO; coverage_high_pct 50 | RED | RED |  | synthetic |
| G6-REPORT-TAMPER-DETECTED | G6 | build exit 0, tamper high coverage, verify exit 2 REPORT_MISMATCH | RED | RED |  | product-path |
| G6-REPORT-UNSIGNED-PLAN | G6 | exit 3; GATE_UNSIGNED | RED | RED |  | synthetic |
| G6-REPORT-MISSING-BOARD | G6 | exit 2; INPUT_MISSING board.jsonl | RED | RED |  | synthetic |
| G6-REPORT-MISSING-END-MARKER | G6 | exit 2; REPORT_MARKER TEAMQA_REPORT_END | RED | RED |  | synthetic |
| G6-REPORT-UNKNOWN-FIELD | G6 | exit 2; REPORT_UNKNOWN_FIELD unexpected | RED | RED |  | synthetic |
| G6-REPORT-UNREADABLE-BOARD | G6 | exit 1; INPUT_UNREADABLE board.jsonl | RED | RED |  | synthetic |

## Freeze gate

- Create the team-qa-thuoc-freeze tag only after the owner approves this table.
- Phase B must run in a new session.
- Phase B must not change test/acceptance/; the diff against the freeze tag must be empty.
