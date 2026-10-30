---
name: qa-gui
description: >-
  Formerly named qa-pro (every reference to qa-pro means this skill). Human-like end-to-end GUI testing / QA of
  any web app in Chrome. Use when the user says "QA E2E", "test E2E", "QA this page", "verify the
  UI", "test it again", "check if the fix works", "reproduce this bug", "review the design /
  review the taste / grade the taste / is this UI good", or wants to confirm a feature works in the browser.
  Drives a REAL browser via Dragon (Lane A/B): acts like a human, reads DOM/network only to judge.
  HARD RULES: every action goes through the GUI as a human — never script-click, call the API, or
  inject state to fake a pass (BLOCKED); QA on the exact env/DB the customer uses; EVERY
  screen-state gets the mandatory Gate-0 UI-sanity sweep (clipped text, occluded popups,
  misalignment, overflow) → one pass, TWO verdicts: Function + UI. QA with more than 3 cases needs a tracked
  plan; evidence: RECORDING for behavioral cases, screenshot for static UI. Not for
  unit/integration code tests or plain scraping (web-extract).
---

# QA GUI — Human-Like end-to-end GUI testing for web apps

> **If it's QA, it's HUMAN-LIKE QA.** The GUI is the thing under test — so we operate it the way a person does, with evidence, and we never trick our way to a green.

> **One pass = TWO verdicts.** Every case is graded on `Function:` (does it work?) AND `UI:` (is the screen free of basic defects?). A functional PASS never closes a case whose UI is FAIL.

Goal: QA a web feature **fast, reliably, with evidence** — no guessing, no
screenshot-then-eyeball *for functional verdicts*. Principles: **act with trusted input like a
real user**, **read the DOM/network only to judge** (never to act), and **pack a whole QA case
into one `do` call** to cut round-trips.

This skill works on **any web app** open in Chrome — SaaS, internal tool, dashboard, localhost
dev build, or any page. The examples below use generic placeholders; swap in the real
text/selectors/endpoints of the app under test.

**How to read this file (v2 layout):** the four HARD RULES say what may never be violated; the
**A/B/C/D rule tables** say what a defect *is*; the **6-step workflow** says what to do, in
order, and each step points back at the rules it enforces. Everything else is reference.

## Teamwork board v6 (qa-gui 2.8)

When a QA round is a shared workspace for the user, human developers, developer agents, and QA
agents, keep state in the `qa-gui` canonical and render the native board with Doc-Colab's
`task-board`. `qa-gui` owns validation, state rules, packet hardening, and the optional Notion
adapter; Doc-Colab owns the shared native surface.

- Canonical source: `scripts/teamwork/canonical.schema.json`; validate before every render or
  optional Notion synchronization with `scripts/teamwork/validate-canonical.mjs`.
- Team QA stable CLI surface: `scripts/teamwork/cli.mjs` exposes `init`, `migrate-sources`,
  `validate`, `render`, `apply`, `export-page`, `compare-page`, `export-notion`,
  `compare-notion`, and `sync-notion` while all
  state rules remain in the modules above. Mutating commands write a new file and refuse to
  overwrite canonical input. `init --source-seed` is the sole seed boundary for an upstream
  tracked plan; the seed must state case id, title, requirement, and source refs explicitly.
  `init --target-binding-sha256 <sha>` starts a deployed-build (web-v1) board without `commit`;
  see `references/release-receipt-web-v1.md`.
- Surface order: Space (native Codex Pages) → Notion → Doc-Colab. Use Pages `export-page`
  and independent actual `read_page` comparison with `compare-page`; see the exact payload and
  evidence-map contract in `references/qa-board-teamwork.md`. Fallback only on provider absence
  or unavailability before writing; an uncertain write or mismatch stops.
- Doc-Colab fallback: render the same canonical directly with
  `scripts/teamwork/doc-colab-renderer.mjs`. Human edits remain staged in
  `window.__docColabState().qaDelta`; materialize staged file evidence and harden a new canonical
  revision with `scripts/teamwork/doc-colab-hardener.mjs` before clearing the page. The renderer
  must receive `verdict=pass` from Doc-Colab's template/data integrity gate before it returns.
- Notion fallback: use `scripts/teamwork/notion-sync.mjs` when Pages is unavailable or when
  the user explicitly selects Notion for that round. The module supplies mapping, comparison, pull, and idempotent upsert logic;
  the caller must inject an authenticated transport. Never make an implicit live write.
- Delivery: Doc-Colab's generator embeds images and videos while the complete HTML stays at or
  below 25 MB; over-threshold videos remain linked with disclosure. The older
  `native-renderer.mjs` and `evidence-packager.mjs` remain compatibility fallbacks only.
- Data-only lock: QA agents edit the canonical JSON only. They never edit the rendered HTML,
  `DOC_DATA`, CSS, or JavaScript. Immediately before delivery, run the renderer's
  `--verify-existing` mode against the final canonical and final board; a missing verifier,
  `TEMPLATE_TAMPERED`, or `DATA_SOURCE_MISMATCH` is fail-closed.
- Finding evidence (schema v5): a defect's `findings[]` and `evidence[]` bind by `findingId`. A
  measured finding ships both roles — the `original` capture and its `.annotated.png` render, as
  two distinct files — and the native board shows the annotated image linked full-size next to a
  separate labelled link to the original. Missing either role stops the round. `fixEvidence` keeps
  its own dev-side workflow meaning and never stands in for QA finding evidence.
- Board delivery quality (rule `qa-gui/board-quality/v1`) is separate from canonical validity and
  Function/UI verdicts. Legacy boards remain readable; before handoff, run
  `inspectBoardQuality(data)` from `scripts/teamwork/board-quality.mjs` and obtain a bound
  independent review with `validateBoardReview({data,review,canonicalSha256})`. Active defects
  need the optional `handoff` action front; deterministic checks reject vague/placeholder text,
  identical actual/expected, fix-versus-explicit-uncertainty contradictions, and ungrounded finding
  captions. Review needs exact case/defect coverage and grounded JSON-pointer quote anchors for all
  five criteria; identity/status-only anchors do not satisfy relevant criteria. Before sealing a
  delivery artifact, use `verifyBoardProjection({file,artifactPath,renderer,projectionOptions})` to
  compare it with the exact canonical projection. Doc-Colab handoff requires exact projected
  `defectSummary.handoff`; absent projection fails closed. This quality result is never a product verdict. Contract and review format:
  `references/board-quality.md`.
- Annotation runtime: `scripts/loop8/annotate-png.mjs` requires the `magick` executable from
  ImageMagick 7.1.2-25. Fonts are bundled in this skill; a missing or different renderer fails
  closed against the byte-exact golden instead of silently producing a different image.
- Prose language (schema v5): every sentence a human reads — titles, steps, expected, human
  summaries, defect repro/expected/actual, finding captions, round scope, release risks, comments —
  is written in the board's declared `language`. Only `vi`, `en`, `ko`, and `ja` are graded; any
  other declared language is `UNGRADED`, never a pass. Machine values stay English and are exempt,
  including selectors, rule names, units, and paths quoted inside a sentence.
- Required round fields (schema v5): a case past `TODO` writes non-blank `steps` and `expected`,
  and every defect writes `actual`, `expected`, `repro`, and at least one QA evidence entry. A gap
  fails at that exact field path and names the owning case or defect id. A `TODO` case is still a
  plan, so it is not asked for them yet.
- Source traceability (schema v6): `sourceItems[]` is the generic source registry and every
  executable `cases[]` item carries non-empty `sourceRefs[]`. References are exact stable ids;
  missing, duplicate, or unknown refs fail closed. A QA-added guardrail uses
  `origin: "qa-derived"`, `kind: "qa-derived"`, and a non-blank `qaDerivedReason`; it never
  impersonates a customer issue. Defects keep only `caseId`. Schema 4/5 remains valid, and the
  explicit `migrate-sources` mapping forbids title/ID inference.
- Notion source projection (schema v6): a compatible source-page map becomes the `Source Issue`
  relation. Unmapped sources retain their stable external key and optional URL. `Issue Group` is
  an adapter-only label derived from `sourceSystem` and is never canonical input.
- Optional `cases[].work` (`qa-gui/case-work/v1`) records remaining checks, next action,
  worker ownership and evidence-backed blockers separately from Function/UI verdicts.
  Preserve it in board exports; a matching export does not prove the remaining checks ran.
