# UX rules U1–U10 — reference

> Companion to the Layer U section of SKILL.md. Code: `scripts/ui-sanity.js` (U9, `__uxObserve`),
> `scripts/a11y-gate0.js` (U4, U5, U6), `scripts/lib/ux-rules.mjs` (registry, settings, U1, U2, U3, paint graders,
> `foldUx`), `scripts/lib/ux-vision.mjs` (U7, U8, U10), `scripts/ux-grade.mjs` (CLI). Tests:
> `test/ux-rules.test.mjs`, `test/ux-rules-dom.test.mjs`, fixtures in `test/fixtures/ux-rules/`.

## What every rule shares

- **Three verdicts.** Each rule returns `PASS`, `FAIL` or `UNGRADED`. When the rule's condition did not occur on the
  state (no field in error, no status message, nothing focused, no write, no held request, no empty state), the
  rule is `UNGRADED` with a `reason` code, never `PASS`.
- **One result shape.** `{id, rule, verdict, level, source, reason?, findings[], thresholds, ...measured}`. A finding
  is `{sel, detail, region?, text?}`. `source` says where the evidence came from: `dom` (a Gate-0 sweep), `paint`
  (Dragon `paintSnapshot`), `observe` (`__uxObserve` / Dragon records), `vision`.
- **Findings belong to the UI verdict.** The in-page rules write into the sweep report of the state
  (`__uiSanity(...).ux.rules`, `__a11yB(...).ux.rules`); the Node-graded rules are folded into that same report with
  `foldUx(report, results, {require})`. The executor records the folded report as the state receipt's
  `ui.uiSanity` (U1, U2, U3, U7, U8, U9, U10) or `ui.a11y` (U4, U5, U6), so the gate computes the case's UI verdict
  from it as it does for every other sweep. No gate change is needed.
- **Level is a setting.** `block`: a FAIL adds `sev:"high"` issues and fails the sweep, so the state's UI is FAIL.
  `warn`: a FAIL is listed (`sev:"warn"`) and the sweep verdict is unchanged. Levels and thresholds are fixed at
  pre-registration (EV2); see *Settings* below.
- **Required rules.** A case that forced a state for a rule (a held write for U2, a forced error for U3, an empty
  list for U7) lists that rule in `require`. A required rule that comes back `UNGRADED` (or has no result) turns a
  passing sweep into `UNGRADED`: the forced condition was not measured, so the state cannot PASS.
- **Measure, never act.** The in-page code only reads. It passes the native GUI read policy (no click, dispatch,
  fetch, submit, navigation or storage access); `test/ux-rules.test.mjs` checks the sources. Typed values never leave
  the page: `__uxObserve` reports fields by key, length and an FNV-1a hash; passwords and files are left out.
- **Forced states only at the environment layer.** Dragon `envSet` request rules (hold, respond, fail), network,
  locale; no injected page state, no fake clock. The executor calls `envReset` at the end of every case (and when a
  case ends early); a reset that does not verify (`ENV_RESET_UNVERIFIED`) means the case cannot PASS.

## Default levels (conservative)

A rule blocks by default only when its condition is forced or measured exactly and its threshold needs no
calibration. Everything else warns until the pre-registration says otherwise. Thresholds are starting points from
the 27/10 proposal and the standards cited; they are calibrated later on dev data, never on eval data.

| Rule | Default | Why |
|---|---|---|
| U1 | `warn` | the 1 s mark and "visible change" need calibration (async UIs, skeletons) |
| U2 | `warn` | the busy-state detection is a heuristic (custom spinners) |
| U3 | `block` | data loss after a forced error, compared field by field; no threshold |
| U4 | `warn` | the distance threshold and the error-message heuristic need calibration |
| U5 | `warn` | the toast heuristic can miss or over-match class names |
| U6 | `block` | WCAG 2.4.11 AA, all five points covered; no threshold to tune |
| U7 | `warn` | vision judgement, uncalibrated |
| U8 | `warn` | vision judgement, uncalibrated |
| U9 | `warn` | the 2-of-5 point threshold needs calibration |
| U10 | `warn` | vision judgement, uncalibrated |

## Settings (pre-registration, EV2)

