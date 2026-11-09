# State receipt v1

Every schema v3+ settled state has exactly one JSON receipt listed in both
`cases[].stateReceipts` and `cases[].evidence`.

For teamwork schemas 4/5/6, the receipt also binds atomic requirements and raw write/readback
evidence used by Release Truth 2.7. Schema 3 keeps its historical assertion keys for compatibility;
schemas 4/5/6 use the keys shown below.

```json
{
  "schema": "qa-gui/state-receipt/v1",
  "caseId": "TC-01",
  "state": "after-submit",
  "capturedAt": "2026-08-11T03:10:00Z",
  "url": "https://test.example/qc",
  "build": "<exact deployed commit/build>",
  "viewport": "1280x800",
  "domHash": "<sha256 of the machine-measured settled DOM>",
  "dragon": {
    "sessionId": "<session>",
    "actionId": "<action/flow>",
    "browserInstanceId": "<browser>",
    "tabId": "<tab>",
    "innerOk": true
  },
  "screenshot": {
    "path": "qa-evidence/<app>/round-1/1280x800/after-submit.png",
    "sha256": "<64 lowercase hex>"
  },
  "function": {
    "verdict": "PASS",
    "assertions": [
      { "requirement_id": "REQ-SAVE-01", "verdict": "PASS", "evidence_ref": "evidence/save-readback.json" }
    ]
  },
  "ui": {
    "verdict": "PASS",
    "uiSanity": { "id": "ui-sanity", "verdict": "PASS", "evidence": "raw sweep output" },
    "a11y": { "id": "a11y", "verdict": "PASS", "evidence": "raw sweep output" },
    "console": { "id": "console", "verdict": "PASS", "evidence": "raw console output" },
    "network": { "id": "network", "verdict": "PASS", "evidence": "raw network output" }
  },
  "preflight": { "id": "preflight", "verdict": "PASS", "evidence": "raw preflight output" },
  "network": [
    { "method": "POST", "url": "https://test.example/api/save", "status": 200 }
  ],
  "readback": {
    "value": { "status": "saved" },
    "evidence_ref": "evidence/save-readback.json"
  },
  "lifecycle": {
    "before": { "verdict": "PASS", "evidence_ref": "evidence/before.json" },
    "action": { "verdict": "PASS", "evidence_ref": "evidence/action.json", "writes_data": true },
    "network": { "verdict": "PASS", "evidence_ref": "evidence/network.json", "expect_net": true },
    "readback": { "verdict": "PASS", "evidence_ref": "evidence/save-readback.json" },
    "refresh": { "verdict": "PASS", "evidence_ref": "evidence/refresh.json" },
    "postcondition": { "verdict": "PASS", "evidence_ref": "evidence/postcondition.json" }
  }
}
```

Behavioral cases require all six lifecycle phases. The gate derives the case kind from mutating
network methods and lifecycle flags, derives Function/UI from the raw assertions, verifies every
`evidence_ref` against the board `evidenceManifest`, and compares board-authored verdicts with the
computed result. Any FAIL wins; any missing/UNGRADED makes the result UNGRADED.

When `equivalentTo` reuses identical screenshot bytes, both receipts must have the same `domHash`
and the later receipt must name the earlier `<caseId>:<state>`. A prose reason without DOM hash
equality is rejected.

A receipt may also name the coverage cell it backs (R1b): an optional `cell` object
(`qa-gui/coverage-cell/v1`: `route`, `state?`, `action`, `viewport` row, `conditions`, `rows?`). The gate checks it in
every mode and keeps the state from PASS when it is malformed or contradicted by the receipt's own row count or
viewport. See [coverage cells](coverage-cells.md).

A receipt may also name the detectors' probe receipts it relies on (R1e, R1d): `probes: [{kind, path, sha256, cells?}]`
with `kind` `width-sweep`, `overlay-check` or `transient`, each file in the evidence manifest. The gate grades each
probe itself and adds its verdict to the state's UI verdict. See [width sweep, overlay check and
exploration](width-sweep-overlays.md) and [transient rules](transient-rules.md).