- Defects: `RETEST` requires fresh fix evidence; defect creators cannot close their own defect;
  independent QA moves passed retests through `VERIFIED` to `CLOSED` and failed retests to
  `REOPENED`. Status, priority, and assignee edits always append history.

The exact commands, state-hardening loop, conflict rule, and shipped example are in
`references/qa-board-teamwork.md`.

Native Dragon sessions use `forbidSyntheticDOM:false` for declared state reads and retain
trusted-input requirements. Use the shared request validator and the supported runtime contract
in `references/native-gui-adapter.md`; Storage reads never authorize synthetic writes.

## Release Truth v2 (qa-gui 2.9)

`scripts/qa-gate.mjs` is one semantic gate for teamwork schemas 4, 5, and 6. `schemaVersion` is
mandatory: an unversioned, schema-3, or unknown board is `UNGRADED` and must migrate; there is no
legacy structural-only fallback. Unknown fields are also `UNGRADED` and are reported by exact path.

Before a completed case can be graded, the board carries non-blank `runUuid`, full `commit`,
`build`, `env`, `db`, `role`, `testProfile`, and `evidenceManifest[]` (`path` + SHA-256). Every
completed case declares `requirements[]`, `kind`, `states[]`, and one `stateReceipts[]` link per
state. The gate reads each linked `qa-gui/state-receipt/v1`, recomputes Function/UI, verifies the
manifest bytes, and rejects board-authored verdicts that do not match.

- Release-truth v2 requires the complete frozen tuple: tracked plan, `requirements.freeze/v2`,
  owning Git repository, and run evidence root. The graph plus plan defines the complete
  `gui|multi` denominator; board-authored subsets cannot shrink it.
- One assertion per requirement uses
  `{requirement_id,assertion_id,verdict,evidence_ref,evidence_type}`. Every referenced artifact is
  a regular non-symlink file under the run root and carries sealed run/task-base/commit/case/state/
  capture-time metadata. A display PASS requires an allowed `gui-*` evidence type.
- Every emitted atomic receipt row adds the tracked `case_id`; the verifier independently checks
  case membership, requirement ownership, and equality with the evidence metadata case.
- Schema-5 `vision.version=2` binds C10-C16 PNG assertions to every settled state. Frozen
  `stable-identity` and `ordered-setup` risks additionally require requirement-specific assertions;
  a generic visual PASS cannot satisfy either risk.
- A 120-second dwell is required only when the tracked plan explicitly declares settling for an
  async projection risk. Timestamped repeated failures are FAIL for every HTTP method, including
  GET; synchronous cases retain the ordinary settle rule.
- A plan case marked `auth_required` cannot grade PASS while application login was not reached.
  That condition is hard `UNGRADED` in the aggregate receipt.
- A mutating network method, `writes_data:true`, or `expect_net:true` derives `behavioral`.
  Declaring that case `static` is FAIL. Writes require raw `{method,url,status}`, server readback,
  all six lifecycle phases, and the existing screen-recording proof.
- Identical screenshots may use `equivalentTo` only when both receipts carry the same measured
  `domHash`; prose alone cannot establish equivalence.
- `GO` cannot coexist with FAIL/BLOCKED cases or open defects. `GO-WITH-RISKS` requires
  `release.approval={by,ts}`.

Run the frozen gate as:

```bash
node scripts/qa-gate.mjs <board.json> \
  --plan <tracked-plan.json> \
  --requirements <REQUIREMENTS.json> \
  --repo <git-checkout> \
  --evidence-root <run-root>
```

It writes sealed `qa-gui/receipt/v2` to
`.teamcode/runs/<runUuid>/receipts/qa-gui.receipt.json`. Verify it with
`scripts/receipt-verify.mjs` using the same repo, graph, and evidence root. Invocation without the
v2 tuple remains compatibility-only and emits v1; v1 can be read but reports
`CAPABILITY_MISSING:release-truth-v2` and cannot close a v2 customer-ready chain. Exit codes are
fixed: `0 PASS`, `1 FAIL`, `20 UNGRADED`, `2 usage error`. The release/incident suite is
`npm run test:release-truth`; a release that does not call it is incomplete.

## ✅ Definition of Done — check ALL before delivering a QA report

1. Every action performed **as a human through the GUI** (trusted input; no tricks) — else **BLOCKED**.
2. Verified on the **exact env/DB** the customer/acceptance actually uses (empirical, not assumed) — Step 0.
3. **Gate-0 sweeps** (A + B + D) ran on **every settled screen-state** the case touched.
4. **Vision check C10–C16** done from a real PNG for **every settled state**; approved baselines
   are pixel-compared after declared masks.
5. Report contains **both** verdict lines — `Function:` **and** `UI:`. **A report missing the
   `UI:` line is incomplete — do not deliver it.**
6. **>3 test cases ⇒ a tracked QA plan existed BEFORE running, and every case carries evidence
   of the RIGHT kind: behavioral case = screen RECORDING of the run; static-UI check =
   screenshot.** Think a plan is unnecessary anyway? **Ask the user first** — never silently
   skip. (Full rule below.)
7. `node scripts/qa-gate.mjs <board>` exits 0. **Gate output IS the report** — no gate pass, no
   delivery. The gate has **no opt-in, disable, or fail-open flag**; a verdict it cannot compute
   is **UNGRADED**, and **UNGRADED is not PASS**.

---

# Part I — The four HARD RULES

## ⛔ HR1 — Human-Like QA (never trick your way to a pass)

The GUI itself is under test, so **every action must be a genuine human interaction through the UI.**

- ✅ **Allowed (acting):** trusted mouse clicks and real keyboard input on the actual on-screen
  control via Dragon (`click`, `fill`, `select`, `type`, `key`, `clickXY`); opening the real
  dropdown/menu/modal; real scroll; real drag. `clickVision` (vision locates the control, then
  Dragon fires a **trusted click at those coordinates**) is allowed — it's still a real click,
  just a smarter way to *find* the target.
- ❌ **Forbidden (acting):** using `executeJs`/`read` to click, set a value, or dispatch
  synthetic events **as the action**; calling the backend API directly to perform the step;
  injecting or mutating DOM / React state / `localStorage` to produce the result; flipping a
  class or attribute to simulate the outcome.
- 🚫 **The cardinal sin:** hitting a hard GUI interaction and then *switching to a trick to get
  a pass.* A finicky control is QA **signal**, not an obstacle to route around. Solve it the
  **human way**: scroll it into view, wait for it to enable, fix the selector, use real keyboard
  navigation, dismiss the overlay, retry the real gesture, escalate the locate to `clickVision`.
  If it still can't be done as a human would → conclude **BLOCKED** and report. **Never a fake PASS.**
- 🔎 **JS reads are for the VERDICT only** — `read`/`expectNet` observe state to grade the case;
  they never perform the user's action.
- 🧪 **Fault-injection is environment, not a GUI trick** — making an upstream/API time out, using
  a bad token, or opening two real tabs to force a race are legitimate *test conditions*; the
  user-facing action and the observation still happen through the GUI like a human.
- 🐉 **Never fall back to weaker tools for actions** — no Claude-in-Chrome / computer-use /
  pixel-clicking to "just get it done". Dragon trusted input only. If Dragon is unavailable,
  it's a prerequisite — stop and tell the user (don't substitute).

## ⛔ HR2 — QA ON THE RIGHT ENV/DB (added after a wrong-environment incident)

**BEFORE QA: verify EMPIRICALLY the build + database + env that the customer/acceptance ACTUALLY uses — do NOT guess.** This is **Step 0** of the workflow, not a side note.

- Read the runtime of the app under test (do not infer "preview = staging"): take the main bundle `src` → `fetch()` → grep the supabase ref `[a-z0-9]{20}.supabase.co` (which DB) + an i18n/feature marker (does the build already have the fix). With Dragon, use `dragon_rpc executeJs`.
- QA must run on **THE EXACT env the customer accepts on**. A fix on env/DB A while the customer tests env/DB B ⇒ **NOT done** — this is exactly how bugs slip through: fixed on the staging DB, while the customer accepts on preview → test DB (a different one).
- Product with several envs (prod/staging/test) → confirm the env↔DB map; every DB/schema fix is synced to the env the customer uses.
- Combined with the "no screenshot-then-eyeball" rule above: only **the right env + a behavioral before/after action** counts as PASS. A render-screenshot of a state is NOT QA.

