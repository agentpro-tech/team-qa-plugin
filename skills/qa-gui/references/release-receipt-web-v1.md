# QA GUI deployed-build receipt web-v1

This lane is for a signed Team QA plan with `preflight.code=false` and
`preflight.gui=true`. It binds GUI observations to the observed frontend
build, not to a product Git commit. The Git-backed `qa-gui/receipt/v2` and its
frozen contract remain unchanged.

Team QA owns the target and original host-source verification. The caller must
supply the verified Team QA `assertWebBinding` callback to:

`readGuiWebContext({ bindingPath, requirementsPath, planPath, runDir, verifyWebBinding })`

The callback must return `{binding,proof}` with proof from original host
call/result refs; a copied run snapshot or boolean claim is insufficient.
`requirementsPath` is a `requirements.freeze/web-v1` graph with exactly
`schema`, `contract_sha256`, `source_revision`, `target_binding_sha256`,
`gate_policy`, and `requirements`. The contract SHA is
`c4961eaa1e1915e567d357fc49d4472d75167c51f388e348e6ac11af790d7d5d`;
`source_revision` names a nonempty document or source version. The target
hash must equal the verified web binding, and the graph hash must equal
`binding.requirements_hash`. `gate_policy.required_layers` is exactly
`["gui"]`, and every requirement uses `verification_lane: "gui"`. Product
Git fields (`repo`, `task_base`, `exact_final_sha`) are forbidden. The
tracked plan must cover each active GUI requirement. This path never
resolves the product repository or interprets the build ID as a commit.

The canonical schema-5/6 board omits `commit`, declares
`targetBindingSha256 = binding.target_binding_sha256`, and sets
`build = target.frontend_build.id`. Its `env` names the signed target
environment. Each evidence manifest metadata entry contains exactly
`run_uuid,target_binding_sha256,case_id,state,captured_at`; each original
state receipt also carries `targetBindingSha256`. Original Dragon session,
action, inner result, screenshot, Function/UI assertions, vision assertions,
and behavioral recording segments remain required by the semantic gate.

Create such a board with
`node scripts/teamwork/cli.mjs init ... --target-binding-sha256 <binding.target_binding_sha256>`
(it refuses `--commit` alongside). A board that declares `targetBindingSha256`
is validated against the deployed-build variant of
`scripts/teamwork/canonical.schema.json`: `targetBindingSha256` replaces
`commit` (a `commit` field is rejected), evidence metadata follows
`$defs/evidenceMetadataWeb`, and a case may carry the `recordingSegments`
(`[{file,startMs,endMs,manifest?}]`, `$defs/recordingSegments`) that the semantic gate
requires for every behavioral case; under `evidencePolicy:{version:1}` each segment names its
recording manifest (`state-receipt-v1.md`), and a Git board may carry segments too. Every other
board is validated exactly as before.

Programmatic grading:

`const result = evaluateGuiWebRun({data,boardPath,evidenceRoot,context});`

The Team QA runtime defaults to the Team QA installed next to this QA GUI (the
suite installer's `~/.agents/skills/team-qa`, or `skills/team-qa` of the Claude
Code plugin); a QA GUI source checkout uses `~/.agents/skills/team-qa`. A packaged Team
QA installed elsewhere, such as a local candidate, is selected with
`runtimeRoot` in `verifyTeamQaGuiAttestation(...)`, or `--teamqa-runtime <dir>`
on `qa-gate.mjs`. QA GUI 2.15 has no separate `localCandidate` parameter or
`verifyTeamQaRuntimeProvenance` export. The selected runtime passes the same
source chain: its `SOURCE.json` must name the canonical Team QA repository, the
commit must exist in the canonical Git repository named by
`~/.agents/skills/team-qa/release-truth.json` with the same
`package-manifest.json` hash, and QA GUI's `package-tool.mjs verify-runtime`
must pass on it. The receipt records the real path as
`teamqa_provenance.runtime_root`; `validateGuiReceipt` and `receipt-verify.mjs`
reopen that runtime. A worktree copy without SOURCE and an actual committed
package remains ungraded.

