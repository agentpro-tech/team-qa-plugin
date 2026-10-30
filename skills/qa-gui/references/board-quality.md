# Board delivery quality and independent review

`validateCanonical` continues to check the canonical data contract for existing boards. Delivery prose has a separate gate: import `inspectBoardQuality(data)` from `scripts/teamwork/board-quality.mjs`. A canonical board may remain readable and usable for ongoing QA while its delivery quality is `FAIL` or `UNGRADED`; do not treat either result as a Function/UI verdict.

Active defects require an optional `defect.handoff` with exactly `kind`, `problem`, `request`, and `expected`. `kind` is `fix`, `investigate`, `clarify`, or `input`. Keep this short action front grounded in what QA observed and what the linked source requires. Put reproduction, captures, comments, history, and technical details in their existing fields below it. Do not infer a root cause, owner, or acceptance rule that the source does not establish. Legacy defects without the field still pass canonical validation but fail the strict delivery-quality gate while active.

The deterministic gate checks active-defect handoffs, placeholder and generic text, `actual`/`expected` duplication, conservative contradictions between confirmed fixes and explicit uncertainty, and each structured finding caption against the finding's measured selector or numbers. It is a quality screen, not a proof that prose is correct.

An independent review uses the `qa-gui/board-review/v1` JSON shape:

```json
{
  "schema": "qa-gui/board-review/v1",
  "ruleVersion": "qa-gui/board-quality/v1",
  "canonicalSha256": "<64 hex characters>",
  "coveredCaseIds": ["<every case id in canonical order>"],
  "coveredDefectIds": ["<every defect id in canonical order>"],
  "criteria": [
    { "id": "actionability", "verdict": "PASS", "rationale": "...", "anchors": [{ "path": "/defects/0/handoff/request", "quote": "exact canonical substring" }] },
    { "id": "source_fidelity", "verdict": "PASS", "rationale": "...", "anchors": [{ "path": "/defects/0/handoff/problem", "quote": "exact canonical substring" }] },
    { "id": "classification", "verdict": "PASS", "rationale": "...", "anchors": [{ "path": "/defects/0/handoff/kind", "quote": "fix" }] },
    { "id": "presentation", "verdict": "PASS", "rationale": "...", "anchors": [{ "path": "/defects/0/handoff/expected", "quote": "exact canonical substring" }] },
    { "id": "captions", "verdict": "PASS", "rationale": "...", "anchors": [{ "path": "/defects/0/findings/0/caption", "quote": "exact canonical substring" }] }
  ],
  "verdict": "PASS"
}
```

Every case and defect ID must be covered exactly once in canonical order. Each of the five criteria appears exactly once. Give every criterion a nonempty rationale and at least one anchor whose JSON pointer resolves into canonical text and whose quote is an exact substring. Every supplied anchor must have the exact shape, resolve, and quote canonical text. Across those anchors, each criterion needs at least one relevant path: actionability cites a defect handoff request or outcome; source fidelity cites linked source/requirement/evidence or grounded handoff context; classification cites kind or observed behavior; presentation cites handoff prose; captions cite a finding caption/measurement (or an existing case requirement/expected when no structured finding exists). Additional grounded anchors may support the rationale even when their paths are not criterion-specific. Identity- or status-only anchors cannot be the only anchor. Absence has a narrow applicability rule: when there are no defects, actionability, classification, and presentation may instead cite an existing case's requirement or expected outcome, with a rationale beginning `Not applicable:` or `Không áp dụng:` explaining why no defect handoff exists. Case-only source fidelity and captions continue to cite substantive case context. A wholly empty draft (empty cases, defects, sources, evidence manifest, coverage, and untested lists, with release `NO-GO`) may use a `/release/risks/<index>` anchor for all five criteria only with that explicit applicability rationale and a complete exact quote of the CLI's localized not-run risk (`QA chưa được chạy.`, `QA has not run.`, `QA가 아직 실행되지 않았습니다.`, or `QAはまだ実行されていません。`). No other risk prose or status/identity anchor qualifies. Any defect disables this absence fallback. These reviews assess the artifact only: draft `PASS` does not establish product Function/UI acceptance or execution evidence. All five criteria and exact ordered ID coverage remain mandatory, even for empty arrays.

A missing, `FAIL`, or `UNGRADED` criterion cannot produce review `PASS`; there is no averaging. `validateBoardReview({data,review,canonicalSha256})` checks these deterministic conditions and returns a validation receipt. It does not authenticate the reviewer or prove that a native reviewer saw the facts; the calling admission layer owns those controls.

For a bounded reviewer input, `boardReviewFacts(data)` projects all case/defect IDs, user-visible action and outcome prose, source identities and links, structured finding measurements/captions, and concise evidence references. It omits machine-state payloads, histories, and raw logs. The caller must bind the facts to the SHA-256 of the full canonical bytes and enforce its own size cap.

Page, Notion, and native board projections put the handoff action front before reproduction details when it exists. Notion mapping includes the handoff field.

`verifyBoardProjection({file,artifactPath,renderer,projectionOptions})` binds a saved artifact to exact canonical bytes and verifies the declared projection. Supported renderers are `page`, `notion`, `native`, and `doc-colab`. Page accepts only `projectionOptions.evidenceMap`; Notion accepts only `projectionOptions.notionSourceMap`; Doc-Colab accepts only `projectionOptions.docColabRoot`; native accepts no projection options. Page export JSON and Notion mapped rows are compared to their canonical projection; complete Page readbacks use the existing independent snapshot comparator. Native HTML must match the native renderer byte for byte. The CLI `native` render currently delegates to Doc-Colab, so use `renderer:'doc-colab'` for that artifact.

Doc-Colab uses an external locked template. `verifyBoardProjection` runs its existing integrity verifier and requires every handoff to appear exactly under the matching projected task's `defectSummary.handoff`. It returns `FAIL` with `DOC_COLAB_HANDOFF_UNSUPPORTED` when that projection is absent or differs. The existing generator may omit this field, so handoff boards remain blocked for Doc-Colab until the external projection is updated and verified. Boards without handoff still use the existing Doc-Colab integrity verifier.