## ⛔ HR3 — Gate 0 is MANDATORY on every screen-state

Basic UI defects are **defects, not taste**: labels clipped mid-letter, a popup opening
half-covered or off-viewport, a row 8px out of line. Functional QA alone lets them slip —
so this gate is **not optional** and **not** part of the taste layer.

**What runs:** the A + B + D sweeps (tables in Part II) as Dragon `read` steps, plus the C10–C16
vision pass from a real PNG.

- `scripts/ui-sanity.js` defines `window.__uiSanity(stateLabel)` →
  `{verdict, counts:{high,warn}, issues:[{sev,rule,sel,detail}]}` (Layer A).
- `scripts/a11y-gate0.js` defines `__a11yB({minTarget:24})` and `__a11yFocusProbe(el)` (Layer B).
- Console/network readings via Dragon `getConsole`/`getNetwork` (Layer D).

**When (3 moments, every case):** ① after initial load (settle first) · ② after each state
change that shows new UI (modal/popover/dropdown opened, tab switched) · ③ final state before
the verdict.

**How:** inline the whole file into ONE `read` step of your `do` chain (it does NOT persist
across `goto` — re-inline after navigation):

```json
{ "read": "<contents of scripts/ui-sanity.js>; return __uiSanity('after-open-settings-modal');",
  "as": "ui_sanity_settings_modal" }
```

**Verdict:** any `high` issue ⇒ `UI: FAIL` for that state (issues carry selector + detail =
ready-to-fix). `warn` = advisory, listed but not failing. CSP-blocked page (eval forbidden) →
sweep **not measurable**: say so explicitly + attach ONE screenshot — never silently skip, and
never record it as a pass. Full rule detail + false-positive policy + E2E evidence:
`references/ui-sanity.md`.

## ⛔ HR4 — QA Plan + Evidence (>3 test cases; recording for action cases)

QA of any real scope must be **planned in the open and proven with evidence of the right
kind** — a chat-only recap is not auditable. Count the test cases at Orient (one case = one
verifiable behavior/screen):

- **>3 cases ⇒ MANDATORY, before running anything:** create a QA plan the user can open, in
  this priority order:
  1. **① qa-gui teamwork board (DEFAULT for a shared QA/dev round):** start from
     `scripts/teamwork/example-canonical.json`, validate it, then export native Page blocks with
     `scripts/teamwork/cli.mjs export-page` and compare the actual Page readback with
     `compare-page`. Space is the default, Notion the first fallback, and Doc-Colab the second.
     This is the canonical-backed path for
     assignee, priority, defect evidence, retest, per-round results, and history. See
     `references/qa-board-teamwork.md`.
  2. **①b doc-colab task-board (for a general collaboration document):** the same sibling
     template without QA canonical mode remains available for ordinary work — same
     self-contained file:// engine plus **comment-everywhere threads, a right-side comment
     panel, tid-threaded replies, and the unified `__docColabState`/`__docColabClear` agent
     API**. Create via its `make_doc.py` (`--template task-board`) with columns like
     `result (verdict)` · `shots (images)` · `verified (check "Reviewed by owner")`. Follow the
     doc-colab SKILL for the read→harden→reply loop.
  3. **①c legacy qa-gui QA Board (built-in fallback — always available):** copy
     `assets/qa-board.html` from this skill →
     `<project>/qa-evidence/YYYY-MM-DD-<app>/QA-Board.html`, then fill the
     `window.QA_DATA` JSON inside the `QA_DATA_START/END` markers with the planned cases
     (`status:"PENDING"`). Notion-like board (status chips, verdicts, screenshot gallery),
     fully offline. **Data inline in the HTML** (file:// blocks fetch); evidence stays under
     the canonical `qa-evidence/<app>/...` tree. Update = Edit the JSON block only (keep markers).
  4. **② Notion** (only if the user prefers cloud/team sharing — attach evidence with the
     `notion-image-proof` skill). **③ Google Sheet/Drive** (if connected and user prefers).

  Minimum fields per case: `id · desc · steps · expected · status · evidence[]` (+ `fn/ui/visual`
  verdicts as they land). On v3+ also fill `states[]`, one canonical state PNG and one
  `stateReceipts[]` JSON per state, plus `visualEvidence[]` for approved-baseline comparisons.
  The receipt contract is `references/state-receipt-v1.md`; manually typed PASS text is not proof.
- **Mid-QA questions to the user:** need a decision with >4 options, context, or evidence
  (which bug to fix first, waive scope, pick an approach)? Create a **doc-colab `decision`
  page** instead of flooding the chat — the user picks + comments, you read it back via
  `__docColabState` and act.
- **Evidence — pick the RIGHT kind per case:**
  - **Behavioral case** (any case where you ACT: click/fill/submit/drag/flow → state changes)
    ⇒ **screen RECORDING of the run is MANDATORY** — a still image cannot prove before→action→after.
    Flow (Dragon, zero focus-steal, records a background tab):
    1. `startRecording {tabId, fps:15, quality:80}` → `{id, dir}` — start BEFORE the first act step.
    2. Run the case's `do` chain as usual (acts + reads + sweeps).
    3. `stopRecording {id}` → `assembleRecording {id, fps:15}` → `<dir>/capture.mp4`.
    4. Copy to `<project>/qa-evidence/YYYY-MM-DD-<app>/<case>-run.mp4` and add to that case's
       `evidence[]`. Default **one case = one clip**; a group of tiny cases (<10s each) may share
       one clip only when every case declares a non-overlapping
       `recordingSegments:[{file,startMs,endMs}]` mapping. A prose note alone is not accepted.
    **No recording = behavioral case not done.** The gate rejects a recording under **50 KB** —
    that floor means "a real run was captured", so satisfy it by recording real interaction, never
    by lowering the bar.
  - **Static-UI check** (render/layout/copy verification, no state change — e.g. Gate-0 sweep
    of one screen, a display check) ⇒ **screenshot is enough**:
    `captureTab {toFile:".../<case>-<state>.png"}` → `evidence[]`.
  - **Finding caption** (the text next to an annotated box, or a defect line on the board)
    ⇒ **1–3 sentences** carrying all four parts: ① **measurable evidence** taken from the finding
    itself — the exact selector, or a number that really appears in its `bbox`, `detail` or DPR;
    ② the **user consequence** (what the person cannot do); ③ a **fix suggestion**; ④ written in the
    **board's language**. A shortened selector (`.dialog` for `.dialog-save`), a rounded measurement
    or an invented figure is not evidence — it reads as proof while proving nothing. Grade it with
    `validateFindingCaption({finding, caption, language})` from `scripts/loop8/index.mjs`:
    `FAIL` ⇒ rewrite before the caption ships; `UNGRADED` ⇒ the input was unreadable, which is the
    gate declining to answer, never a pass. The gate checks grounding and shape only — it does not
    detect or enforce which language you wrote in, so ④ stays your check.
  - Update the case's status (PASS/FAIL/BLOCKED) + verdict fields as evidence lands. (Evidence
    documents an outcome you verified behaviorally — the render-screenshot-as-QA ban still
    applies to the VERDICT itself.)
- **When done:** re-open the board once (Dragon `openTab file://...`) and run the Gate-0 sweep
  on it — the evidence board itself must not ship with clipped/occluded UI. Put the board path
  on the report's `Plan:` line.
- **Comments — user feedback loop (MANDATORY read):** the board has per-case comment threads.
  User comments are staged in the browser's `localStorage` until an agent collects them.
  (Tracker is a **doc-colab** board ⇒ use its API instead: `__docColabState()` /
  `__docColabClear()` and the harden protocol in the doc-colab SKILL — preserve `tid`/`anchor`.)
  **Every time you open an existing board** (resume, re-test, "check the board", next QA round):
  1. Open it via Dragon **Lane A** (the user's real Chrome — that's where their localStorage
     lives; Lane B has a different profile and will see nothing).
  2. `read: "return __qaBoardComments();"` → `{pending:[{caseId,author,text,ts}]}`.
  3. Pending comments exist ⇒ **harden them into the file**: Edit the `QA_DATA` block, append
     each to that case's `comments[]` as `{by:"user",author,text,ts}` — comments must survive
     in the file (synced, machine-independent), not in the browser.
  4. **Act on each comment** (it is user instruction: re-test, fix, clarify), then append your
     answer as `{by:"agent",author:"<agent name>",text,ts}` to the same `comments[]`.
  5. `read: "return __qaBoardClearPending();"` (staging collected) → reload the board → verify
     the thread renders with your replies and the "waiting for agent" badge is gone.
  Never close a QA round while `__qaBoardComments().pending` is non-empty and unprocessed.
