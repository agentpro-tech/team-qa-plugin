# Transient defects: the probe and rules T1–T8 (upgrade R1d)

A settled-state screenshot misses defects that live for a fraction of a second after an action: a layout jump, a
toast over the Save button, a flash of "No items", a scrollbar during a transition, a button that can be clicked
twice. The probe records a short window around each risky action with Dragon's R1a sensors and native frames, and
the T rules judge that recording by machine. The VLM only looks at a few keyframes for meaning.

- Code: `scripts/lib/transient-probe.mjs` (when, the window, kept frames, keyframes, receipt, grader, Dragon driver),
  `scripts/lib/transient-rules.mjs` (T1–T8, confirmation, schedules), `scripts/lib/dragon-env.mjs` (the Dragon R1a
  surface QA GUI accepts).
- Dragon interface: Dragon `docs/r1a-environment-and-sensors.md` (`help.environmentContract`), lane build
  `1.6.9-qa.f108af9` or later.
- Findings belong to the **UI verdict**. The Function/UI two-verdict contract does not change.
- HR1 holds: every action and observation goes through Dragon. Nothing is injected into the page and the page clock is
  never faked; forced states (CPU, network) exist only at the environment layer and are recorded as conditions.

## 1. When the probe is on

`classifyAction(action)` decides from the action type and DOM facts the executor reads before acting
(`qa-gui.mjs probe classify --in <action.json>`). Labels match whole words in English and their Vietnamese equivalents.
The probe runs when any kind applies:

| Kind | Fires on |
|---|---|
| `submit` | a submit button, a button in a form without `type`, Enter in a form field, labels such as Submit, Send, Sign in, Checkout, Confirm, Continue |
| `save` | Save, Update, Done, Publish |
| `delete` (+ `list-remove` in a list) | Delete, Remove, Discard, Trash, Archive |
| `toast` | a write on a page with a toast region, or Copy, Undo, Share |
| `list-add`, `list-sort`, `list-filter` | Add/New/Create in a list; Sort or a column header; Filter/Search, typing in a search box, a toolbar select |
| `route-change` | a same-origin link (not `#…`), `role=link` |
| `overlay-open`, `overlay-close` | `aria-haspopup`, `aria-controls` naming a dialog, `popovertarget`; Close/Cancel in a dialog, Escape |
| `disclosure` | `summary`, `aria-expanded`, `role=tab`, `aria-selected` (accordion, tab) |
| `theme-locale` | theme, dark, light, language, locale |
| `drag-drop`, `scroll-load` | a drag; a scroll on an infinite list, Load more, Show more |

## 2. The window

```
sensors.start ──150 ms── frames.start ── read(s-pre) ─100 ms─ ACTION ─ reads at +16 +50 +100 +250 +500 +1000 ─┐
                                                       (mark)                                                  │
   window: mark −100 ms ………………………………………………………………………… +1000 ms, then +250 ms steps while extended, never past +3000 ms
```

1. `sensors.start {tabId, watch: PROBE_WATCH}`: Dragon's default watch list plus the state surfaces the rules follow
   (empty/error states, toasts, tooltips, banners, drawers, busy indicators). Sensors start before the action; the
   IntersectionObserver needs ~100 ms to report the state before it.
2. `frames.start {maxWidth: 480, quality: 50, everyNthFrame: 1, maxMs: 4000, maxFrames: 600}` just before the action:
   high frequency, low resolution, behind the privacy mask.
3. One `do`: the geometry sample `sampleRead({targetSelector})`, `wait 100`, the action step, then a sample at each mark.
   The sample is a read-only `read` (MAIN world): page horizontal overflow (only when the page can scroll sideways), text
   clipped without an ellipsis, the target's clickable state (`disabled`, `aria-disabled`, `aria-busy`, `pointer-events`,
   `inert`), visible busy indicators, focus and scroll, stamped `performance.timeOrigin + performance.now()`.
