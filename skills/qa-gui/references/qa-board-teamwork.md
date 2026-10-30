# QA Board teamwork v6

Use this path when the QA board is also the team workspace for comments, assignment, fix
evidence, retest, and release review. The default surface is Space (native Codex Pages), then
Notion when Pages is absent or unavailable, then Doc-Colab when both cloud providers are absent
or unavailable. An uncertain write or failed readback stops; it never triggers another write.

The canonical and gates live in `qa-gui`. Pages and Notion are generated projections; neither
is a second authoring source. The Doc-Colab fallback preserves exact canonical in `DOC_DATA.qaBoard`.

## 1. Canonical first

Copy `scripts/teamwork/example-canonical.json` to the round evidence folder, then edit only the
copy. The machine values remain English even when `language` is `vi`:

`TODO DOING PASS FAIL BLOCKED ASSIGNED FIXING RETEST VERIFIED CLOSED REOPENED REJECTED DEFERRED`

Validate before rendering or syncing:

```bash
node scripts/teamwork/validate-canonical.mjs qa-evidence/<round>/canonical.json
```

Team QA calls the stable machine-readable wrapper instead of importing modules or copying rules:

```bash
node scripts/teamwork/cli.mjs validate --file qa-evidence/<round>/canonical.json
node scripts/teamwork/cli.mjs render --file qa-evidence/<round>/canonical.json \
  --out qa-evidence/<round>/QA-Board.html
```

The wrapper also exposes `init`, `migrate-sources`, `apply`, `export-page`, `compare-page`,
`export-notion`, `compare-notion`,
and `sync-notion`. `init` accepts an optional `--source-seed`; `migrate-sources`, `apply`, and
`sync-notion` require a distinct `--out` path so the prior canonical revision remains recoverable.

Delivery prose has a separate strict check: use `inspectBoardQuality(data)` and
`validateBoardReview({data,review,canonicalSha256})` from
`scripts/teamwork/board-quality.mjs`. They do not replace `validateCanonical` or determine Function/UI
results. See `references/board-quality.md` for the action-front and exact review contract.

Any missing required field, unknown status, broken round reference, or invalid defect state must
stop the round. Do not render or synchronize invalid data.

### Schema v6 — upstream source traceability

Schema 6 pairs `canonicalVersion: "qa-board-teamwork/v2"` with
`boardKind: "team-qa-board"`. Its canonical source registry is `sourceItems[]`; every case carries
one or more exact `sourceRefs[]`. Registry order and each case's reference order are canonical and
must be preserved by renderers and adapters.

```json
{
  "sourceItems": [
    {
      "id": "SRC-JIRA-42",
      "kind": "issue",
      "sourceSystem": "jira",
      "externalKey": "APP-42",
      "title": "Save action loses the selected owner",
      "url": "https://jira.example.test/browse/APP-42",
      "origin": "upstream"
    },
    {
      "id": "SRC-QA-EMPTY",
      "kind": "qa-derived",
      "sourceSystem": "qa-gui",
      "externalKey": "QA-EMPTY-STATE",
      "title": "Empty-state regression guardrail",
      "origin": "qa-derived",
      "qaDerivedReason": "QA added this guardrail after a repeated empty-state regression."
    }
  ],
  "cases": [
    { "id": "TC-01", "sourceRefs": ["SRC-JIRA-42", "SRC-QA-EMPTY"] }
  ]
}
```

- `id` is the stable local identity. `kind`, `sourceSystem`, `externalKey`, and `title` are
  required; `url` is optional. `(sourceSystem, externalKey)` and local ids are unique.
- One source may feed many cases and one case may name many sources. A missing, duplicate, or
  unknown ref fails at the exact case path. Titles and ids are never parsed or guessed to create
  a ref.
- A QA guardrail declares both `origin: "qa-derived"` and `kind: "qa-derived"`, plus a concrete
  `qaDerivedReason`. An upstream item cannot carry that reason or use the QA-derived kind.
