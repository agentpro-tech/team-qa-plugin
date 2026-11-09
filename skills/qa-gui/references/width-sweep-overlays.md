# Width sweep, overlay check and frontier exploration (R1e)

Three detectors and one explorer. Each is a pure engine behind a small interface: QA GUI drives Dragon (HR1), and the
tests drive Playwright behind the same interface. A detector's result reaches the gate as a **probe receipt** that a
state receipt names; the gate grades it itself.

## Probe receipts in the gate

A state receipt may add `probes: [{kind, path, sha256, cells?: {path, sha256}}]`, `kind` = `width-sweep` or
`overlay-check`. The file must be in the evidence manifest with that SHA-256. The gate (every mode) loads it, checks its schema and **recomputes** its
verdict with the detector's grader; a verdict stored in the file is not trusted. The probe verdict joins the state's
UI verdict (FAIL wins; an ungradable probe makes it UNGRADED), so the receipt's `ui.verdict` and the board must say
the same. Problems are reported as `PROBE:<case>:<state>:<code>`. A receipt without `probes` is unchanged. A probe that
turns a UI PASS into UNGRADED is on, not advisory: it only adds checking, and the eval decides whether it stays.

### Probe cells (`qa-gui/probe-cells/v1`)

The sealed per-cell result of one probe, for Team QA to count without grading:
`{schema, case, state, kind, probe_sha256, cells: [{route, state, action, viewport, condition, status, reason?}],
integrity}` (`integrity` = SHA-256 of the canonical JSON of the rest). `probeCells(...)` in `scripts/lib/probes.mjs`
derives it from the probe and the state receipt's own coordinates (its `cell`, else its URL path, state and the
matrix row of its size); `node scripts/qa-gui.mjs probe-cells --receipt <state receipt> --probe <probe> --kind <kind>
--out <file>` writes it. Name it in that probe's `cells: {path, sha256}` and list it in the evidence manifest. The gate
re-derives it on every run: a file that differs is `PROBE_CELLS_MISMATCH`, one not in the manifest
`PROBE_CELLS_NOT_IN_MANIFEST`, a wrong hash `PROBE_CELLS_HASH_MISMATCH` (all UNGRADED). The gate cannot write into a
state receipt or the board's manifest (both are hashed inputs), so the file is made with the gate's own grader when the
evidence is made, and enforced by the gate after.

- Overlay check: one cell per way in and out of each overlay (route `dialog:<id>`, state `ideal`, actions
  `open:mouse` … `close:button`), at the receipt's viewport row and condition; an UNGRADED cell keeps its reason
  (`PRECONDITION_ABSENT`, `UNMEASURED`).
- Width sweep: one cell per matrix row it measured (action `view`, viewport = the row, condition `default`): FAIL where
  a band's failure shows on the verified row, UNGRADED `EMULATION_NOT_VERIFIED` or `SWEEP_MATRIX_DISAGREES`, else PASS.

## Width sweep (`qa-gui/width-sweep/v1`)

`sweepWidths({reader, min = 320, max = 1440, step = 20})` in `scripts/lib/width-sweep.mjs`; the step must be 20–40 px
(20 by default: the reads are cheap).

1. **Coarse, read-only.** Every `step` px from `min`, plus `max`, the reader resizes and runs `GEOMETRY_PROBE_BODY`
   (geometry and computed style only; no screenshot). It returns the layout signature (landmarks grouped into rows)
   and the failures: `W1` the page scrolls sideways, `W2` an element sticks out of the viewport (outermost offender,
   not inside a scroller), `W3` text cut by its own box without an ellipsis, `W4` two controls overlap.
2. **Bisection.** Between two coarse widths whose layout or failure set differs, binary search finds the exact edge.
   `breakpoints` are the widths where the layout signature changes; `bands` are, per failure (`rule|selector`), the
   exact contiguous width ranges `[from, to]` where it is present. A band narrower than `step` that falls between two
   samples can still be missed; the edges of a band that is found are exact.