4. The mark is the trusted `pointerdown`/`keydown` the sensors saw (Dragon also marks the frame window at dispatch).
5. From +1000 ms the window closes unless the network is still busy (`waitForNetworkIdle {idleMs:100}` timed out) or an
   anomaly is open (an occlusion not over yet, overflow in the latest sample, the page changing in the last 150 ms;
   busy indicators excluded). Each extension waits 250 ms and takes one more sample. Cap: +3000 ms. The open-anomaly
   extension goes beyond the BA's "while the network is busy" and is accepted because it only adds observation: an
   anomaly that starts near +1000 ms is seen to its end (the +1000 ms canaries need it). The receipt records why a
   window was extended (`window.reason`: `network-busy` or `anomaly-open`).
6. `sensors.read` from the start of the sensor session; `frames.stop {keep, edges:true, maxKeep:24}` where `keep` is
   the ranges around every anomaly the rules found (±50 ms, at most 600 ms each), or, with no anomaly, around the first
   and the last DOM change. Dragon never keeps a duplicate frame and adds the clean frame on screen at the mark and the
   last frame. Frames not kept never leave Dragon's memory.
7. `getNetwork {types:["XHR","Fetch"]}` (response times) and `env.get {readback:false}` (conditions, held requests).
8. Repeat the action at real speed (3 times by default; the caller restores the page between repeats, a write is
   repeated only on an approved plan). An action the plan does not approve repeating runs once with
   `repeatable:false` (`runTransientProbe({repeatable:false})`, receipt `action.repeatable:false`; see section 5).
   `sensors.stop` at the end; the case ends with `env.reset` as every case does.

`runTransientProbe({rpc, binding, tabId, step, targetSelector, action, repeats, restore, fast?})` does all of this over
Dragon RPCs. A click `step` is sent with `fast:false` unless `fast` (the R3 fast-click plan, `fastClickAllowed`) is true. `schedule:'all'` keeps every frame and `schedule:'fixed7'` runs without sensors (frames at the marks only); both
exist to measure the schedules (section 6).

**Keyframes for the VLM.** `selectKeyframes(trial)` picks 3–6 kept frames of one trial (the first with an anomaly):
the frame after each anomaly starts, its middle and the frame after it ends; with fewer candidates, an even spread of the
kept frames, or all of them when fewer than 3 frames after the mark exist (Chrome sends a frame only when the screen
changes). The clean frame (Dragon's edge frame at the mark) is always shown beside them. The VLM grades meaning only
(C10 overlap, C16 "a user would call it broken"); geometry and timing are measured by the rules.

**Milliseconds added.** `addedMs(trial)` = the probe's RPC time (sensors.start, frames.start, frames.stop, sensors.read,
the sample reads, the window decisions) plus the wait past the moment the page settled (its last DOM change or write
response, plus 100 ms). The receipt keeps it per trial; section 6 has the clean-screen measurement.

## 3. The probe receipt `qa-gui/transient-probe/v1`

`qa-gui.mjs probe build --in <{caseId, state, action, trials}.json> --out <probe.json>` writes it;
`qa-gui.mjs probe grade --in <probe.json>` prints what the gate computes.

