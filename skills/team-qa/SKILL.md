---
name: team-qa
description: Orchestrates risk-based QA of a whole app or release, from a plan with exit criteria and a signing gate to a tracked plan, independent execution through qa-gui/qa-code, RTM, coverage gate and an evidence-backed GO/NO_GO report. Use when QA spans several features/lanes, the plan must be signed before EXECUTE, three-level verdicts must be merged, child skill schemas must be checked, or an auditable, re-runnable QA record is needed.
---

# Team QA

Orchestrate; do not grade by yourself and do not fix bugs. Keep files in git as the source of truth. Accept verdicts only from the declared interfaces of `qa-gui`, `qa-code`, or a deterministic script.

In the Claude Code plugin (`team-qa@agentpro`), `teamqa` is on the PATH of your Bash commands. Otherwise use an alias such as `teamqa="node <team-qa>/scripts/teamqa.mjs"`, or replace `teamqa` with Node and the real path in the commands below.

When calling the CLI from a client app repo, set `TEAMQA_ROLES` to the absolute path of the skill's `roles.json`:

```bash
export TEAMQA_ROLES="/absolute/path/to/team-qa/roles.json"
```

Do not use a relative path here: a relative adapter in the config is resolved against the folder that holds `roles.json`, not against the cwd of the app repo.

## Check the machine before running

`teamqa doctor` checks, in order: macOS, Node.js, Claude Code or Codex, QA GUI and QA Code (with a provenance check), Dragon (runtime and extension meet `scripts/requirements.json`; the extension is the Chrome Web Store build), then the Dragon commands that must exist. It stops at the first missing item and prints the error code, a machine-readable action (`install_runtime`, `install_extension`, `update_extension`, `pair`…) and a fix for people. `teamqa doctor --bundle <file.json>` writes a diagnostic file for support, with tokens, passwords, e-mail addresses and home paths filtered out.

Team QA relies only on the Store build of Dragon: the bridge and the extension each range from the minimum version in `scripts/requirements.json` up to below the next major; the two need not match each other. A manually loaded extension or another browser platform runs only on a machine with a grant signed by the owner (`teamqa grant show`); when Dragon fails, the agent does not switch platforms by itself but runs `teamqa doctor` and follows the action it returns.

## Install, update and license

Team QA, QA GUI and QA Code ship together as one suite signed by the owner: `teamqa suite install --dir <suite folder>` checks the signature of each package, then installs in the order QA Code, QA GUI, Team QA and leaves `release-signature.json` next to each skill. On a machine without the owner's git repo, this signature is the provenance evidence in place of canonical git. `teamqa update --check` reads the release channel (`TEAMQA_CHANNEL` or `channel` in `~/.agentpro/teamqa/config.json`); `teamqa update` installs a newer version and refuses while a run is not yet COMPLETE. A machine without Team QA installs with `bash install.sh --license <license.json>` in the suite folder: it checks Node, prints the publisher's key id, then hands over to the Team QA in the suite, which checks the signatures and installs. The release suite requires a user license (currently the free plan, activated with `teamqa activate <file>`); the license is checked only on install and update, and no check interrupts a running run. Preflight reports a new version at most once a day when a channel is set, and never blocks a run.

### As a Claude Code plugin

Installed with `/plugin marketplace add agentpro-tech/team-qa-releases` and `/plugin install team-qa@agentpro`, Team QA, QA GUI and QA Code sit in the plugin's `skills/` folder, file for file as the suite installs them; each skill finds the others next to itself. In the plugin:

- Claude Code updates Team QA (`/plugin update team-qa@agentpro`, or auto-update for the `agentpro` marketplace); `teamqa update` refuses with `UPDATE_MANAGED_BY_PLUGIN`.
- The Team QA hooks are already on (the plugin's `hooks/hooks.json`). `teamqa continuation register --run <id> --session <id>` binds a run in the fixed registry `~/.agentpro/teamqa/continuation`; leave out `--registry`. `teamqa continuation unregister --session <id>` ends the binding (moved to the registry's `archive/`); a binding that drifted from its run (new round, run deleted, Team QA updated) refuses only Dragon and board writes until it is registered again or unregistered. `stage-hooks` refuses with `PLUGIN_HOOKS_ACTIVE`. A session that is not registered gets `{}` from every hook.
- When `teamqa doctor` reports the Dragon runtime missing, it prints `teamqa dragon install --from <the release's dragon-runtime.dbrc URL>`; the signature is checked before anything runs.
- `teamqa doctor` notes how Team QA is installed and warns when Claude Code loads Team QA twice, as the plugin and from its own skills folder (`DUPLICATE_INSTALL`; a suite install in `~/.agents/skills` that only Codex links to is fine), a staged hook left in a Claude Code settings file (`HOOKS_TWICE`) and plugin files that differ from the signed copies in `scripts/plugin` (`PLUGIN_FILES_DRIFT`).

## A roster confirmed for each run and round

Read [roster and reasoning](references/roster-and-reasoning.md) before dispatch. Collect a catalog with source/date and the capabilities of the exact harness, resolve a model per role, put the whole role/provider/model/effort/route/task table into the chat, then get the user's approval event; the machine binds the exact hash, and the user does not type a hash. `scripts/roster.mjs` uses the same policy as the runner; `roles.json` only declares tools/interfaces and does not decide the model.

