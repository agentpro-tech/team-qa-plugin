# Adjudicator contract (R2a)

An independent model checks each executed case from the raw evidence, without seeing what the executor concluded. It
runs in **shadow** by default: its results are recorded and the report shows what the verdicts would be if it were
on. It only ever keeps or lowers a PASS. Team QA owns this contract; QA GUI is unchanged and is reached only through
its existing `board apply` change format.

Code: `scripts/lib/adjudicator.mjs` (inputs, audit, validator, effect, report), `scripts/lib/adjudicator-engine.mjs`
(engine interface and CLI binding), `scripts/lib/roster.mjs` (seat). Policy: `references/adjudicator-policy.json`.
Model instructions: `references/adjudicator-instructions.md`.

## 1. Roster seat

The roster request may carry an optional field:

```json
"adjudicator": { "provider": "anthropic", "model": "claude-sonnet-5-5", "effort": "high", "harness": "claude", "mode": "shadow", "scope": "pass_only", "caps": { "timeout_ms": 600000, "max_turns": 30 } }
```

Only `provider` is required. `roster.mjs select --catalog <c> --adjudicator-catalog <c2> --request <r> --out <roster>`
picks the seat from `<c2>` (or from `<c>` when no second catalog is given). The second catalog is collected for the
adjudicator's provider with `roster.mjs collect --provider <provider>` and must be of the same kind (runtime or fixture)
as the main one.

A candidate model must be: of that provider (and model/harness when named); on a `claude` or `codex` CLI harness
whose version meets the model's minimum; `available` (runtime catalogs: also `source-reviewed`, harness-compatible);
able to run the effort (default `high`); with the tool `fs.read`; of tier `reasoning` or `general`; reviewed for a
read-only judging role (`adjudicator`, `analyst` or `test_manager`). Excluded families (`astra`) need the model named.

**Family.** The family is the provider's model line from `provider_families` in the policy (anthropic → claude,
openai → gpt, google → gemini, xai → grok, mistral, deepseek). The catalog's per-model `family` is not used: two models
of one lineage are never independent. The seat must differ in family from **every** executor seat (`executor_gui`,
`executor_code`).

The seat in `roster.json` (`adjudicator`): `role`, `mode`, `scope`, `provider`, `family`, `model`, `effort`, `harness`,
`harness_version`, `harness_bin`, `harness_bin_sha256`, `tools` (`["fs.read"]`), `permission_profile` (`read-only`),
`caps`, `context` (SHA-256 of the instructions and the policy), `reasoning_control`, `executor_families`
(`{executor_gui: "gpt", …}`), `catalog_sha256`, `catalog_source`, `model_status`, `policy_sha256`. A roster without the
request field has no `adjudicator` key and keeps its bytes. The chat table shows one more row,
`Adjudicator (shadow|enforce)`, and a detail line with the families; the user approves it with the roster hash.

**Roster validator** (`checkRoster`, on approve, check and every use) refuses: `ADJUDICATOR_SAME_FAMILY` (the seat's
family equals an executor's), `ADJUDICATOR_FAMILY_MISMATCH` (family not the provider's), `ADJUDICATOR_FAMILY_UNKNOWN`,
`ADJUDICATOR_EXECUTOR_FAMILIES_DRIFT`, `ADJUDICATOR_MODE`, `ADJUDICATOR_PERMISSION_DRIFT`, `ADJUDICATOR_CONTEXT_DRIFT`,
`ADJUDICATOR_POLICY_DRIFT`, `ADJUDICATOR_SCOPE`, `ADJUDICATOR_CAPS_INVALID`, `ADJUDICATOR_SEAT_FIELDS` (unknown field),
`ROSTER_HARNESS_DRIFT`, and for a fixture roster `FIXTURE_HARNESS_NOT_TEST_STUB`.

**Switch.** `mode` is `shadow` unless the request says `"mode": "enforce"`. It is fixed in the approved roster; there is
no environment switch. Without an approved roster with a seat, a run is always read as shadow.

