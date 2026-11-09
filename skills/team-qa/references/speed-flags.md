# Speed flags (upgrade R3)

Every Team QA speed-up that skips work is behind one named flag. Each flag is `off` by default, and the eval decides
whether each one is kept. A flag can also be `shadow`: the run does all the work as with `off`, and the speed-up only
records what it would have decided, so both ways can be compared.

## Where a flag is set

Only in the signed plan: the optional `speed` block of the `TEAMQA_PLAN` JSON in `runs/<id>/test-plan.md`
(`schemas/plan.json`, `lib/speed.mjs`). The executor never sets a flag. Team QA reads the flags from the plan file the
user signed (the document lock's `plan`), and that file's SHA-256 is the policy's source. From there they reach:

- the GUI case dispatch prompt (a `TEAMQA_SPEED` section, only for flags that are `on`);
- `teamqa web collect` (the board's `speedPolicy` for QA GUI, the vision decisions, the fast-click check);
- the GUI case dispatch start (the parallel lane check);
- `runs/<id>/decisions.jsonl` and the report.

```json
"speed": {
  "vision_by_diff": "off|shadow|on",
  "cost_ladder": "off|shadow|on",
  "parallel_gui_lanes": "off|shadow|on",
  "fast_click": "off|shadow|on",
  "action_cache": "off|shadow|on",
  "min_tier": { "gate0": 0, "vision": 0, "function": 2, "verdict": 2 },
  "baseline_store": { "path": "<relative to the project folder>", "sha256": "<64 hex>" },
  "action_cache_store": { "path": "<relative to the project folder>", "sha256": "<64 hex>" }
}
```

- A flag left out is `off`.
- A check left out of `min_tier` has minimum tier 0.
- `vision_by_diff` and `action_cache` need their store pinned by hash in `shadow` and `on`. A store is therefore fixed
  when the plan is signed.
- `plan validate` refuses an unknown field, a wrong mode or tier, a missing store, and an absolute or `..` path.
- `teamqa speed show --run <id>` prints the policy with what each flag skips and keeps.
- A plan without the block is validated, dispatched, collected and reported exactly as before R3.
  `test/speed/flags-off.test.mjs` compares a fixture run with the pre-R3 code.

## The flags

| Flag | Default | Where it is set | What it skips when `on` | What always still runs |
|---|---|---|---|---|
| `vision_by_diff` | `off` | `speed.vision_by_diff`, with `speed.baseline_store` pinned | The VLM pass (C10–C16) of a state that QA GUI's tier-0 decision lets inherit from an approved baseline (diff ≤ 0.5% after the approved mask, no 32x32 tile over 5% changed, clean DOM sweeps). The executor may write `"vision": "inherit"` for a state and not open its PNG. | The screenshot, Gate-0, console, network and function assertions of every state. The QA GUI gate recomputes every inherited assertion. A FAIL the VLM saw is never replaced. A state left to the machine that cannot inherit stays UNGRADED (`VISION_TIER2_REQUIRED`), and the next dispatch of the case asks the VLM for it. |
| `cost_ladder` | `off` | `speed.cost_ladder` and `speed.min_tier` | Settling a check above its lowest conclusive tier. Today the only lower-tier resolver is vision by diff (tier 0 for `vision`). | Every check at or above its plan minimum. A tier only pushes work up, and the cheap model (tier 1) never settles a check, so it never makes a PASS. Every settlement is logged; a minimum the run did not reach is listed in collect's issues (`LADDER_BELOW_MIN_TIER`). |
| `parallel_gui_lanes` | `off` | `speed.parallel_gui_lanes` and each lane's `parallel_ok`, `account`, `data_namespace`, `dragon_session` | Running GUI lanes one after another: a case of a `parallel_ok` lane may start while a case of another `parallel_ok` lane runs. | Each parallel lane names its own test account or tenant, data namespace and Dragon session. `plan validate` refuses two parallel lanes on one account, namespace or session (`PLAN_PARALLEL_LANE_SHARED_*`), and a parallel lane that does not name all three. The case dispatch start refuses a case beside a running case of the same lane, of a lane that is not `parallel_ok`, or of a lane that shares any of them (`DISPATCH_PARALLEL_LANES_REFUSED`). |
| `fast_click` | `off` | `speed.fast_click` | Dragon's human-speed cursor travel: the prompt lets the executor set `fast:true` on clicks. | Trusted clicks through Dragon (HR1). Never in a case that checks hover or drag-and-drop: the tracked case declares it (`data.interaction` with `hover`, `drag` or `drag-and-drop`), or its title, steps or expected text name it. Collect refuses a fast click in such a case (`FAST_CLICK_ON_HOVER_OR_DRAG_CASE`), and the case is dispatched again. |
| `action_cache` | `off` | `speed.action_cache`, with `speed.action_cache_store` pinned | Working out again the path from the start page to a case's first state, when a passed run stored it under the same fingerprint: the prompt gives the executor the cached `do` steps. | Every screenshot, sweep and assertion. A `waitFor` guard sits on each cached action. Only a case whose latest board record passed with a QA GUI child verdict pass is stored (`teamqa speed cache-store`). No verdict, read, assertion or typed secret is ever cached. Entries expire after 14 days. |

In `shadow`:

- `vision_by_diff` logs each state's decision, and which VLM FAIL inheriting would have missed (`missed_rules`).
- `cost_ladder` logs the ladder records.
- `parallel_gui_lanes` logs what `on` would refuse.
- `fast_click` logs each case's clicks.
- `action_cache` logs HIT, MISS or EXPIRED.

None of them changes what the executor does or what the board says.

## Tiers

| Tier | Who decides | In Team QA today |
|---|---|---|
| 0 | machine | Gate-0 sweeps; vision by diff |
| 1 | cheap decision model | none (R2b is deferred); it may only push work up |
| 2 | large VLM or LLM | the GUI executor (C10–C16, function judgement) |
| 3 | adjudicator and human | the adjudicator (R2a) and the owner |

With every flag off, each check runs at its tier of today: `gate0` 0, `vision` 2, `function` 2, `verdict` 2. A
component that settles a check at tier 3 (the adjudicator) records it with `ladderDecision` and `appendSpeedDecision`
from `lib/cost-ladder.mjs` (check `function` or `verdict`, step `{tier: 3, outcome: "settled"}`). The adjudicator does
so for every case it judges (adjudicator contract, section 7), in shadow and in enforce mode.

## The decision log

Each speed decision is one line of `runs/<id>/decisions.jsonl` (`team-qa/speed-decision/v1`). Every line has `kind`
and `mode` (`on` or `shadow`). The kinds are:

- `ladder`: `check`, `min_tier`, `default_tier`, `steps[]`, `settled_tier`, `errors[]`.
- `vision_by_diff`: `decision` (`inherit` or `vlm`), `reasons[]`, `baseline_sha256`, `same_build`, `diff_percent`,
  `max_tile_percent`, `vlm_verdicts`, `applied`, `vlm_skipped`, `escalated`, `agree`, `missed_rules[]`.
- `fast_click`: `plan`, `would_be_fast`, `summary` (clicks, fast clicks, hover or drag calls), `issues[]`.
- `parallel_lanes`: `lane`, `beside[]`, `allowed`, `errors[]`.
- `action_cache`: `reason` (`STORED`, `HIT`, `MISS`, `EXPIRED`), `fingerprint_sha256`.

R0's time receipt reads the log: `timing.json` gets `speed {decisions, summary}`, and the report's Time section gets a
Speed table. Both appear only when the run has speed decisions.

## Running both ways

The eval runs the same cases twice, with a flag `off` and with it `on`, or once in `shadow`. Then:

```bash
teamqa speed compare --off <run with the flag off> --on <run with the flag on or in shadow>
```

- **Misses.** The command lists each case the off run fails that the on run passes, and each shadow state where
  inheriting would have missed a VLM FAIL. A case the on run left ungraded is listed apart.
- **Time.** It puts both runs' time receipts side by side, by wall time and step kind.
- **Exit code.** It exits 1 on a miss.

`test/speed/speed-shadow.test.mjs` shows this on fixtures.
