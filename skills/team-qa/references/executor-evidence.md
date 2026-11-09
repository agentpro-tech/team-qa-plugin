# The GUI Executor's evidence draft (TEAMQA_EVIDENCE_DRAFT v1)

Applies to per-case dispatch on the `claude -p` route (`roster.mjs dispatch --case-id`). The executor writes no files. At the end of
its turn, the executor prints exactly one draft for its case: one line `TEAMQA_EVIDENCE_DRAFT v1`, directly followed by one
```` ```json ```` block. The root runs `teamqa web collect --run <id> --attestation <attestation> --board <canonical board>`: the command only reads
the stream bound to the executor's own attestation, copies the images and videos, writes the state receipts and updates the case on the board. Every measurement
and raw output comes from the tool results in the stream, not from the text of the draft.

The executor uses only the Dragon tools and Read. Do not call Bash or any shell command, not even to read a large saved result: a
refused command makes the whole dispatch turn unattested (`ROLE_RUNTIME_UNATTESTED TOOL_FAILED`) and the case must run again. A large result
saved to a file is read with Read (with `offset`/`limit`).

Each dispatch creates a new Dragon session with a `sessionId` never used before, for example by adding the current hour and minute to the name.
The `sessionId` of an earlier dispatch (including a broken one) has a locked policy: `session.create` again with that name returns
`POLICY_LOCKED` without a `nonce`, and the case cannot run.

First, prove the build on your own tab (deployed target). On the Dragon session the executor itself created
(`session.create`), open a tab on the target's exact `preview_url` with
`openTab` `{sessionId,nonce,browserInstanceId,url:<preview_url>,proveIdentity:true}`. Dragon then makes the three identity reads
on the new tab inside that call and answers with `identity:{ok:true,page,network,tab}`: that is the proof, and you make no other
identity read. Make the three reads yourself, through `mcp__Dragon_Browser__dragon_rpc`, one command at a time, within 300 seconds,
before any `screenshot`, only when the answer has no `identity` (a Dragon without it) or `identity.ok` is not true or the app
needs a sign-in before it calls the backend (log in, reload the tab, then read):

1. `getPageIdentity` `{sessionId,nonce,browserInstanceId,tabId}`
2. `getNetwork` `{sessionId,nonce,browserInstanceId,tabId,summary:true}`
3. `getTabInfo` `{sessionId,nonce,browserInstanceId,tabId}`

These must be the first three page reads on that tab, with no other parameters, and the tab must still be on the exact `preview_url`.
A missing or wrong sequence (a build different from the target, no 2xx/3xx request to the backend, a screenshot first) rejects the whole
dispatch turn and the case becomes ungraded.

Then, for each state to grade, follow exactly this order on the tab of the Dragon session the executor created:

1. Take a screenshot with Dragon (`screenshot`) with a separate `toFile` for that state, for example `TC-02-after-save.png`, on the
   tab where you read the page identity. Do not pass `domHash:false` or any parameter that removes `dom` and `domHash` from the
   result: the state receipt needs the page URL and the DOM hash of the image; without them the state becomes UNGRADED
   (`SCREENSHOT_DOM_MISSING`). A screenshot of another tab has no measured build and QA GUI refuses it (`EVIDENCE_IMAGE_BINDING`).
2. Run Gate-0 (ui-sanity, a11y) with one `do`/`runFlow` command that has a `read` step (`as: "g0"`) if the plan requires UI. In
   the same command add a `read` step that returns the element under test as `{selector, rect:{x,y,width,height}}` from
   `getBoundingClientRect()` (for example `as: "target"`) and name that label in the draft's `target`. A state with
   function assertions and no target cannot PASS under QA GUI's evidence policy (`EVIDENCE_IMAGE_TARGET_MISSING`).
3. Call `getConsole`, then `getNetwork` (without `summary`).
4. Behavioral case: `startRecording {sessionId,nonce,browserInstanceId,tabId,quality:50,maxWidth:960,maxHeight:960}` on the same tab
   before the first action, every action through Dragon trusted input (`do` steps or the action methods, so the recording and
   the action receipts carry the action times), then `stopRecording` and `assembleRecording` after the last action.

Test data the app refuses by a rule it states is not a defect of the app. When a field shows a message that states a
format (for example "Code must be uppercase letters, numbers, and underscores") and the plan's value breaks it, capture
that state (it is the validation evidence), then type the closest value that meets the stated rule (`QA-R1-001` becomes
`QA_R1_001`), say so in `lifecycle.action`, and finish the case with that value. Propose a defect only when the stated rule
contradicts the requirement or the message does not fit the value. Never stop a case only because a planned value broke
such a rule.

The executor does not see the `tool_use` id of the commands it calls, so the draft records no ids. The draft names the screenshot of each
state by the exact `toFile` that was passed. Team QA takes the Gate-0, `getConsole` and `getNetwork` of that state as the first
successful command of each kind on the same tab, after that screenshot and before the screenshot of the next state. The recording
is the last successful `assembleRecording` in the stream and the `stopRecording` right before it. So finish
steps 2–3 of one state before capturing the next state; when the same `toFile` is captured again, the last successful capture is
used.

```json
{
  "case_id": "TC-02",
  "summary": { "function": "Function conclusion, one short paragraph", "ui": "UI conclusion, one short paragraph" },
  "lifecycle": { "before": "…", "action": "…", "network": "…", "readback": "…", "refresh": "…", "postcondition": "…" },
  "recording": true,
  "states": [
    {
      "state": "tc02-after-save",
      "screenshot": "TC-02-after-save.png",
      "gate0": "g0",
      "target": "target",
      "action": "view",
      "rows": "rows",
      "console": true,
      "network": true,
      "assertions": [ { "assertion_id": "TC-02-A1", "verdict": "PASS", "note": "…" } ],
      "vision": [ { "rule": "C10", "verdict": "PASS" }, { "rule": "C11", "verdict": "FAIL", "note": "…" }, "… all of C10–C16" ]
    }
  ],
  "defects": [ { "title": "…", "state": "tc02-after-save", "steps": ["…"], "expected": "…", "actual": "…" } ],
  "blocked": false
}
```

- `verdict` is only `PASS`, `FAIL` or `UNGRADED`. When something cannot be measured, record `UNGRADED`; do not guess.
- A field left empty (no `gate0`, `console`, `network`, `recording`) makes that part UNGRADED with a reason. So does a missing
  screenshot with that `toFile`, no successful command of the same kind within the state's window, or a command that did not
  succeed. Do not invent file names or ids.
- `vision`: each state gives all seven QA GUI rules C10–C16 (the "Tier C" table in QA GUI's `SKILL.md`:
  C10 overlap, C11 broken or distorted image, C12 off-theme color, C13 text and spacing, C14 all declared states were viewed,
  C15 dark mode, C16 what a normal user would call broken). Grade with the captured image itself (open the PNG file with Read). A
  rule that cannot be graded records `UNGRADED` with a `note`; a missing rule also becomes `UNGRADED`, and a case with an `UNGRADED` vision
  has no official verdict yet. When the app has no dark mode, C15 records `PASS` with the `note` "no dark mode" (QA GUI's vision v2
  assertion has no `WAIVE`). Rule names other than C10–C16 are dropped; other remarks go into `assertions` or
  `summary`.
- When the dispatch prompt has a `TEAMQA_SPEED` section (speed flags the signed plan set `on`, see
  [speed flags](speed-flags.md)), follow it: it may let you set `fast:true` on clicks, or write `"vision": "inherit"`
  for a state instead of the seven verdicts. Without that section, nothing here changes.
- When the dispatch prompt has a `TEAMQA_DETECTORS` section (QA GUI's detectors this case runs; QA GUI
  `references/team-qa-detectors.md`), follow its recipes with Dragon calls only and keep the `as` labels exactly: Team
  QA rebuilds every probe from them. Its page helpers are defined once from QA GUI's helper pack (`helpersDefine
  {"pack": {"path", "sha256"}}`: never type a body), loops (`{"forEach": ...}`) are sent as written, and every detector
  read is a `{"call": <helper>}` step: a read whose result does not name QA GUI's helper is `DETECTOR_HELPER_MISMATCH`
  (UNGRADED). On the state each one belongs to, say what ran: `"transient": {"action": {...}}` (the probe of the action
  that led to this state: one `framesTrial` call per trial, labelled `"correlationId": "transient:<state>"`, each with
  its setup, after `stopRecording` and the case's `envReset`; QA GUI decides how many trials an action gets, so do not
  claim it is not repeatable), `"ux": ["U1","U2"]` (the
  U rules you forced a state for), `"explore": true` (the exploration, after the last state). The probe runs when the
  case's main action is risky. Call `help` once before any R1a tool; its result is saved to a file with a preview: a preview
  that begins `{"r1a":` means R1a is here (Dragon 1.7.0; an older build with no preview of it: Grep the file for
  `environmentContract`). Otherwise Dragon has no R1a: call no R1a tool, skip only the probe and the forced U
  states and write `"detectors": {"unavailable": {"transient":
  "DRAGON_R1A_UNAVAILABLE", "ux": "DRAGON_R1A_UNAVAILABLE"}}` instead of skipping them silently; the forced U rules
  then say UNGRADED with that reason and the case is graded as before. `web collect` honours the claim only when the
  stream shows a Dragon without R1a; any other claim is refused (`DETECTOR_UNAVAILABLE_REFUSED`) and what it would skip
  counts as not run (`DETECTOR_NOT_RUN`, UI UNGRADED). End the case with `envReset` when it touched the environment
  (envSet, sensors or a frame window). Without that section, nothing here changes.
- The width sweep and the overlay check are not in a case: they run once per screen of the run (one route and role of
  the plan) in a screen check dispatch (`roster.mjs dispatch --screen-id <S1..>`, its prompt has a `TEAMQA_SCREEN_CHECK`
  section). That dispatch proves the build like a case, follows the section, and prints one `TEAMQA_SCREEN_DRAFT v1`
  block instead of the evidence draft; `teamqa web collect-screen --run <id> --attestation <its attestation>` grades it
  into `runs/<id>/screens/<S>/attempts/<attempt>/` (every attempt is kept), and each case's collect folds the attested
  attempts of its screens into its first state on that route (else its first state): an attempt's attestation and
  stream are verified again and the check is graded again from the stream; a FAIL in any attempt stands. The screen
  check signs in as the screen's role first; a check (the sweep or the overlay check) whose page was not the screen
  after any goto (a sign-in redirect) is UNGRADED `SCREEN_ROUTE_MISMATCH:<check>`, and only that check is dropped.
  Each attempt keeps its own band captures (`attempts/<attempt>/`); a later attempt on a Dragon without R1a never hides
  an earlier attempt's FAIL.
- `state` is a short name (letters, digits, `.`, `_`, `-`), unique within the case.
- Coverage cells (a case with `route` in a tracked plan with the coverage block, [coverage cells](coverage-cells.md)):
  `action` names the planned action this state checks (`view` when omitted; it must be one of the case's `actions`, else
  `CELL_ACTION_NOT_PLANNED`). For a state `empty`, `one-row` or `many-rows`, add a `read` step that returns the row count
  (a number, or `{rows}`) in the state's `do`/`runFlow` and name its label in `rows`; without it the cell has no measured
  row count and the state cannot PASS (`CELL_ROWS_UNAVAILABLE`, then QA GUI's `CELL_ROWS_UNMEASURED`).
- `defects` are proposals for the root to write defects on the board; collect does not write defects by itself.

What `web collect` makes from the stream, so the QA GUI gate's evidence policy v1 can check it (QA GUI
`references/state-receipt-v1.md`): each screenshot is fitted to at most 1,280 px wide (Dragon's mask boxes painted black again)
and its state receipt carries `screenshot.capture` (the capture's tab, `dom.url`, `domHash`, `sha256`, `maskedRects`, `viewport`,
and the build read on that tab) and `screenshot.fit`; `target` comes from the named read step. For a cell case the receipt
also carries `cell` (route from the plan, state, action, the plan row of the measured size, `conditions: {}`, and `rows`
from the named read step), checked with QA GUI's cell checks; a QA GUI without them gets no cell (`CELL_UNSUPPORTED_BY_QA_GUI`). The recording gets a
`qa-gui/recording-manifest/v1` built from the recording folder Dragon reports (`dir`), with the action times from the recording's
own input events, or else from the action receipts of the calls made between `startRecording` and `stopRecording`; the case's
recording segment names it. The board gets `evidencePolicy: {version: 1}`.
With QA GUI's stream detectors (`TEAMQA_DETECTORS`), collect also carries what QA GUI rebuilt from the stream into the
run: each state receipt names its `probes` (`transient`, `width-sweep`, `overlay-check`, each `{kind, path, sha256}`
and, for the last two, the sealed `qa-gui/probe-cells/v1` file as `cells`), the probe's kept frames and the sweep's
captures are copied hash for hash, a case that touched the Dragon environment gives every state an `env` block (the
conditions in force when it was captured) and names the raw `env.reset` result on its last state, and a cell's
`conditions` come from that env record. U1/U2/U3 results fold into the state's `ui.uiSanity`; the UI verdict joins
QA GUI's own probe verdict. A detector the case needed that did not run (`DETECTOR_NOT_RUN`, the screen check of a
screen of the case, the transient probe of a risky main action or a U rule its plan forces), a screen check QA GUI could
not grade (`SCREEN_CHECK_UNGRADED`), a claim with nothing in the stream behind
it (`*_NOT_RECORDED`), or an unverified reset keeps the case from PASS; an exploration that did not run is reported
only, and so is a case without a route (`SCREEN_NO_ROUTE`: its screen checks are N/A). A request a Dragon request rule
forced (env.get's log, matched by the request's own time, so a later state whose envSet replaced the rules still
excuses it) and its console line do not fail the state's network or console check. A probe Dragon's destructive gate
refused on every trial is N/A (`DETECTOR_NA:<case>:transient:DESTRUCTIVE_HANDOFF_REQUIRED`), reported only. On a Dragon the stream
shows without R1a, the probe and the screen check are reported (`DETECTOR_UNAVAILABLE`, `SCREEN_CHECK_UNAVAILABLE`) and the forced U rules
say UNGRADED with `DRAGON_R1A_UNAVAILABLE`, and the case is graded as before. The explorations make the run's
`app-map.json`. Evidence QA GUI rejects is listed in collect's
`issues` with its code and fix (`EVIDENCE_IMAGE_BLANK`, `EVIDENCE_IMAGE_BINDING`, `EVIDENCE_IMAGE_TARGET_OUTSIDE`, … fix=re-capture;
`EVIDENCE_VIDEO_NO_ACTION_COVERAGE`, `EVIDENCE_VIDEO_NO_CHANGE`, `EVIDENCE_VIDEO_STALE`, `EVIDENCE_VIDEO_FRAME_COUNT`, …
fix=re-record) and that case is UNGRADED: dispatch the case again and capture or record it again.