- Defects do not duplicate source metadata or refs. They continue to point to a case through
  `caseId`, yielding the single chain source → case → defect.
- The literal field `Issue Group`/`issueGroup` is rejected by canonical validation. Presentation
  adapters may derive a label from exact `sourceSystem` values only.

New boards can be seeded without constructing qa-gui canonical data outside qa-gui:

```bash
node scripts/teamwork/cli.mjs init \
  --board-id <round-id> --title <title> --language en \
  --source-seed scripts/teamwork/example-source-seed.json \
  --out qa-evidence/<round>/canonical.json
```

The `qa-source-seed/v1` document must explicitly state each case's `id`, `title`, `requirement`,
and `sourceRefs`; omitting the title or refs is an error, not an invitation to infer them.

Schema 4/5 boards remain valid as `qa-board-teamwork/v1`. Migrate only with a reviewed exact
mapping such as `scripts/teamwork/example-source-mapping.json`:

```bash
node scripts/teamwork/cli.mjs migrate-sources \
  --file qa-evidence/<round>/canonical-v5.json \
  --mapping qa-evidence/<round>/source-mapping.json \
  --out qa-evidence/<round>/canonical-v6.json
```

Every legacy case must appear exactly once in `caseMappings[]`. The command validates input and
output, refuses to overwrite either path, and never matches on a case title or requirement id.

### Schema v5 — finding evidence

`schemaVersion: 5` lets a defect carry `findings[]` and `evidence[]`. Schema v4 boards stay valid
and unchanged. Every evidence item names the finding it documents:

```json
"findings": [{ "id": "F-01", "rule": "unintended-text-overflow", "severity": "high",
               "selector": "div > a.inline-flex", "caption": "…", "bbox": { "…": 0 } }],
"evidence": [
  { "id": "EV-ORIGINAL",  "type": "image", "path": "evidence/phone-320.png",
    "role": "original",  "findingId": "F-01" },
  { "id": "EV-ANNOTATED", "type": "image", "path": "evidence/phone-320.annotated.png",
    "role": "annotated", "findingId": "F-01" }
]
```

- A finding with a measured `bbox` needs exactly one `original` and one `annotated` image bound to
  it by `findingId`. Missing either role fails at `defects[n].evidence` and names the defect.
- The annotated path ends in `.annotated.png` and is a different file from the original. A finding
  that carries a `bboxReason` instead of a box has nothing to annotate and is not asked for the pair.
- An evidence path is a round-relative file or an `http(s)` URL; any other scheme is rejected
  before it reaches the board's `href`.
- The board renders the annotated image inside the defect's `Finding evidence` card, linked to its
  full-size file, with a separate labelled link to the original capture.

### Schema v5 — prose language gate

A `schemaVersion: 5` board writes every sentence a human reads in the language it declares in
`language`. The gate reads the board title, case `title`, `steps`, `expected`, and `humanSummary`,
defect `title`, `repro`, `expected`, `actual`, finding `caption`, round `scope`, release risks, and
comment text. A mismatch fails at that exact field path, names the case or defect, and quotes the
offending sentence. Schema v4 boards are not gated.

- Gated languages: `vi`, `en`, `ko`, `ja`. A board declaring any other language — `th`, `zh` —
  reports `language-unsupported` at `language` and the run is **UNGRADED**, not `PASS`: the gate
  declines to judge rather than wave prose through. An ungraded board still does not render or
  sync, because a gate that cannot answer must not certify.
- Machine values are exempt everywhere and stay English: `machine.rule`, `machine.selector`,
  finding `rule`, `severity`, and `selector`, ids, statuses, priorities, `requirement`, `app`,
  `envDb`, `viewport`, evidence paths, and timestamps.
- Machine tokens embedded *inside* a sentence are also exempt, so a Vietnamese caption may name
  `div > a.inline-flex`, `320 px`, `CSS`, `unintended-text-overflow`, or `evidence/phone-320.png`
  without failing. The gate weighs only the words left after those tokens are lifted out.