- **≤3 cases ⇒ inline report allowed** (skip the tracker), but the report still carries the
  per-state screenshots required by C14 and both verdict lines.
- **You think the plan is unnecessary even though >3 cases?** Do NOT decide alone —
  `AskUserQuestion` first ("This QA has X cases — do you want a tracked plan or a quick inline run?").
  Only the user can waive; note `Plan: waived by user` in the report.

---

# Part II — Rule tables A / B / C / D (what counts as a defect)

Gate-0 (mandatory) = **A** (DOM/layout) + **B** (a11y) + **D** (console/network), plus the **C10–C16**
vision pass. The **taste layer stays optional** (aesthetics/taste, B1–B7 scoring, anti-slop C1–C13).

> ⚠️ **Naming collision — read once.** The Gate-0 letters below (`A1–A11`, `B6–B9`, `C10–C16`,
> `D1–D4`) are **not** the taste rubric's letters. `references/taste-rubric.md` has its own
> `A1–A6 · B1–B7 · C1–C13` for scoring. When quoting a rule id in a report, say which family:
> e.g. `Gate-0 A3 occluded-control` vs `taste C2 anti-slop gradient`.

## Layer A — ui-sanity, DOM-deterministic (`scripts/ui-sanity.js`, no LLM, ~ms)

| Id | Rule | Sev | Fires when |
|---|---|---|---|
| A1 | `text-clipped-x` | high | direct text, `overflow-x:hidden/clip`, `scrollWidth > clientWidth+2` |
| A2 | `text-clipped-y` | high | same vertically AND >0.45 line-height hidden |
| A3 | `occluded-control` | high | visible interactive element whose center `elementFromPoint` hits an unrelated element |
| A4 | `overlay-cut-viewport` | high | open dialog/menu/popover <98% inside viewport |
| A5 | `overlay-cut-ancestor` | high | overlay escapes nearest `overflow:hidden` ancestor (dropdown-in-card bug) |
| A6 | `page-overflow-x` | high | `documentElement.scrollWidth > clientWidth+2`; names ≤5 offenders |
| A7 | `broken-image` | high | `img.complete && naturalWidth===0` (finished loading, no pixels) |
| A8 | `distorted-image` | high | `object-fit:fill` and render aspect ratio deviates >15% from natural |
| A9 | `stacking-error` | high | an OPEN overlay whose center hit-tests to another element (rendered underneath) |
| A10 | `invisible-interactive` | high | control with `opacity:0` yet still hit-testable ⇒ invisible click target |
| A11 | `unintended-text-overflow` | high | text box escapes a NON-clipping parent (ellipsis/line-clamp whitelisted) |
| — | `misaligned-row/column` | warn | ≥3 same-tag siblings drift 3px…60% of item size |
| — | `zero-size-interactive` | warn | button/link/input rendered 0×0, statically positioned |

Deliberately NOT flagged (conservative by design): `text-overflow:ellipsis`, `-webkit-line-clamp`,
`sr-only`/`aria-hidden`, elements behind an OPEN modal, below-the-fold, scrollable ancestors.
Caps: 3000 elements, 20 issues, 150 occlusion probes, epsilon 2px. Returns `v:'ui-sanity/2.0'`.

**Known blind spots — do not oversell the gate:** visually-broken-but-DOM-legal (overlapping
positioned text, off-palette colors, font fallback) is C-tier, not A; occlusion checks the element
**center only**, so a half-covered edge passes; CSP-locked pages are **unmeasurable**, not clean.

## Layer B — a11y, promoted into Gate-0 (Phase 3)

| Id | Rule | Threshold | WCAG |
|---|---|---|---|
| B6 | contrast | text ≥4.5:1 (large ≥3:1), non-text ≥3:1 | 1.4.3 + 1.4.11 |
| B7 | focus-visible | a focused control shows a visible indicator — flow focuses each control, then `__a11yFocusProbe(el)` judges | 2.4.7 |
| B8 | target-size | interactive ≥ 24×24 CSS px (mobile 44) | 2.5.8 |
| B9 | reflow | no horizontal scroll / content loss; run every row in `scripts/loop7/responsive-matrix.mjs` | 1.4.10 |

Any `high` ⇒ `UI: FAIL`. Returns `v:'a11y-b/1.0'`. `axe-core` is bundled offline and
version-locked at `scripts/vendor/axe.min.js` (4.10.2) for deeper a11y runs.
Reference test: `.teamcode/browser-harness/a11y-acceptance.mjs` (real Chrome) proves B6–B9.

## Layer C — vision C10–C16, every settled state + approved-baseline diff

The DOM sweeps cannot judge every rendered defect. At **each settled state**, run the A/B/D
sweeps, then immediately call Dragon `screenshot {tabId,toFile}` **before any later action**. Store
the PNG at `qa-evidence/<app>/round-<n>/<viewport>/<state>.png`, list that exact path in the
case's `evidence[]`, and record these fixed verdicts in `cases[].visual`:

| Id | Check |
|---|---|
| C10 | overlap / collision |
| C11 | broken, stretched, or wrongly cropped imagery |
| C12 | color / theme outliers |
| C13 | typography and spacing consistency, including fallback artifacts |
| C14 | interaction-state matrix — every declared settled state was visually inspected |
| C15 | dark-mode consistency where supported; otherwise explicitly `WAIVE` with the reason in `untested[]` |
| C16 | anything a normal user would call broken |

New boards use `schemaVersion:6`; `schemaVersion:4` and `schemaVersion:5` remain valid compatibility inputs. Vision uses `vision:{version:1,app,viewport,baselineManifest,
baselineMask?}`. The first run may copy screenshots into the baseline tree only as
`status:"proposed"`, with blank `approvedBy`/`approvedTs`; it must declare the exact outlook
`baseline pending owner approval`. **A proposed baseline is never compared.** The project owner's
approval is a separate source-review event: an approved manifest entry has an `approvedBy` that
names the approving owner (a non-empty, trimmed string of at most 120 characters), a real
`approvedTs`, and the SHA-256 of `baseline/<viewport>/<state>.png`. When the environment variable
`QA_GUI_BASELINE_APPROVER` is set, `approvedBy` must equal its value exactly; otherwise any named
approver is accepted.

For later rounds, run `node scripts/visual-diff.mjs <baseline.png> <round.png> --state <state>
--mask <baseline-mask.json> --diff <state.diff.png>`. Masks contain only explicitly dynamic
rectangles for that state. Mask rectangles are in **device pixels**, not CSS
pixels: a 1280x800 retina capture is a 2560x1600 PNG, so a mask authored in viewport
coordinates covers only a quarter of what you meant. A mask covering more than 40% of the
image makes `visual-diff.mjs` **throw (exit 2)** instead of quietly voiding the comparison and
reporting PASS - shrink the mask, or waive the state explicitly in `untested`. More than 0.5% changed unmasked pixels is `C-REG FAIL`; `>5%` is
major, otherwise minor. Add the matching diff and percent to `visualEvidence[]`, add a matching
`C-REG` defect, and include the diff PNG in evidence. **Never overwrite or blind-update an
approved baseline to make a failure pass.** The final gate recomputes every comparison.

This is not the forbidden screenshot-then-eyeball pattern: screenshots support visual verdicts;
functional verdicts still require real human-like actions plus DOM/network observations.

## Layer D — console & network sweep

| Id | Rule | Sev |
|---|---|---|
| D1 | `console.error` / uncaught error during the flow | high — FAIL that state |
| D2 | console-warn repeated (>5 same message) | warn |
| D3 | network 4xx/5xx **not surfaced by an error state** | high |
| D4 | request hung / timeout | warn |

Run alongside ui-sanity at EVERY settled state via Dragon `getConsole`/`getNetwork`. Record
results per state in the machine receipt; the gate enforces their structured verdict and raw
evidence **unconditionally**. `sweeps[]` is display-only and cannot make a case pass.
Reference test: `.teamcode/browser-harness/p2-acceptance.mjs` (real Chrome via Playwright)
proves A7–A11 + D1/D3 on fixtures in `.teamcode/p2/fixtures/`.