```json
{ "ux": { "version": 1, "levels": { "U9": "block" }, "thresholds": { "U1": { "progressMs": 1000 } } } }
```

`uxSettings(prereg.ux)` returns the resolved `{version, levels, thresholds, sha256}`; every key is optional and
missing keys keep the defaults. An unknown rule, level, threshold name, type or out-of-range value throws
(`UX_SETTINGS_*`): a pre-registered setting that cannot be read stops the run instead of falling back. Record the
`sha256` in the pre-registration lock. Pass the same levels and thresholds to the in-page sweeps
(`__uiSanity(label, {ux:{levels, thresholds, require}})`, `__a11yB({minTarget, ux:{...}})`) and to the CLI
(`--settings`). An invalid setting inside a sweep makes that rule `UNGRADED` (`SETTINGS_INVALID`).

## Machine-measured rules

### U1 `no-feedback-after-action`

- **Signal**: `__uxObserve` before the action, while the write is still pending (`during`) and after the result;
  or Dragon `sensors.read` events over the same window. A visible change is a different visible-content digest
  (text, classes, inline style, state attributes, field values, visibility), a URL change, a new live-region message,
  a new dialog or a new busy marker; from sensors, the first mutation that adds, removes or changes text or a
  non-`data-*` attribute, or a resize, visibility change or layout shift after the action.
- **Condition**: the action made a mutating request that succeeded (`writes` with a 2xx), or the write stayed
  pending longer than `progressMs` (`pendingUntil`, or the env.get `released:*` / `responded:*` entry of a held
  write). FAIL `NO_PROGRESS_INDICATOR` when nothing visible changed within `progressMs` while it was pending;
  FAIL `NO_VISIBLE_CHANGE` when a write succeeded and nothing visible changed at all.
- **Threshold**: `progressMs` = `1000` (NN/g: 1 s keeps the flow of thought; past it the user needs a progress
  indicator). A `during` observation must be taken at or after the mark and before the write ended.
- **UNGRADED**: `NO_ACTION`, `NO_WRITE_OR_WAIT` (no successful write and no wait), `NO_DURING_EVIDENCE`,
  `NO_AFTER_EVIDENCE`.
- **Default level**: `warn`.
- Blind spots: a change outside the document (title, favicon) is not seen; a change that only a canvas or a
  pseudo-element shows counts only when a class or style changed with it.

### U2 `double-submit-open`

- **Signal**: `__uxObserve({trigger})` while the write is held by an `envSet` `hold` rule, and the `env.get` read taken
  right after it (`held[]`, `requests[]`).
- **Condition**: a held mutating request is confirmed. FAIL `DUPLICATE_REQUEST` when the hold rule matched two or more
  requests after the action (a second trusted click went out); FAIL `STILL_ACTIONABLE` when the trigger is enabled,
  not `aria-disabled`, not inert, not covered, still visible, and neither it nor its form shows a busy state
  (`aria-busy`, a progress or spinner element or a running infinite animation inside it, a changed label). A busy bar
  elsewhere on the page does not stop a second click and does not count.
- **Threshold**: none (the hold makes the condition exact).
- **UNGRADED**: `NO_OBSERVATION`, `TRIGGER_NOT_FOUND`, `NO_ENV_READ`, `NO_PENDING_REQUEST`.
- **Default level**: `warn`. `DUPLICATE_REQUEST` is direct evidence and a candidate for `block` at pre-registration.
- R1d's T5 (double-click window) measures the same defect at real speed; U2 is its stable, forced-state twin.

### U3 `error-lost-input`

- **Signal**: `__uxObserve` after the user filled the form (just before the submit) and after the error shows; the
  `env.get` request log (`responded:4xx|5xx`, `failed:<reason>`) or the network log.
- **Condition**: the submit met an error (forced with an `envSet` `respond` 500 or `fail` rule). FAIL for every field
  filled before the error that is gone, or holds a different value, after it (hash compare); a form that disappeared
  lost all of its fields.
- **Threshold**: none.
- **UNGRADED**: `NO_OBSERVATION`, `NO_ERROR`, `NO_INPUT`. Passwords and file inputs are never compared (clearing a
  password after a failure is accepted practice).
- **Default level**: `block`.

### U4 `error-not-tied-to-field`