Default: one provider per run, no automatic fallback. The five LLM roles need truly separate agents/sessions; Coverage Gate runs Node, not an LLM. OpenAI example when the catalog confirms compatibility: Test Manager Sol medium; Analyst Luna high; Designer and GUI Sol medium; Code Sol high. This is an example of choosing by role, not a fixed model table for every run. Astra is excluded from the default but allowed when the user asks for it directly for the exact role/run/round and confirms a compatible roster; helpers/fallbacks do not inherit that exception.

Roster approval does not replace plan SIGN, permission to write Test data, or a Production grant. Missing approval/source metadata, a model/effort/session/context/target mismatch, or an undeclared helper means no dispatch and no graded verdict is accepted. The context hash proves that the runner supplied the bytes; it does not prove that the model read and understood them. The skill locks its dispatcher and its intake; it does not lock every free tool on the machine.

In a Codex chat with `collaboration.spawn_agent`, prefer native with exact `model`, `reasoning_effort`, `fork_turns: none`. Use `prepare-native` after the roster is confirmed, call the tool with the exact locked payload, then `attest-native` to match the original call/result and the child session log. Prepare locks role, skill and prompt into a context packet; the agent must read the packet with its first tool call, then read the facts separately. Intake checks the hash of the actual output of both reads; the encrypted spawn text is still unobservable and does not prove understanding. Native Code goes through the QA Code static adapter; native GUI goes through the original Dragon trajectory + QA GUI checker, see [native child adapters](references/native-child-adapters.md). Do not switch to CLI just to collect logs more easily; CLI is a separate route only when native does not meet the role's capability, and it must be shown in the roster before running. Native has no per-role sandbox or timeout flag; accept only the trajectory and the actual limits that were checked, and do not claim that the host blocked every action.

In Claude Code, the interactive session is the orchestrating root: the roster/plan is shown in the assistant chat, the user types “Approve”, and preflight and continuation read the original transcript `~/.claude/projects/<project>/<session-id>.jsonl` (`$CLAUDE_CONFIG_DIR/projects/…` when that variable is set; a symlinked `~/.claude` is followed). LLM roles run through the `claude` seat (`claude -p` with exact `--model`/`--effort`, a separate session, with the parent session's environment variables removed); effort is observed from the worker's original transcript through QA Code ≥ 1.9.0. The hook uses `continuation stage-hooks --host claude`. Details, trusted sources and limits are in [Claude Code as root](references/claude-host.md).

A run with a roster/current phase uses the current contract; legacy utilities and reports that carry `historical_diagnostic=true current_run_graded=false` are only for historical diagnosis, even when the old calculation gives GO. An official receipt/handoff must re-verify approval, roles, docs, child evidence and coverage; a legacy signature/receipt does not certify a new run.

For a run that must continue over several turns, use [scoped continuation](references/continuation.md): register the exact root/run, check the decision from cases and evidence, then review/trust the hook on the exact Codex host. Without a native canary, the hook is not yet confirmed to enforce. `CONTINUE` performs the remaining step; `WAIT` reports starting with `NOT COMPLETE` (the marker that the stop hook checks for); only a verified COMPLETE gate closes the run. A blocked case or a board export error does not stop independent cases that are already allowed. The hook's automatic prompt is not an approval.

A native worker still gets one turn; hand over the remaining work with a [new attempt dispatch](references/native-attempts.md) within the same scope and cap. Case history is append-only; use the latest verified attempt, and do not fall back to an old PASS when the new attempt lacks proof. Canonical `case.work` stores the remaining work and blockers; it does not replace the Function/UI verdict. For a target that has only a deployed build, use identity/build evidence and the locked web binding; do not invent a Git SHA.

Dragon through code mode must be one separate RPC in the form `text(await tools.<tool_name>(<JSON>));`, with a valid JSON argument and double-quoted key names. Do not merge RPCs, add pragmas/statements, use variables, or use a JavaScript object with unquoted keys: Dragon may run it, but the native parser will reject the provenance.

## Teamwork QA board — Space first, Notion next, Doc-Colab last

**Never write a QA board by hand.** Not as a Notion page, a Notion database you design, a Doc, a Drive file, an
artifact or a chat table. The board exists only as `qa-board.json` (from `board init`, changed with `board apply`),
and it reaches people only through `teamqa board publish`. In a registered run the hook refuses every other Notion,
Claude Docs, Google Drive and Space write (`BOARD_WRITE_NOT_PLANNED`); in any run the report lists board writes made
outside `board publish` under "Board written outside Team QA" and they are never handed over.

```bash
teamqa board publish --run <run_id> --to notion --parent <Notion page id or URL> --quality-review <review-receipt.json>
teamqa board publish-next --run <run_id>      # after each planned call, until it prints integrity=verified
teamqa board publish --run <run_id> --to html --quality-review <review-receipt.json>
```

`--to notion` (Claude Code or Codex with a Notion MCP connection) creates two databases, Cases and Defects, from the
canonical board. It prints one Notion call at a time: call that tool with the JSON of `board-notion/next-input.json`
as its input, unchanged (no field added, removed or reworded), then run `publish-next`. After the rows it asks for the
readback queries; `publish-next` compares the readback with the canonical board and, at 100%, prints the database
links and the two artifacts to lock (`board_notion`, `board_quality`). A mismatch or a failed call stops with its
code; do not repair the databases by hand. Without a Notion connection use `--to html`, say that Notion is not
connected, and hand over the local board. `teamqa board audit --run <run_id>` shows any board write made outside
`publish`.

Each run creates a board draft from `qa-gui` canonical JSON in PLAN, before SIGN; after DESIGN it updates a new revision with the tracked cases. The board helps developers find the
**defects to fix** first; all cases, Function/UI, source refs and history are still kept in full.
`board.jsonl` is the immutable verdict ledger; `qa-board.json` is the current collaboration state.

Default: **Codex Space/Page → Notion → Doc-Colab**. Use the available Pages tools to create a Page;
when no Space is listed, create a private Page with no parent. Fall back only when the provider
is absent or a probe confirms before the write that it cannot be reached. A timeout, an unknown outcome or
a mismatched readback needs diagnosis/re-reading; do not create another board on the next provider by yourself.

```bash
teamqa board init --run <run_id> --title "<app> QA" --tracked runs/<run_id>/tracked-plan.json --environment TEST --database <db> --out runs/<run_id>/qa-board.json
teamqa board prepare --file <qa-board.json> --capabilities <connector-probes.json> --out <page-payload.json> --quality-review <review-receipt.json>
```

`board init --evidence-policy 1` turns on QA GUI's evidence policy v1 (every screenshot and recording is machine-checked before it
can back a PASS); on the deployed-build lane `web collect` makes that evidence and turns it on itself
([claude-host](references/claude-host.md), [evidence draft](references/executor-evidence.md)).

