# Claude Code as the orchestrating root

This route lets a whole Team QA run be driven from an interactive **Claude Code** session (CLI, desktop or
app) on a machine that has the child skills, in place of a native Codex session. The gates do not change: roster, SIGN,
phase lock, child proof, coverage and receipt still go through the existing verifiers. Only reading the host
transcript and the way workers are called are new.

## Trusted sources

| Source | Accepted path | Used for |
|---|---|---|
| Root transcript | `~/.claude/projects/<project>/<session-id>.jsonl` (`$CLAUDE_CONFIG_DIR/projects/…` when set; compared by real path); the file name must be the session ID and match `sessionId` of the first metadata line | host descriptor, shown roster/plan tables, approval line, preflight, continuation |
| Worker transcript | the same root folder, the `<session-id>.jsonl` file of the `claude -p` session | observed model and effort, the supplied context packet |
| Subagent transcript, `tool-results/`, other files | every other file under `~/.claude` | **not** a source; rejected |

The host descriptor has the same shape as on Codex (`path,line,sha256,session_id,agent_path,version`).
`line` is the first line that has `sessionId` and `version`; `sha256` locks the exact bytes of that line. The root must be an
interactive session: the first prompt must have `origin.kind=human`; a headless session (`claude -p`, a prompt
without `origin`, `turnOrigin=sdk` or an `entrypoint` of the form `sdk-*`) is rejected with `CLAUDE_HOST_HEADLESS`.

## Chat and the approval line

- A roster/plan table counts only when it is in a `text` block of an `assistant` line that is not a sidechain.
  Thinking, tool calls, tool output and subagent text do not count.
- The approval line must be a `user` line typed by a person: not `isMeta`, not a sidechain, `userType` is
  `external`, `origin.kind=human` is **required**, `turnOrigin` (if present) is `human`, `entrypoint` is not
  of the form `sdk-*`, it holds only text blocks, and it is not a tool result, a slash-command echo or a hook. A
  `<system-reminder>` block inserted by the host is removed before the verbatim comparison.
- The text `TEAMQA_AUTOMATIC_CONTINUATION` is still blocked, as on the Codex route.
- Approving with a choice button (AskUserQuestion) is a tool result and is **not** accepted; the user types
  “Approve” into the chat.

## Preflight

Call/result evidence is a pair of original lines in the root transcript: an `assistant` line that holds **exactly
one** `tool_use`, and a `user` line that holds exactly one `tool_result` with the same `tool_use_id` and a
`sourceToolAssistantUUID` that points to the call line. The marker `TEAMQA_PREFLIGHT run=… round=… roster=…`
must appear in the visible assistant chat before the call. After the roster is approved, the host of all
evidence must be the exact root session that holds the approval line (`PREFLIGHT_HOST_NOT_ORCHESTRATOR`).

- `Bash` is normalized to `exec_command` with `{cmd}`; the output is taken from `toolUseResult.stdout`, and
  `exit_code` is 0 when there is no error, or the code in `Exit code N`. A background command (`run_in_background`) is rejected.
- MCP (`mcp__<server>__<tool>`) keeps its name; the output is the single text block of the tool result.
- Dragon runs through MCP directly as `mcp__Dragon_Browser__dragon_rpc`. The `qa_do.mjs` helper through the shell
  is still blocked by the hook; the Codex `exec_command` helper route (which needs `login:false`) does not apply.

## Worker `claude -p`

The seat uses the `claude` harness in the roster (`roster collect --provider anthropic`). On dispatch:

1. The worker gets its environment from an **allowlist** (PATH, HOME, locale, proxy/CA, `ANTHROPIC_*`,
   `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex). Every variable tied to the parent session
   (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, remote ingress, entrypoint, effort…) is removed; otherwise
   the worker would write into the **root's session** or stream into the root's remote session.
2. Each attempt runs with `--session-id <attempt-uuid>`; the observed session must be exactly that UUID
   and differ from the root session (taken from the roster approval line).
3. Claude's stream-json does not output effort. QA Code ≥ 1.9.0 reads model and effort from the worker's original
   transcript (the `claude-transcript` metadata source), seals the first observed line and the
   Claude Code version; Team QA checks that the context packet is in the first user line of that transcript.
   A missing transcript, empty/differing effort, a line from another session, a session ID present in two projects
   (even when the source is supplied up front) or a file outside the root folder is UNGRADED.
4. A role without an MCP route runs `-p --safe-mode --permission-mode plan` with empty MCP. The GUI Executor seat
   that has a locked Dragon route (`mcp_config` of the runtime roster) does not use `--safe-mode`: Claude Code
   2.1.311 with `-p --safe-mode` turns off every MCP server, including the `--mcp-config` server, and
   `--permission-mode plan` refuses MCP calls. This seat runs `--disable-slash-commands`,
   `--permission-mode default` and `--allowedTools mcp__<server>` for each server of the route (usually
   `mcp__Dragon_Browser`), plus `--add-dir <Dragon output root>` (`DRAGON_OUT_DIR`, default
   `~/.dragon/out`): the Dragon bridge writes the executor's screenshots and recordings there, outside the run folder,
   where the default `-p` permissions refuse Read and the parser would break the attestation; Edit and Write stay forbidden.
   This seat also has one more `--add-dir`: the `tool-results` folder of the executor session itself
   (`<CLAUDE_CONFIG_DIR>/projects/<cwd>/<session id>/tool-results`, created before the run): Claude Code stores
   tool results that exceed the output limit there and tells the model to Read them back; without this flag the executor loses the results.
   Dispatch for this seat keeps up to 256 MB of output (other seats 16 MB), because stream-json carries every image
   the executor Reads in full, about 0.5–1 MB per image.
   The other flags (`--strict-mcp-config --mcp-config <locked config>`,
   `--setting-sources ''`, `--tools Read,Glob,Grep,Bash`, `--disallowedTools …`, `--max-turns`,
   `--effort`, `--session-id`) stay unchanged. The Codex harness and the fixture roster do not change.
5. Waiting for a dispatch (U6). One worker turn can run up to 30 minutes, above the 10-minute cap of one Bash command. Run
   `roster.mjs dispatch … --detach`: the command returns at once with `attempt=<id>`, while the dispatch runs in the background, writes
   `dispatch/<role>/<attempt>/state.json` (`starting` → `running` → `done`, or `failed` with an error code) and copies the
   worker's stream into `progress.jsonl` while it runs. Then call `roster.mjs wait --run-dir runs/<id> --attempt <id>` with
   a Bash timeout of 600000 ms: the command waits until the dispatch is done or `--max-seconds` runs out (default 540) and prints one line
   (`status`, `turns`, `last_dragon`, `elapsed`). On `status=running`, call `wait` again; `done` prints `graded` and the
   attestation path; `failed` prints the dispatch `code` and exits non-zero. Do not use `run_in_background`, `&` or
   `sleep` to wait for a dispatch. A dispatch without `--detach` runs as before.

## Continuation on Claude Code

```bash
teamqa continuation register --run <id> --session <claude-session-id> --registry <abs-registry>
teamqa continuation unregister --session <claude-session-id> --registry <abs-registry>   # when the run ends or its binding drifted
teamqa continuation stage-hooks --host claude --registry <abs-registry> --out <claude-hooks.json>
```

- With a CLI-seat roster (no `native_host`), `register` accepts only the Claude root session that holds the
  verified roster approval line. A Codex roster with only CLI seats is still rejected, as before.
- `--host claude` generates a `{"hooks": …}` fragment to merge into the project's `.claude/settings.json`:
  `PreToolUse`/`PostToolUse` (matcher `Bash|mcp__.*`), `Stop`, `SubagentStop`. Claude Code has no
  `Interrupt` hook; when the user stops the turn, Stop does not run.
- Stop uses Claude Code's exact `{decision:"block", reason}` output. When the input has no
  `last_assistant_message`, the hook reads the last assistant message from the tail of the original transcript (a read error
  does not break the hook). Each WAIT code gets only one automatic correction prompt; a repeated Stop
  (`stop_hook_active`) only reports a `systemMessage`.
- The hook accepts only the registered root session as owner; a subagent transcript does not own the binding.
  A subagent's tool call (Agent tool) carries the root session, so it still goes through the same Dragon/board gates.
- The user must review the fragment before merging it. Without a canary on the real host, report NOT RUN.
- In the Claude Code plugin (`team-qa@agentpro`) the hooks are already on: register without `--registry` (the
  plugin's registry is `~/.agentpro/teamqa/continuation`) and do not stage or merge a fragment; `stage-hooks`
  refuses with `PLUGIN_HOOKS_ACTIVE`.

## Offer a re-run

When a case needs a new round or the next attempt to get an official verdict, the root runs
`teamqa run offer --run <id> --kind round|attempt --cases <id,id> --reason <CODE>` (for example `--reason DISPATCH_UNGRADED`)
and then pastes the line `TEAMQA_OFFER run=<id> round=<n> kind=<round|attempt> next=<n> cases=<ids> reason=<code> sha256=<hash>`
unchanged into the assistant chat, right before the question. The command writes `runs/<id>/control/offers/<n>.json` (the hash in the marker is the hash of that
file) and rejects cases outside the tracked plan, cases that have used all 3 tries (`RUN_OFFER_ATTEMPTS_EXHAUSTED`), a run out of budget, and a run that is already
COMPLETE (`RUN_OFFER_COMPLETE`). The marker only makes the question machine-readable: a new round still goes through roster and plan approval; to change
the target, roster or plan, ask in words and do not use the marker.

## Board delivery on Claude Code

Codex Space does not exist on Claude Code. Deliver the board with `teamqa board publish --to notion` when a Notion MCP
connection is available (claude.ai Notion connector or `claude mcp add`), otherwise `--to html`. The root makes each
planned Notion call itself with `board-notion/next-input.json` unchanged and runs `teamqa board publish-next` after it;
the plugin hook admits only that call and records its result, and `publish-next` also finds the result in the root's
original transcript. Lock `board_notion` and `board_quality` as `publish-next` prints them. Never create a Notion
page, database, Doc or Drive file for the board yourself: the hook refuses it in a registered run and the report lists
it as written outside Team QA.

## Board review on Claude Code

A Codex root spawns a native reviewer. A Claude Code root uses the dispatch route below; the receipt still goes through the exact
`board-quality` verifier and is used for `teamqa board render --quality-review` as on Codex.

1. Get the prepare command verbatim:
   `node <team-qa>/scripts/board-quality.mjs recipe --file <canonical board> --out-dir <new review folder>
   --parent-source <root transcript> --author-source <root transcript> --task-name board_review --model <model> --effort <effort>`.
   When `--parent-source` is a Claude transcript, `recipe` prints a shell command. Run exactly that command with Bash: do not add
   `cd`, variables, pipes or background runs. The output has `TEAMQA_NATIVE_PREPARED sha256=…` and `dispatch_command`.
2. Run `dispatch_command` verbatim with Bash. The command launches an independent `claude -p` reviewer: no tools,
   no settings, no MCP; the packet and the facts are in the prompt. The output has
   `TEAMQA_BOARD_REVIEW_DISPATCHED intent=… session=… child=<reviewer transcript>`.
3. `node <team-qa>/scripts/board-quality.mjs attest --intent <review folder>/intent.json --child-source <child> --out <receipt>`.

The verifier checks: the two original Bash commands (prepare, then dispatch) in the root transcript match verbatim and in the right order;
the dispatch receipt and the reviewer's stream; the reviewer's original transcript has a first message holding exactly the locked message;
the observed model and effort match the intent; the reviewer used no tools and has a session different from the root; after that come the same
board content checks as qa-gui. The reviewer model is a Claude model in the catalog; effort is low, medium, high, xhigh or max.

Unattended run (`TEAMQA_RUN_MODE=unattended` at `roster.mjs select` time, shown in the roster table and fixed for
the whole run; changing this variable after approval makes the next command fail with `RUN_MODE_DRIFT`): after 3 board fix rounds with evidence where
the review is still not PASS, the root does not ask the user. Run `teamqa board deliver-blocked --run <id> --reviews <r1,r2,r3>` (the
review receipts already `attest`ed, the last receipt being for the locked canonical board): the command re-checks each receipt, writes
`runs/<id>/control/board-delivery.json`, and from then on the board is not handed over or published (no `render`, `prepare`, `sync
--mode push`, `write-request`). `run transition --to COMPLETE` accepts this record in place of a published board (every case still
needs a verdict), `report build` has a "Board not handed over" section listing the open review points, and `receipt create` writes
`board_delivery: "blocked"`. GO/NO_GO still follows only the exit criteria of the signed plan. Interactive mode (the default) stays as in
1.13.1: `deliver-blocked` is rejected (`BOARD_DELIVERY_INTERACTIVE`) and the root asks the user.

## Deployed build (web) lane

This route is for a target that has only a running build (no source repo), for example a Vite SPA. The target is a
`deployed-build` with identity proof from the root transcript; a graded verdict comes only from the QA GUI receipt
`qa-gui/receipt/web-v1`. Every command runs with the folder that holds `runs/` as cwd and prints exactly one result
line: `web identity …` and `preflight build` print JSON even on error (`ok:false`, `code`); `web requirements`,
`web bind`, `web record` print JSON on success and `verdict=fail|ungraded <CODE>` on error; the exit code is non-zero on error.
A command that writes an artifact never overwrites different bytes (`WEB_ARTIFACT_EXISTS`, `WEB_IDENTITY_*_EXISTS`); running it again
with the same bytes succeeds. `preflight.json` is the exception: it may only be replaced by a version that passed the verifier, and the old version is kept
in `runs/<id>/archive/`.

**Environment**

- Do not set `TEAMQA_TARGET_PROJECT_ID`, `TEAMQA_TARGET_PREVIEW_URL`, `TEAMQA_TARGET_VERSION` or any
  `TEAMQA_TARGET_*` variable: they can declare only a Git target, force a Git lock and break the web run with
  `TARGET_BINDING_KIND_MISMATCH`; the `web …` commands refuse with `WEB_TARGET_ENV_SET`.
- `TEAMQA_ROLES`: an absolute, writable path **outside** the package folder, for example
  `<workspace>/.teamqa/roles.json`, set from the start of the session for every command. Run `teamqa web overlay` once to write
  an overlay without a target (the content of the package `roles.json`, with mirror adapter paths anchored to the package);
  `web bind` later replaces exactly that file with an overlay that has `target`. If it is not set from the start, then before `web bind`
  use the package `roles.json` as in SKILL.md, and from `web bind` on set the overlay for every command. Do not edit
  the package `roles.json`: `package-tool.mjs verify-runtime` (QA GUI runs this command against Team QA) would fail.
- QA GUI is a local candidate: `TEAMQA_QA_GUI_ROOT=<candidate root>` and `TEAMQA_ALLOW_LOCAL_CANDIDATE=yes`.
  `web requirements` and `web bind` check the graph with the reader of this root itself.
- SCROLL ships with Team QA (`vendor/scroll`); `TEAMQA_SCROLL_ROOT` points at another copy. Node 24 or 26 for preflight.

**Order of steps for the Claude Code root**

1. Choose a `preview_url` that is a page without a client-side redirect, in the form `new URL(u).href`: the SPA moves `/` to
   `/auth` when not logged in, so use a public page such as `http://127.0.0.1:5401/intro`. Log in first
   in the Dragon tab so that the page load calls the backend with 2xx (`backend_origin` is the bare origin, for example
   `http://127.0.0.1:5411`); the tab URL must equal `preview_url` byte for byte. Every Dragon command of the root goes through
   `mcp__Dragon_Browser__dragon_rpc`, one command at a time, never in parallel.
2. Scout read: `session.create` (log in if needed) → `openTab` on the exact `preview_url` → `getPageIdentity` and
   `getTabInfo` on that tab. Then `teamqa web identity draft --run <id> [--round <n>] --project-id <p>
   --environment Local --preview-url <url> --backend-origin <origin>`: the command takes the latest page read/`getTabInfo` pair
   of the exact `preview_url` in the root transcript, writes `runs/<id>/identity/target.draft.json` and prints
   the line `TEAMQA_IDENTITY_PREFLIGHT run=<id> round=<n> target=<target_binding_sha256>`.
3. Put that marker line unchanged into the assistant chat text (an echo through Bash does not count).
4. Reload the tab (so that the app calls the backend), then three Dragon commands of the root, in this order, with the same
   `sessionId/nonce/browserInstanceId/tabId`, the whole set within 5 minutes: `getPageIdentity`
   `{sessionId,nonce,browserInstanceId,tabId}` → `getNetwork` `{…,tabId,summary:true}` (no `failedOnly`)
   → `getTabInfo` `{…,tabId}`. These must be the last three page reads after the marker (`WEB_IDENTITY_SEQUENCE`).
   `getPageIdentity` (Dragon ≥ 1.6.9, see `scripts/requirements.json`) returns the page digest and its `<script>`/`<link>` tags instead of the full HTML;
   `summary:true` returns the request count per origin instead of the whole list. The verifier builds the identity and checks it exactly as with the
   old sequence `getPageHtml {…,maxLength}` → `getNetwork {…,maxBytes≤200000}`; the old sequence is still accepted (a mixed pair too). With the
   old sequence, the results must be intact in the transcript: not truncated (`maxLength` large enough for the whole page;
   `MAX_MCP_OUTPUT_TOKENS` high enough). A large result that Claude Code 2.1.311 moves out to a file (`<persisted-output>` in the
   message) is still usable, because the same transcript line keeps the original blocks in `toolUseResult`; the ref is read from there and the
   line hash still binds it.
5. `teamqa web identity prove --run <id> [--round <n>]` writes `runs/<id>/identity/proof.json` and
   `runs/<id>/identity/target.json` (a 10-field target), after the draft has passed
   `readDeployedIdentityObservation` and `assertDeployedIdentityProof`.
6. Roster: `roster.mjs collect --provider anthropic --harness claude …` → `roster.mjs select --catalog <catalog>
   --request <request> --target runs/<id>/identity/target.json --out <candidate>`. `--target` embeds the exact bytes of
   the proven target (see [roster](roster-and-reasoning.md)); the run_id/round of the request must equal the identity marker.
   A web roster has exactly five roles, with no `executor_code`.
7. Basic preflight: chat marker `TEAMQA_PREFLIGHT run=<id> round=<n> roster=<sha256 of the candidate file>` → Bash
   `curl --fail --silent http://127.0.0.1:9233/status` (when `TEAMQA_DRAGON_STATUS_URL` has a value, for example the separate Dragon of
   a measurement setup, call `curl --fail --silent "$TEAMQA_DRAGON_STATUS_URL"`) → `session.create` (a new `sessionId`,
   `forbidSyntheticDOM:false`) → `openTab` (`url` = `preview_url`, `active:false`) → `getPageIdentity` →
   `getNetwork {summary:true}` → `getTabInfo` → `screenshot` on the same session/tab →
   `teamqa preflight build --run <id> --stage basic --roster <candidate>` (details in
   [chat and preflight](chat-and-preflight.md)).
8. Roster approval: `roster.mjs show --file <candidate>`, paste the output unchanged into the chat, the user types “Approve”, write
   a `team-qa/roster-user-event/v1` event that points to that user line, then `roster.mjs approve --run-dir runs/<id>
   --file <candidate> --user-event <event>`. From here on, all evidence must come from the same approved root session;
   choosing the roster again voids the old markers and refs.
9. Test Manager and Analyst as in a normal run; the plan declares `preflight:{code:false,gui:true,recording}`.
10. Plan preflight: marker → the GUI sequence of step 7 plus `screenshot` (the `savedTo` file is a PNG image) →
    `teamqa preflight build --run <id> --stage plan --image <png> [--video <mp4>]` → `teamqa run show-plan
    --run <id>` and paste the output unchanged into the chat.
11. Plan approval: the user types “Approve” → `teamqa gate approve --run <id> --plan runs/<id>/test-plan.md --signed-by
    owner --user-event <plan-user-event.json>`.
12. DESIGN: the Designer writes tracked plan v2 with every case `lane:"gui"`, `design validate`, `rtm build`, a board
    revision with cases, `run lock-docs` locking at least `source`, `plan`, `tracked`. This board revision is the canonical
    board that `web collect` writes into and that the QA GUI gate reads: create it with QA GUI's `teamwork init` with
    `--run-uuid <a new UUID>`, `--target-binding-sha256 <target_binding_sha256 in runs/<id>/identity/target.json>` and
    `--evidence-policy 1` (QA GUI evidence policy v1: the gate checks every screenshot and recording; `web collect` also sets it),
    then pass exactly that UUID to `--run-uuid` in step 14. A board that carries a `runUuid` different from the binding is rejected by `web collect`
    (`WEB_COLLECT_BOARD_RUN_UUID`) and the gate reports `TEAMQA_WEB_TARGET_MISMATCH`.
13. `teamqa web requirements --run <id> [--allowed-types <a,b>] [--threshold <n>]` writes
    `runs/<id>/requirements.web.json` and prints `requirements_hash`.
14. `TEAMQA_ROLES=<overlay> teamqa web bind --run <id> --requirements runs/<id>/requirements.web.json [--run-uuid <uuid>]`
    writes `runs/<id>/binding.json` and the overlay (the package `roles.json` + the roster `target`), runs
    `assertWebBinding` with the proof and `assertGovernedRelease`, and prints `binding_sha256`, `requirements_hash`,
    `roles_overlay`. Steps 13–14 run in DESIGN, before step 15 and before `run transition --to EXECUTE`.
15. `teamqa board seed --run <id> --tracked runs/<id>/tracked-plan.json --file runs/<id>/board.jsonl`.
16. `teamqa run transition --run <id> --to EXECUTE`. For a deployed target, the command refuses while there is no
    valid `binding.json` (`WEB_BINDING_REQUIRED`, `WEB_BINDING_INVALID`): a run that has entered EXECUTE cannot go back.
17. Per-case dispatch (`--case-id`, step 18) does not need to read the identity again before each dispatch: the plan preflight of step 10 is enough,
    because the Executor itself reads the identity on its own tab (see [evidence draft](executor-evidence.md)) and Team QA checks
    that sequence in the Executor's stream when it binds the attestation, and again everywhere the attestation is used, with exactly the
    checks of the execute preflight: the tab opens the exact `preview_url` on the Dragon session that the Executor created itself, `getPageIdentity` (or
    `getPageHtml`) → `getNetwork` → `getTabInfo` are the first three reads on that tab (or the `identity` triple Dragon made inside
    `openTab {proveIdentity:true}`, each read timed inside that call) and come before any `screenshot`, on the same
    session/tab, within 300 seconds, there is a 2xx/3xx request to `backend_origin`, and the build with the same `asset_manifest_sha256` equals the
    target. Otherwise the dispatch binds no attestation, and the case is recorded ungraded with the code of the failed check
    (`PREFLIGHT_WEB_CURRENT_BUILD`, `PREFLIGHT_WEB_BACKEND_OBSERVATION`, `PREFLIGHT_WEB_EXECUTOR_IDENTITY_SEQUENCE`,
    `PREFLIGHT_WEB_EXECUTOR_IDENTITY_ORDER`, …). A dispatch that is not per case stays as before: within the 5-minute window before each dispatch,
    paste the `TEAMQA_PREFLIGHT …` marker again, reload the tab (same session/tab), call `getPageIdentity` → `getNetwork
    {summary:true}` → `getTabInfo` → `screenshot` again → `teamqa preflight build --run <id> --stage execute --current` →
    dispatch before the `fresh_until` printed in the result.
18. `roster.mjs dispatch --run-dir runs/<id> --role executor_gui --case-id <case_id> --prompt <prompt> --out <attestation> --detach`
    then `roster.mjs wait --run-dir runs/<id> --attempt <attempt>` until `status` is `done` or `failed` (section
    Worker, step 5): each dispatch runs exactly one case of the locked tracked plan. Each case gets at most 3 dispatches, and the whole run at most the number of cases × 3; a
    refused dispatch (`DISPATCH_CASE_ATTEMPTS_EXHAUSTED`, `DISPATCH_CASE_BUDGET_EXHAUSTED`, `DISPATCH_CASE_NOT_IN_PLAN`) does not run a worker.
    The first bound dispatch of the run is in `role-bindings/executor_gui.json`, later ones in
    `role-bindings/executor_gui/attempt-<n>.json` (attestation v2 chains its hash to the previous one). `--out` is the attestation file
    of the dispatch, placed outside `role-bindings/` (for example `runs/<id>/attestations/executor_gui-<case_id>-<n>.json`):
    `role-bindings/` is where Team QA binds attestations itself, so an `--out` in it is rejected (`DISPATCH_OUTPUT_IS_BINDING`). Without `--case-id`, as before:
    the CLI route writes one `role-bindings/executor_gui.json` per run/round. `--inputs <folder>` copies the files the executor needs
    to read (at most 200 files, 32 MB, no symlinks) into `dispatch/executor_gui/<attempt>/inputs/` in the run and lists the
    paths in the prompt; do not point the executor at files outside the run. The prompt does not pin a Dragon `sessionId` reused across
    dispatches (Dragon returns `POLICY_LOCKED` for a name already used). A per-case dispatch includes the
    [evidence draft](executor-evidence.md) contract: the executor writes no files and ends its turn with `TEAMQA_EVIDENCE_DRAFT v1`.
    After that, `teamqa web collect --run <id> --attestation <attestation> --board <canonical board>` builds the images, video, state
    receipts, manifest, vision and the case on the board from the exact stream bound to the attestation; the root does not write receipts itself.
    Through QA GUI's evidence tools it fits each screenshot to at most 1,280 px, binds it to its capture, builds the recording manifest
    from the Dragon recording folder and turns on `evidencePolicy` (QA GUI not found: `WEB_COLLECT_QA_GUI_EVIDENCE_UNAVAILABLE`);
    a case whose evidence QA GUI rejects is UNGRADED with the `EVIDENCE_*` code in `issues`, and is dispatched again. When
    `docs-lock.json` pins that board, the command re-locks the new revision itself (`relocked` in the result, the old lock goes to `archive/`),
    so there is no need to run `run lock-docs` again before the gate. QA GUI accepts only a
    `claude-stream` attestation on a web receipt under the rule `qa-gui/claude-stream-dragon-route/v1`: the executor's stream has
    at least one successful `mcp__<dragon server>__dragon_rpc` (a utility tool such as `mcp__Dragon_Browser__listTabs`
    does not count), Dragon is the only MCP server and is connected, and no Bash command or tool drives a browser
    other than Dragon (playwright, puppeteer, selenium, chromium, `--headless`, CDP, `:9222`, `osascript`, `open`,
    WebFetch, Task, Agent are all rejected, whether they ran or were blocked). The dispatch prompt must therefore require the executor
    to do every browser action through `mcp__Dragon_Browser__dragon_rpc` and to use no other browser tool or
    command.
19. QA GUI receipt. With per-case dispatch, run qa-gate for each case in turn with that case's own attestation and
    `--case <case_id>`, then `web record` that case right after (qa-gate overwrites the receipt file on each run). A per-case receipt records
    `teamqa_provenance.case_id`; every state receipt of the case must carry the `dragon.sessionId` that the Executor of that case used
    (`TEAMQA_CASE_EVIDENCE_SESSION_FOREIGN`). Command: `node <qa-gui>/scripts/qa-gate.mjs <canonical board> --web-binding runs/<id>/binding.json
    --run-dir runs/<id> --plan runs/<id>/tracked-plan.json --requirements runs/<id>/requirements.web.json
    --evidence-root runs/<id> --teamqa-attestation runs/<id>/role-bindings/executor_gui.json
    --teamqa-runtime <team-qa>` writes `.teamcode/runs/<run_uuid>/receipts/qa-gui.receipt.json`. `<team-qa>` is
    the installed Team QA folder the root is running (the folder that holds the `scripts/teamqa.mjs` being called); without this flag the gate
    uses `~/.agents/skills/team-qa`.
20. Each case (per-case receipt: the case verdict comes from that case's own atomic rows, so another case's FAIL does not block this case;
    another case's receipt is rejected with `CHILD_RECEIPT_CASE_SCOPE`): `teamqa web record --run <id> --case <case_id> --receipt <qa-gui receipt> --function <v> --ui <v>
    --started-at <iso> --ended-at <iso> --timeout-ms <n> --out runs/<id>/records/<case_id>.json` →
    `teamqa board add --file runs/<id>/board.jsonl --record runs/<id>/records/<case_id>.json`.
21. COMPLETE: `rtm fill`, board review/publication as in a normal run, `run transition --to COMPLETE`, then
    `teamqa report build --run <id>` and `teamqa report verify --run <id>`.
22. `teamqa receipt create --run <id> --binding runs/<id>/binding.json --out runs/<id>/team-qa.receipt.json` →
    `teamqa receipt verify --file runs/<id>/team-qa.receipt.json`.
23. Optional: `teamqa handoff create --receipt runs/<id>/team-qa.receipt.json --producer-commit <sha> --out
    runs/<id>/team-qa.handoff.json` (no `--capsule`; a web handoff is not bound to a Job Capsule) →
    `teamqa handoff verify --file runs/<id>/team-qa.handoff.json --receipt runs/<id>/team-qa.receipt.json`.
    The Team-code ack does not apply to a web handoff.

**The `requirements.freeze/web-v1` graph built by `web requirements`**

The source is the signed plan and the tracked plan v2 locked in `docs-lock.json` (exactly the files `runs/<id>/test-plan.md`,
`runs/<id>/tracked-plan.json`, with the same SHA-256), the locked source manifest and the approved roster. A case that is not
`gui` is rejected (`WEB_CASE_LANE_NOT_GUI`). One requirement per `req_id` that has a case, in the tier order
of the plan; a tier without a case stays outside the graph (QA GUI needs non-empty `acceptance_ids`) and is printed in
`uncovered_requirements`; the RTM/report still show that gap.

| Field | Value | Reason |
|---|---|---|
| `source_revision` | `version` of the locked source manifest (`team-qa/source-manifest/v1`) | QA GUI: the document/source version name when there is no repo |
| `target_binding_sha256` | `roster.target.target_binding_sha256` | must equal the binding (`WEB_GRAPH_TARGET_BINDING_MISMATCH`) |
| `gate_policy.coverage_threshold` | `--threshold`, default: the plan's highest threshold for the tiers present in the graph (`coverage_high_pct` for FULL, `coverage_low_pct` for SMOKE) | signed exit criteria |
| `gate_policy.required_layers` | `["gui"]` | the only one QA GUI web accepts |
| `id`, `acceptance_ids` | `req_id`; every case of the requirement in tracked order | QA GUI requires every case to be in `acceptance_ids` |
| `expectation` | `<case_id>: <expected>` of the cases, joined with newlines | describes the expectations the Designer locked |
| `requirement_owner` | the plan's `app` | the plan declares no human owner; the app owns the requirement |
| `verification_lane` | `gui` | web has only the GUI lane |
| `risk_dimensions` | `["live-projection-cache"]` when a case has `data.settling.required:true`, otherwise `[]` | QA GUI requires exactly this dimension for dwell; `stable-identity`/`ordered-setup` require extra assertions, so only when the plan declares them explicitly (no field yet) |
| `evidence_contract.allowed_types` | `--allowed-types`, default `gui-screenshot` plus `gui-recording` when the plan has `recording:true` | PASS needs a `gui-*` type |
| `evidence_contract.atomic` / `multi_evidence` | `true` / `false` | atomic is required; one lane, so no multi-lane evidence |

**`web bind` and `web record`**

- `web overlay` writes an overlay without a target into `$TEAMQA_ROLES` (same path conditions as `web bind`); running it again
  gives `unchanged`, and after `web bind` it gives `bound`.
- `web bind` accepts only a graph inside the run, read through QA GUI's reader (or an equivalent local check), that
  matches the tracked plan; `run_uuid` comes from `--run-uuid`, the old binding, or a new UUID. The overlay keeps
  the package `roles.json` unchanged and adds `target` last (it replaces the target-less overlay written by `web overlay`; a different file is
  rejected with `WEB_ARTIFACT_EXISTS`); relative mirror adapter paths are anchored to the
  package, because a relative adapter resolves against the folder that holds the roles file. It rejects a missing `TEAMQA_ROLES`
  (`WEB_ROLES_REQUIRED`), a relative one (`WEB_ROLES_RELATIVE`), or one that points into the package, including through a symlink
  (`WEB_ROLES_INSIDE_PACKAGE`).
- `web record` copies the QA GUI receipt to `runs/<id>/evidence/qa-gui/<sha256>.receipt.json` (qa-gate overwrites the
  `.teamcode` path on the next run), takes the child verdict from the receipt's `semantic_verdict`, the case verdict
  from `--function`/`--ui`, the next attempt from the board, `ts` from `--ended-at`, then runs exactly the checks
  of `board add` first and stops with their codes instead of letting `board add` downgrade the verdict to `ungraded`.
  `semantic_verdict` is the verdict of the whole QA GUI board: a `pass` case is accepted only from a PASS receipt, a `fail` case needs a
  FAIL receipt with a FAIL row for that case (`lib/child-verdict.mjs`); when the board already has a FAIL case, another case
  cannot record `pass` from that receipt (`CHILD_VERDICT_CONFLICT`). An ungraded attempt is recorded with
  `--function ungraded --ui ungraded` (reason `QA_GUI_UNGRADED`), and the next attempt then points `parent_attempt_id` at it by itself.

## Limits of this release

- Workers run through `claude -p`; the native Agent tool is not yet an official route because the exact
  effort cannot be pinned per spawn.
- Native GUI on Claude (QA GUI's trajectory parser) does not exist yet; GUI uses the CLI worker with
  the locked Dragon `--mcp-config` and the flags in the Worker section, step 4.
- The Space board is a Codex connector; on Claude, use the order Notion → Doc-Colab.