- **Signal**: the a11y sweep at the error state. Error messages are visible elements with a class or id token
  `error`, `errors`, `invalid` or `danger` (or `role="alert"`), 2–200 characters, not containing a field. A field is
  in error with `aria-invalid="true"` or an error token on it or on its single-field wrapper. A message is tied to a
  field when the field (or its fieldset / group) references it with `aria-describedby` or `aria-errormessage`, or it
  sits inside the field's label.
- **Condition**: a field error is shown. Pairs: every referenced message with its field; every unreferenced message
  within `adjacentPx` below or beside a field; every field in error with its nearest message. FAIL when the pair is
  not referenced, or when a referenced message is more than `maxGapPx` from its field.
- **Threshold**: `adjacentPx` = `24` (a message this close, at or below the field's top, belongs to it);
  `maxGapPx` = `120` (a tied message further away is "far from the field").
- **UNGRADED**: `NO_FIELD_ERROR`, `NO_ERROR_MESSAGE` (a field marked invalid with no message anywhere).
- **Default level**: `warn`.
- Blind spots: a form-level banner above the first field is not paired by distance; colour-only error states are
  WCAG 1.4.1, not U4.

### U5 `status-not-announced`

- **Signal**: the a11y sweep while the message is on screen (run it in the same `do` chain right after the `waitFor`
  of the message, so a short toast is still there). Candidates: live regions (`role` status, alert, log, marquee,
  timer, `aria-live`, `output`), toast or snackbar class tokens, `data-sonner-toast`, `data-toast`, and floating
  (fixed, absolute, sticky) elements with an alert / notification / notice / flash / message token; visible, 2–300
  characters; the innermost candidate is judged.
- **Condition**: a status message is visible. FAIL when it is not inside a live region (or a live region set to
  `aria-live="off"`), or sits inside `aria-hidden`, unless it holds the focus (WCAG 4.1.3 covers messages that do
  not take focus).
- **Threshold**: none.
- **UNGRADED**: `NO_STATUS_MESSAGE`.
- **Default level**: `warn`.
- Blind spots: an inline result message with none of these markers is not a candidate; whether the live region
  existed before the message was inserted (needed for some screen readers) is not checked.

### U6 `focus-obscured`

- **Signal**: the a11y sweep after trusted keyboard focus (the `do` step `{key:"Tab"}`), at the centre and the 20%/80% corners of
  the focused element's part inside the viewport and its clipping ancestors (the same five points as Dragon
  `paintSnapshot`). A point is covered when the topmost element there that paints something (a background colour,
  a background image, a replaced element) is not the element, its subtree, an ancestor or its label. With Dragon
  `paintSnapshot {selector: <focused element>}` the same rule runs on the paint order (`gradeU6Paint`), which also
  sees `pointer-events:none` layers and ignores transparent overlays.
- **Condition**: an element has focus and part of it is in view. FAIL when at least `coveredPoints` points are covered.
- **Threshold**: `coveredPoints` = `5` (WCAG 2.4.11 AA: not entirely hidden; a lower value moves toward 2.4.12 AAA).
- **UNGRADED**: `NO_FOCUS`, `FOCUS_IN_FRAME`, `FOCUS_NOT_VISIBLE`, `FOCUS_NOT_IN_VIEW`, and for the paint path
  `NO_SNAPSHOT`, `PAINT_TARGET_NOT_FOUND` or the Dragon error code.
- **Default level**: `block`.

### U9 `occluded-control-partial`

- **Signal**: ui-sanity, for the same controls and exclusions as A3 (inside the topmost overlay when one is open;
  disabled, sr-only and hidden controls skipped; at most 150), hit-testing five points of each control's part in
  view. A point is covered when it hits an element that is not the control, its subtree, an ancestor, its label, or
  an adornment of the control's own wrapper drawn inside its box. `gradeU9Paint` runs it on a Dragon
  `paintSnapshot {selector, all:true}` (painted cover only, the "visible" confirmation R1e asks for).
- **Condition**: a control is in view. FAIL for every control with at least `minCovered` covered points. A3 still
  reports a covered centre; U9 adds the half-covered control whose centre is free.
