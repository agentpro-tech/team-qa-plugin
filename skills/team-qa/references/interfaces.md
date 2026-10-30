# Declared dependency interfaces

Read this file when configuring `roles.json` or replacing an adapter. Do not read or call internal implementations outside the interfaces below.

## qa-gui

- Declared schema: `~/.agents/skills/qa-gui/scripts/qa-board.schema.json` (major 3).
- Receipt schema: `~/.agents/skills/qa-gui/contracts/release-truth-contract/v2/qa-gui.receipt.schema.json` (major 2).
- Declared gate: `node ~/.agents/skills/qa-gui/scripts/qa-gate.mjs <board>`.
- Team QA accepts only verdicts/evidence that passed the gate; it does not import UI grading logic.
- Teamwork canonical current `qa-board-teamwork/v2` / schema 6 (legacy v1 schemas 4/5 remain
  readable): `~/.agents/skills/qa-gui/scripts/teamwork/canonical.schema.json`.
- Teamwork CLI: `node ~/.agents/skills/qa-gui/scripts/teamwork/cli.mjs
  init|migrate-sources|validate|render|apply|export-page|compare-page|export-notion|sync-notion|compare-notion`.
- `init --source-seed <qa-source-seed/v1.json>` is the only Team QA handoff for seeded source
  registry/cases. Team QA sends explicit ids, titles, requirements and refs; qa-gui creates and
  validates canonical defaults. No Team QA module constructs qa-gui canonical directly.
- `export-notion` and `compare-notion` accept the same optional `--notion-source-map`; unknown
  canonical source ids fail. Mapped ids become `Source Issue` relations; unmapped ids keep stable
  external key/URL. `Issue Group` is derived presentation only.
- `apply` and `sync-notion` must write a new revision file; the interface refuses to overwrite the input canonical.
- Final-byte verifier: `node ~/.agents/skills/qa-gui/scripts/teamwork/doc-colab-renderer.mjs
  <qa-board.json> --verify-existing <index.html> --doc-colab-root ~/.agents/skills/doc-colab`.
  Team QA must get exactly one machine line `verdict=pass`; a missing verifier or a mismatch fails closed.

## Space/Page board projection

- Canonical exporter: `node ~/.agents/skills/qa-gui/scripts/teamwork/cli.mjs export-page --file <canonical> --out <payload> [--evidence-map <map>]`.
- Readback compare: same CLI `compare-page --file <canonical> --snapshot <actual-read-page.json> [--out <receipt>] [--evidence-map <map>]`.
- Payload protocol `qa-gui/page-export/v1`, receipt `qa-gui/page-readback/v1`; receipt must have `ok:true`, `matchPercent:100`, observed Page URL and seal.
- Team QA delegates projection/compare; it does not implement native Page rendering or copy child rules.
- Pages tools perform create/edit/read, after observed capability/access probes. The CLI only prepares and validates artifacts; prepared output never proves a cloud commit.

## qa-code

- Declared schema: `~/.agents/skills/qa-code/references/verdict.schema.json` (major 1).
- Receipt schema: `~/.agents/skills/qa-code/contracts/release-truth-contract/v2/qa-code.receipt.schema.json` (major 2).
- Gate 0: `bash ~/.agents/skills/qa-code/scripts/gate0.sh --repo <path> --base <ref> --config <config> --json <gate0.json>`.
- Run: `bash ~/.agents/skills/qa-code/scripts/qa-run.sh --repo <path> --mode tools|static --gate0 <gate0.json> --json <verdict.json>`.
- Validate: `node ~/.agents/skills/qa-code/scripts/verdict-validate.mjs --verdict <verdict.json> --gate0 <gate0.json>`.

## doc-colab

- Declared generator: `python3 ~/.agents/skills/doc-colab/scripts/make_doc.py --template doc|task-board|decision --data <data.json> --out <index.html>`.
- The bundled adapter only translates the Team QA payload into this data model, then calls the generator. Readback runs in a separate process and reads `window.DOC_DATA.teamqa_payload` from the generated HTML.
- With canonical `canonicalVersion:"qa-board-teamwork/v1"` or `v2`, the generator takes the original JSON directly, and readback must compare
  `window.DOC_DATA.qaBoard` with the canonical file before the artifact is published.

## Notion teamwork board

- Env adapter for the second destination in the fallback order: `scripts/adapters/notion-board-env.mjs`.
- Probe/push/readback take argv JSON from `TEAMQA_NOTION_BOARD_PROBE_CMD`,
  `TEAMQA_NOTION_BOARD_PUSH_CMD`, `TEAMQA_NOTION_BOARD_READBACK_CMD`.