## Viewport & responsive (applies to A, B and C)

Always **declare the viewport** in the report — overlay-cut/overflow results are only meaningful at
the measured size. For any responsive-critical screen, read the complete matrix from
`scripts/loop7/responsive-matrix.mjs`; this file is the only source for row id, size, profile and DPR.
Run `node scripts/dragon-responsive-matrix-preflight.mjs --tab-id <id> --json` (or `--url <url>`)
to apply every row, run Gate 0 and save one privacy-attested PNG per row under Dragon's evidence
directory.

- A phone-profile row uses Dragon `setViewport` with `mobile:true` and its canonical DPR. Before
  grading, the preflight reads touch, DPR, Android Chrome UA/UA-CH identity five times and passes
  those samples through `verifyMobileEmulation`.
- Missing touch, wrong DPR, identity mismatch or inconsistent samples produces
  `UNGRADED: emulation-not-verified` for that row. Gate 0 does not run on an unverified phone row.
- A desktop-profile row explicitly disables mobile emulation through the same Dragon viewport
  engine. Never infer device profile from width; the landscape phone is intentionally wide.
- After override, drive by **text/selector** because click coordinates are remapped in CSS pixels.
  Session cleanup must restore metrics, touch and identity; a cleanup failure invalidates the run.
- Each finding inherits the PNG evidence reference for its row. Report every row by id as
  `PASS`, `FAIL`, or `UNGRADED`; do not compress away an ungraded row.
- Sanity check that the reported width equals the requested width. A mismatch means the row was
  not measured and must fail closed.

### Loop 7 mobile detectors

All web actions remain Dragon actions; the helpers under `scripts/loop7/` only grade readbacks.
Attach the row PNG to every returned finding before placing it in the existing responsive risk
family — never create a separate verdict channel.

- **V7.3 hover-only:** on each verified phone row, use Dragon trusted hover/tap checks to build
  candidates with `selector`, `essential`, `revealedByHover` and the available tap/click
  equivalent. Grade with `detectHoverOnly`. A control reachable by tap/click or a decorative
  tooltip is not a finding.
- **V7.4 mobile rules:** collect viewport metadata plus DOM/CSS observations and grade with
  `detectMobileRisks`: R1 input text below the focus-zoom boundary; R2 bottom-critical `100vh`
  without dynamic units; R3 permanent fixed-bar occlusion; R4 adjacent controls below the gap
  floor, excluding inline prose links; R5 fixed-bottom bar without safe-area inset; R6 missing or
  fixed-width viewport metadata; R7 body copy below the reading floor, excluding short captions.
- **V7.5 keyboard simulation:** for each form field on a verified phone row, focus it with trusted
  Dragon input, capture the before PNG, shrink visible height to 60% through Dragon, read whether
  the field remains fully visible and the submit control remains scroll-reachable, then capture the
  after PNG and restore the canonical row. Grade with `evaluateKeyboardSimulation`. If the height
  cannot be proven to shrink, return `UNGRADED: keyboard-sim-unavailable`, never PASS.

---

# Part III — Dependency: Dragon Browser (Lane A + Lane B, with skill memory)

Drives the browser through **Dragon Browser**, a local control service on `:9233`
(`POST /rpc`, `GET /status` → `{ready:true}`) plus **MCP-native tools**
(`mcp__Dragon_Browser__do / perceive / screenshot / listTabs / runFlow / saveFlow / dragon_rpc`).
Input events are **trusted** (real), so they pass anti-bot checks and fire framework handlers.

**Two lanes — the router picks automatically; your QA code doesn't change:**

- **Lane A — extension** (`chrome.debugger`): trusted input in the user's **visible** Chrome
  tab. Default for normal pages (~99% of web apps).
- **Lane B — host-launched Chrome** (raw CDP, zero-dep): runs **hidden / headless without
  stealing focus** (anti-occlusion flags, no `_foreground`), and can drive **locked surfaces**
  the extension can't script (`chrome://`, the Web Store, dev consoles). The router sends
  restricted surfaces, `silent` flows, or an explicit `lane:"B"` here; everything else stays on
  Lane A. Lane B uses a **fixed profile** — log in once (visible), then it reuses that real
  session headless.
- **Sessions & no-focus-steal (Lane A, 2026-07-14):** open your QA tab with a `sessionId` —
  `openTab {url, sessionId:"qa-<case>"}` (or `session.create` first). Agent tabs then live in a
  **dedicated BACKGROUND window + colored tab group**, so driving them **never** switches the user's
  active tab or raises their window. **⚠️ ALWAYS QA inside a session window; NEVER drive the user's
  real working tabs** — reload/debugger churn on their live Chrome once cost the user 2 windows / ~16
  tabs (lesson 07-13, never-decay). Run many cases in parallel with distinct sessionIds
  (`session.list` / `session.close` to manage; `tabGroups.*` for groups). Occluded window → auto
  no-focus nudge; a user-window tab whose input times out now auto-foregrounds once (no manual `steal`).
- **⚠️ Session policy — `forbidSyntheticDOM:false` is REQUIRED (2026-07-31):** every sweep this
  skill runs (ui-sanity, a11y-gate0, settle/readiness checks) is a **synthetic-DOM read** — a `do`
  step shaped `{read:"<js>", as:"…"}`. Dragon's **default** session policy is
  `forbidSyntheticDOM:true`, which denies those reads with `SYNTHETIC_FORBIDDEN` **and latches the
  session circuit breaker**, so every later call returns `CIRCUIT_OPEN` until you
  `session.acknowledge` the exact violating `actionId`. So open the session explicitly and assert
  the policy came back as asked — don't assume:
  `session.create {sessionId:"qa-<case>", forbidSyntheticDOM:false}`, then keep `nonce` **and**
  `browserInstanceId` from the reply and send **both on every subsequent call**
  (`openTab`/`setViewport`/`startRecording`/`do`/`screenshot`/`stopRecording`/
  `assembleRecording`/`closeTab`). Passing `nonce` without `browserInstanceId` ⇒
  `SESSION_MISMATCH`.
  **A denial is NOT an absent Dragon.** No RPC at all ⇒ **UNGRADED**; a policy/protocol denial
  ⇒ a real **FAIL**. Never downgrade one into the other.
- **⚠️ `/rpc` nests its errors — check the INNER `ok`:** a denied call still answers **HTTP 200**
  with `{ok:true, result:{ok:false, code:"SYNTHETIC_FORBIDDEN"|"CIRCUIT_OPEN"|"SESSION_MISMATCH"}}`.
  Testing only the outer envelope reads a denial as success; it then surfaces as a nonsense error
  downstream (e.g. `setViewport: Either tab id or extension id must be specified`) or, worse, as a
  **null sweep scored PASS** — a silent fail-open, which this skill never allows. Test `result.ok === false` too, and treat a
  sweep that carries no string `uiVerdict`/`a11yVerdict` as a hard error, never as a clean pass.
- **`human_needed` handoff:** on a login wall (`accounts.google.com/signin/challenge`) or a
  CAPTCHA (recaptcha/hcaptcha/turnstile/cf), Dragon returns `{human_needed, kind, hint}` instead
  of failing silently; `{method:"show"}` makes Lane B visible so the **user** logs in / solves it
  once, then it resumes. **Never authenticate, type passwords, or solve a CAPTCHA on their behalf** —
  hand off.
- **`clickVision`:** when a semantic `click` can't locate a control, a vision fallback (gpt-vision
  → coordinates) resolves the target and Dragon performs a **trusted click** there (human-like).
- **Experience Layer (skill memory):** a flow that has been **verified** (its `assert` passed),
  is non-trivial, repeats (≥2) or is marked `remember`, and **contains no secret**, is
  auto-saved as a replayable skill (`provenance:"learned"`) and later replayed near-**0-LLM**
  with self-verify. Flows with passwords/tokens are **skipped**. Manage everything (view
  provenance / success / last-verified / steps, delete one, or clear all learned) at the
  manager UI **`GET :9233/skills`** — like a cookie manager. `saveFlow`/`runFlow` feed this.
- **Kill-switch (Lane B):** PID-lock + max-runtime + idle-close + `127.0.0.1` only + audit log.