- The signal is orthographic, not a word list: Hangul, kana, and Han are counted directly, and
  Latin prose is separated by the density of Vietnamese diacritics. One borrowed word never moves
  a field; an English clause inside a `vi` field — Vietnamese for "the button is covered" followed
  by `and users cannot save.` — does.
- Consequence for `vi`: write Vietnamese with its diacritics. Unaccented Vietnamese reads as
  foreign prose to the gate and is treated as a language mismatch.

### Schema v5 — required round fields

A `schemaVersion: 5` board carries the prose that lets someone who did not run the round read it.
Every gap fails at the exact field path and names the owning case or defect. Schema v4 boards are
not gated and keep their looser shape.

- A case whose `status` has left `TODO` writes non-blank `steps` and `expected`: what was run, and
  what should have happened. A `TODO` case is a plan nobody has executed yet, so it is not asked
  for them — the gate starts once the case makes a claim.
- Every defect writes all four parts: `actual`, `expected`, `repro`, and at least one QA evidence
  entry under `evidence[]`. The first three fail at `defects[n].actual`, `.expected`, and `.repro`;
  the missing capture fails at `defects[n].evidence` under the finding-evidence rule above.
- Whitespace is absence. `"   "` says nothing a missing key does not, and both fail the same way.
- The report is deterministic: errors come out in board order, so two runs over the same board
  return the identical list.

## 2. Doc-Colab native renderer and hardening

```bash
node scripts/teamwork/doc-colab-renderer.mjs \
  qa-evidence/<round>/canonical.json \
  --out qa-evidence/<round>/QA-Board.html \
  --doc-colab-root /path/to/doc-colab/skill/doc-colab
```

`--doc-colab-root` may be omitted after the compatible Doc-Colab skill is installed at user
scope, or set through `DOC_COLAB_SKILL_ROOT`.

The renderer generates and then invokes Doc-Colab's external integrity verifier against the
same canonical JSON. It returns success only when that verifier emits `verdict=pass`. The HTML
is a sealed build artifact; QA agents never edit `DOC_DATA`, HTML, CSS, JavaScript, or the
generator-owned `.doc-colab-lock.json` receipt directly.

Open the board through Dragon. Human edits are trusted GUI actions. Read only this state packet:

```js
return window.__docColabState();
```

The packet contains `qaDelta = {baseRev,updates,comments,evidence}` plus the Doc-Colab v2 fields.
Save the packet JSON, then materialize file evidence and write a new canonical revision:

```bash
node scripts/teamwork/doc-colab-hardener.mjs \
  qa-evidence/<round>/canonical.json qa-evidence/<round>/packet.json \
  --evidence-dir qa-evidence/<round>/evidence \
  --out qa-evidence/<round>/canonical-rev-next.json \
  --actor Owner --now 2026-08-11T08:20:00Z --qa-actors Owner
```

The hardener refuses to overwrite its input. Validate the new revision, render again, reopen,
then clear staging. A revision mismatch is a conflict, never a silent overwrite.

Only `status`, `priority`, and `assignee` are editable. Every accepted edit appends history with
actor, old value, new value, timestamp, and source.

## 3. Defect workflow

- A defect may enter `RETEST` only after at least one new fix-evidence item was added since its
  previous retest.
- The creator cannot set their own defect to `CLOSED`.
- `VERIFIED`, `CLOSED`, and `REOPENED` require an actor listed in `qaActors`.
- `REJECTED` requires one machine reason: `cannot-reproduce`, `as-designed`, or `duplicate`.
- Results are append-only per round. Adding round 2 cannot replace round 1.
- `fixEvidence` remains the dev-side proof attached while a defect is fixed. It is never reused as
  the QA finding evidence in `evidence[]`, and neither list satisfies the other.

## 4. Self-contained delivery