**Scope.** `scope` is `pass_only` (the policy's `scope`) unless the request says `"scope": "all"`. Under `pass_only`
only a case whose latest executed record is PASS is adjudicated, the only verdict the adjudicator can change; any other
case is skipped before a file, a checklist or an engine call is made, so it costs nothing. `all` judges every executed
case (a FAIL or UNGRADED stays as it is).

## 2. Engine interface and binding

`team-qa/adjudicator-engine/v1`:

```
engine.call({ phase, input, attempt, runDir, images }) -> Promise<{ output, session_id?, stdout?, stderr?, exit? }>
```

One call is one fresh model session. `input` is the exact text on stdin; `phase` is `checklist` or `judge`;
`attempt` is the session id Team QA chose; `images` are the absolute image paths of the payload. `output` is the
model's text. The engine only carries text; this module builds every input and reads every output. Tests use a fake
engine (`test/adjudicator/fake-engine.mjs`) and stub harnesses; no network and no key.

`cliEngine(seat)` runs the seat's exact binary (`harness_bin`, hashed in the roster) with cwd = the `runDir` it is
given. The adjudicator gives it a fresh blind workspace outside the run directory that holds only byte copies of the
payload's evidence at the paths the payload names (`rel`), and the images as those copies; the workspace is removed
after the call. The engine can therefore open no board record, receipt, executor stream or draft:

- Claude: `claude -p --safe-mode --model <m> --effort <e> --output-format stream-json --verbose --permission-mode plan
  --max-turns <n> --setting-sources '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools Read,Glob,Grep
  --disallowedTools Agent,Task,Bash,Edit,Write,NotebookEdit,WebSearch,WebFetch --session-id <attempt>`, with the
  allowlisted environment of a role dispatch (nothing of the root session).
- Codex: `codex exec --skip-git-repo-check --ignore-user-config --json --sandbox read-only --disable multi_agent
  [--image <a.png,b.png>] -m <m> -c model_reasoning_effort="<e>" - -c approval_policy="never"`.

**At runtime the call needs:** the seat's CLI installed at the hashed path, at the catalog's version, and signed in to
an account that may use the model (`claude` for an Anthropic seat, `codex` for an OpenAI seat); a catalog collected
for that provider; the run under the cost cap (`teamqa cost cap`). For a runtime roster the stream is checked against
the seat (provider, model, effort, session) through QA Code's declared provider-execution interface; a mismatch is
`ENGINE_UNATTESTED`. A different family is chosen only through the roster: the request names the provider, the
validator checks the family.

Each call is recorded as `runs/<id>/dispatch/adjudicator/<attempt>/state.json` (role, case, phase, start, end,
status) plus `stdout.jsonl`/`stderr.txt` for a CLI harness, where the R0 time receipts and the cost cap read attempts.
`timing.json` counts these attempts as kind `adjudication` (`summary.attempts_by_kind`), apart from case and screen
check dispatches: shadow adjudication runs after the case's verdict is recorded and off its critical path.

## 3. Commands

```
teamqa adjudicate checklist --run <id> --case <case>
teamqa adjudicate run --run <id> --case <case> --attestation <executor attestation> [--board <qa-board.json>]
                      [--evidence <path,…>] [--baseline <image>] [--attempt <n>]
teamqa adjudicate show --run <id>
teamqa adjudicate board-change --run <id> --board <qa-board.json> --out <change.json>
```

`checklist` may run as soon as the tracked plan exists, before the case runs. `run` freezes the checklist first when
it is not yet frozen, adjudicates the latest executed attempt (or `--attempt`), and prints
`ADJUDICATION case=… attempt=… outcome=… mode=… if_enabled=… effect=none|report`, or, for a case outside the scope,
`ADJUDICATION_SKIPPED case=… attempt=… reason=verdict_not_pass scope=pass_only` (nothing written). Paths of `--evidence` and
`--baseline` are relative to the run directory. One attempt is adjudicated once (`ADJUDICATION_EXISTS`).

## 4. Files and input schemas

Under `runs/<id>/adjudication/<case>/`:

| File | Content |
|---|---|
| `checklist-input.txt` | exact input of the checklist call |
| `checklist-output.txt` | the model's text |
| `checklist.json` | `team-qa/adjudicator-checklist/v1`, written once; its SHA-256 freezes it |
| `attempt-<n>/payload.json` | `team-qa/adjudicator-payload/v1` |
| `attempt-<n>/input.txt` | exact input of the judge call: header, instructions, payload between `TEAMQA_ADJUDICATOR_PAYLOAD_START`/`_END` |
| `attempt-<n>/audit.json` | `team-qa/adjudicator-input-audit/v1`, written before the call |
| `attempt-<n>/output.txt` | the model's text |
| `attempt-<n>/result.json` | `team-qa/adjudication/v1` |

**Checklist request** (`team-qa/adjudicator-checklist-request/v1`): `run_id`, `case_id`, `requirement`
(`id`, `tier`, `sources[{id, kind, system, key, title}]`), `case` (`id`, `title`, `priority`, `kind`,
`steps[{id: "step:k", text}]`, `expected`, `data` with secret keys redacted, `states`, `viewports`) and
`baseline_items`. No evidence, no action chain, no executor output.

**Checklist** (`checklist.json`): `items[{id, text, origin, refs}]`: `S1…Sn` (`case-step`, `refs: ["step:k"]`), `E1`
(`case-expected`), then `R1…` (`requirement`, at most 12, from the model's answer
`TEAMQA_ADJUDICATOR_CHECKLIST v1` + `{"items":[{"text"}]}`); `requirement_items` is `OK` or why there are none; plus
`input_sha256`, `output_sha256`, `engine`, `frozen_at`. It cannot be frozen again
(`ADJUDICATOR_CHECKLIST_FROZEN`) or after evidence was shown (`ADJUDICATOR_EVIDENCE_ALREADY_SHOWN`).

**Judge payload** (`payload.json`): `run_id`, `case_id`, `built_at`, `requirement`, `case`,
`checklist {sha256, items}`, `action_chain[]`, `evidence[]`, `baseline` (or null), `pointer_kinds`.

- `action_chain[]`: the executor stream's Dragon tool calls, in order: `id` (`A1…`), `tool_use_id`, `tool`, `method`,
  `params` (without `reason`, `note(s)`, `comment(s)`, `description`, `why`, `rationale`, `explanation`, `intent`,
  `thought(s)`, `verdict`, `assessment`, `conclusion`, `narrative`; secret keys and `nonce` redacted), `called_at`,
  `result_at`, `is_error`, `result_excerpt` (first 2,000 characters of the raw tool result), `result_chars`,
  `result_sha256`. No assistant text and no other tool.
- `evidence[]`: `id` (`E1…`), `kind` (`image`, `video`, `text`), `rel`, `path`, `sha256`, `bytes`, `media_type`,
  and `width`/`height` (images, read from the file), `duration_ms` (MP4/QuickTime movie header; null otherwise) or
  `lines` (text). Sources: the canonical board's `evidenceManifest` entries of the case of type `gui-screenshot`,
  `gui-recording`, `recording-manifest`, `dom-snapshot`, `network-log`, `console-log`, and `--evidence`. Never a
  state receipt, a verdict or attestation file, the child verdict artifact, anything under `dispatch/`,
  `role-bindings/`, `control/`, `inputs/`, or a text file that holds the executor's prose. Each exclusion is listed
  in the audit with its reason.
- `baseline`: an approved clean image (`B1`) when one exists.

Known test-account secrets of the run are masked in every input.

## 5. Input audit

Run over the exact checklist input and judge input, and over every text evidence file the engine may read. It looks
for: a verdict key (`verdict`, `*_verdict`, `executor_*`, `narrative`, `conclusion`, `assessment`); a standalone verdict
value (`pass`, `passed`, `fail`, `failed`, `ungraded`, `blocked`) in a payload; any fragment of the executor's prose
(its assistant text, its evidence draft, the record's `reason`, the child verdict's strings; a fragment is a sentence
or line of at least 4 words and 24 characters, minus what it copied from the plan or from a tool result); references
to its verdict files (the child artifact path and hash, the stream and attestation, `board.jsonl`, `role-bindings/`,
`.receipt.json`, `TEAMQA_EVIDENCE_DRAFT`). A finding names where, the kind and a SHA-256 of what matched, never the
text. `clean: false` makes the result `ABSTAIN` (`INPUT_AUDIT_FAILED`) and the judge is not called.

## 6. Output schema and validator rules

The model answers `TEAMQA_ADJUDICATION v1` followed by one JSON block:

```json
{ "items": [ { "id": "S1", "status": "SUPPORTED", "pointers": [ { "kind": "action", "action": "A2" } ], "note": "…" } ], "overall": "CONFIRM" }
```

Pointers (each must resolve, against the evidence given and unchanged since):

| Kind | Fields | Resolves when |
|---|---|---|
| `file` | `evidence`, `line?` | the evidence exists with its hash; `line` within a text file |
| `image_region` | `evidence`, `x`, `y`, `w`, `h` (integer px) | an image; the region inside its real size |
| `timestamp` | `evidence`, `t_ms` | a recording with a known duration; `0 ≤ t_ms ≤ duration` |
| `timestamp` | `at` (ISO) | inside the action chain's first call and last result |
| `selector` | `selector`, `evidence?` | without evidence: used as a value by an action; with a DOM snapshot: a simple selector (tag, `#id`, `.class`, `[attr]`, `[attr=v]`) matches an element |
| `action` | `action` | an id of the chain |

Failure reasons: `EVIDENCE_UNKNOWN`, `EVIDENCE_MISSING`, `EVIDENCE_CHANGED`, `FILE_NOT_TEXT`, `FILE_LINE_OUTSIDE`,
`NOT_IMAGE`, `IMAGE_REGION_INVALID`, `IMAGE_REGION_OUTSIDE`, `TIMESTAMP_INVALID`, `TIMESTAMP_NO_DURATION`,
`TIMESTAMP_OUTSIDE`, `NOT_DOM_SNAPSHOT`, `SELECTOR_UNSUPPORTED`, `SELECTOR_NOT_FOUND`, `ACTION_UNKNOWN`,
`POINTER_KIND_UNKNOWN`, `POINTER_FIELDS`.

The validator, not the model, decides the outcome:

1. No marker or no JSON: `ABSTAIN` `ENGINE_OUTPUT_INVALID`; an unknown field or overall: `RESPONSE_SCHEMA`; the model's
   own `ABSTAIN`: `MODEL_ABSTAINED`; an engine failure: `ENGINE_FAILED` or `ENGINE_UNATTESTED`.
2. Every checklist item exactly once, a known status, 1 to 8 pointers, a note of at most 600 characters; otherwise
   `ABSTAIN` with `ITEM_*` codes.
3. Any pointer that does not resolve: `ABSTAIN` with `POINTER_UNRESOLVED:<item>:<index>:<reason>`.
4. `CONFIRM` when every item is `SUPPORTED`, else `CONTEST` (`CONTRADICTED` and `INSUFFICIENT` both: a PASS the
   evidence does not support is not confirmed). The model's overall must equal it, else `ABSTAIN`
   `OVERALL_INCONSISTENT`. A CONTEST lists `ITEM_CONTRADICTED:<id>` / `ITEM_INSUFFICIENT:<id>`.

**Result** (`result.json`): `run_id`, `case_id`, `executor_attempt`, `executor_attempt_id`, `mode`, `fixture`,
`engine {kind, provider, model, family, harness, effort, attempt, checklist_attempt, session_id}`, the SHA-256 of
checklist, payload, input, audit and output, `items[{id, status, pointers, pointer_checks, note?}]`,
`model_overall`, `outcome`, `codes`, `started_at`, `ended_at`, `duration_ms`. It does not hold the executor's verdict.

A reader re-checks everything (`verifyAdjudication`): the hash chain checklist → payload → input → audit → output →
result, the checklist frozen before `built_at`, the audit again from its recorded sources, the answer validated again
against the evidence as it is now, and the engine equal to the approved seat. A break is `ABSTAIN` with
`CHECKLIST_DRIFT`, `PAYLOAD_DRIFT`, `INPUT_DRIFT`, `AUDIT_DRIFT`, `AUDIT_SOURCE_DRIFT`, `OUTPUT_DRIFT`,
`ADJUDICATOR_SEAT_MISMATCH`, `RESULT_DRIFT` or the pointer code. A result of an earlier attempt than the case's
latest is `ADJUDICATION_STALE`.

## 7. Effect

`adjudicatedVerdict(verdict, outcome)`: a `pass` with `CONTEST` becomes `ungraded`; every other pair keeps its verdict.
The adjudicator never makes a case PASS or FAIL. ABSTAIN keeps the verdict (it is counted).

- **Shadow:** nothing changes: the ledger, the RTM, the board, the metrics and the decision are the executor's.
- **Enforce:** in the report the contested PASS counts as UNGRADED (reason `ADJUDICATOR_CONTEST`), so
  `UNGRADED_PRESENT` makes the decision NO_GO; `adjudicate board-change` writes the QA GUI change packet
  (`doc-colab/v1`: the case `status` PASS → BLOCKED, with a comment) for `teamqa board apply --change`. The ledger keeps
  the executor's record.
- **Cost ladder (R3):** every recorded result is also one ladder decision of the case verdict in `runs/<id>/decisions.jsonl`
  (`ladderDecision({check:"verdict", minTier, mode, steps})`, mode `shadow`, or `on` for enforce): the executor's verdict
  at tier 2 escalates (`reason: EXECUTOR_VERDICT`), the adjudicator settles at tier 3 with `adjudicatedVerdict` and the
  outcome as the reason. A signed plan with `min_tier.verdict: 3` starts the ladder at tier 3. A case the scope skips
  records nothing. The report's Speed section and `timing.json` count it.

## 8. Report fields (additive)

`summary-report.md` gets, inside the machine-checked block, `adjudication` (`team-qa/adjudication-report/v1`) when the
run has a seat or a result, and a section `## Adjudicator (shadow|enforced)` with one row per case:
`| Case | Executor verdict | Adjudicator | If on | Codes |`.

| Field | Meaning |
|---|---|
| `mode` | `shadow` or `enforce` (from the approved roster only) |
| `scope` | `pass_only` or `all` (the seat's, else the policy default) |
| `seat`, `executor_families` | the seat's provider, model, family, harness, effort; the executors' families |
| `cases[]` | `case_id`, `executor_attempt`, `executor_verdict`, `outcome`, `if_enabled_verdict`, `applied`, `codes`, `items` (counts per status) |
| `counts` | `executed`, `adjudicated`, `confirm`, `contest`, `abstain`, `not_adjudicated {verdict_not_pass, missing}` |
| `not_adjudicated` | the case ids: `verdict_not_pass` (skipped by the `pass_only` scope), `missing` (in scope, no result) |
| `actual` | the report's `pass`, `fail`, `ungraded`, `decision` |
| `if_enabled` | the same with every contested PASS lowered, plus `lowered[]` (shadow: decision NO_GO when any is lowered) |

`teamqa report verify` recomputes the field from the files, so an edited result is a `REPORT_MISMATCH`.

The R0 decision log (`timing.json`, `decisions.adjudicator[]`) has one entry per result: `point: "adjudicate"`,
`case_id`, `executor_attempt`, `at`, `input_sha256`, `options` (`CONFIRM`, `CONTEST`, `ABSTAIN`), `chosen`,
`latency_ms`, `attempt`. Adjudicator attempts appear by role in the time receipts and are not added to the executor's
time per case.

## 9. Later

- Enforce mode should also apply to `rtm.md` and the ledger (`board.jsonl`): today a contested PASS is UNGRADED in the
  report and on the board, while the RTM and the ledger keep the executor's PASS. The eval runs shadow only, where
  nothing changes anywhere.
- A clean baseline image comes from `--baseline` until R3 adds approved baselines.