If Dragon Browser is not available, this skill cannot run — tell the user it's a prerequisite
rather than falling back to slower/less reliable browser tools. (Deeper detail lives in
the Dragon Browser project docs — `Upgrade-Plan-Restricted-Surfaces.md` and
`Experience-Layer-Concept-Spec.md`.)

### Why a trusted-input service (not generic browser tools)

- Many browser automation tools auto-deny domains outside an allowlist, or only read content.
- Pixel-level "computer use" on a browser is slow and often read-only.
- Dragon gives full control, reads the DOM in ~tens of ms, and fires real (trusted) events
  that pass anti-bot checks and trigger framework handlers (React, etc.).

### Calling Dragon

- **Easiest:** call the Dragon **MCP tools** directly (`do`, `perceive`, `screenshot`,
  `listTabs`, `runFlow`, `saveFlow`).
- **Raw RPC:** send JSON to `http://localhost:9233/rpc`. If you have shell/network access to
  localhost, `curl` it; in a sandbox that can't reach the host, route through a host-shell bridge
  (e.g. an "osascript / run on host" tool on macOS).

Deeply-nested JSON quoting through a host-shell bridge is fragile. **Strong recommendation:**
for any non-trivial `do` call, write the payload + logic into a small **Node script run on the
host** and invoke that — Node parses JSON natively and avoids all escaping. The bundled
`scripts/qa_do.mjs` does exactly this. Escaping pitfalls: `references/troubleshooting.md`.

`qa_do.mjs` authenticates every RPC automatically. It checks `DRAGON_RPC_TOKEN`, then a custom
`DRAGON_RPC_TOKEN_FILE`, then the stable `~/.dragon-browser/auth/service-token` and legacy
`~/.dragon-browser/auth/token` files. If none is available it fails before making a network
request; do not paste the bearer token into recipes, payloads, logs, or chat.

### When to escalate to UI Critic (quality + design feedback)

qa-gui answers **"does it work?"** (functional PASS/FAIL from network/DOM) plus **"is the UI
free of basic defects?"** (Gate 0). For the **full** quality pass — accessibility (WCAG /
contrast), Core Web Vitals, layout/responsive correctness, design taste — and especially a
**machine-readable feedback-contract** a coding agent can act on (or to **auto-loop** a code
agent until the page passes), use the **`ui-critic`** skill. It runs on top of Dragon too
(Dragon is its default adapter).

- Skill: `ui-critic` · CLI: `node bin/critic.mjs run <url> [--vlm]` or `critic loop <url> --project <dir>`
- MCP tool: `critique { url, vlm? }` → feedback-contract (verdict/score + issues with selector + fix_hint)
- `ui-critic` is a separate skill; it is not part of the Team QA suite.

Rule of thumb: **qa-gui = behavior verified + basic UI sane; ui-critic = quality scored + fixes fed back.**

---

# Part IV — The QA workflow (6 steps)

`0 Prepare → 1 Orient → 2 Perceive → 3 Act → 4 Gate 0 → 5 Record`

## Loop 6 — planning, memory and regression primitives (v2.2)

The public entry point is `scripts/loop6/index.mjs`. It exports eight pure,
deterministic helpers; they do not open a browser or perform I/O. Feed them
observations and evidence read back from Dragon, then keep their fail-closed
verdicts in the QA plan/report. Do not import the `*-frozen.mjs` compatibility
tables directly.

| BA capability | Public function | Input |
|---|---|---|
| V6.1 app map and measurable coverage | `buildAppMap(observations)` | settled crawl observations |
| V6.4 diagnosis before retry | `diagnoseFailure(evidence)` | one failed-step evidence bundle |
| V6.8 EP/BVA form probes | `planFormProbes(fields)` | readable field constraints |
| V6.2 traceable P/I/Q properties | `generateProperties(appMap, baRequirements, envPin)` | app map, coded BA rows, optional live-target pin |
| V6.5 BA-pro to test plan | `baToPlan(markdown)` | closed BA-pro Markdown |
| V6.6 intent-based replay | `replayIntent(savedSteps, redesignedControls)` | saved intent steps and current controls |
| V6.3 three-layer app memory | `recallMemory(appIdentity, appMapHash, records, nextRound)` | pinned app identity, current map hash, memory records and round policy |
| V6.7 controlled regression report | `evaluateRegressionJob(job, runResult)` | declared job and raw run result |

Use only `scripts/loop6/index.mjs` as the stable import surface. `UNGRADED`, an
unknown denominator, an ambiguous diagnosis/intent, stale or foreign memory,
or an incomplete regression group must remain non-PASS. These helpers prepare
and grade data; Dragon still performs every trusted GUI action, and Step 5 plus
`scripts/qa-gate.mjs` still controls the final QA report.

## 0. Prepare — pin the ENV/DB and the Dragon session (enforces HR2)

**Nothing else in this workflow is trustworthy until Step 0 answers two questions empirically:
which build/DB am I actually testing, and is Dragon really driving it?** Never skip it, never
infer it from a URL, and never start Step 1 with an assumption here.

1. **Dragon reachable?** `GET :9233/status` → `{ready:true}`. **No RPC at all ⇒ STOP and report
   UNGRADED** — do not simulate, do not narrow the acceptance, do not "test what you can".
   A reply that *is* an error (`SYNTHETIC_FORBIDDEN`, `CIRCUIT_OPEN`, `SESSION_MISMATCH`) is the
   opposite case: Dragon is present and refusing ⇒ that's a real **FAIL** to fix, not UNGRADED.
2. **Open the session with the right policy:** `session.create {sessionId:"qa-<case>",
   forbidSyntheticDOM:false}`, **assert the policy in the reply**, and keep `nonce` +
   `browserInstanceId` to send together on every later call (Part III).
3. **Identify the build:** read the running app's main bundle `src` → `fetch()` → grep the
   backend ref (e.g. `[a-z0-9]{20}.supabase.co`) plus an i18n/feature marker that proves the fix
   under test is actually in this bundle.
4. **Identify the DB/env the customer accepts on**, and confirm the env↔DB map when the product
   has several. Testing prod-bundle-against-staging-DB is the exact shape of the 9.6 incident.
5. **Write both down** — the `Env/DB:` line of the report is filled in *here*, from what you
   read, not from what you were told.
6. **Permission check before destructive data:** test data on a TEST app is fine with the user's
   permission; on production, ask before any irreversible write/delete (Safety, below).

Output of Step 0: a verified `tabId` inside a session window, an asserted policy, and a factual
`Env/DB:` string. If any of those is missing, the case is **BLOCKED** or **UNGRADED** — not PASS.

## 1. Orient — define the case, the coverage, and the plan

- State the **acceptance** in 1–2 measurable lines covering BOTH dimensions: what does "works"
  mean (Function), and which screens/states must be defect-free (UI)? If ambiguous, ask.
- **Coverage checklist (design coverage, not memory).** Before running any case, list the
  taxonomy and mark each **tick** (has a case) or **waive** (reason → `untested[]`):
  `happy · boundary/EP-BVA · empty · loading · error (fault-injection) · auth-role ·
  navigation (refresh/Back/deep-link) · keyboard (tab-through) · responsive (canonical Loop 7 matrix) ·
  dark-mode (if any)`.
  Record it as `QA_DATA.coverage[] = [{area, status:"tick"|"waive", note?}]`. The gate fails if
  any taxonomy area is neither ticked nor waived; **coverage has no opt-in or disable flag**.
- **Count the cases** and apply HR4: >3 ⇒ tracked board before running anything. The board
  renders Coverage + Untested + Charter/Obstacles/Outlook/Rounds (SBTM) so the plan is auditable.
- Find the tab to QA: `listTabs` → pick the `tabId` from your Step-0 session. If the app needs
  login and there's no session, **hand off** (`human_needed` / ask the user to log in) — never
  type passwords or authenticate on their behalf.

## 2. Perceive — read state (not screenshots)

- `perceive {tabId,max}` → JSON of interactive elements (name/role/center-xy/state). Use this
  to decide what to click and read. Only `captureTab {format:"jpeg",quality:40}` when you
  genuinely need human eyes (layout/color) or to show the user.
- To read exact in-page data (field values, active tab, lists), use a `read` step inside `do`
  (runs JS, returns JSON) — **for the verdict, not to act.**