- **Threshold**: `minCovered` = `2` (one corner under a small badge is tolerated).
- **UNGRADED**: `NO_CONTROLS_IN_VIEW`.
- **Default level**: `warn`.

## Vision-judged rules

U7, U8 and U10 ride the per-state vision pass of Layer C: the same canonical PNG, the same pass. The executor builds
one request for the rules the state needs (`uxVisionRequest`, or `node scripts/ux-grade.mjs --vision-request
<ctx.json>`), answers it with JSON only against `UX_VISION_SCHEMA`, and grades it (`gradeUxVision`, or `--rule U7
--input {request, outputs}`). Each answer entry is `{rule, applies, verdict, confidence, <yes/no fields>,
evidence:{region:{x,y,w,h} (image px), quote}, reason}`.

The grader accepts an entry only when it is complete and closed (no extra keys), `applies` is true, `confidence` is
at least `minConfidence`, the verdict follows from its own yes/no fields, and a FAIL points at a region inside the
image. Otherwise the rule is `UNGRADED`: `NO_VISION_OUTPUT`, `OUTPUT_INVALID`, `NOT_APPLICABLE`, `LOW_CONFIDENCE`,
`INCONSISTENT_OUTPUT`, `NO_EVIDENCE`. Several independent answers (judges) that disagree give `JUDGES_DISAGREE`.
Machine facts outrank vision where vision is blind and block a PASS they contradict (`MACHINE_VISION_DISAGREE`).

### U7 `empty-state-dead-end`

- **Signal**: the canonical PNG of the empty state, with machine facts: the empty response was forced
  (`forcedEmpty`), the list selector and its measured item count.
- **Condition**: the main list or content area shows no items (`applies`). Fields `explains` (says it is empty or
  why) and `offersAction` (a visible next step: create, import, clear filters, search, go elsewhere, or an
  instruction). FAIL when it neither explains nor offers an action (the BA wording); with `requireAction`, FAIL
  whenever no action is offered.
- **Threshold**: `minConfidence` = `0.7`; `requireAction` = `false`.
- **UNGRADED**: the vision codes above; `NOT_APPLICABLE` when the screen is not empty (a forced empty that did not
  reach the screen leaves a required U7 UNGRADED).
- **Default level**: `warn`.

### U8 `destructive-unguarded`

- **Signal**: the PNG right after the destructive control was activated, with `uxDestructiveContext({before, after,
  action, dialogHandled})`: a dialog opened, an undo control is visible, Dragon handled a native confirm.
- **Condition**: the control deletes, removes, discards or overwrites (`applies`). Fields `confirmation` and `undo`.
  FAIL when there is neither. A native `confirm()` (Dragon `do.dialogHandled`, invisible in screenshots) is a
  confirmation and passes without vision; a vision FAIL against a dialog or undo the machine saw is
  `MACHINE_VISION_DISAGREE`.
- **Threshold**: `minConfidence` = `0.7`.
- **UNGRADED**: the vision codes above.
- **Default level**: `warn`.
- Destructive actions run only on test data with an approved plan (`NEEDS_APPROVAL` otherwise). Dragon answers a
  native confirm with Cancel by default, so a guarded delete deletes nothing.

### U10 `diacritics-clipped`

- **Signal**: `__uxObserve().diacritics`: visible text with Vietnamese marks (capital letters with a mark above the
  cap height, the letters of the Vietnamese extension block U+1EA0–U+1EF9, U+0110, U+0102, U+01A0, U+01AF), each with
  its box, font size, line height, the box that clips it (`self` or `ancestor`) and the glyph ink outside that box
  measured with canvas text metrics (`overflowTopPx`, `overflowBottomPx`, `clipped`). The candidates become regions
  of the vision request (scaled to image pixels); the PNG is the verdict.
- **Condition**: Vietnamese text with such marks is visible (`applies`). Field `clipped`: a mark above or a dot
  below is cut by its box, line or container. FAIL when clipped. A vision PASS against a machine-measured clip is
  `MACHINE_VISION_DISAGREE` (never PASS); a vision FAIL stands even when the pre-screen saw no clip (it cannot see
  every clip, for example in inline boxes, which are listed but not measured).