- The adapter gets `TEAMQA_BOARD_SNAPSHOT` and `TEAMQA_BOARD_PATH`. Readback must print the exact snapshot JSON;
  Team QA writes its own readback copy, then calls qa-gui `compare-notion` at 100%. For `push`, the adapter verifies
  the `notion` delivery receipt for the exact canonical and snapshot before calling the command; a missing or
  stale receipt blocks the push. `probe` and `readback` stay unchanged.

## Mirror adapter contract

Each mirror in `roles.json` declares `probe?`, `publish`, `readback` as argv arrays. Team QA passes the canonical JSON through `TEAMQA_MIRROR_PAYLOAD` and the project through `TEAMQA_PROJECT_ROOT`.

- `probe`: exit 0 when present; nonzero to try the next tier.
- `publish`: performs the write; nonzero creates sync debt and tries the fallback.
- `readback`: an independent read command that prints the exact payload JSON again on one line.
- A successful write with a mismatched readback is `EFFECT_UNCONFIRMED`, exit 1; a fallback to hide an unconfirmed write is forbidden.

The bundled Notion adapter only calls the argv arrays the operator sets in `TEAMQA_NOTION_PROBE_CMD`, `TEAMQA_NOTION_PUBLISH_CMD`, `TEAMQA_NOTION_READBACK_CMD`; it hardcodes no connector or database.


## Current Team QA roster interfaces

- `scripts/roster.mjs`: collect/select/show/approve/check/dispatch; native Codex uses `collect --harness codex-native --host-source <original-host-rollout>`, `prepare-native --run-dir <run> --role <role> --prompt <file> --facts <read-only-file> --out <intent>`, then `attest-native --run-dir <run> --intent <locked-intent> --prepare-source <actual-prepare-output-line.json> --parent-source <actual-spawn-line.json> --child-source <original-child-rollout> --out <attestation>`. Prepare-source binds the original successful output with exact intent hash before spawn. Intent v2 includes context_packet_path/context_packet_sha256; its first child tool must read that exact packet, with successful original output hash matching before the separate facts read. Encrypted spawn/task text remains unobservable; packet read proof is not comprehension. Legacy encrypted full-message evidence stays ungraded. Native Code execution still requires the QA Code child interface; a prompt-only review is not a QA Code result.
- `code-proof --run-dir <run> --repo <repo> --base <sha> --head <sha> --coder <identity.json> --out <proof.json>` creates the declared child lock.
- QA Code: `qa-run.sh --engine codex|claude --provider-model <id> --reasoning <effort> --teamqa-proof <locked-proof.json> --teamqa-runtime <verified-package>`, alongside existing gate0/repo/base/receipt arguments. Keep run/evidence output outside product repo for its read-only boundary. Same-provider exception belongs only to this approved Team QA route.
- QA GUI: existing release-truth v2 gate arguments plus `--teamqa-attestation <run>/role-bindings/executor_gui.json [--teamqa-runtime <verified-package>]`; a case-scoped web receipt passes the attestation of that case's own dispatch (`role-bindings/executor_gui/attempt-<n>.json` for every dispatch after the first) and `--case <case_id>`. Receipt readback rechecks binding in EXECUTE or COMPLETE; standalone interface remains available.
- Current final receipt schema is `team-qa/receipt/v2`; legacy receipt/v1 is historical verification only. `handoff verify` requires `--receipt <receipt.json>` and compares sealed envelope to exact verified receipt bytes, integrity and verdict.

## Target composition v1

`teamqa composition validate|prepare|build|verify` reads `schemas/target-composition.json` and `schemas/composition-children.json`. Parent source/ordered-case hashes remain immutable; preparation is ungraded and requires current child approvals. `build/verify` accept only authentic current TeamQA v2 receipts, through the existing receipt verifier, and retain per-target UUID/SHA instead of a joined source. Cross-app IDs require every declared target component plus per-child `composition-execution-<sha256>.json` evidence binding the exact dependency tuples and captured flow files; missing/mismatched pins stay UNGRADED. IDs count once in parent totals; Function/UI use original explicit layer metadata. Report output must be a new path and is written exclusively. See `references/target-composition.md`. The output is `team-qa/composition-report/v1`, distinct from single-target release receipts.

Native child interfaces: QA Code `scripts/lib/native-qa.mjs` owns intent/source/judge verification; QA GUI `scripts/lib/native-gui-trajectory.mjs` owns Dragon semantics. Team QA calls verified canonical packages, never copies their judgment logic. See [native child adapters](native-child-adapters.md).