`prepare` only prepares the payload when Space/Notion is chosen; it does not confirm a remote write.
For Space, use `title` and `initial_blocks` from the payload with the `create_page` tool, read the Page independently
with a full `read_page`, save the response unchanged, then run:

```bash
teamqa board compare-page --file <qa-board.json> --payload <page-payload.json> --snapshot <read-page.json> --out <page-receipt.json>
```

In a registered run, lock the Page creation request before calling the connector:
`node scripts/board-quality.mjs write-request --file <qa-board.json> --payload <page-payload.json> --destination <page-destination.json> --out <board-write-request.json>`.
The hook allows `create_page` only when exactly this request is locked together with `board`, `board_payload` and
`board_quality`. Direct Page edit/visualization and direct Notion create/update are blocked; use the gated
Notion adapter. The connector's response does not replace the Page readback.

Only `integrity=verified effect=confirmed` hands over the Page link. How to probe, evidence mapping,
update/comment, native fallback and the defect writing template are in [board for developers](references/board-for-developers.md).
For Notion, use the declared export/sync/readback interface; this provider is the default fallback
and no longer needs a separate opt-in when Space is verified unavailable.

Doc-Colab is only the last fallback. Do not edit the rendered HTML, `DOC_DATA`, CSS/JavaScript or the lock
receipt. Create it from canonical, verify the exact final bytes, then open it with its canonical:

```bash
teamqa board render --file <qa-board.json> --renderer native --out <index.html> --quality-review <review-receipt.json>
teamqa board open --file <index.html> --canonical <qa-board.json>
```

Prepare an independent review from immutable native session evidence, then attest and verify it with `scripts/board-quality.mjs` before handover. Render, prepare and Notion push need an authenticated review receipt; the CLI creates `<artifact>.quality.json`, which locks the exact canonical and the exported artifact. `compare-page` needs the exact exported `--payload` so that the readback is bound to the sealed projection. Notion pull updates canonical and is reported as `quality=not-reviewed` until there is a new independent review. Verify and open check the current sidecar before calling the renderer verifier or the opener.

The agent edits only canonical; `apply`/`sync` create a new revision, do not overwrite the input and do not edit old
rounds. `RETEST` needs a new fix proof; independent QA goes through `RETEST → VERIFIED → CLOSED`, and a fail becomes
`REOPENED`; do not close a defect you created yourself. Human edits/comments must be read back, materialized
through `board apply`/the qa-gui hardener, validated and rendered/read back before staging is cleared.

Read [chat and operational preflight](references/chat-and-preflight.md). `roster approve` requires basic preflight; `run show-plan` locks the board link/readback, and the content must appear unchanged in the chat before SIGN. Executor dispatch/intake checks the preflight of the exact role; the canary below does not replace evidence that the tools work.