A receipt may be created only with a verified Team QA executor attestation:

`const teamqa = verifyTeamQaGuiAttestation({attestationPath,runtimeRoot,runUuid:data.runUuid,requirementsHash:context.requirementsHash,targetBindingSha256:context.targetBindingSha256});`

`const receipt = createGuiReceiptWeb({context,data,semanticVerdict:result.verdict,atomicCoverage:result.atomicCoverage,teamqa});`

Only call the creator when `result.receiptEligible` is true and completed
cases exist. Receipt validation reopens the canonical Team QA runtime, signed
run, binding, executor source check below, and original-source preflight. The
resulting schema is `contracts/deployed-build/v1/qa-gui.receipt.schema.json`.

## GUI executor source

The selected Team QA runtime must first pass its own
`assertRunContract({action:"verify-result",role:"executor_gui"})` and
`assertRoleAttestation`. The verified executor attestation then needs one of
these sources:

- `codex-native` (Codex root). `metadata_source.native` carries `gui_policy`
  and a PASS `gui_verification` for the same policy hash; the policy file still
  matches that hash, has schema `qa-gui/native-policy/v2`, target kind
  `deployed-build` and this receipt's `target_binding_sha256`. Team QA has run
  `validateNativeGuiTrajectory` with that policy, so the executor's calls are
  policy-compliant: pinned Dragon tool, session, nonce, browser instance and
  tab; declared capabilities and reads; trusted-input receipts inside the call
  interval; privacy-masked captures; recording delivery; call cap.