```json
{
  "schema": "qa-gui/transient-probe/v1", "caseId": "TC-04", "state": "after-save",
  "action": { "label": "Save", "method": "click", "selector": "#save", "kinds": ["save", "toast"], "reasons": ["save:label", "toast:..."], "repeatable": true },
  "plan": { "windowBeforeMs": 100, "windowAfterMs": 1000, "windowMaxMs": 3000, "extendStepMs": 250,
    "sampleOffsetsMs": [-100, 16, 50, 100, 250, 500, 1000], "schedule": "events" },
  "trials": [{
    "index": 0, "markT": 1793797092636.4,
    "conditions": { "v": 1, "caseId": "TC-04", "role": "test", "...": "Dragon env.conditions at the trial" },
    "window": { "from": 1793797092536.4, "to": 1793797094121.0, "extended": true, "reason": "anomaly-open" },
    "sensors": { "startedAt": 1793797091900.2, "streams": { "layout-shift": "cdp", "animation": "cdp" }, "gap": false, "overflow": 0, "pageDropped": 0 },
    "viewport": { "vw": 800, "vh": 600 },
    "events": ["Dragon sensor events of the trial, plus the last known state per target of the same document"],
    "samples": [{ "t": 1793797092652.9, "overflowX": false, "clipped": [], "target": { "found": true, "disabled": true }, "busy": 0, "sy": 0, "active": "form#f>button#go" }],
    "network": [{ "t": 1793797093336.0, "method": "POST", "url": "http://host/api/save", "status": 201 }],
    "held": [],
    "frames": { "ok": true, "windowId": "fw-…", "startedAt": 0, "guardFrom": 0, "stoppedAt": 0, "marks": [], "counts": {},
      "keep": [{ "from": 0, "to": 0 }], "index": [{ "seq": 1, "t": 0, "len": 3212, "hash": "0b6307…", "dup": false, "kept": true }],
      "kept": [{ "seq": 1, "t": 0, "reason": "edge", "file": "f-00001.jpg", "sha256": "…" }] },
    "timing": { "sensorsStartMs": 23, "framesStartMs": 20, "samplesMs": 86, "decisionsMs": 212, "sensorsReadMs": 1, "framesStopMs": 3, "wallMs": 1674 }
  }],
  "keyframes": { "trial": 0, "clean": { "seq": 2, "t": 0, "reason": "edge", "file": "f-00002.jpg", "sha256": "…" }, "frames": [{ "seq": 3, "t": 0, "...": "3 to 6" }] },
  "overhead": { "addedMs": [912, 905, 899], "meanMs": 905, "medianMs": 905 },
  "rules": { "T2": { "verdict": "FAIL", "reason": "CONFIRMED", "k": 3, "n": 3, "mark": 305, "episode": { "sub": "occlusion", "subject": "…", "durationMs": 701 } } },
  "verdict": "FAIL",
  "vision": { "verdict": "PASS", "rule": "C16", "frames": [3, 5], "note": "optional: the VLM on the keyframes" }
}
```

- **Frames kept**: `trials[].frames.kept` (and the window directory Dragon wrote them to); `index` lists every buffered
  frame with its hash, kept or not. **Timestamps**: every `t` is unix-epoch ms on Dragon's one clock (sensor events,
  frames, samples, marks); `markT` is the action. **Milliseconds added**: `overhead.addedMs` per trial.
- `rules` and `verdict` are informational: the gate re-runs the rules on `trials` and never reads them.
- A state receipt names the probe: `probes: [{"kind": "transient", "path": "<probe.json>", "sha256": "<file sha256>"}]`
  (the probe registry R1e introduced), the file in the evidence manifest, and the state's `env` block
  (`references/state-receipt-v1.md`): a transient probe ran sensors and frames, so the case must end with a verified
  `env.reset`.

## 4. The rules

Every threshold is a public starting point (named in `T_DEFAULTS`): Layout Instability's 3 px, RAIL's 100 ms response,
the 300 ms bounds of the R1d proposal, WCAG 2.3.1's three flashes, the 100 ms long frame of GUIWatcher. None was fitted
to eval data; the eval calibrates them on its dev sets and pre-registers them (EV2).

**Condition absent.** A rule whose condition never occurred in any repeat (no toast appeared, nothing animated, no write
was pending) is `UNGRADED` with `CONDITION_ABSENT`, never `PASS`. That reason alone does not change the probe's verdict.