## 3. Act + Function verdict — pack into ONE `do` call

This is the heart of the skill. `do {tabId, steps:[...]}` runs a chain — act → wait → read →
assert — in one round-trip. Common steps:

- Act (trusted, human-like): `click` (semantic, climbs to the clickable ancestor — opens Radix
  triggers), `fill`, `select`, `clickXY`, `type`, `key`. Locate-fallback: `clickVision`.
- **Speed — use fast-click.** Dragon auto-collapses a trusted click to ~instant (~8–20ms) on
  QA-safe targets (localhost + your own app domains) vs ~0.6–1s on public sites (the eased
  ~26-step cursor path that defeats passive bot-detection). It is **still a real trusted click**
  (`isTrusted=true`, fires framework handlers) — fast-click drops the anti-bot cursor travel, not
  the realness, so it does **not** violate HR1. Automatic on the app under test; force with
  `{fast:true}` on a click step, or `{fast:false}` to keep human motion (e.g. a public login
  wall). Together with packing steps into one `do`, this is the main QA speed lever.
  Call `dragon_rpc {method:"help"}` once to see the live fast-click + lane surface.
- **Watch it run (optional):** `setCursorOverlay {tabId,on:true}` draws a live cursor + click
  ripple on the page — pure evidence/observability, no effect on click speed or accuracy.
- **Modals & text entry (avoid the common traps).** In a dialog, click by **text/selector**
  (`{click:"Save"}` / `{clickSelector}`), not pixels — modal layouts shift and Radix/cmdk dialogs
  render at the END of `<body>`; raise `perceive {max}` (e.g. 200) so the dialog's buttons/fields
  are captured. To put a value in a field use `{fill:{selector,value}}` or `{type:"...",selector}`
  — **never Cmd/Ctrl+V**: CDP cannot fire a real OS-clipboard paste (a synthetic paste keystroke
  does nothing). In a **session window** (Part III) a modal is driven with **zero focus-steal** —
  the window never jumps to the front.
- **Radix "…" action menus:** `{menuSelect:{trigger:{text|selector|xy}, item:{text}}}` opens the
  kebab **and** picks the item **atomically** — a plain two-step click fails (the portaled menu
  dismisses in the gap and the click lands on the row behind). Verified on a real app's Post/Delete menus.
- **Native JS dialogs (`window.confirm/alert/prompt`):** browser UI, NOT the DOM — `perceive`/`read`
  can't see them and they'd block the page. Dragon auto-handles each on open (default alert=OK,
  **confirm/prompt=Cancel** for safety) so nothing wedges. To **accept** a destructive confirm
  ("Delete?"), put `{dialog:{accept:true}}` **BEFORE** the click that opens it; result → `do.dialogHandled`.
  (An in-app Radix `alertdialog` is DOM — just `{click:"Delete"}` in it.)
- **Reuse a QA case (save-skill):** for anything you'll repeat (regression, a login, multi-step
  setup), `saveFlow {name, steps, defaults}` → later `runFlow {name, params}` replays it near-**0-LLM**
  with self-verify. A verified + repeated + secret-free `do` is also auto-saved (Experience Layer).
  Inspect/manage everything at `GET :9233/skills`. Use this instead of re-authoring the same chain.
- Sync: `waitFor {text|selector,timeoutMs}`, `wait {ms}`. **Wait on something the page actually
  contains** — an unsatisfiable `waitFor` that a lenient client swallows is how a run reaches a
  null read and still scores PASS.
- **Custom read (verdict):** `read {read:"<js; return ...>", as:"key"}` → value lands in
  `out.reads[key]`.
- **Network verdict:** `expectNet {pattern,status?,method?}` → assert an API call (e.g.
  `POST /api/orders → 201`). Verdict-by-network is the most reliable way to grade a write.
- **Simulate leaving/returning to the tab:** prefer `switchTab {ms}` (real); `focusCycle {ms}`
  (in-page, works under CSP) when a real switch isn't possible — both test refocus-state bugs.
- Control: `if/then/else`, `repeat`, `assert`, `dismiss`.

Choose the verdict type:

| Situation | How to grade | Step |
|---|---|---|
| Action that writes to a DB (create/update/delete) | API call status | `expectNet {pattern,status,method}` |
| Display / computation / UI state | Read DOM and compare | `read` + compare in script |
| State retained after leaving the tab | switch/focus cycle then re-read | `switchTab`/`focusCycle` + `read` |
| Element present/absent | shown or not | `assert {text\|selector,absent?}` |

Per-pattern recipes (CRUD+delete, display/aggregate read-flags, page-state on refocus,
i18n/currency, form validation): `references/recipes.md`. Full list of `do` steps:
`references/do-macro.md`.

## 4. Gate 0 — A/B/D sweeps + per-state vision (MANDATORY)

- Append the ui-sanity and a11y `read` steps **into the same `do` chain** at each settled state
  (after load, after each modal/popover opens, final state) — they ride along in the one
  round-trip, so they cost ~nothing. Step JSON in HR3; rule detail in Part II.
- At that same settled point, capture the canonical PNG **before the next action**, inspect
  C10–C16, and compare it with an approved baseline when one exists.
- Read console/network for D1–D4 over the same window.
- Collect: per-state `ui_sanity_*` / a11y reads, state PNGs, C10–C16 verdicts, and any C-REG diff
  → this produces the `UI:` and `Visual:` lines of the report.
- Persist one `qa-gui/state-receipt/v1` JSON per state, bound to case, state, URL, exact build,
  viewport and Dragon session/action/tab IDs. It must contain raw function assertions,
  ui-sanity/a11y/console/network, preflight, screenshot SHA-256, and `innerOk:true`.
- Behavioral/write flows also record `before → action → network → readback → refresh →
  postcondition` in `lifecycle`. Missing evidence is `UNGRADED`, never inferred PASS.
- Distinct states with identical screenshot bytes fail integrity unless the later receipt declares
  an explicit `equivalentTo` case/state and a concrete reason. Generic screenshots are not proof.
- For a workflow with a state machine or an escaped defect, run `scripts/transition-corpus.mjs` on
  the frozen machine definition. Every state needs a case/build-bound receipt, every transition needs
  the exact from/to receipts and all six lifecycle phases; coverage below 100% may not close a regression.
- **A sweep that returned nothing is not a clean sweep.** A missing/`null` verdict is a hard
  error to investigate (denied read, changed shape, CSP) and is reported as **not measurable** —
  never as PASS.

## 5. Record — run the gate, then the report contract (both verdicts, always)

**Report = the OUTPUT of a `scripts/qa-gate.mjs` PASS. Gate not passed = no report to deliver.**
The gate is the mandatory last step before delivery. Verdict is tri-valued: **PASS | FAIL | UNGRADED**,
and **UNGRADED is not PASS**. On canonical schema 4/5 the gate recomputes Function/UI from state receipts;
board-authored verdict strings cannot override the computed result.

Use this template — **a report without the `UI:` line is incomplete; do not deliver it:**

```
Case:     <name> · Build/commit: <if known>
Env/DB:   <what you verified empirically in Step 0, e.g. "prod bundle → supabase cbtnmjgsa">
Viewport: <e.g. 1280x800>
Plan:     <Notion/Sheet link or file path> | inline (≤3 cases) | waived by user
Function: PASS | FAIL | BLOCKED — <evidence: net status / values read>
UI:       PASS | FAIL — <n high, n warn> — <top issues: rule sel detail>
Visual:   C10..C16 PASS|FAIL|WAIVE — <per-state findings; baseline pending or max diff%>
Evidence: <n recordings + one canonical PNG per settled state + any C-REG diff paths>
States swept: <after-load, after-open-X, final>
```

- A real GUI interaction you genuinely could not complete = **BLOCKED**, never a fake PASS.
- An environment that could not be measured = **UNGRADED** — say so and stop; never quietly
  narrow the acceptance to whatever happened to run.
- If a tracker/board is in play, record the verdict there (with proof); otherwise report inline.

---

# Part V — Optional layers, pitfalls, safety

## (Optional) Product-Taste Review Layer — "is it good?" not just "does it work?"

