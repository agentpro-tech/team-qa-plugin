# The detectors in a Team QA web-lane run (upgrade integration)

In a Team QA run on the Claude web lane the GUI executor is a model on the Claude CLI. It drives Dragon through its MCP
tools and has no shell, so QA GUI's Node drivers (`runTransientProbe`, `dragonGeometryReader`, `dragonOverlayDriver`,
`dragonExploreDriver`) cannot run there. The executor sends the same Dragon calls by recipe instead, with labelled
`read` steps, and Team QA's `teamqa web collect` hands the calls of the executor's attested stream to
`scripts/lib/stream-detectors.mjs`. That module rebuilds each probe receipt with the detector's own engine and grader;
Team QA writes the files and grades nothing; the QA GUI gate grades every receipt again from the files.

| Detector | Executor recipe (labels) | Rebuilt by | Receipt |
|---|---|---|---|
| R1d transient probe | `sensorsStart`; per trial `framesStart`, one `do` (`t:s-pre`, the action, `t:s16` … `t:s1000`, eight `t:sx`), `sensorsRead`, `framesStop {keep:"all"}`, `getNetwork`, `envGet`; `sensorsStop` | `transientProbeFromOps` | `qa-gui/transient-probe/v1` |
| R1c U1, U2 | `envSet` hold rule; `do` [`u:hold:before`, trusted click, wait 1200, `u:hold:during`]; `envGet`; `envRelease`; `u:hold:after`; `envGet` | `uxActionResultsFromOps` → `foldUxInto` | folded into `ui.uiSanity` |
| R1c U3 | `envSet` respond 500 rule; trusted fill; `u:error:before`; submit; `u:error:after`; `envGet` | same | same |
| R1c U4, U5, U6, U9 | the Gate-0 read returns the whole `__uiSanity(state, {ux})` and `__a11yB({minTarget:24, ux})` reports | the sweeps themselves | `ui.uiSanity`, `ui.a11y` |
| R1e width sweep | `w:found` (installs `__qaSweep`), coarse `w:<width>`, `w:refine`, refined widths, `w:bands`; per band `setViewport` + `paintSnapshot` + evidence `screenshot`; per row `w:row:<id>:emu`/`:geo`; restore + `w:restored` | `widthSweepFromOps` (sweepWidths over `recordedGeometryReader`) | `qa-gui/width-sweep/v1` + probe cells |
| R1e overlay check | `o:triggers`; per trigger k: `o:k:before`, `first`, `trap-<n>`, `scroll-from`/`-to`, `now`, `stacked-two`/`-esc`, `esc-open`/`-after`, `backdrop-open`/`-after`, `button-open`/`-after`, `kbd-0`… `kbd-<n>`, `kbd-reach`, `kbd-enter` | `overlayCheckFromOps` (probeOverlay's observation, `gradeOverlay`) | `qa-gui/overlay-check/v1` + probe cells |
| R1e/R1b exploration | `x:0` after a goto (installs `__qaExplore`), one click + `x:<n>` per action, `x:css` | `explorationFromOps` (the explorer following the executor's choices) | app map v2 log |

`detectorPromptSection({caseId, detectors, fast})` renders these recipes with the exact page helpers (each with its
SHA-256) for Team QA's case dispatch. The page helpers are read-only: they measure and plan which widths to read; they
never change the page. They do not survive a navigation, which is why each recipe installs them in the first read
after a `goto`.

## Rules

- **Same engine, same grader.** A rebuilt receipt is what the Node driver would have made from the same Dragon data:
  `transientProbeFromOps` gives the driver's trials on every recorded R1d canary and clean twin (samples, events,
  window, frames, network, conditions), the sweep and overlay recipes give the live drivers' bands and checks on the
  R1e fixture pages (`test/stream-detectors*.test.mjs`).
- **The window is the driver's.** The executor cannot judge whether a probe window must stay open, so the trial `do`
  carries every extension sample to +3 s; the rebuild replays `windowDecision` at the driver's decision points (its
  last sample plus 100 ms, never before +1000 ms) and keeps the samples up to where the driver closes the window.