| Id | Rule | Signal | Threshold (default) | Condition (else UNGRADED CONDITION_ABSENT) | Level |
|---|---|---|---|---|---|
| T1 | layout jump | `layout-shift` sources (CDP PerformanceTimeline or the isolated world) inside the window; shifts flagged `hadRecentInput` count | a source in the viewport moves ≥ 3 px; not counted: sources below the click point after an expansion the user made (`disclosure`, `list-add`, `list-remove`) within the input's 500 ms | the DOM changed after the action; `LAYOUT_SHIFT_UNSUPPORTED` when the browser reports none | block |
| T2 | transient occlusion | IntersectionObserver v2 on watched controls: `visible:false` while intersecting, after being visible; an overlay (dialog, alert, status, tooltip, menu, toast/snackbar/popover/banner/modal/drawer) that appeared after the action, whose box overlaps the control's | covered ≥ 300 ms | an overlay appeared; `VISIBILITY_V2_UNSUPPORTED` without v2 | block |
| T3 | wrong-state flash | an empty/error/no-results/not-found/alert node (not a busy indicator) appearing (ResizeObserver or IntersectionObserver) and going away (hidden, size 0, or removed under its parent); a root (`html`/`body`) class/theme attribute flipped twice where the frames show the screen return to the exact image before | shown < 300 ms (longer is a real state) | the DOM changed after the action | block |
| T4 | overflow during a transition | the geometry samples: page horizontal overflow (when the page can scroll sideways) or text clipped without an ellipsis | in ≥ 2 consecutive samples after the action, absent before the action and in the last sample (still there = a static defect, A6/A1) | the DOM changed; `SAMPLES_MISSING` with fewer than 2 samples | block |
| T5 | double-click window | a POST/PUT/PATCH/DELETE answered after the action (or held by an `env.set` rule) and the samples of the target | the target is clickable (not disabled, aria-disabled, aria-busy, pointer-events:none, inert) and no busy indicator is visible at a sample > 100 ms after the click while the request is pending | a submit/save/delete action with a write request; `TARGET_UNSAMPLED` when samples lack the target | block |
| T6 | lost focus, scroll position, size oscillation | focus events after an overlay closed or the focused node left the DOM; document scroll events; ResizeObserver sizes of watched nodes | focus on the body ≥ 100 ms; the page scrolled up ≥ max(200 px, 50% of the viewport) after a DOM update (not after a route change or a scrolling key); ≥ 2 reversals of ≥ 2 px in one dimension | an overlay closed, the page was scrolled ≥ 200 px, or a watched node resized | block |
| T7 | jank | long-animation-frame entries overlapping an animation or a scroll | a frame ≥ 100 ms | something animated or scrolled | **warn** (always) |
| T8 | animation lint | animation events (CDP Animation or the isolated world), root/attribute toggles, the frame index | warnings: one iteration > 500 ms, a transition of a layout property (width, height, top, margin, padding, font-size, …), an endless CSS animation (busy indicators excepted), any motion > 100 ms under `prefers-reduced-motion: reduce`. FAIL: the screen returns to the image two frames before more than 3 times within 1 s while an animation runs faster than 3 a second or an attribute toggles faster | something animated | **warn**, except flashing (block) |

T3 (theme flash) and T8 (flash) read the frame index. Without a frame window, T3 cannot confirm a theme flip-flop (it
reports nothing for it) and T8 reports `FRAMES_MISSING` when a fast animation or toggle exists. A window whose frames
around the mark were dropped for privacy (Dragon `privacyUnverified`/`privacyDropped`, not the `maxKeep` spread), or a
refused window (`C2_MASK_FAILED`), makes T3 and T8 `UNGRADED PRIVACY_GAP` for that action, never PASS (curator
decision 5 applies to these frame rules only; the sensor and sample rules T1, T2, T4–T7 grade the same window).

Not measured by machine: movement by `transform` alone (the layout-shift API does not count it; the keyframes may show
it), WCAG 2.3.1's area condition (any flashing screen region counts, which is stricter), text covered by an overlay
(controls only; text is left to the VLM).

## 5. Confirmation: k of n

A transient finding becomes FAIL only when the action was repeated at real speed and the anomaly appears again at the
same mark. Per rule, over the repeats:

- **Real speed**: no CPU throttle and no animation playback rate in the trial's `conditions` (a network condition does
  not slow the page clock). CPU-throttled repeats (`env.set {cpu:4..6}`) only show where to look.
- **Same anomaly, same mark**: the same sub-rule and subject (element descriptor; for a CDP layout-shift source, the box
  it moved from) with its onset within max(100 ms, 20%) of the first one's offset from the action.