Cost: the roster table carries a cost estimate at API list prices (planning roles per round, each GUI case); `teamqa cost estimate --run <run_id>` gives the run total once the tracked plan exists. When the user names a budget, set it with `teamqa cost cap --run <run_id> --usd <amount>`: a dispatch or case that would start after the cap is spent is refused with `RUN_COST_CAP_REACHED` (an attempt with no reported price, such as a Codex worker or one that timed out or still runs, counts at its role's measured maximum); keep the evidence of finished cases and report NOT COMPLETE with the cases left. `report build` adds the actual tokens and cost per role (`teamqa cost report --run <run_id>` shows them any time).

## Prepare the run

1. Create `runs/<run_id>/` and keep `test-plan.md`, `tracked-plan.json`, `board.jsonl`, `rtm.md`, `summary-report.md` in it.
2. Run `teamqa roles check`; do not assign a role if the engine lacks a tool declared in `roles.json`. For Dragon, set `TEAMQA_DRAGON_STATUS_URL` to probe the real endpoint; even when the endpoint returns 2xx, Team QA must still run the qa-gui gate with a wrong canary and check the negative canary when the real gate rejects it with a reason; operational readiness also needs a successful probe in `preflight.json`. Only resolving the binary, or only an HTTP 2xx, is not enough.
3. Run `teamqa smoke`; it stops with code 4 when the schema major of `qa-gui` or `qa-code` differs, and with code 5/ungraded when the interface cannot be measured. Smoke really runs the canary of each child skill: the command declared in `skills.<skill>.commands` (`canary` → `gate` → `gate0`) is called with the deliberately wrong canary input `fixtures/canary/child-gate-canary.html`. A gate that cannot be called, dies from a signal/timeout, accepts the wrong input with exit 0, or returns an error without a reason is code 5/ungraded with the skill name; when a skill declares no command, smoke records `canary=undeclared`.
4. Run models through the dispatcher/child interface locked in the roster; use native Codex or a compatible Claude adapter, and MIXER only when the user chooses it and the adapter can prove the actual configuration. When the engine fails, keep ungraded/BLOCKED; changing model/provider/fallback needs a new roster confirmed by the user; do not switch seats by yourself.

## Roles

| role | Contract | OpenAI example if the catalog confirms | Constraints |
|---|---|---|---|
| `test_manager` | brief → plan, gate, summary | `gpt-6.1-sol`, medium | agent/session and actual configuration match the roster |
| `analyst` | source/spec → risk dossier | `gpt-6-luna`, high | read-only; context and source refs are hashed |
| `designer` | signed dossier → tracked plan + RTM | `gpt-6.1-sol`, medium | DESIGN only after plan SIGN on the exact SHA |
| `executor_gui` | plan → qa-gui verdict + evidence | `gpt-6.1-sol`, medium | `tool_bound=true`; strict Dragon MCP + qa-gui; separate Function/UI |
| `executor_code` | diff → qa-code verdict | `gpt-6.1-sol`, high | independent QA Code on the same provider; child proof, read-only and actual config |
| `coverage_gate` | board → RTM, metrics, decision | Node deterministic | no LLM, never changes a verdict by itself |

Keep `roles.json` compatible for historical tooling checks; old aliases are not an executable default/fallback. Only the `roster.json` confirmed by the user is the authority for the current run.

**Adjudicator (optional seat).** A roster request with `"adjudicator": {"provider": …}` adds one read-only seat of a
model family other than every executor's (`roster.mjs select … --adjudicator-catalog <catalog of that provider>`);
the roster validator refuses the executor's family. It judges PASS cases only unless the request says
`"scope": "all"`. It is **shadow** unless the request says `"mode": "enforce"`: its
results are recorded and the report shows what the verdicts would be if it were on. It only ever lowers a PASS to
UNGRADED (CONTEST); it never makes a case PASS or FAIL. Contract, schemas and validator rules:
[adjudicator contract](references/adjudicator-contract.md).

## Phase 1 — PLAN

1. After roster approval and the separate attestations of Test Manager/Analyst, lock the source with version/refs/target; the Analyst builds a risk-based dossier; the Test Manager writes `test-plan.md` with a `TEAMQA_PLAN_START/END` block per `schemas/plan.json`.
2. By default GUI runs sequentially by lane. Set `parallel_ok:true` only when `vi_sao` proves that no data is shared.
   Speed flags (upgrade R3): every speed-up that skips work is off unless the plan's `speed` block, signed with the plan,
   sets it to `shadow` or `on`; parallel GUI lanes, vision by diff, the cost ladder, fast-click and the action cache are
   described, with what each one skips and what always still runs, in [speed flags](references/speed-flags.md).
   QA GUI's detectors (upgrade integration) are not a flag: on the web lane a GUI case dispatch carries a
   `TEAMQA_DETECTORS` section when something applies to it (the transient probe of a risky main action: the case's
   `data.main_action` (a label, or `{label, inForm, inList, inDialog}`) or else the last quoted control of its steps,
   never a sign-in or navigation step; a write with no `data.reset` gets no trial, N/A; the U1/U2/U3
   states a case forces through `data.ux` or a `request=` condition, the exploration of a cell case), and `web collect`
   carries what QA GUI rebuilds from the stream into the run ([evidence draft](references/executor-evidence.md)); QA GUI
   grades it. The width sweep and the overlay check run once per screen (each route and role of a GUI case; `teamqa web
   screens --run <run_id>` lists them), before the cases: `roster.mjs dispatch --role executor_gui --screen-id <S1..>`
   (three attempts per screen), then `teamqa web
   collect-screen --run <run_id> --attestation <its attestation>`; every case on that screen gets its result at collect.
   A case without a route has no screen check (N/A).
3. Run `teamqa plan validate runs/<run_id>/test-plan.md`. A missing number, a wrong type, a broken marker or an unknown field is rejected.
4. Lock source/dossier/plan with `teamqa run lock-docs --run <run_id> --manifest <artifact-map.json>`, then `teamqa run transition --run <run_id> --to PLAN`; create/read back the board draft and run `teamqa run show-plan --run <run_id>`, put the output unchanged into the chat, then SIGN. The plan declares the scope `preflight:{code,gui,recording}`; record BLOCKED explicitly when a lane is not ready. Fixed before EXECUTE: P0 at most 0; P1 at most 0 except a waiver signed per case; FULL coverage 100%; SMOKE coverage from 70%.

## Phase 2 — SIGN

1. Run `teamqa gate publish --run <run_id> --plan runs/<run_id>/test-plan.md`.
2. Use the highest tier verified to be present, in the order Space/Page → Notion → doc-colab decision page → file in git. A Google Sheet is only a view for the client, not a signing gate.
3. Every publish adapter must come from `roles.json`; after the write, run the separate readback adapter and compare the exact payload. Only `effect=confirmed` counts as success.
4. After the user has seen the full roster, the QA board link and the preflight, and has approved the exact plan in a chat with a read-back source, harden the state, then run `teamqa gate approve --run <run_id> --plan <file> --signed-by owner --user-event <plan-user-event.json>` to write the machine source `control/approvals/<run_id>/plan-v<X>.json` and read it back.
   `--signed-by owner` is only a label of the plan-signing interface; it does not replace the real user event and never replaces roster approval. A current SIGN must be bound to the run/round/roster hash and to a signing source that the verifier accepts; without the source it is BLOCKED.
5. Run `teamqa gate status --run <run_id> --plan <file>`. Unsigned, or signed on an old SHA, locks DESIGN/EXECUTE with code 3. A plan changed after signing must be published as a new version and signed again.

## Phase 3 — DESIGN

After plan SIGN on the exact SHA, dispatch the Designer separately, read back the attestation/context, then `teamqa run transition --run <run_id> --to DESIGN`.

1. The Designer writes a new tracked plan per `schemas/case-v2.json`: the root has `schemaVersion:2`, a `sourceItems[]`
   registry, and each case has `title` and `sourceRefs[]` besides id, requirement, lane, steps,
   expected, data, priority, kind and coverage axes. One source can link to many cases and one case can
   link to many sources; the registry order and the case order are the canonical order.
   To gate coverage by cell (route × state × action × viewport row × condition), add the root `coverage` block
   (viewport rows, static routes, screens with data) and a `route` on each GUI case; N/A cells go in the signed
   plan with a reason. See [coverage cells](references/coverage-cells.md).
2. Run `teamqa design validate --file runs/<run_id>/tracked-plan.json`.
3. Run `teamqa rtm build --plan <plan> --tracked <tracked> --out runs/<run_id>/rtm.md`.
4. Do not hide gaps: a requirement with no case and a source with no case must show `**EMPTY**` (the RTM gap marker). RTM v2
   orders each edge by `source → case`, then fills the exact `verdict → evidence` from the board.
5. Tracked plan v1 `{cases:[...]}` can still be read/validated for diagnostics; current EXECUTE requires v2. Upgrade only with a reviewed mapping; each legacy
   case must have an explicit `caseId`, `title`, `sourceRefs`, not inferred from id/requirement/title:

```bash
teamqa design migrate-sources --file <tracked-v1.json> \
  --mapping fixtures/data/source-mapping.example.json --out <tracked-v2.json>
```

6. For an escaped defect recorded in the immutable registry `agentpro/escaped-defect-registry/v1`,
   compile each incident into exactly one `qa-derived` source and each affected layer into one
   tracked regression case. The command seals every `incident → source → case` edge in the receipt;
   a missing layer, a detached source ref, changed output bytes or an existing destination all fail closed:

```bash
teamqa design compile-defects \
  --registry <escaped-defect-registry.json> \
  --tracked <tracked-plan-v2.json> \
  --out <tracked-plan-with-regressions.json> \
  --receipt <escaped-defect-compile.receipt.json>
```

## Multi-target release

Use [target composition](references/target-composition.md) when a parent signed suite holds several apps/builds. `teamqa composition prepare` creates a projection that keeps case/steps/source edges unchanged; it creates no approval or PASS. Each child must have a roster/SIGN/target binding and a real v2 receipt; `composition build|verify` calls the existing gates again and counts each original case once, requiring every target component. A cross-app case must have an evidence hash bound to the exact UUID/SHA/version of every target and of the executed files; missing or mismatched is UNGRADED. The report writes only to a new path and never overwrites an old input/report. Parent bytes/denominator do not change; no child proof means no GO.

## After a fix — choose the re-test scope

Before each round, read the diff/fix proof and its impact on screens, flows, and shared permissions/data.
Use the [re-test policy](references/retest-policy.md): defect + affected regression + core smoke
when the impact is known; expanded for a shared change; full suite when the impact is unclear or for
whole-release acceptance. Do not default to the full app after every fix, and do not check only the defect either.
The selection does not replace the tracked plan, does not shrink the denominator, and does not reuse a PASS from another build.
A change of scope outside the signed plan requires editing the plan and signing again; the release report still goes through every existing gate.

## Phase 4 — EXECUTE

Lock tracked v2, the exact RTM/source edges, the canonical board/template, and the selection/fix proof for a retest; `teamqa run transition --run <run_id> --to EXECUTE` opens only when the chain is complete. GUI without a hashed strict Dragon MCP config or without runtime metadata is blocked before the model call/its result is not accepted.

1. Run `teamqa gate status` again; the signing gate locks this whole phase.
2. The official target must match the target of the confirmed roster; declare the tooling target before any graded verdict with `target` in the roles config or with all three variables `TEAMQA_TARGET_PROJECT_ID`, `TEAMQA_TARGET_PREVIEW_URL`, `TEAMQA_TARGET_VERSION`. These three variables can declare only a Git target, and they win over the roles config. A deployed-build target is declared only through `target` of the roles overlay that `teamqa web bind` writes outside the package (the package `roles.json` + the roster `target`, pointed to by `TEAMQA_ROLES`); in that case set no `TEAMQA_TARGET_*` variable, see [Claude Code as root](references/claude-host.md). A missing field, an invalid URL or a record that differs in any field becomes `ungraded`; no fallback to another target.
3. Call `qa-gui` lane by lane in sequence and `qa-code` by the tier in the plan, only through the commands/schemas declared in `roles.json` and `references/interfaces.md`.
4. Do not copy the scripts, schemas or grading logic of the two child skills into Team QA.
5. Write each record with `teamqa board add --file runs/<run_id>/board.jsonl --record <record.json>`. A PASS must have `source` equal to the child skill name, an artifact with that skill's schema and a matching SHA-256; `source=script` must not sign a child PASS by itself. A case that already has `ungraded`/`blocked` continues with the next attempt, with a new `attempt_id` and a `parent_attempt_id` pointing to the exact previous attempt; the board keeps the whole history and only the latest fully verified attempt counts.
   With tracked plan v2, `board seed` copies `traceabilityVersion` and `sourceRefs` unchanged; `board add`,
   `board verify`, RTM and report all reject a ref that is missing, reordered or different from the plan.
6. Use the SCROLL ledger `local://`; every pass/fail must open its proof. Behavioral GUI needs a recording; static UI can use images per the qa-gui contract.
7. Run `teamqa board verify --file <board>`. `blocked` must become `verdict=ungraded` with a reason; a pass/fail with missing or unreadable evidence also becomes ungraded and is not counted as pass.
8. Re-test at most 3 times per case per SCROLL §26. When the tries run out, record the failure proof and continue with the next case; on gate denied, stop at once.
9. To offer a re-run for an official verdict (a new round, or the next attempt of a case): run `teamqa run offer --run <run_id> --kind round|attempt --cases <id,id> --reason <CODE>` and paste the `TEAMQA_OFFER …` line it prints, unchanged, into the assistant chat right before the question. The command rejects cases outside the tracked plan, cases that are out of tries, and runs that are already COMPLETE; the marker keeps the approved roster and target. A proposal to change the target, roster or plan does not use this marker. A new round still goes through the roster and plan approval of that round.

When the approved roster has an adjudicator seat: freeze each case's checklist before its evidence exists
(`teamqa adjudicate checklist --run <run_id> --case <id>`, any time after DESIGN), and after each executed record run
`teamqa adjudicate run --run <run_id> --case <id> --attestation <the executor's case attestation> --board <qa-board.json>`.
Never pass it the executor's verdict, draft or notes; it reads only the raw evidence. In shadow mode change nothing
else and do not wait for it: start it after the case's verdict is recorded (`run_in_background`) and go on with the next
case; with an enforcing seat apply `teamqa adjudicate board-change` through `teamqa board apply`. Before `teamqa report build`,
wait for every background adjudication you started to finish (each writes its `result.json`); a report built while one
still runs leaves that case's shadow decision out.

## Phase 5 — COMPLETE

Fill the RTM from the ledger, run the [authenticated independent board review](references/board-review-workflow.md), verify the exact artifact/Page and lock `board_quality` together with `board_render` or `board_payload`; re-lock the changed artifacts, then `teamqa run transition --run <run_id> --to COMPLETE`. In an unattended run (`TEAMQA_RUN_MODE=unattended` on the approved roster) where the board review is still not PASS after 3 fix rounds, do not ask the user: run `teamqa board deliver-blocked --run <run_id> --reviews <r1,r2,r3>`, do not hand over or publish the board, and still go to COMPLETE, report and receipt (`board_delivery: "blocked"`); an interactive run keeps the old behavior. The gate checks every case/child proof, separates Function/UI and does not count BLOCKED/NOT RUN/DEFERRED as coverage. When the chain is incomplete, `teamqa report diagnose --run <run_id>` outputs a diagnostic NO_GO and issues no completion receipt.

1. Run `teamqa report build --run <run_id>`. The command uses only the exit criteria of the signed plan SHA and cross-checks plan + tracked plan + board + RTM. It also refuses `TEST_SECRET_IN_OUTPUT` when a test-account password from the run's credential inputs appears in the board, report, RTM or plan (`teamqa secrets scan --run <run_id>` names the files): remove it from that file and build again. Never copy a password into a case step, note or evidence caption.
2. Coverage counts only graded cases (`pass` or `fail`); `verdict=ungraded` does not cover a requirement.
   With the tracked plan's `coverage` block the Coverage Gate counts only cells that have a state receipt: a graded
   case whose declared cell has none is `COVERAGE_CELL_UNGRADED` and does not cover its requirement. The report
   gives the cells by two state groupings, the frontier, Û = f1/n and the stop reason separately, and writes
   `coverage-map.json`; put QA GUI's app map v2 at `runs/<run_id>/app-map.json` first ([coverage cells](references/coverage-cells.md)).
3. One missed criterion produces `decision: "NO_GO"` and `reasons[]`; only when all criteria pass is it `GO`.
4. Run `teamqa report verify --run <run_id>` to catch any hand-edited number.
   Report v2 carries the registry and rows in the order `sourceRef, caseId, verdict, evidence`; an edit to source,
   verdict or evidence in the RTM/report is read back and rejected.
5. Run `teamqa report publish --run <run_id>`; apply the same independent publish/readback chain as Phase 2.
6. Run SCROLL check/build/eval for the agents involved, then audit: `teamqa scroll check|build|eval <agent>`, `teamqa scroll audit` and `teamqa scroll audit --verify` (the SCROLL copy that ships with Team QA). Red or ungraded means not done.
7. Run `fixtures/run_fixtures.sh`; clean up only the resources of the adapters that were used, and call `mixer_reap` only if the run really used MIXER.

## Guardrails L11 and L12

- **L11:** use the SCROLL approval file §18.3, ledger §24, tries §26, proof-pack §27, independent readback §28 and ternary verdict §29. Do not invent your own loop, approval store, ledger or boolean pass.
- **L12:** the main session uses at most 25% of the tokens per run; accept only summaries with a line cap or a file pointer; keep a stable prefix; the product fix loop (dev fixes, QA re-tests per [retest](references/retest-policy.md)) runs at most 2 rounds, then goes to the user; the board review uses the 3-fix-round cap of [board review](references/board-review-workflow.md); reap only the adapters that were used.
- Env dies mid-case: record ungraded/blocked with proof, stop the lane and report. Two lanes collide on data: stop the later lane, switch to sequential, record a process defect.
- Do not fix bugs, do not write automated tests into the client repo, do not measure load/performance. Plan/report use the
  declared publish/readback adapter when Notion is chosen; the canonical teamwork board is updated both ways only
  within the scope the user confirmed and through the gate + independent readback above.
- A regression proposed for the client repo may only be written inside the `teamqa:begin/end` markers; read the markers back after the write.

## Plugging in an unknown engine P1–P5

- **P1:** give only analysis/design to an engine without tools; never fake a description of GUI actions.
- **P2:** the validator grades the artifact, not the engine name.
- **P3:** every official model call goes through the locked route with actual config/tool receipts; MIXER is not required; no hidden helper/fallback is accepted.
- **P4:** declare the tool cap explicitly; an engine that does not run tools may only do analysis/design.
- **P5:** point to files instead of stuffing argv; continue only within the confirmed scope and keep the user approval gate; trust numbers only after Coverage Gate has cross-checked the board.

## Exit code

| Code | Meaning |
|---|---|
| 0 | pass |
| 1 | other error or an outcome that did not pass; with a reason |
| 2 | validator rejected the input |
| 3 | gate locked: unsigned or signed on an old version |
| 4 | child skill schema major mismatch |
| 5 | preflight broken: env, quota, dependency or path; usually ungraded |

Every command must print exactly one of `verdict=pass`, `verdict=fail`, `verdict=ungraded`. Ungraded is not pass.

## Files and verification

- Use the schemas in `schemas/`; use the adapter contract and the child skill commands in `references/interfaces.md`.
- The full source traceability contract and the migration/readback gate are in
  `docs/source-issue-traceability-contract.md`; a tracked v2 example is in
  `fixtures/data/tracked-plan-v2.example.json`.
- A native board is handed over only after `teamqa board verify --file <canonical> --artifact <html>` returns
  `verdict=pass ... integrity=verified` on the exact final bytes.
- Run `python3 <skill-creator>/scripts/quick_validate.py <team-qa>` after changing SKILL metadata.
- Run `fixtures/run_fixtures.sh` with both Node 24 and Node 26 before handover.

## Release Truth contract v2

A current official run needs a confirmed roster, role attestations, docs/phase locks and `binding.json` next to `tracked-plan.json`; `board seed` copies the `task_base`,
`source_revision`, `exact_final_sha`, contract SHA and lane keys into each PENDING row. With tracked v2,
it also copies the exact `sourceRefs`. `board add` only replaces the PENDING row of a case that exists in the tracked
plan and rejects any mismatched binding/lane/source ref. A retry only chains from the latest attempt with verdict `ungraded` or `blocked`, at most three attempts per case; attempt number, unique `attempt_id`, parent link, lane, source refs and binding must match. History is append-only; a broken chain makes the case invalid and does not allow falling back to an old PASS.

```bash
node scripts/teamqa.mjs board seed --run <run-id> --tracked runs/<run-id>/tracked-plan.json --file runs/<run-id>/board.jsonl
node scripts/teamqa.mjs rtm fill --rtm runs/<run-id>/rtm.md --board runs/<run-id>/board.jsonl --out runs/<run-id>/rtm.md
node scripts/teamqa.mjs receipt create --run <run-id> --binding runs/<run-id>/binding.json --out runs/<run-id>/team-qa.receipt.json
node scripts/teamqa.mjs receipt verify --file runs/<run-id>/team-qa.receipt.json
```

A release-bound run must have `run_uuid`, the requirements hash, `roles.json`, a target lock and the exact receipt
schema major of QA Code/QA GUI before EXECUTE. The historical receipt `team-qa/receipt/v1` seals the plan,
tracked plan, board ledger, RTM and summary; GO is recomputed from the machine report, not read from prose.
Team QA still only orchestrates and never replaces a QA Code or QA GUI verdict by itself. Do not use a standalone legacy receipt/handoff helper as sufficient evidence for the current run; the receipt needs its provenance and the full current verifier.

## Release B — handoff truth 1.4

After the current receipt has passed the current-contract/provenance verifier, Team QA creates an envelope bound to the exact Team-code Job Capsule.
The envelope keeps Team QA's orchestrating role: it does not re-grade QA Code/QA GUI and does not turn an
exit code, prose or a retry into a verdict.

```bash
node scripts/teamqa.mjs handoff create \
  --receipt runs/<run-id>/team-qa.receipt.json \
  --capsule .teamcode/runs/<run-id>/job-capsule.json \
  --producer-commit <exact-team-qa-commit> \
  --out runs/<run-id>/team-qa.handoff.json
node scripts/teamqa.mjs handoff verify \
  --file runs/<run-id>/team-qa.handoff.json \
  --capsule .teamcode/runs/<run-id>/job-capsule.json
node scripts/teamqa.mjs handoff ack-verify \
  --file .teamcode/runs/<run-id>/receipts/team-code.handoff-ack.json \
  --handoff runs/<run-id>/team-qa.handoff.json
```

The six keys `run_uuid`, `task_base`, `source_revision`, `exact_final_sha`, `requirements_hash` and
`capsule_digest` must match exactly. Team-code must return a sealed acknowledgement that can be read
back and has `handoff_latency_ms`; by default, over 15 seconds fails closed. Team QA caches only the verification
of immutable sources/dependencies; verdicts, approvals and waivers are never cached data.

## Release gate

Team QA uses the same package/provenance schema as Team-code, QA Code and QA GUI. The build must call
the installed canonical Team-code gate directly; copying the Git/runtime logic into a separate copy is forbidden:

```bash
TEAMCODE_RELEASE_TRUTH_GATE="$HOME/.agents/skills/team-code/scripts/release-truth-gate.mjs" bash scripts/build-package.sh
bash dist/team-qa-1.6.0-release/install.sh
bash "$HOME/.agents/skills/team-qa/scripts/verify-install.sh"
```

Before a GitHub push, use `--local-candidate` with the Team-code gate of the same Release A. The installer
rejects this package by default; only `--allow-local-candidate yes` with separate `--dest-root` and `--compat-root`
allows a rehearsal, and it must not point at the official runtime.

Release only after local `main` is clean and equal to GitHub `main` read live. The runtime must have
`SOURCE.json`, `package-manifest.json` and `release-truth.json`; missing one layer means not complete.

*v1.16.2 — 2026-11-10. Beside the Claude Code plugin, the suite installer and `teamqa update` keep the Codex links and
move the ~/.claude/skills links of qa-code, qa-gui and team-qa to `<dest-root>/.backups`, so Claude Code loads Team QA
once (from the plugin) and Codex keeps using ~/.agents/skills.
v1.16.1 — 2026-11-10. `teamqa dragon install` installs for real: it runs the package's installer by its real path
(on macOS the temp folder is a symlink, and the installer skipped its work and exited 0) and passes only when the
installer reports the version running (`DRAGON_RUNTIME_INSTALL_UNCONFIRMED` otherwise).
v1.16.0 — 2026-11-10. GUI cases run QA GUI's detectors through Dragon R1a (Dragon 1.7.0; on an older Dragon they
are reported, not run): forced loading and error states (U1–U3), the transient probe of the case's main action (a save
without a reset path gets fresh-value trials, a delete is N/A), the entry probe of each screen, and the width sweep and
overlay check once per screen, also for a screen a case reaches from a share link. An executor proves the build with
`openTab {proveIdentity:true}`. Coverage cells from state receipts; an optional adjudicator seat from another model
family (shadow by default); speed flags in the signed plan, off unless it says shadow or on; light, bounded evidence;
dispatch, hook and update fixes.
v1.15.1 — 2026-10-30. Gate fixes from the 1.15 review: roster and plan approval refuse any message with a negator or
hold word (`isApprovalText`); the test-secret scan reads the credential forms real accounts files use (key styles,
Vietnamese labels, quoted values, numbers, .env, links), scans outputs of any size and warns `TEST_SECRETS_NOT_FOUND`
when it reads none.
v1.15.0 — 2026-10-30. Team QA as a Claude Code plugin (`team-qa@agentpro`): each skill finds the others next to
itself (`SIBLING_SKILL_MISSING` instead of another install); plugin mode for update, doctor and continuation (fixed
registry, hooks through `scripts/plugin/plugin-gate.sh`, `{}` for sessions not registered); doctor names the release's
Dragon runtime URL; `scripts/release-plugin.sh` builds the plugin from the signed suite.
v1.14.0 — 2026-10-29. Public v1: one signed suite with Team QA, QA GUI and QA Code (`bash install.sh --license`),
`teamqa doctor`, `teamqa update`, the signed Dragon runtime (`teamqa dragon install`) and the free licence; a
suite-installed skill proves its origin by the publisher's signature; SCROLL ships inside (`teamqa scroll`); English
text and RTM/WAIT tokens (older RTM files still parse); skills come from the agentpro-tech organization.
v1.13.0 — 2026-10-23. Claude Code as the orchestrating root: host descriptor, chat/approval, preflight and
continuation read Claude Code's original transcript; the `claude -p` worker has its own session, with the parent
session's environment variables removed; effort observed from the worker transcript (QA Code ≥ 1.9.0); `stage-hooks --host claude`.
v1.6.0 — 2026-10-02. Space/Page → Notion → Doc-Colab; developer board per BA Pro v2;
opening a QA artifact requires verification against canonical; re-test selection by impact, denominator kept.
v1.5.1 — 2026-09-02. CI portability patch: Release C acceptance and mutation get the exact pinned
SCROLL root on the GitHub runner; runtime behavior and role contracts unchanged.
v1.5.0 — 2026-09-02. Release C Escaped-defect Defense: the immutable registry is compiled into a
`qa-derived` source and a tracked regression case per layer; the receipt seals 100% of the
source → case edges and fails closed on a missing binding, a detached ref, changed bytes or an overwritten output.
v1.4.0 — 2026-09-02. Release B Reliability: the Team QA envelope is bound to the exact Job Capsule, the Team-code
acknowledgement has seal/read-back/latency, and cross-SHA and contract drift both fail closed.
v1.3.0 — 2026-09-01. Release A Truth Chain: an absent tier is N/A, checkers run before coverage,
a release-bound run fails closed when governance is missing, an exact child receipt v2 must be bound to the exact case and
requirement, the schema major is checked before EXECUTE, GO only comes from a re-derived machine report.
v1.2.0 — 2026-08-28. Adds tracked plan v2 with a many-to-many source registry, explicit migration,
refs across board/qa-gui/Notion, and a deterministic source → case → verdict → evidence RTM and report.
v1.1.1 adds an isolated package install path with `--compat-root` so that a local rehearsal does not touch the official
runtime. v1.1.0 adds release-truth-contract/v2, board seed PENDING, binding across board/report,
RTM fill, a sealed receipt and coverage per lane. v1.0.4 adds the package manifest, provenance and the
GitHub main ↔ local main ↔ runtime gate; drops `.build` state, pins SCROLL and uses a hermetic child fixture
in CI.*