- **A recipe not followed is never a PASS.** A width the sweep needs but did not read (`SWEEP_WIDTH_NOT_RECORDED`),
  an overlay leg without its input (`OVERLAY_LEG_NOT_RECORDED`, all nine checks UNGRADED), a probe without sensors,
  sensor reads or frames (the gate's `TRANSIENT_SENSORS_*`, `FRAMES_NOT_RECORDED`), an exploration click the explorer
  did not have open (stop `BLOCKED`): each one is ungradable or flagged, and Team QA reports it.
- **Clicks** carry `fast:false` unless the case's R3 fast-click plan allows `fast:true` (`fastClickAllowed`).
- **Key presses** are the `do` step `{key}`; there is no `pressKey` step.
- **Forced states** are environment only (`envSet`: network, request rules, CPU, time zone, locale, media), with the
  board case id as `caseId`, and every case ends with `envReset` (verified `atDefault:true`), also when it ends early.
- **A behavioral case** runs the transient probe at least once, around its main action (Team QA reports
  `DETECTOR_NOT_RUN:<case>:transient` otherwise).
- **No Dragon R1a** (`help` without `environmentContract`, or an R1a tool refused as unknown): the executor skips only
  the transient probe and the forced U states and writes `"detectors": {"unavailable": {"transient":
  "DRAGON_R1A_UNAVAILABLE", "ux": "DRAGON_R1A_UNAVAILABLE"}}` for the state. The forced U rules then say UNGRADED with
  that reason (`uxUnavailableResults`, folded without `require`, so the state keeps its verdict); the probe is
  reported (`DETECTOR_UNAVAILABLE`); the case runs and is graded as before. The width sweep, the overlay check and the
  exploration need no R1a (the sweep's paint confirmation is then `UNCONFIRMED`). Team QA honours the claim only when
  the stream shows that Dragon (and also without a claim when it does); a claim on a Dragon the stream shows with R1a,
  with nothing in the stream behind it, or for a detector that needs no R1a is refused
  (`DETECTOR_UNAVAILABLE_REFUSED:<case>:<state>:<detector>:R1A_RECORDED|NOT_SHOWN|NEEDS_NO_R1A|REASON_UNKNOWN`) and
  what it would skip counts as not run.

## The receipt fields Team QA writes

- `probes: [{kind, path, sha256, cells?: {path, sha256}}]` with kind `transient`, `width-sweep` or `overlay-check`;
  probe cells (`qa-gui/probe-cells/v1`) are made with `probeCells` for the sweep and the overlay check.
- `env: {conditions, reset?}`: `conditions` is the latest Dragon conditions record of the tab before the state's
  screenshot (`null` at defaults), on every state of a case that touched the environment (envSet, sensors or frames);
  `reset` names the raw `env.reset` result on the case's last state.
- `cell.conditions` is `cellConditionsOf(env.conditions)` (`scripts/lib/coverage-cell.mjs`): `network` (`offline`,
  a preset name, or `latency<ms>-down<kbps>-up<kbps>`), `request` (`hold`, `respond:500`, `fail:<reason>`, comma
  separated), `cpu` (the rate above 1), `timezone`, `locale`, `media` (`colorScheme:dark,…`). The gate refuses a cell
  whose conditions differ from the record (`CELL_CONDITIONS_MISMATCH`) or that names conditions with no record
  (`CELL_CONDITIONS_UNBACKED`).

## Limits

- After a navigation the sample helper is gone, so a probe around a route change keeps its sensor streams and frames
  but loses the later geometry samples (T4, T5 and the target state read on them are then measured on fewer samples).
- The exploration follows the executor's own order; its decision log records `by: "executor"` and the rule's choice
  when it differs. The explorer's ordering is advice in the recipe, not enforced.
- U7, U8 and U10 (vision U rules) are not wired into the Team QA executor flow yet.
- The screen check's role is asserted, not proven: the recipe tells the executor to sign in as the screen's role
  (`screenCheckPromptSection({role, signIn})`), and the reads prove which page was measured, but nothing in the stream
  shows which account's session it was. A check run under another role's session is graded as the screen's.

## Fix round 1 (screen checks, page helpers, atomic trials)

- **Screen checks** run once per screen per run, in their own dispatch: `screenCheckPromptSection({screenId, url,
  route, planned, fast})` is the recipe, the draft is `TEAMQA_SCREEN_DRAFT v1` `{screen_id, url, unavailable?}`,
  `screenCheckFromOps(ops, {screenId, route, url, planned, captureRef})` returns `qa-gui/screen-check/v1`
  `{screenId, route, url, status, sweep, overlay, verdict, issues}` and `foldScreenChecks({caseId, states, screens})`
  gives each case `{states: Map(state -> {probes, issues}), issues, notes}` (codes `SCREEN_CHECK_UNGRADED:<screen>`,
  `DETECTOR_NOT_RUN:<case>:screens:<screen>`, notes `SCREEN_NO_ROUTE:<case>`, `SCREEN_CHECK_UNAVAILABLE:<screen>:DRAGON_R1A_UNAVAILABLE`,
  `SCREEN_NOT_VISITED:<case>:<screen>`). The case section has no screen checks any more.
- **Page helpers**: `STREAM_HELPERS` (`sweep`, `overlay`, `explore`, `sample`; each `{name: "qagui.<key>@<sha12>",
  body, sha256}`), `helperCall(key, args, as)`, `helperDefinitions(keys)`. The builders take `{helpers: true}`: a
  labelled read that is not a `{call}` of QA GUI's helper with Dragon's matching `helper.sha256` makes the detector
  `DETECTOR_HELPER_MISMATCH:<width-sweep|overlay-check|explore|transient>`.
- **Settle**: a sweep measure counts only after a `{wait}` of at least `SETTLE_MS` (150) following its viewport.
- **Overlays**: dialog-type triggers only; O6/O8 only on modal overlays; Tab reach is read from the `log`/`keylog`
  modes of the overlay helper (one sample per Tab); a trigger past 40 presses is UNGRADED `TOOL_LIMIT` unless focus went
  round the page (then O2 FAILs). Triggers past the cap of 3 are `notChecked` in the receipt and `NOT_CHECKED` cells.
- **Transient**: `trialParams({step, targetSelector, fast, setup})` is one Dragon `frames.trial`; `transientProbeFromOps`
  builds from those calls when present (`transientProbeFromTrials`), else from the earlier recipe. A frame window that
  did not cover the action (closed before +1000 ms after the mark, or no frame before it) is UNGRADED
  `TRANSIENT_FRAMES_EARLY`; a sensor read that still had `more` is a gap.


## Fix round 2 (folds that lose nothing, proven pages and trials, packs and loops)

- **Fold**: `foldScreenChecks` matches a screen to the case's first state on its route by `screenRouteKey` on both
  sides (hash and trailing slash dropped; the query kept only when the planned route has one), else to the case's first
  captured state (note `SCREEN_FOLDED_INTO_FIRST_STATE`); a screen with no attested result is
  `DETECTOR_NOT_RUN:<case>:screens:<screen>` whether a state was on it or not. A screen entry may carry `attempts` (every
  attested attempt, oldest first): per kind the attempt that FAILed is folded, else the latest. `SCREEN_NOT_VISITED`
  is gone.
- **Which page**: the sweep's `w:found` and the overlay's `o:triggers` return `href`; `screenCheckFromOps` gives
  `measured: {sweep, overlay}` and is UNGRADED `SCREEN_ROUTE_MISMATCH:<check>:<route seen>` (or
  `SCREEN_ROUTE_UNKNOWN:<check>`) when the page was not the screen; such an attempt is folded into no case.
  `screenCheckPromptSection({..., role, signIn})` signs in as the screen's role first.
- **Sweep**: a `w:<width>` read counts only with `vw === width` and a `failures` array; its `layout` is a digest of
  the layout signature. A band capture with a `problem` (`SWEEP_CAPTURE_HASH_MISMATCH`) is UNGRADED.
- **Overlays**: focus is followed by element identity (`activeId`, through open shadow roots; 0 the document). A cycle
  is a return to the first element or to the document. The press limit is 80. A trigger past it, or Tab presses that
  left no sample (focus in a frame, `keyboard.lost`), leave O2 UNGRADED `TOOL_LIMIT` and the receipt's verdict as it
  is. The backdrop and close-button clicks come from the `-open` read they are checked against (the do stops there).
- **Transient**: `transientRepeatability({kinds, reset})` decides: a write (submit, save, delete, list-add,
  list-remove) with no reset path in the plan gets no trial (N/A, `TRANSIENT_WRITE_NO_RESET`); anything else gets 3.
  `transientProbeFromOps(ops, {..., plan: {kinds, reset}, claimed})` keeps every frames.trial in `receipt.attempts`; a
  trial with no setup, whose action step was not ok, whose do did not complete or with no trusted-input mark is not run,
  and the gate grades the probe UNGRADED (`TRANSIENT_ATTEMPT_NOT_RUN`, `TRANSIENT_REPEATS_REQUIRED:<n>/3`,
  `TRANSIENT_CONDITIONS_NOT_DEFAULT` for a trial outside the default environment). The executor's `repeatable` is
  reported (`TRANSIENT_REPEATS_REQUIRED:the executor said not repeatable`), never trusted.
- **Helpers and loops**: the bodies ship as a Dragon helper pack, `scripts/lib/stream-helpers.pack.json`
  (`dragon/helper-pack/v1`, written by `node scripts/stream-helper-pack.mjs`, sha256 `HELPER_PACK_SHA256`); the recipes
  say `helpersDefine {pack:{path, sha256}}` (`helperPack(root)`). The sweep widths, the matrix rows, the trap presses and
  the 80 Tab presses are Dragon loops (`{forEach}`); `dragonOps` expands them as Dragon does (`expandDoSteps`) and counts
  an expanded step only when Dragon's result names the same step (`ran`, or `ranHash` in a brief answer) at the same
  place (`each`). Every R1a tool of a case section (helpersDefine too) is behind the help check; without R1a the
  exploration is skipped and reported.

## Fix round 3 (the main action, the focus cycle, hash routes, one leg per page, fallbacks)

- **Overlays**: O2 counts a cycle only when the first element focus reached comes back after a different element had
  it (`focusCycled`); one element that takes several Tab stops in a row (a date input's fields, a closed shadow host)
  is no cycle, and focus on the document alone is none either.
- **Routes**: `screenRouteKey` keeps a hash route (`#/...`, the rule of `routeOf`; its trailing slash dropped, its own
  query kept only with `query`); any other hash is an anchor and is dropped.
- **Which page, per leg**: the overlay helper's reads carry `href` whenever the page's URL is new to it (always the
  first read after a goto); `screenCheckFromOps` checks the first sweep or overlay read after every goto. A leg on
  another page is `SCREEN_ROUTE_MISMATCH:<sweep|overlay>:<route>` and only that leg is dropped: the attempt's verdict
  is the other leg's FAIL when it failed, else UNGRADED, and the fold still takes the other leg.
- **Transient**: a trial whose action step (or sample) targets another element than the state's main action (or than
  the first trial, when the state names none) is not run, `TRANSIENT_ACTION_MISMATCH` (UNGRADED). When Dragon's
  destructive gate refused every trial (`DESTRUCTIVE_HANDOFF_REQUIRED`, manual policy), `transientProbeFromOps`
  answers `{receipt: null, issues: [], na: "DESTRUCTIVE_HANDOFF_REQUIRED"}`: the probe is N/A, reported by Team QA.
- **Fallbacks**: the `r1a` summary at the start of help (Dragon 1.7.0) says `packs` and `loops`; an older R1a build
  without it: the executor Greps help once for `packs` (and, in a screen check, `loops`). Without `packs`, or when Dragon refuses the pack (`HELPER_PACK_FORBIDDEN` for a path outside its
  pack roots, any other error), it sends the same bodies inline (`helpersDefine {helpers}`, copied from the pack file;
  proven by hash as before). Without `loops`, or when a do refuses a `forEach`, it writes each loop out as its steps;
  `dragonOps` counts written-out steps as typed steps, so both paths grade the same.


## Round G (entry screens, the entry probe)

From the Team QA dogfood of 05/11: the Designer's plans gave GUI cases a share link and a screen named in words, no
`route`, so no screen check ran; a planted layout shift while a screen loads was never measured.

- **Entry screens (G4).** Team QA gives a GUI case with no `route` but an entry link (`data.entry_url`, `data.case_url`
  or a URL in its first step) its own screen, `route: null`. `screenCheckPromptSection({..., entry: {url, steps,
  account, caseId}})` opens the link once (it may reset data and sign out), follows the case's steps up to its first
  write (sign-in and navigation only, never a save, delete or submit), stops on the named screen, and every later goto
  goes to the href `w:found` returned there. `screenCheckFromOps(ops, {route: null, entry: {url}})` grades the check at
  that href (`measuredRoute` in the result); a page still at the entry link or on a sign-in page is UNGRADED
  `SCREEN_ENTRY_NOT_REACHED:<where>`. `foldScreenChecks` folds an entry screen into its own case by case id (the state at
  the measured route, else the first) and flags `SCREEN_ENTRY_NOT_REACHED:<screenId>`.
- **Entry probe (G5).** `detectorPromptSection({detectors: {entry: {screenId, url}}})` adds the `E` part: three
  `framesTrial` labelled `entry:<screenId>`, each with `setup: [{goto: "about:blank"}]` and `steps: [{goto: <screen
  url>}]` (`entryTrialParams`), after the main action's probe and the case's envReset; at most one `sensorsRead` page
  more. `entryProbeFromOps` grades only those trials with the T rules (a goto needs no trusted-input mark; its kind is
  `route-change`) into a `qa-gui/transient-probe/v1` receipt that Team QA folds as probe kind `entry` on the first state
  on that screen; `PROBE_KINDS.entry` grades it with the transient grader. The main action's probe never takes an
  `entry:` trial. Canaries: `test/round-g-entry.test.mjs` (synthetic R1a streams: a 60 px jump 300 ms after load FAILs T1,
  its clean twin does not).