- **FAIL** when k ≥ 2 of n ≥ 3 real-speed repeats (`CONFIRMED`; `k/n` and the mark in ms are reported). The 2-of-3
  default (`confirmRepeats`, `confirmMinK` in `T_DEFAULTS`) is a setting fixed at the eval's pre-registration.
- **An action that cannot be repeated** (no approved plan for repeats, typically a write; receipt
  `action.repeatable:false`): an anomaly seen in fewer than 3 real-speed trials is **WARN `UNCONFIRMED_SINGLE`**
  (k/n as seen, normally 1/1). It is a finding that reports what was seen, not UNGRADED, and it does not block a PASS
  by itself: saves are the most common risky action, and a missing approval must not turn their cases UNGRADED.
- **A repeatable action** (the default): **UNGRADED `REPEATS_REQUIRED`** when the anomaly was seen and fewer than 3
  real-speed repeats exist (also when only slowed repeats exist): repeat it. **WARN `TRANSIENT_UNCONFIRMED`** when it was
  seen once in ≥ 3. **WARN `SLOWED_ONLY`** when only throttled repeats showed it and ≥ 3 real-speed repeats did not.
- A warning rule (T7, the T8 lint) is **WARN `WARNING_ONLY`** whenever it fires.
- **PASS** when the condition occurred and nothing was found; **UNGRADED** with the reason when it could not be graded
  (`PRIVACY_GAP`, `FRAMES_MISSING`, `SAMPLES_MISSING`, `TARGET_UNSAMPLED`, `LAYOUT_SHIFT_UNSUPPORTED`,
  `VISIBILITY_V2_UNSUPPORTED`).

The probe's verdict, joined into the state's UI verdict: **FAIL** if a rule FAILs (or the optional `vision` says FAIL);
**UNGRADED** if a rule is UNGRADED for any reason other than `CONDITION_ABSENT`, or a structural check fails; **PASS**
otherwise. Warnings never change it; they are listed (`TRANSIENT_<rule>:<sub>:<k>/<n>@<ms>ms:<reason>`).

**Gate codes** (`PROBE:<case>:<state>:<code>`): `TRANSIENT_<rule>:<sub>:<k>/<n>@<ms>ms` (FAIL),
`TRANSIENT_<rule>_<reason>:<k>/<n>` (UNGRADED), and the structural checks, all UNGRADED: `TRANSIENT_PROBE_INVALID`,
`TRANSIENT_TRIAL_INVALID`, `TRANSIENT_WINDOW_SHORT` (closed before +1000 ms), `TRANSIENT_WINDOW_LONG` (past the
cap), `TRANSIENT_EXTENSION_UNEXPLAINED` (extended without `network-busy`/`anomaly-open`), `TRANSIENT_SENSORS_LATE`
(sensors started less than 100 ms before the action), `TRANSIENT_SENSORS_GAP` (Dragon reported a gap, overflow or
dropped page events), `TRANSIENT_FRAMES_LATE` (frames guarded from less than 100 ms before the action),
`TRANSIENT_CONDITIONS_INVALID`, `TRANSIENT_EVIDENCE_TAB` (a `role:"evidence"` tab grades nothing),
`TRANSIENT_KEYFRAMES_INVALID` (more than 6, not kept, or not after the mark), `TRANSIENT_VISION_INVALID`. The registry's
own codes (`PROBE_NOT_IN_MANIFEST`, `PROBE_HASH_MISMATCH`, …) apply as for every probe kind.

## 6. Observation schedules

Four ways to observe the same action, as views over one recording (`gradeTransientRules(trials, {schedule})`,
`scheduleMetrics`, `scheduleFrames`, `overheadSummary` in `scripts/lib/transient-rules.mjs`):

