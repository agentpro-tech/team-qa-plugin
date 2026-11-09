# Speed flags (upgrade R3)

Every QA GUI speed-up that skips work sits behind one named flag. Each flag is `off` by default. An eval decides
whether each one is kept, so a flag can also be `shadow`: the full path runs exactly as `off`, and the speed-up only
records what it would have decided, so both ways can be compared on the same run.

## Where a flag is set

A flag is set in a speed policy, never by the executor:

- **In a Team QA run**, Team QA writes the policy from the signed plan (the `speed` block of `test-plan.md`). The board
  then carries it as `speedPolicy` with `source: {kind: "team-qa/signed-plan", sha256: <plan SHA-256>}`. Team QA's
  `web collect`, the board's only writer in EXECUTE, writes it, and the document lock pins the board it wrote.
- **In a standalone QA GUI run**, the project owner writes the policy file. The board carries it with
  `source: {kind: "qa-gui/owner-policy", sha256: <policy file SHA-256>}`.

Shape of `speedPolicy` (canonical board root; `lib/speed-flags.mjs` checks it, and an invalid one is
`SPEED_POLICY_INVALID`, UNGRADED):

```json
{ "version": 1,
  "source": { "kind": "team-qa/signed-plan", "sha256": "<64 hex>" },
  "flags": { "vision_by_diff": "off|shadow|on", "cost_ladder": "off", "parallel_gui_lanes": "off", "fast_click": "off", "action_cache": "off" },
  "min_tier": { "gate0": 0, "vision": 0, "function": 2, "verdict": 2 },
  "baseline_store": { "path": "<store JSON, relative to the evidence root>", "sha256": "<64 hex>" } }
```

A flag left out is `off`. A check left out of `min_tier` has minimum tier 0. A board without `speedPolicy` is graded
exactly as before R3 (`test/speed-r3-flags-off.test.mjs` compares a fixture run with the pre-R3 code).

## The flags

| Flag | Default | Where it is set | What it skips when `on` | What always still runs |
|---|---|---|---|---|
| `vision_by_diff` | `off` | `speedPolicy.flags`, from the signed plan or the owner's policy | The VLM pass (C10–C16) of a state that has an approved baseline, a diff of at most 0.5% after the approved mask with no 32x32 tile over 5% changed, and clean DOM sweeps. Its seven assertions carry `inherited` with the baseline SHA-256. | The screenshot, the Gate-0 sweeps (A, B, D), the function assertions, the baseline diff itself, and the gate's recomputation of every inherited assertion. Any other state gets its VLM pass. |
| `cost_ladder` | `off` | Same | Settling a check at a tier below the one it runs at today, when that lower tier is conclusive and the plan's `min_tier` allows it. QA GUI's only lower-tier resolver today is vision by diff (tier 0 for `vision`). | Every check at or above its minimum tier. A lower tier can only push work up to a higher tier; a cheap model (tier 1) never makes a PASS. |
| `parallel_gui_lanes` | `off` | Same (Team QA plan lanes) | Running GUI lanes one after another (Team QA). | Each lane's own account or tenant and its own Dragon session; Team QA's validator refuses two lanes on one account or one data namespace. |
| `fast_click` | `off` | Same | Dragon's human-speed cursor travel on a click (`fast:true`). | The click itself is still a trusted click (HR1). Never in a case that checks hover or drag-and-drop: the plan declares it or the case's calls show it, and a fast click there is refused (`FAST_CLICK_ON_HOVER_OR_DRAG_CASE`). The Codex native route keeps its rule (every click `fast:false`). |
| `action_cache` | `off` | Same | Working out again the action path to a state that a passed run already reached on the same app, origin, route, build, viewport, locale and role. | Every sweep and assertion (a replay plan refuses to run without them); a `waitFor` guard on each cached action's target; trusted input through Dragon. The cache never holds a verdict, a read, an assertion or a typed secret, stores only from a run that passed (gate, Function, UI), and serves nothing older than 14 days. |

## Cost ladder tiers

| Tier | Who decides | Example |
|---|---|---|
| 0 | machine | Gate-0 sweeps, the baseline diff of vision by diff |
| 1 | cheap decision model | none in QA GUI today; it may only push work up |
| 2 | large VLM or LLM | the executor's C10–C16 pass, function judgement |
| 3 | adjudicator and human | Team QA's adjudicator, the project owner |