## Environment conditions (R1d)

A state observed on a tab whose Dragon environment was touched (R1a `env.set`, sensors or a frame window) carries an
`env` block, copied from Dragon:

```json
"env": {
  "conditions": { "v": 1, "caseId": "TC-01", "role": "test", "network": { "offline": true, "latencyMs": 0, "downloadKbps": null, "uploadKbps": null, "urlPattern": null },
    "cpu": null, "timezone": null, "locale": null, "media": null, "animation": null, "requests": [],
    "probes": { "sensors": true, "frames": false }, "verified": true, "setAt": 1793143771543, "expiresAt": 1793144671543 },
  "reset": { "evidence_ref": "evidence/TC-01/env-reset.json" }
}
```

- `conditions` is the `receipt.env.conditions` of the Dragon action that led to this state, unchanged (Dragon's closed
  record), or `null` when that receipt had none (all defaults).
- `reset` names the raw result of the case's `env.reset` (Dragon's result object or its `dragon_rpc` envelope), listed in
  the evidence manifest. Call `env.reset {tabId}` at the end of every case, also when it ends early, and put the reference
  on one state receipt of the case (normally the last).

Every gate mode checks it; a failure is UNGRADED, turns the case's PASS rows UNGRADED and keeps the case from PASS:

| Code | Checked |
|---|---|
| `ENV_CONDITIONS_INVALID` | `env` is `{conditions, reset?}`; `conditions` is `null` or Dragon's closed record |
| `ENV_CONDITIONS_UNVERIFIED` | a forced dimension (network, CPU above 1x, time zone, locale, media, animation, request rules) read back: `verified:true` |
| `ENV_CONDITIONS_CASE_MISMATCH` | `conditions.caseId` is `null` or this case (pass the board case id as `env.set {caseId}`) |
| `ENV_EVIDENCE_TAB_VERDICT` | the tab is not a `role:"evidence"` tab (an evidence tab takes no verdict) |
| `ENV_RESET_EVIDENCE_INVALID` | the reset reference is in the manifest and parses |
| `ENV_RESET_UNVERIFIED` | the reset result is `ok:true, atDefault:true`, no mismatch or error, and its record is at the defaults (`ENV_RESET_UNVERIFIED` from Dragon lands here) |
| `ENV_RESET_CASE_MISMATCH` | the reset ended this case (`endedCase` is this case or `null`) |
| `ENV_RESET_MISSING` | a case with an `env` block or a transient probe names a verified reset |
| `ENV_BLOCK_REQUIRED` | a state with a `transient` probe has an `env` block |

A receipt without `env` and without a transient probe is graded exactly as before.

## Evidence policy v1 (correct and light evidence)

A board turns these checks on with a top-level `evidencePolicy: {version: 1}` (canonical schema 4/5/6;
`teamwork init --evidence-policy 1` writes it). Without it, every board and receipt is graded exactly as
before. With it, the gate (`scripts/qa-gate.mjs`, every mode: default, release-truth v2 and web-v1) runs the
checks of `scripts/lib/evidence-quality.mjs` on top of the byte checks (file exists, valid PNG / mp4 over 50 KB,
SHA-256 matches). A failed check is an UNGRADED issue with a stable code and a fix hint; it adds UNGRADED to the
case's computed verdict and turns the case's PASS atomic rows into UNGRADED, so the case cannot PASS (a FAIL
assertion still makes it FAIL). A board that keeps claiming PASS for that case fails on the verdict mismatch.

### Screenshot fields

```json
"screenshot": {
  "path": "evidence/qa-gui/TC-02/after-save.png",
  "sha256": "<sha256 of the evidence PNG, the fitted file>",
  "capture": {
    "tabId": "7", "url": "https://test.example/orders/1", "build": "<app build measured on that tab>",
    "domHash": "<Dragon domHash of the capture>", "sha256": "<Dragon sha256 of the capture file>",
    "viewport": "1440x757", "maskedRects": [{ "kind": "secret", "x": 114, "y": 224, "w": 318, "h": 48 }],
    "domStable": true
  },
  "fit": { "fromSha256": "<capture sha256>", "fromWidth": 2880, "fromHeight": 1514, "width": 1280, "height": 673 }
},
"target": { "selector": "#save", "rect": { "x": 24, "y": 247, "width": 118, "height": 36 } }
```