Re-run `doc-colab-renderer.mjs` on the final canonical. Doc-Colab embeds local images and videos
only while the resulting file stays at or below 25 MB. Over-threshold video remains linked and
the board displays a clear disclosure. Evidence is never silently dropped.

Immediately before delivery, verify the final bytes again so any post-render workaround is caught:

```bash
node scripts/teamwork/doc-colab-renderer.mjs \
  qa-evidence/<round>/canonical.json \
  --verify-existing qa-evidence/<round>/QA-Board.html \
  --doc-colab-root /path/to/doc-colab/skill/doc-colab
```

Only `verdict=pass` may proceed to the QA report. Repair means regenerate from canonical JSON;
never patch the HTML to make the board look different.

## 5. Optional Notion adapter

`scripts/teamwork/notion-sync.mjs` does not contain credentials and does not call Notion by
itself. The caller injects a transport with `listRows()` and `upsertRow()`. The adapter:

- maps Cases and Defects from canonical while keeping machine status separate from localized
  labels;
- compares every expected row and requires 100% field match;
- pulls status, priority, assignee, and comments back into canonical with history;
- upserts by `externalId`, so a retry is idempotent;
- reports the first pending row after a partial failure while leaving canonical unchanged.
- projects case sources into `Source Issue`: exact entries in `--notion-source-map` become
  relations, while other sources remain stable external-key/URL objects. The optional JSON map is
  keyed by canonical source id; unknown ids fail closed. Defect rows carry no source duplicate.
- emits `issueGroup` only as `{derived:true,...}` from the ordered source-system list. It is a
  presentation hint, never accepted back into canonical data.

For an offline export/readback test, use the same source-page map on both operations:

```bash
node scripts/teamwork/cli.mjs export-notion --file canonical-v6.json \
  --notion-source-map notion-source-pages.json --out notion-rows.json
node scripts/teamwork/cli.mjs compare-notion --file canonical-v6.json \
  --notion-source-map notion-source-pages.json --snapshot notion-rows.json
```

For a native/Notion conflict, preserve both ordered history events, use the QA-side status as the
final status, and disclose the resolution to both sides. Never add realtime synchronization or a
third renderer in this version.

## 6. Delivery gate

### Release Truth 2.7 fields

A plan may start with empty `states[]`/`stateReceipts[]`, but before any case leaves `TODO` the
canonical must bind the actual run:

```json
{
  "runUuid": "<uuid>",
  "commit": "<full 40-character SHA>",
  "build": "<runtime build marker>",
  "env": "TEST",
  "db": "<measured DB identity>",
  "role": "<tested role>",
  "testProfile": "<profile and denominator>",
  "evidenceManifest": [{ "path": "evidence/file", "sha256": "<64 hex>" }]
}
```

Each completed case adds `requirements[]`, machine-derived `kind`, `states[]`, and exactly one
`stateReceipts[]` link per state. Unknown fields are `UNGRADED`; do not hide future data in an
unrecognized key. For `GO-WITH-RISKS`, record the named approval as
`release.approval={"by":"<name>","ts":"<ISO timestamp>"}`.

Before handing off the board:

```bash
node scripts/qa-gate.mjs qa-evidence/<round>/canonical.json
```

The standalone command writes compatibility `qa-gui/receipt/v1`. When the run has a frozen
requirement graph, invoke the same gate with `--plan`, `--requirements`, `--repo`, and
`--evidence-root`; that path writes `qa-gui/receipt/v2`, whose exact verifier workflow is in
`release-receipt-v2.md`. Treat exit `20` as `UNGRADED`, never as a soft failure to waive. Before
packaging a QA GUI release itself, run `npm run test:release-truth`; it contains the legacy
incident replay plus Session 3 RED/GREEN and live mutation coverage.

Then open the rendered board through Dragon, collect pending comments, run Gate 0 on every
settled state, attach the required recording or screenshot per case, harden all staged data, and
run the gate again. The gate output, exact Git SHA, board, canonical data, and evidence belong in
the review pack.