3. **Paint-ordered confirmation.** At `from`, the narrowest failing width, `reader.confirm(width, failure)` decides:
   Dragon's reader reads R1a `paintSnapshot {tabId, selector}` for the failing element (`failure.target`): `shown` →
   `CONFIRMED`; `covered`, `display-none`, `visibility-hidden`, `transparent`, `zero-size` or `no-layout-box` →
   `NOT_VISIBLE` (no finding); not found → `UNCONFIRMED`. Sticking out of the viewport or being clipped is the W2/W3
   failure itself and counts only against W4. A reader without `confirm` may give `snapshot(width)` (CDP
   `DOMSnapshot.captureSnapshot` with paint order, `normalizeDomSnapshot` + `confirmVisible`, as the Playwright test
   reader does); with neither, `UNCONFIRMED`. `W1` is confirmed by the scroll width itself.
4. **One capture.** `reader.capture` runs only at `from`, once per width, and never for a `NOT_VISIBLE` band.
5. **The verdict comes from the matrix.** For each band, the responsive matrix rows whose width lies inside it
   (`rows`) are measured with `reader.measureRow` under their own verified emulation (width, DPR, touch). Band
   verdict: `FAIL` when a verified row shows the same failure; else `UNGRADED` with `SWEEP_BAND_OUTSIDE_MATRIX` (no row
   inside), `EMULATION_NOT_VERIFIED` or `SWEEP_MATRIX_DISAGREES`. `sweepVerdict(receipt)` (the gate's grader)
   recomputes this from the receipt's `rows`: `FAIL`, `UNGRADED`, or `PASS` when no band counts.

Receipt: `{schema, min, max, step, samples:[{width, layout, failures}], probes, breakpoints:[{width, from, to}],
bands:[{id, rule, selector, from, to, detail, status, confirmation, capture, rows, verdict, reason}],
captures:[{width, capture}], rows:[{row, verified, failures}], viewport?: {found, restored: {ok, viewport?, reason?}}}`.

6. **The viewport it found.** A reader with `found()`/`restore(found)` reads the tab's viewport first and puts it back
   last, also when the sweep throws; the receipt records it as `viewport`. `sweepVerdict` makes a sweep whose restore
   did not read back UNGRADED (`SWEEP_VIEWPORT_NOT_RESTORED:<reason>`): the next states would be measured at another size.
   A reader without them (the Playwright stand-in) records nothing and is graded as before.

**Dragon reader** (`scripts/lib/width-sweep-dragon.mjs`, `dragonGeometryReader({rpc, binding, tabId, restore?})`):
`setViewport` (desktop profile, DPR 1) then one `do` `read` step per width; `paintSnapshot` (R1a) for the confirmation;
`captureTab {evidence:true}` for the capture; `setViewport` with the row's profile and DPR plus an emulation readback
for `measureRow`. Restore: by default the window's own size, DPR and touch (`VIEWPORT_BODY`) read before the sweep and
set back with `setViewport`, then read back; `restore: 'clear'` (the case set no override) calls `clearViewport`;
`restore: {width, height, deviceScaleFactor, mobile}` (the case's matrix row) sets that one.

## Overlay inventory and check (`qa-gui/overlay-check/v1`)

`checkOverlays({driver, route})` in `scripts/lib/overlay-check.mjs`. `OVERLAY_STATE_BODY` (a read) lists the screen's
overlay triggers (`aria-haspopup`, `popovertarget`, or `aria-controls` naming a dialog, alertdialog, `aria-modal` or
popover element) and, while an overlay is open, the open overlays (top last), the focused element, the scroll
position, its close button and a backdrop point outside its panel. Each trigger is probed through trusted input only,
each way out from a fresh page (`reload`):

| Rule | Check | Condition absent → UNGRADED `PRECONDITION_ABSENT` |
|---|---|---|
| O1 | a click on the trigger opens it | — |
| O2 | Tab reaches the trigger and Enter opens it (`TRIGGER_NOT_REACHABLE` is a FAIL) | — |
| O3 | Esc closes it | it never opened |
| O4 | a click on the backdrop closes it | no backdrop outside the panel |
| O5 | its close button closes it | no close button found |
| O6 | focus moves in and stays in for 12 Tab presses | it never opened |
| O7 | after every close that worked, focus is back on the trigger | nothing closed it |
| O8 | a scroll attempt does not move the page behind | the page is too short to scroll |
| O9 | an overlay opened from inside it: one Esc closes only the top one | no nested trigger |

`gradeOverlay(observation)` is pure; the receipt keeps each `observation` (raw readbacks), `checks` and `cells`. Each
overlay is a coverage cell: route `dialog:<overlay id>`, state `ideal`, actions `open:mouse`, `open:keyboard`,
`close:esc`, `close:backdrop`, `close:button`. `overlayVerdict(receipt)` (the gate's grader) regrades every
observation: FAIL on a failed check (`OVERLAY_<rule>_FAIL:<id>`), UNGRADED on an unmeasured one; an absent condition
does not change the verdict.

**Dragon driver** (`dragonOverlayDriver({rpc, binding, tabId, url?, fast?})`): `do` steps `clickSelector`, `clickXY`, `key`,
`read`, and the trusted wheel step `scroll {delta: 400}` (a scroll Dragon could not dispatch makes O8 UNGRADED
`UNMEASURED`, never PASS); a fresh page is a `goto` step to `url` (it waits for the load), else `reloadTab` +
`waitForState`. Every click step carries `fast:false` (human-speed motion; the native route refuses a click without
it) unless `fast` is true, which a caller sets only from the R3 fast-click plan (`fastClickAllowed({policy,
caseChecksHoverOrDrag})` in `scripts/lib/fast-click.mjs`: `fast_click: "on"` and a case that checks no hover or drag).

## Frontier exploration (`qa-gui/exploration-policy/v1` in, app map v2 log out)

`explore({driver, policy, chooser?, budget = 30, historyLimit = 20, plateauWindow = 6})` in
`scripts/lib/frontier-explorer.mjs` walks the app and writes an exploration log that `buildAppMapV2` reads: settled
observations with their `candidates`, refused attempts, `decide` entries, a `css-hints` entry, `skip` entries and
always a final `stop` entry. It returns `{log, map, decisions, history, actions}`.

- **Policy** (from Team QA, `teamqa coverage policy`): `{schema, requirementCells: [{route, action?, requirement}],
  highRisk: [{route, action?}], approvedDestructive: [{route, action}]}`.
- **Order.** `scoreCandidate`: +100 on a requirement cell, +50 on a plan high-risk cell, +30 for a save/submit/delete
  kind of action, +10 for navigation, sort, filter, open/close and the like. Ties prefer the current screen.
- **The chooser** is asked only when two or more candidates tie at the top: it gets at most 5 options and the last
  `historyLimit` (20) steps, and an answer that is not an option is not taken (`CHOOSER_ANSWER_NOT_AN_OPTION`).
- **Plateau.** After `plateauWindow` steps with no new coarse state the explorer reads, once, the CSS rules that match
  nothing (`UNMATCHED_CSS_BODY`); `cssStateHints` maps those naming `empty`, `loading` or `error` states to every
  screen with data. A hinted state the exploration never saw is a `skip` with `UNREACHABLE` and the rule in `detail`.
- **Destructive actions** (a destructive word on a control in a dialog, or one the driver marks) are never pressed
  unless `approvedDestructive` lists them; they stay in the frontier with `NEEDS_APPROVAL`.
- **Stop.** `FRONTIER_EMPTY` when nothing explorable is left, `BUDGET_EXHAUSTED` when `budget` actions are used,
  `BLOCKED`/`TOOL_LIMIT` when the driver fails. Every untaken candidate carries one NOT_EXPLORED code
  ([coverage cells](coverage-cells.md)).

**Dragon driver** (`dragonExploreDriver({rpc, binding, tabId, url, fast?})`): a `goto` step to start (it waits for the load), the
`EXPLORE_OBSERVE_BODY` read for each state (node: the open dialog, else the route; a structural DOM hash; the first
list's row count; the top layer's visible controls), a trusted `clickSelector` per action (`fast:false` unless `fast`,
as for the overlay driver).