- `capture` is filled from the Dragon `screenshot`/`captureTab` result and the DOM measurement taken at that
  capture: `tabId` is the tab the capture was called on, `url`/`viewport` are its `dom.url`/`dom.viewport`,
  `domHash` its `domHash`, `sha256` its `sha256` (the file Dragon saved), `maskedRects` its privacy-mask boxes
  (CSS px). `build` is the application build measured on that same tab (HR2 Step 0, or Team QA's identity read);
  Dragon's own `build` field is the extension tag, not the application build.
- `fit` is printed by `node scripts/qa-gui.mjs evidence fit --in <capture.png> --out <evidence.png> [--max-width 1280]
  [--masks <maskedRects.json> --viewport <WxH>]`. `fit` may be left out only when the evidence PNG is the capture
  itself (`capture.sha256` equals `screenshot.sha256`) and it is at most 1,280 px wide.
- `target` is optional: the element under test, with its `getBoundingClientRect()` in CSS px, measured at the
  settled state.

| Code | Checked | Fix |
|---|---|---|
| `EVIDENCE_IMAGE_INVALID` | the PNG decodes | re-capture |
| `EVIDENCE_IMAGE_BLANK` | outside the capture's mask boxes, one colour covers less than 99.95% of the pixels and the luminance standard deviation is at least 1 | re-capture |
| `EVIDENCE_IMAGE_BINDING` | `capture` is present; its `tabId`, `url`, `build`, `domHash` (and `viewport` when given) equal the receipt's `dragon.tabId`, `url`, `build`, `domHash` (`viewport`); its `sha256` is `fit.fromSha256` (or the PNG itself with no fit); the PNG has the receipt viewport's aspect ratio (within 1%, 2 px) at 0–4 image px per CSS px (device scale factor, then the fit) | re-capture |
| `EVIDENCE_IMAGE_TARGET_OUTSIDE` | `target.rect` is well formed and lies inside the viewport (1 CSS px tolerance) | re-capture |
| `EVIDENCE_IMAGE_TOO_WIDE` | the evidence PNG is at most 1,280 px wide | re-capture |
| `EVIDENCE_IMAGE_FIT` | `fit` is well formed, its `width`/`height` are the PNG's, and `fromWidth`×`fromHeight` scales to them | re-capture |

The fit is a box-filter downscale (exact overlap weights, integer sums) and a PNG encode with `node:zlib`
(RGB when opaque, per-row adaptive filter, deflate level 9): the same capture gives the same bytes. A pixel whose
whole source span is mask black stays exactly black, and with `--masks`/`--viewport` the scaled mask boxes are
painted black again, rounded outward. Baselines for `visual-diff.mjs` go through the same fit (copy the fitted
round PNG into the baseline tree), so a baseline and a round screenshot keep the same size; `visual-diff.mjs`
refuses to compare PNGs of different sizes and names the fit.

### Recording manifest (`qa-gui/recording-manifest/v1`)

`node scripts/qa-gui.mjs recording-manifest --dir <Dragon recording dir> --out <manifest.json> --video <assembled mp4>
[--receipts <the case's Dragon action receipts, .json or .jsonl>]` reads the recording dir Dragon wrote
(`events.json` and its `f-NNNNNN.jpg` frames, the `dir` of `startRecording`/`stopRecording`) and writes:

```json
{
  "schema": "qa-gui/recording-manifest/v1", "id": "rec-20261027-232931-e45f32", "startedAt": 1793143771543,
  "durationMs": 5006, "viewport": { "deviceWidth": 1280, "deviceHeight": 800 }, "result": "ok",
  "frameSize": { "width": 1280, "height": 800 }, "frameBytes": 350000,
  "frames": [{ "t": 70, "file": "f-000000.jpg", "sha256": "<sha256 of the frame bytes>", "bytes": 14101 }],
  "events": [], "actionSource": "dragon-receipts",
  "actions": [{ "t": 1143, "kind": "reloadTab", "source": "dragon-receipt", "actionId": "act-…" }],
  "delivery": { "extensionFrames": 20, "persistedFrames": 20, "ingestErrors": 0 },
  "video": { "sha256": "<sha256 of the mp4>", "bytes": 61440 }
}
```

The manifest is listed in the case evidence (and `evidenceManifest`, type `recording-manifest`) and named by its
segment: `recordingSegments: [{file: "<mp4>", startMs, endMs, manifest: "<manifest.json>"}]`, where `startMs`/`endMs`
are on the recording clock (frame `t`). Under the policy a Git-target board may carry `recordingSegments` too.

Action times, most trustworthy first: the recording's own input events (`events[]` of kind `down` or `key`), which
the extension stamps `Date.now() - startedAt` on the same clock as the frames. Navigations, `insertText` fills and
some extension builds send no events; then the case's Dragon action receipts give them: `ts` (epoch ms, extension
clock) minus the manifest `startedAt` (the bridge's clock, read just before the extension starts recording), so a
receipt time can read up to that start latency late (tens of ms); receipts from before `startedAt` are dropped.
`actionSource` names which one was used (`recording-events`, `dragon-receipts` or `none`).

For each behavioral segment, over the frames and actions inside `[startMs, endMs]`:

| Code | Checked | Fix |
|---|---|---|
| `EVIDENCE_VIDEO_MANIFEST` | the segment names a manifest listed in the case evidence and the evidence manifest; it parses as v1; its `video.sha256` is the segment mp4's | re-record |
| `EVIDENCE_VIDEO_FRAME_COUNT` | `delivery.extensionFrames === delivery.persistedFrames === frames.length` (frames sent = frames saved), at least one frame | re-record |
| `EVIDENCE_VIDEO_NO_ACTION_COVERAGE` | at least one action time; a frame before the first action, a frame within 1,000 ms of every action, a frame after the last action | re-record |
| `EVIDENCE_VIDEO_NO_CHANGE` | the frame after the last action differs from the frame before the first action, and some frame changes within 3,000 ms after an action | re-record |
| `EVIDENCE_VIDEO_STALE` | the action window `[first action − 1,000 ms, last action + 3,000 ms]` is not one repeated image (every consecutive frame identical) | re-record |

Why the stale test looks at the action window and not at "most frames": Dragon grabs a fresh frame at a min-fps
floor even on a static page, so a real recording is mostly identical consecutive frames (the run4 recording the
fixture comes from: 141 frames, 126 of them one image, 93% identical pairs, because the page sat still for 31 s
after the actions). A whole-recording majority rule would reject good recordings; one image across the action
window is the stale repeat.

### Light evidence: size note

Measured on this repository's fixtures:

- Screenshot: `qa-evidence/fixture-a/…/after-load.png` is a 2560×1600 retina capture of a 1280×800 viewport,
  103,681 bytes; `evidence fit --max-width 1280` gives 1280×800, 53,627 bytes (−48% bytes, −75% pixels), the same
  bytes on every run.
- Recording frames (estimates, re-encoding with libjpeg, not Chrome's encoder): a 1280×800 run4 frame averages
  17.5 KB as recorded; at quality 50 it is about 0.90× of quality 80, and at quality 50 and 960 px wide about
  0.66×. On a retina display the frame is the full 2560×1600 surface: about 136 KB at quality 80, 109 KB at
  quality 50, and 21 KB at quality 50 and 960×600 (6.5× smaller). The recording guidance is
  `startRecording {tabId, quality:50, maxWidth:960, maxHeight:960}`; Dragon 1.6.x applies `quality` but its
  recorder grabs every frame with `Page.captureScreenshot` at full surface size, so `maxWidth`/`maxHeight` take
  effect only once Dragon honours them (an open Dragon change). `assembleRecording` is unchanged (ffmpeg crf 20).