Today's tier per check (with every flag off): `gate0` 0, `vision` 2, `function` 2, `verdict` 2.

## Vision by diff in detail

- **Store.** `qa-gui/approved-baselines/v1` (`lib/baseline-store.mjs`): entries keyed by `route` (URL path, plus a
  `#/` hash route), `state`, `viewport` and `build`. Each stores its PNG SHA-256 (the PNG is kept as
  `png/<sha256>.png` beside the store), its mask rectangles, and the C10–C16 verdicts the state had (all PASS: only a
  clean state can become a baseline to inherit from).
- **Approval is explicit.** `node scripts/qa-gui.mjs baseline propose --store <file> --png <state.png> --route <r>
  --state <s> --viewport <WxH> --build <b> --vision <C10-C16 json> [--mask <rects json>]` adds a `proposed` entry.
  `baseline approve ... --sha256 <png sha> --by <owner>` approves exactly that key and SHA. When
  `QA_GUI_BASELINE_APPROVER` is set, `--by` must equal it. A later approval for the same key supersedes the earlier one.
  A proposed or superseded entry is never compared.
- **Lookup.** The entry approved for the exact build, else the most recently approved entry for the same route, state
  and viewport on another build (`same_build: false` in the decision).
- **Decision.** `node scripts/qa-gui.mjs vision decide --store <file> --png <state.png> --route --state --viewport
  --build --sweep <{uiSanity,a11y} json> --captured-at <iso> [--min-tier n]` prints `qa-gui/vision-diff-decision/v1`:
  `inherit` (tier 0) or `vlm` (tier 2) with every reason that applied. The reasons are `MIN_TIER`,
  `NO_APPROVED_BASELINE`, `BASELINE_APPROVED_AFTER_CAPTURE`, `BASELINE_PNG_DRIFT`, `BASELINE_VISION_NOT_PASS`,
  `SIZE_MISMATCH`, `MASK_TOO_LARGE`, `DIFF_OVER_LIMIT`, `DIFF_LOCAL_OVER_LIMIT`, `DOM_SWEEP_MISSING` and
  `DOM_SWEEP_NOT_CLEAN`.
- **Thresholds.** 0.5% of the compared pixels (`VISION_DIFF_MAX_PERCENT`, the same limit as C-REG), and at most 5% of
  any 32x32 tile (`VISION_TILE_PX`, `VISION_TILE_MAX_PERCENT`). The tile limit is what sends a small concentrated
  change to the VLM: on the shadow fixtures (`test/speed-r3-shadow.test.mjs`) one wrong glyph in a price changed 6.4% of
  its tile and 0.006% of the image, so a 10% limit would have inherited it. A change under 5% of every tile (about 51
  pixels) with clean DOM sweeps is inherited: vision by diff is not a text checker, and the function assertions keep
  checking the content. Clean DOM sweep means ui-sanity and a11y both PASS
  with no high or warn finding. The eval may recalibrate these numbers on the dev sets.
- **C14.** A state is visually inspected either by the VLM on this round's PNG, or through the approved baseline whose
  SHA-256 its assertions carry.
- **Gate.** For a state with `inherited` assertions, the gate needs all seven rules inherited, `vision_by_diff: "on"`,
  the store the policy pins (inside the evidence root, same SHA-256, valid), and the approver rule of the environment.
  It makes the decision again from the state receipt and the screenshot; the SHA, key, diff numbers and verdicts must
  match. Otherwise the state is UNGRADED (`VISION_INHERIT_*`), and so are the case's PASS rows.

## Fast-click and the action cache

- `lib/fast-click.mjs`: `fastClickPlan({mode, caseChecksHoverOrDrag})` gives the instruction for one case;
  `fastClickIssues({calls, mode, caseChecksHoverOrDrag})` checks the case's Dragon calls after it ran;
  `fastClickSummary(calls)` counts clicks, fast clicks and hover or drag calls for the decision log.
- `lib/action-cache.mjs` (`qa-gui/action-cache/v1`): `storeFromPassedRun`, `lookupActions`, `replayPlan`,
  `pruneActionCache`, `actionCacheErrors`. The fingerprint has seven signals, all required: `app`, `origin`, `route`,
  `build`, `viewport`, `locale` and `role`. Because `build` is one of them, a new build never gets a hit.