- **Threshold**: `minConfidence` = `0.7`; `inkTolerancePx` = `1` (ink more than this outside the clip box counts as
  clipped in the pre-screen; pass the same value as `__uxObserve({inkTolerancePx})`).
- **UNGRADED**: `NO_DIACRITIC_TEXT` (no such text on screen: vision is not asked), and the vision codes above.
- **Default level**: `warn`.
- Probe text with stacked marks is entered through the GUI (trusted typing) or comes from seeded test data; the
  locale can be forced with `envSet {locale:"vi-VN"}` (it changes `Intl` only).

## Forced states (environment layer only)

| Rule | Force with Dragon | Observe |
|---|---|---|
| U1 slow, U2 | `envSet {tabId, caseId, requests:[{id:"write", urlPattern:"*/api/<endpoint>*", method:"POST", action:"hold"}]}` | `__uxObserve({trigger})` before; trusted click; `wait 1200`; `__uxObserve({trigger})` during; `envGet` (held must list it); optionally a second trusted click and `envGet` again; `envRelease {tabId, ruleId:"write"}`; `__uxObserve` + Gate-0 after the result |
| U3, U4 (server error) | `envSet {requests:[{id:"save-error", urlPattern, method:"POST", action:"respond", status:500, body:{...}, times:1}]}` (or `action:"fail", errorReason:"TimedOut"`) | fill with trusted input; `__uxObserve` before the submit; submit; `waitFor` the error; `__uxObserve` + a11y sweep; `envGet` |
| U7 | `envSet {requests:[{id:"empty", urlPattern, method:"GET", action:"respond", status:200, body:<the app's own empty shape>}]}`, a test account with no data, or a search for a word that does not exist (through the GUI) | navigate or reload through the GUI; canonical PNG; vision request with `forcedEmpty` |
| U10 | `envSet {locale:"vi-VN"}` plus probe text typed through the GUI | `__uxObserve` candidates; canonical PNG; vision request |

Every forced condition is recorded by Dragon in `receipt.env.conditions`. End every case (also one that ends early)
with `envReset {tabId}` and check `atDefault:true`; `ENV_RESET_UNVERIFIED` means the case cannot PASS. The hold also
keeps a loading state still, so Gate 0 and the vision pass can grade that loading state like any settled state.

## Dragon reads and actions used

| Name | Kind | Used by |
|---|---|---|
| `read` (in-page, MAIN world) | read (accepted today) | `__uiSanity`, `__a11yB`, `__uxObserve` |
| `env.get` / MCP `envGet` | read (new, R1a) | U1 (pending time), U2 (held, duplicate), U3 (forced error) |
| `sensors.read` / `sensorsRead` | read (new, R1a) | U1 (first visible change, optional) |
| `paintSnapshot` | read (new, R1a) | U6, U9 paint-order path (optional) |
| `env.set`, `env.release`, `env.reset` / `envSet`, `envRelease`, `envReset` | action (new, R1a) | forced states above |
| `sensors.start`, `sensors.stop` / `sensorsStart`, `sensorsStop` | action (new, R1a) | U1 sensor path |
| `do.dialogHandled` | field of the `do` result (accepted today) | U8 native confirm |

The shapes are those of `r1a-environment-and-sensors.md` (Dragon). The tests grade outputs recorded from Dragon's
env-controller on the fixture screens (`test/fixtures/ux-rules/recorded/`).

## Fixtures

`test/fixtures/ux-rules/`: one screen per defect and its clean twin: `u1-defect` (a save with no visible feedback),
`u1-slow-defect` (no progress while pending), `u1-clean`; `u2-defect` (button stays clickable, a page bar only),
`u2-clean`; `u3-defect` (a 500 resets the form), `u3-clean`; `u4-unlinked`, `u4-far`, `u4-clean`; `u5-defect` (toast
outside any live region), `u5-clean`; `u6-defect` (focused field under a fixed header), `u6-clean`; `u7-defect`
(bare empty table), `u7-clean`; `u8-defect` (delete at once), `u8-clean` (confirmation dialog); `u9-defect` (button
half covered), `u9-clean`; `u10-defect` (stacked marks cut by a tight chip), `u10-clean`. The vision answers in the
tests are synthetic structured outputs; they test the grader and the prompt contract, not a vision model.
