# A board where developers find what to fix

## Choose where to create it

Default order: **Codex Space/Page → Notion → Doc-Colab**. Use the connector available in the runtime,
probe account/access before the write and save the evidence. Pages with create/read tools but no listed Space
is still usable: create a private Page with no parent. Do not treat an empty Spaces list as losing Pages.

Save the real probes in `connector-probes.json`, for example after calling the matching tools:

```json
{
  "space": {"status":"available","evidence":"Pages list_spaces completed; create_page/read_page exposed for current account"},
  "notion": {"status":"unavailable","evidence":"Notion tools absent in current runtime"}
}
```

`status` is only `available`, `unavailable` or `unknown`. Do not record unavailable from a timeout or
an unknown commit outcome. `prepare` stops while the preferred provider is undetermined; it does not fall back by itself after
a failed write or a readback mismatch, because the board may already exist.

```bash
node scripts/board-quality.mjs recipe --file <qa-board.json> --out-dir <review-dir> --parent-source <parent-session.jsonl> --author-source <author-session.jsonl> --task-name <unique-review-task> --model <approved-model> --effort <approved-effort>
# Execute the emitted exact functions.exec input in a separate call; then spawn the emitted task with its exact payload.
node scripts/board-quality.mjs attest --intent <review-dir/intent.json> --child-source <reviewer-session.jsonl> --out <review-receipt.json>
node scripts/board-quality.mjs verify --file <qa-board.json> --receipt <review-receipt.json>
teamqa board prepare --file <qa-board.json> --capabilities <connector-probes.json> --out <page-payload.json> --quality-review <review-receipt.json>
```

Use `recipe` as the handoff workflow: it emits the exact `functions.exec` input that prepares the immutable review intent. Execute that emitted input as its own tool call before spawning the emitted task; do not substitute a direct `prepare` command.

The review must be independent of the board author and bound to the exact canonical SHA. Do not write the receipt yourself or edit the intent/spawn payload after it is prepared. The payload is an artifact generated from canonical, not a second authoring file. Edit only canonical. Every `prepare`, `render` or Notion push needs `--quality-review`; the CLI checks the review before export/render/write, then creates `<artifact>.quality.json` bound to canonical, the artifact, the rule version and the review. Changing canonical/payload bytes voids the old receipt.
When `--evidence-map` is used for a Space export or `--notion-source-map` for a Notion export, the delivery receipt also locks the content of that map. When comparing the Page, pass the exact map used to create the payload; a different map, or a missing map when the projection has one, is rejected.
`stage=prepared effect=not-committed` does not yet mean that the board is saved in the cloud.

## Space/Page

1. Read the `pages:write-page` skill and the Page/Space guidance if a destination was specified.
2. For a board without a Page, call Pages `create_page` with the exact `title` and `initial_blocks` from the
   payload. With a confirmed parent/Space, read the parent/root first and use the exact ID; otherwise create a private
   Page with no parent. Keep the same idempotency key/args when the outcome is unclear, and read back before a retry.
3. Read the full Page with `read_page` and save the MCP response unchanged (do not build a snapshot from the payload yourself).
4. Run the independent comparator; every block, title and canonical revision/hash must match 100%:

```bash
teamqa board compare-page --file <qa-board.json> --payload <page-payload.json> --snapshot <read-page.json> --out <page-receipt.json>
```

For a registered run, lock the exact direct-create request before calling the Pages connector. The
request builder verifies the sealed payload and writes a new immutable request file; copy its exact
`tool_name` and `tool_input` into the connector call:

```bash
node scripts/board-quality.mjs write-request --file <qa-board.json> --payload <page-payload.json> --destination <page-destination.json> --out <board-write-request.json>
```

The run's `docs-lock.json` must bind `board`, `board_payload`, `board_quality`, and `board_write`.
The registered hook admits only the exact create request recomputed from that payload. Direct Page
edits, visualization writes, and direct Notion create/update calls are denied as unsupported
projections; use the existing gated adapter for supported Notion push. The connector's success
response is not a Page readback or QA PASS.

5. Hand over the canonical Page URL from the receipt and open it with the `open_in_codex` Page target. Do not derive the URL
   from the ID when the tool has returned a link. The board is a native Page, not HTML pasted into Markdown.

On update, read the current Page/guidance and keep the block IDs/hashes; patch/replace exactly the changed blocks,
and keep comments and unrelated content. Human edits/comments are read back, translated into a reviewed
delta, applied with `board apply` to create a new canonical revision, then projected again. Do not take a status edited by hand
on the Page as a QA verdict; verdicts/evidence must still go through the child gate. The readback after projection must match
the new canonical; never ignore a difference between the two sources.

Local evidence cannot open by itself in the cloud. Upload it with `write_page_reference` with the Page ID and the real
path, and use only a reference with `file_access_confirmed:true`; map the exact canonical evidence path:

```json
{"evidence/capture.png":{"reference":"library-file:<observed-id>","verified":true}}
```

Pass the same `--evidence-map` on prepare and compare. A missing upload must show clearly on the Page that the evidence is not yet
reachable; do not create a fake file ID/URL and do not claim the media rendered. A native Page uses a video link
instead of a player. Use a disclosure heading for the technical reference part when needed; do not add
HTML/CSS or an unsupported generic toggle yourself.

## Notion and Doc-Colab fallback

When Pages is verified unavailable, use the declared qa-gui Notion export/sync: Cases and Defects,
independent readback, 100% compare; `--renderer notion` is a technical choice of the allowed fallback,
and there is no need to ask the user again just to switch providers. Notion push needs a current review and a delivery sidecar;
the env adapter also verifies the receipt on the exact canonical and snapshot before running the push command,
for example `teamqa board sync --file <qa-board.json> --renderer notion --mode push --quality-review <review-receipt.json>`.
Keep source relations when the map really has them. Pull only updates canonical and records `quality=not-reviewed`;
that change needs a new review before the next handover.

When both cloud providers are unavailable, `prepare` creates a native Doc-Colab and verifies the exact final bytes.
Opening a QA artifact requires `--canonical`; `board verify` and `board open` check the current delivery sidecar
before integrity/opener. The legacy opener for generic HTML can
return `qa_integrity=not-applicable`; that result does not certify a QA board.

## How to write per BA Pro v2

The authenticated review process and how the receipt is locked: [board-review-workflow.md](board-review-workflow.md).

The board leads developers to defects first; cases, coverage, Function/UI and history can still be read below.
A defect is one reproducible problem, not a log excerpt used as a title.

- The title states the action and the observed error, illustrative example: “Saving the form drops the selected branch”.
- Location: the screen/flow actually known, role, env/build and the conditions needed to hit the error.
- Reproduce: steps with an actor/action; special data must be stated explicitly.
- Actual: the observed behavior; evidence points to the exact state/finding.
- Expected: the correct result per the source requirement; do not invent a solution or a policy.
- Check after the fix: run the linked case and verify the expected result again; do not create a second acceptance.

`repro`, `actual`, `expected`, `caseId` and the existing evidence are the source for this content. Do not add
fields just to fill the template. When the root cause is not known, say it is not verified, and write an investigation hint only when
there is a basis for it; do not assign a code file or an owner to fill a gap. The template/schema/integrity gates check
the structure; the semantic review checks that developers find the right place, can reproduce it and understand what passing means.

RETEST/VERIFIED belong to the waiting-for-QA part; CLOSED/REJECTED belong to the resolved part. Keep the machine codes and
states unchanged, along with creator/QA separation, source refs and the append-only round history.