> **Basic UI correctness is NOT this layer** — that's the mandatory Gate 0 (Part II). This
> layer is aesthetics/taste only. Use when the user asks to **review the design / review the taste /
> grade the taste / is this UI good / critique this page / check CSS / is the typography OK**, or when
> QA-ing a landing / product screen / clip frame needs an aesthetic verdict. **Full runnable
> rubric (paste-grade detail, A1–A6 · B1–B7 · C1–C13 + verdict + feedback-contract):
> `references/taste-rubric.md`** (versioned from the Dragon Browser project's `UI-Critic-Rubric-v1.md`).
> Remember the naming collision warning in Part II — these letters are the rubric's, not Gate-0's.

Run **3 gates in order, stop early to save cost:**

1. **Gate 1 — Deterministic (machine, no LLM):** inject axe-core + read
   `getComputedStyle`/bbox via `read` steps → score **A1–A6**. Any `critical|high` → **FAIL now**,
   skip the rest. Catches a11y, overflow/clipping, contrast, console/network errors, responsive,
   off-scale spacing/type.
2. **Gate 2 — Anti-slop hard flags (C1–C13):** scan the CSS you already read (default Tailwind
   palette, purple→pink gradient, Inter-everywhere, single hard shadow, over-rounded, missing
   focus/empty-state). Functional hard-flags **C9** (missing empty/loading/error states) and
   **C13** (missing focus / unlabeled icon-button) → FAIL.
3. **Gate 3 — Taste score 0–100 (VLM judge):** only when Gate 1 is clean. `captureTab` JPEG +
   attach the DOM facts you read → score **B1–B7 per-criterion, reasoning-before-score, ≥3
   samples take the median** (never one holistic score).

**Mandatory pre-conditions (else mass false-positives):** measure after `window.load` +
`document.fonts.ready` + 2×`requestAnimationFrame`; pin & declare the viewport (desktop taste
default comes from the canonical row; responsive rows come only from
`scripts/loop7/responsive-matrix.mjs`); use epsilon ≥1px. The highest-priority CSS/typography
group (🅒 = A6, B1, B2, B5, B6, C1, C2, C6–C8, C11) runs first.

**Verdict:**

```
deterministic critical|high               → FAIL  (skip VLM)
anti-slop functional hard-flag (C9|C13)   → FAIL
taste_score < 70 with a critical issue    → FAIL
taste_score < 85                          → WARN
else                                      → PASS
```

Emit one unified feedback-contract (each issue = `source · rule · severity · selector ·
expected/actual · fix_hint`); the auto-fix loop only iterates on `critical|high`, `low|medium`
are advisory. Needs axe-core (Gate 1) + a VLM (Gate 3); **no VLM → run Gates 1–2 and report
taste = "not scored"**. On CSP-locked editors, run on the deployed/preview build. Clip frames
(no DOM) → Gate 3 + visual anti-slop (C2/C4/C11) only.

## Composition — when the QA subject is an IMAGE/VIDEO

> qa-gui grades **the function + UI + taste of a web app**. When the QA subject is **an image / video frame / poster / slide / diagram** (not a web UI) → grade the **COMPOSITION** with the **`composition-critic`** skill (Checklist §C of its composition principles). Pre-ship gate: ≥3 FAIL = redo the layout.

## Pitfalls to know (read when hit)

- **CSP blocks eval:** some pages (often builder/editor UIs) block `executeJs`/`read` (eval).
  Use `perceive`/`click`/`fill`/`type`/`focusCycle` (function-injection, no eval) instead. If
  you must read state with JS, do it on a page that allows eval (e.g. the deployed/preview app
  rather than a locked editor). The sweep is then **not measurable**, not clean.
  *(Reading-fallback only — never reach for a non-GUI trick to act.)*
- **Synthetic-DOM reads denied:** first `{read:"<js>"}` comes back denied and every later call
  returns `CIRCUIT_OPEN` — you opened the session on Dragon's default policy. See Part III and
  `references/troubleshooting.md`.
- **ui-sanity does not survive navigation:** `executeJs`/`read`-injected script is wiped by
  `goto` — inline the file into each sweep `read` step; never assume `__uiSanity` still exists.
- **🚨 Reloading the extension orphans chrome.debugger:** after reloading the Dragon extension
  to pick up new code, trusted mouse (`Input.dispatchMouseEvent`) times out (~5s) while
  `read`/`focusCycle`/`perceive` still work. **Recovery: open a NEW tab + `setActiveTab` to it**
  (`reloadTab` is not enough). Avoid reloading mid-session.
- **Locked surface fails on Lane A:** `chrome://`, Web Store, dev consoles can't be scripted by
  the extension — let the router send them to **Lane B** (or pass `lane:"B"`). Don't fall back to
  pixel tools.
- **Verifying typed text in a contenteditable:** `perceive` names don't reflect contenteditable
  contents — take one screenshot to confirm before submitting.
- Full list: `references/troubleshooting.md`.

## Safety

- Never type passwords or authenticate on the user's behalf — hand off (`human_needed`) or ask
  them to log in. Never solve CAPTCHAs.
- Creating/editing/deleting test data on a TEST app is fine with the user's permission. On a
  production app, ask before any irreversible write/delete.
- Honesty over green: if you can't drive it like a human, it's **BLOCKED**; if you couldn't
  measure the environment at all, it's **UNGRADED** — never manufacture a pass with a non-GUI
  shortcut and never silently shrink the acceptance to fit what ran.

## Team QA roster binding

Native Codex execution in QA GUI 2.13 uses the existing attestation gate and receipt readback.
The verified Team QA runner locks `native_gui.policy_path` and `policy_sha256` before spawning
an independent GUI executor, verifies original Codex host/model/effort/context metadata through
the QA Code native parser, then calls `validateNativeGuiTrajectory({calls,policy})` from
`scripts/lib/native-gui-trajectory.mjs`. `nativeGuiPolicyErrors(policy)` validates policy shape.
Unknown tools, helpers, capabilities, source pairs, stale session/nonce/browser metadata,
untrusted or fast input, unmasked captures, and incomplete recording delivery return UNGRADED.
The policy pins Dragon 1.6.4, exact tool namespace/name, target URL and full Git SHA, allowed
measurement reads and commands, helper file hashes, and call cap; Team QA verifies canonical
roots and actual bytes before invoking the pure checker. Behavioral trajectories require a
privacy-attested start, trusted action, stop and assembly; every trajectory needs a masked PNG.
This trajectory verdict certifies policy compliance only. Product Function/UI verdicts still
come from the existing frozen plan, state receipts and semantic gate; no parser or synthetic
fixture can substitute for application QA. The existing original/annotated finding renderer
and standalone CLI interface remain unchanged. See `references/native-gui-adapter.md`.

In a current Team QA run, the GUI agent uses the provider/model/effort of the roster the user has settled, its own session and the locked direct Dragon route. After the controlled runner verifies the real source, call the gate with `--teamqa-attestation <run-dir>/role-bindings/executor_gui.json`; add `--teamqa-runtime <verified-package>` when checking a candidate. All release-truth v2 arguments are required. The gate checks package, phase, role/session/config/context and target, then attaches provenance to the sealed receipt; the verifier re-reads the proof independently. Without a real attestation, a Team QA run is not certified. Standalone QA-GUI keeps its existing interface.

A web-v1 receipt (deployed build) accepts two kinds of GUI executor. Root Codex: executor `codex-native` through native policy v2, bound to the target as above. Root Claude Code: the GUI Executor is a `claude -p` worker, and its attestation has `source.kind=claude-stream`. The gate accepts this attestation when Team QA has verified the role and the hashed stream passes rule `qa-gui/claude-stream-dragon-route/v1`: init has exactly the Dragon MCP server the roster locked (`connected`); at least one `mcp__<server>__dragon_rpc` succeeds; the stream ends with a successful `result` in the same session; no tool call takes a browser route outside Dragon (another MCP server, `WebFetch`/`WebSearch`/`Task`/`Agent`, a server tool, or a Bash command that calls Playwright/Puppeteer/Selenium/Chromium/CDP/`open`). Errors have stable codes `TEAMQA_WEB_CLAUDE_*`; the receipt records `teamqa_provenance.executor_route`. This rule proves the MCP route only; it does not replace native policy v2 (it does not pin the Dragon session/tab, capability, trusted receipt, privacy mask or recording). The default Team QA runtime is `~/.agents/skills/team-qa`; use `--teamqa-runtime <dir>` for a runtime installed elsewhere; the canonical anchor and `verify-runtime` still apply. See `references/release-receipt-web-v1.md`.