- `claude-stream` (Claude Code root; the GUI Executor is a `claude -p` worker
  and the source is its stream-json stdout). Team QA has verified the seat's
  model and effort, context packet, independent session, its pinned
  single-server Dragon `mcp_config` and the QA Code provider parser with
  `allowedMcpServers`. QA GUI then applies rule
  `qa-gui/claude-stream-dragon-route/v1` from
  `scripts/lib/claude-stream-route.mjs`:
  1. The attestation is the graded `executor_gui` attestation of an
     `anthropic` provider on the `claude` harness.
  2. `<run>/roster.json` hashes to `roster_hash`; its target is this deployed
     build; its one `executor_gui` seat pins an `mcp_config` whose bytes still
     match and which holds exactly one server, `dragon` or `Dragon_Browser`.
  3. The stream file is inside the run directory and hashes to
     `source.sha256`.
  4. Every non-empty stream line is a JSON object. A `system/init` event comes
     before any assistant, user or result event. Every init, every result and
     every event with a `session_id` names the attested session.
  5. Every init lists exactly one MCP server, the roster's Dragon server, with
     status `connected`, and no `mcp__` tool of another server.
  6. No tool use (executed or denied, subagent events included) takes a web
     route outside Dragon: an `mcp__` tool of another server, a
     `server_tool_use` or `mcp_tool_use` block, `WebFetch`, `WebSearch`,
     `Task` or `Agent`, or a Bash command that, after quotes and backslashes
     are removed, matches `FOREIGN_BROWSER_COMMAND_PATTERNS` (Playwright,
     Puppeteer, Selenium, WebDriver, Cypress, Chromium, Google Chrome, Firefox,
     Edge, Safari, `--headless`, `--remote-debugging-*`, CDP or port 9222,
     `osascript`, `xdg-open`, or `open` in command position). HTTP clients
     such as `curl` are not browsers and are not matched.
  7. Tool ids are unique and each result follows its call once. There is
     exactly one result event, `subtype:"success"` with `is_error:false`, and
     no assistant or user event after it.
  8. At least one `mcp__<server>__dragon_rpc` call with a string `method` has a
     result that is not an error and decodes to `{ok:true,result:{...}}`
     without `ok:false`, `completed:false`, `human_needed`, `error` or a failed
     `results[]` entry (Team QA's preflight Dragon success rule).

  A pass adds `executor_route: {rule, mcp_server, mcp_config_sha256,
  dragon_rpc_ok}` to `teamqa_provenance`; readback derives it again. This rule
  proves the executor's MCP route only. It gives none of the policy v2
  guarantees above: no pinned Dragon session or tab, capability or read
  allowlist, trusted-input receipt, privacy-mask or recording-delivery check,
  or call cap on the executor's own calls. The Bash rule is lexical; a
  deliberately obfuscated command can evade it. The semantic gate's evidence
  requirements are unchanged.
- Any other source kind fails `TEAMQA_WEB_NATIVE_SOURCE_REQUIRED`.

`claude-stream` failures use stable codes, sometimes followed by `:<detail>`:
`TEAMQA_WEB_CLAUDE_ATTESTATION_SHAPE`, `TEAMQA_WEB_CLAUDE_ROSTER_DRIFT`,
`TEAMQA_WEB_CLAUDE_TARGET_MISMATCH`, `TEAMQA_WEB_CLAUDE_ROUTE_REQUIRED`,
`TEAMQA_WEB_CLAUDE_ROUTE_DRIFT`, `TEAMQA_WEB_CLAUDE_STREAM_DRIFT`,
`TEAMQA_WEB_CLAUDE_STREAM_INVALID`, `TEAMQA_WEB_CLAUDE_STREAM_SESSION`,
`TEAMQA_WEB_CLAUDE_MCP_ROUTE_MISMATCH`,
`TEAMQA_WEB_CLAUDE_DRAGON_NOT_CONNECTED`,
`TEAMQA_WEB_CLAUDE_FOREIGN_BROWSER_ROUTE`,
`TEAMQA_WEB_CLAUDE_STREAM_INCOMPLETE` and
`TEAMQA_WEB_CLAUDE_DRAGON_CALL_REQUIRED`. The gate reports them as UNGRADED;
receipt readback reports them as `TEAMQA_GUI_PROVENANCE_INVALID:<code>`. The
Git-backed `qa-gui/receipt/v2` lane is unchanged.

The CLI accepts the same inputs:

`node scripts/qa-gate.mjs <board.json> --web-binding <run/binding.json> --run-dir <run> --plan <tracked-plan.json> --requirements <REQUIREMENTS.json> --evidence-root <run-root> --teamqa-attestation <run/role-bindings/executor_gui.json> [--teamqa-runtime <verified-runtime>]`

Case-scoped receipt (Team QA case-scoped GUI dispatch). With `--case <case_id>`, `--teamqa-attestation` names the
attestation of that case's own dispatch: `role-bindings/executor_gui.json` for the run's first bound dispatch, or
`role-bindings/executor_gui/attempt-<n>.json` (n ≥ 2) for a later one, which is accepted only with `--case`. The
attestation's `dispatch_case_id` must equal the case (`TEAMQA_GUI_CASE_SCOPE_MISMATCH`), and every state receipt of
the case must name a Dragon `sessionId` the attested executor used in a successful `dragon_rpc` call
(`TEAMQA_CASE_EVIDENCE_SESSION_FOREIGN`, ungraded). The receipt records `teamqa_provenance.case_id` and
`executor_route.dragon_sessions`; Team QA then grades that case from its own `atomic_coverage` rows. Without `--case`
the receipt and its provenance are exactly as before.

Readback uses `verifyGuiWebReceiptBindings(receipt,{context,evidenceRoot})` or:

`node scripts/receipt-verify.mjs --receipt <qa-gui.receipt.json> --web-binding <run/binding.json> --run-dir <run> --plan <tracked-plan.json> --requirements <REQUIREMENTS.json> --evidence-root <run-root>`

A mismatch in target hash, build ID, source proof, original UI evidence, or
recording remains UNGRADED or FAIL and cannot become a product PASS.