## Native Page projection and independent readback

```bash
node scripts/teamwork/cli.mjs export-page --file canonical.json --out page-export.json
node scripts/teamwork/cli.mjs compare-page --file canonical.json \
  --snapshot actual-read-page.json --out page-readback-receipt.json
```

`export-page` writes a new `qa-gui/page-export/v1` artifact with `title`, `initial_blocks`
(ordered native Markdown strings), and `canonical:{boardId,rev,sha256}`. The hash binds exact
canonical file bytes, including immutable round results. The caller passes only `title` and
`initial_blocks` to Pages `create_page` after the final write authorization. The marker stays in
the lower technical-reference section. Generated output and receipts refuse overwrites.

Show concise app/environment/build/role/test-profile context first, then active defects, waiting
QA (`RETEST` and `VERIFIED`), resolved defects (`CLOSED` and `REJECTED`), deferred defects (`DEFERRED`), scope and all cases.
Keep each defect assignee directly visible; the creator remains in technical references.
Each defect preserves title, app/environment/viewport and linked case location. When the optional
handoff is present, Page shows its kind, problem, request, and expected outcome before evidence and
reproduction detail; otherwise the legacy actual/expected summary remains visible. Do not infer a
more precise screen location, root cause, owner, or policy. Case Function and UI outcomes remain
separate; exact case/source IDs remain available. Selectors, history, logs, immutable results, and
source registry are references below.

Optional `--evidence-map map.json` applies identically to export and compare. The map is keyed
by an exact canonical evidence path, including `cases[].results[].evidence[]`; each entry is `{"reference":"library-file:observed-id",
"verified":true}`. Only observed `library-file:`, `project-file:`, or HTTPS references are
accepted. The caller must verify access; the CLI checks declarations and safe syntax, not remote
availability. Unknown paths, unverified entries, and unsafe schemes fail. Without a map, local
paths explicitly say they are unavailable in the Page and need upload; they never become cloud
links. Historical round evidence is listed explicitly with the same verified links or upload
disclosures alongside the preserved result records. HTTPS canonical evidence remains a link,
not an assertion of access or rendered media.

`compare-page` consumes the saved real `read_page` MCP response at
`structuredContent.content.{title,page_id,blocks[]}` and `structuredContent.metadata.url`.
Saving `structuredContent` alone is also supported. Every block requires its observed
`id`, `hash`, `kind:"markdown"`, and exact `markdown`; metadata page identity must agree.
Use a complete editing/full read. Excerpts, partial selections, scratch streams, error responses,
export artifacts, and nonnative blocks are rejected. Block-boundary blank paragraph separation
is normalized. Pages also splits list items into separate blocks: blank separators between
adjacent ordered items or adjacent unordered items normalize to one LF, while item markers,
numbers, text, and order remain exact. No text or general whitespace normalization occurs.
Text, order, title, extra/missing content, revision, and canonical hash are compared
exactly. A mismatch is fail-closed and cannot certify delivery. `--out` saves a new
`qa-gui/page-readback/v1` receipt, including observed Page URL, canonical identity, content and
snapshot hashes, 100-or-0 match percent, mismatches, and SHA-256 seal of the receipt without
`seal`. This seal detects local changes; it is not a signature or proof of connector provenance.

Apply BA Pro v2 writing guidance: retain source meaning, IDs, statuses, conditions, and exceptions;
use the user's screen names and concrete action/result sentences; show unresolved facts where
they occur. Write actual steps in `repro` and an observed symptom in `actual`, rather than raw
rule/selector summaries. Literal heading characters in prose are escaped so a symptom beginning
with `#` remains text rather than becoming a native heading. Automated field/language checks establish presence and syntax only;
a reviewer must still judge whether a new reader understands and can reproduce the defect.
No schema bump or forced new prose format is needed.
