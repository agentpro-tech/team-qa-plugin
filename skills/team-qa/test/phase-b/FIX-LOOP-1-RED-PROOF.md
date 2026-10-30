# Phase B fix-loop 1 RED proof

`test/phase-b/fix-loop-1.test.mjs` was added and run before any product change of this fix loop.

| Runtime | Command | Result on the product before the fix |
|---|---|---|
| Node v24.14.0 | `/usr/local/bin/node --test test/phase-b/fix-loop-1.test.mjs` | exit 1; 0 pass, 7 fail |
| Node v26.0.0 | `/opt/homebrew/bin/node --test test/phase-b/fix-loop-1.test.mjs` | exit 1; 0 pass, 7 fail |

Important raw failure signals:

- V5: `verdict=pass decision=GO` although `CASE-HIGH-1-SIBLING` has no board row.
- RTM: `verdict=pass rtm=rtm.md` with an orphan requirement and an orphan lane.
- Report: an orphan lane still gives `decision=GO`; an orphan requirement stops at a different RTM error instead of a plan cross-check.
- `.gitignore` does not have `.scroll/` yet; `SKILL.md` has no guidance yet on the app repo/an absolute `TEAMQA_ROLES`.

Test SHA-256 at RED: `608e44998fb28c5fadf2adfc6492bbe1ffcc86e7fbcf1afb15d80d9005331173`.

## Freeze review and withdrawal

The temporary patch of fix-loop 1 then reached 7/7 on both Node v24.14.0 and Node v26.0.0. This is historical evidence of the temporary patch, **not the final result**, because 4/7 assertions were proposed additional cross-validation guards:

- RTM rejects an orphan requirement.
- RTM rejects an orphan lane.
- Report rejects an orphan requirement.
- Report rejects an orphan lane.

The frozen acceptance G4 overrules this proposal: `G4-RTM-EXPOSES-GAP` must exit 0 and build an RTM with a gap even though the tracked plan holds `CASE-004 REQ-PROFILE` together with a lane outside the plan. Because the freeze contract is supreme, all four assertions, the `TRACKED_REQ_UNKNOWN`/`TRACKED_LANE_UNKNOWN` implementation, and the two matching mutations were withdrawn in fix-loop 2.

After the withdrawal, the maintained regression suite keeps only 3 freeze-compatible guards:

- V5 board completeness: every tracked case without a board row creates `BOARD_CASE_MISSING <case_id>` and locks `decision=NO_GO`, including a requirement with a graded sibling case.
- Packaging ignores `.scroll/` and `agents/**/.build/`.
- `SKILL.md` gives guidance on an absolute `TEAMQA_ROLES` when called from an app repo.

Result of the maintained suite after the withdrawal:

| Runtime | Command | Final result of the maintained suite |
|---|---|---|
| Node v24.14.0 | `/usr/local/bin/node --test test/phase-b/fix-loop-1.test.mjs` | exit 0; 3 pass, 0 fail |
| Node v26.0.0 | `/opt/homebrew/bin/node --test test/phase-b/fix-loop-1.test.mjs` | exit 0; 3 pass, 0 fail |