| Schedule | Observes |
|---|---|
| `stable` | the settled state only (today's baseline): an anomaly counts only if it is still there when the window closes and a settled-state check would see it (an occlusion) |
| `fixed7` | point observations at the 7 sample marks (−100, +16, +50, +100, +250, +500, +1000 ms, plus extensions): the geometry sample and the frame on screen; no sensor stream (T7, T8 and the theme flash need it); an occlusion needs two marks ≥ 300 ms apart inside it, a size oscillation three marks |
| `events` | the probe: the marks plus the continuous sensor stream and the frame index, frames kept around the events |
| `all` | every frame kept and shown (the cost ceiling) |

For each schedule the comparison reports four numbers: dynamic defects caught (and caught additionally over `stable`),
frames per action, milliseconds added per action, and false alarms on clean screens. The eval picks the schedule at the
Pareto point on its dev data, not the one that catches most; the numbers below are this repository's fixtures only and
pick nothing.

Measured on the recorded canaries (36 defect variants: 12 canaries × 3 onsets; 36 clean twins; 3 real-speed repeats
each; Chromium 153, Dragon 1.6.9 R1a controller over a Playwright CDP session; overhead: 5 repeats per schedule on the
clean `none` page, the action without a probe settles in a median 146 ms):

| Schedule | Caught (of 36) | Caught additionally over `stable` | Frames per action | ms added per action (median) | False alarms (36 clean screens) |
|---|---|---|---|---|---|
| `stable` | 0 | 0 | 0 | 0 | 0 |
| `fixed7` | 19 | 19 | 2.5 | 1130 | 0 |
| `events` | 36 | 36 | 5.8 | 1146 | 0 |
| `all` | 36 | 36 | 6.6 | 1142 | 0 |

Per canary, `fixed7` misses T2 and T3 at +300 ms (the anomaly falls between two marks or spans less than the
two marks it needs), the theme flash, the size oscillation, T7 and T8 (they need the sensor stream or every frame);
`events` and `all` catch all of them. `all` adds no machine catch over `events`: Dragon's frame index lists every
frame either way, so the difference is the frames kept for the VLM (Chrome sends a screencast frame only when the
screen changes: 8.5 buffered frames per window here; the default probe kept 7.0 per defect action and 5.0 per clean
one, edges included). The milliseconds are dominated by the window itself (+1000 ms after the action, longer when
extended); the RPCs add tens of ms. The receipt's own estimate (`addedMs`, wait past the settled page plus RPCs) has a
median of 782 ms on the same recordings. Recorded locally, not through the extension: the `chrome.debugger` and bridge
hops are not included.

## 7. Canaries

`test/fixtures/r1d/canary.html?s=<scenario>&at=<ms>[&clean=1]`: one defect per scenario, starting `at` ms after the
click (100, 300, 1000), and its clean twin (same action, no defect). Scenarios: T1 a notice pushes the form down; T2 a
toast covers the button for 700 ms; T3 "No items" for 150 ms before the list; T3theme a dark page flips light for
120 ms; T4 a 1100 px block for 800 ms in an 800 px viewport; T5 the submit button re-enabled while its POST is pending;
T6focus a dialog removed with its focused button; T6scroll the list emptied and refilled; T6size a status that toggles
Saving/Saved four times; T7 a 150 ms busy loop during a slide; T8flash a banner blinking 5 times a second; T8lint a
600 ms height transition. Clean twins: a reserved slot, a corner toast, a skeleton, one theme switch, a wrapped block,
disabled until the response, focus back on the trigger, rows updated in place, one Saving/Saved change, no busy loop, a
single fade, an opacity transition.

`test/fixtures/r1d/recorded/<scenario>.json.gz` holds three real-speed repeats per onset and per twin, recorded in
Chromium through Dragon's own R1a controller (`extension/env-controller.js`) over a Playwright CDP session, with this
probe driver; `overhead.json` holds the clean-screen measurement. `test/transient-canary-r1d.test.mjs` grades them on
every run; with Playwright and `DRAGON_APP_DIR` it also runs two canaries live. Refresh after a change to the probe, the
canaries or Dragon R1a:

```
DRAGON_APP_DIR=<Dragon checkout>/apps/dragon-browser node test/support/record-r1d-canaries.mjs
```

Limits of the recordings: the privacy mask provider is a stub (the page has no secret or PII field), and the
extension's `chrome.debugger` and bridge hops are not in the measured milliseconds.
