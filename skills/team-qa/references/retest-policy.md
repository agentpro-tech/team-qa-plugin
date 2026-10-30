# QA again after a defect fix

Choose the scope before the round from the diff, the fix proof and the evidence-backed impact. This policy supplements
the signed plan; it does not replace the exit criteria or the release acceptance gate.

| Impact of the fix | Scope |
|---|---|
| `bounded`: known, limited to the feature | Defect cases + affected regression + core smoke |
| `shared`: shared permissions, data or components | Defect cases + regression of the identified shared flows + core smoke |
| `unknown`: not enough evidence to determine the impact | Full tracked suite |
| `full-release`: whole-release acceptance | Full tracked suite |

A shared change whose affected cases cannot be listed yet chooses `unknown`; do not record "no impact" from
a guess. Core smoke is the main flows already in the tracked plan; do not invent new case IDs to fill it.
An escaped defect must still have a regression for each affected layer per the registry/compile receipt.

Write a change analysis with reasons, the exact target build/version and IDs from the tracked plan:

```json
{
  "target_version":"<exact-new-build>",
  "impact":"bounded",
  "defect_cases":["<existing-defect-case>"],
  "affected_cases":["<existing-affected-case>"],
  "smoke_cases":["<existing-core-flow-case>"],
  "rationale":"<diff/fix proof and the basis for choosing the scope>"
}
```

```bash
teamqa retest select --tracked <tracked-plan.json> --change <change-analysis.json> --out <retest-selection.json>
```

The output keeps the original case order, seals the input hashes and records `notSelectedCaseIds` explicitly. It does not overwrite
the tracked plan or an old output. This is a selection, not evidence of testing or a GO receipt.

After the round: record the cases actually run, Function/UI/evidence, the new target, the cases not run and the reasons. Cases
that were not selected are not counted as PASS on the new build; an old PASS is only history of the old build. The re-test report
records **re-test scope met/not met**; a whole-app/release GO still needs the full frozen denominator/exit criteria
and a receipt for the exact build. If the scope goes outside the signed plan, publish a new plan version and sign it again.

There is no extra confirmation round for each case within the signed scope. Keep the limits of 3 tries/case, 2 fix loops,
independent QA and the RETEST → VERIFIED → CLOSED chain; a failed case becomes REOPENED.
