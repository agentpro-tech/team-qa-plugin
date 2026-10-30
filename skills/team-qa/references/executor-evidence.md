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
(`session.create`), open a tab on the target's exact `preview_url` (`openTab`), log in if needed, reload the tab so that the app calls
the backend, then call through `mcp__Dragon_Browser__dragon_rpc`, one command at a time, within 300 seconds, before any `screenshot`:

1. `getPageIdentity` `{sessionId,nonce,browserInstanceId,tabId}`
2. `getNetwork` `{sessionId,nonce,browserInstanceId,tabId,summary:true}`
3. `getTabInfo` `{sessionId,nonce,browserInstanceId,tabId}`

These must be the first three page reads on that tab, with no other parameters, and the tab must still be on the exact `preview_url`.
A missing or wrong sequence (a build different from the target, no 2xx/3xx request to the backend, a screenshot first) rejects the whole
dispatch turn and the case becomes ungraded.

Then, for each state to grade, follow exactly this order on the tab of the Dragon session the executor created:

1. Take a screenshot with Dragon (`screenshot`) with a separate `toFile` for that state, for example `TC-02-after-save.png`.
   Do not pass `domHash:false` or any parameter that removes `dom` and `domHash` from the result: the state receipt needs the page URL
   and the DOM hash of the image; without them the state becomes UNGRADED (`SCREENSHOT_DOM_MISSING`).
2. Run Gate-0 (ui-sanity, a11y) with one `do`/`runFlow` command that has a `read` step (`as: "g0"`) if the plan requires UI.
3. Call `getConsole`, then `getNetwork` (without `summary`).
4. Behavioral case: `startRecording` before the first action, `stopRecording` and then `assembleRecording` after the last action.

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
- `state` is a short name (letters, digits, `.`, `_`, `-`), unique within the case.
- `defects` are proposals for the root to write defects on the board; collect does not write defects by itself.
