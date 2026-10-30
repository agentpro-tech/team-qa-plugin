# Provider routes — Team QA integration

Last verified: 2026-10-02, source protocol tests only; live LLM certification pending roster approval.

Standalone default remains Grok, with its model read from `provider-defaults.json`. New explicit routes:

```bash
bash scripts/qa-run.sh --repo <repo> --mode tools --gate0 <gate0.json> \
  --base <TASK_BASE> --json <verdict.json> --receipt <receipt.json> \
  --engine codex --provider-model <exact-openai-model-id> --reasoning <effort>

bash scripts/qa-run.sh --repo <repo> --mode tools --gate0 <gate0.json> \
  --base <TASK_BASE> --json <verdict.json> --receipt <receipt.json> \
  --engine claude --provider-model <exact-anthropic-model-id> --reasoning <effort>
```

Codex sends `-m`, explicit `model_reasoning_effort`, read-only sandbox, no multiagent and JSONL output. Claude sends `--model`, `--effort`, stream JSON, restricted read/test tools, no helpers/MCP, noninteractive denied permissions and repository write denial in sandbox settings. Actual enforcement by each CLI/version must be checked during an approved live canary. Missing/unsupported CLI controls fail closed; the source tests do not certify CLI sandbox enforcement.

The harness owns engine identity. A model's final answer cannot supply provider metadata. Logs normalize completed tool events, successful test commands, session identity and provider model/effort metadata. Codex metadata comes from its CLI stderr banner or the original persisted `~/.codex/sessions` rollout bound to the emitted thread ID; Claude `-p` stream-json carries the model but not the reasoning effort; Claude metadata therefore comes from the worker's original transcript `~/.claude/projects/<project>/<session-id>.jsonl`, bound to the session ID emitted by the stream. Exactly one such file must exist; only non-sidechain, non-synthetic assistant turns of that session count, every one must carry the same `model` and non-empty `effort`, and the source seals the first observed line number/hash plus the Claude Code version. A foreign-session line, a nested subagent transcript or a file outside the projects root is rejected. The bounded rollout reader only searches recent original session directories, and seals the exact session_meta and turn_context line numbers/hashes so later appends do not invalidate proof. Independent verification rereads those original line bytes and actual runtime model/effort; caller-supplied text or sent config cannot substitute for observed metadata. If either CLI omits actual model or effort metadata, the result is `UNGRADED`. In particular, a sent `--effort` alone does not prove Claude's effective effort; only the transcript observation does.

Tools mode requires an actual completed successful test event, not a read-only file inspection. Malformed JSONL, unpaired/failed tools, hidden helpers, model/effort drift and missing session metadata are rejected. The direct verdict and receipt validators reread provider source bytes and hashes. Receipt extensions preserve the legacy v1/v2 schemas; new provider runs carry `provider_execution` with separate sent/observed values and stdout/stderr evidence refs. The existing runtime/product-path acceptance rules remain in force.

Same-provider Team QA reviews additionally pass `--teamqa-proof <proof.json>` and optionally `--teamqa-runtime <verified-package>`. The runtime defaults to the Team QA installed next to this QA Code (the suite installer's `~/.agents/skills/team-qa`, or `skills/team-qa` of the Claude Code plugin); a QA Code source checkout uses `~/.agents/skills/team-qa`. Explicit staged runtime packages require Team QA canonical repo identity in `SOURCE.json` and independent manifest/source verification with QA Code's package verifier before importing the official roster verifier. Configuring that package path is a trusted harness decision; users with arbitrary filesystem write access can alter both source and receipts, and this adapter does not claim to prevent every host action.

Team QA `verifyChildDispatchProof(proof,{stage:'pre'|'post',attestation})` independently verifies roster approval, run/round/target/context and frozen proof bytes. Predispatch proof authorizes a logical seat; it cannot manufacture session IDs. After execution, the adapter emits `team-qa/role-attestation/v1` from actual provider session/log metadata; post verification binds the observed session and runtime-derived agent ID and rejects reuse of coder identity. A standalone/Team-code same-provider run is rejected before any provider CLI call. `--engine-cmd` is an injected diagnostic path and cannot become an official provider/Team QA route.

No live model/tool probe was run while implementing these routes. Fixture-binary protocol tests and mutation tests prove code behavior; their results cannot be submitted as official live Team QA evidence.

The shared provider parser accepts `allowedMcpServers` only as an explicit controller argument; its default is empty and QA Code does not expose an override. Team QA GUI may pass its locked direct Dragon MCP server names. Codex checks exact MCP `item.server`, Claude checks exact `mcp__<server>__` prefix, and both retain paired tool status/server receipts. Other servers and Agent/Task/collab/file-write helpers remain rejected. This parser interface does not authorize a model-delegating MCP bridge.

## Native Codex provenance helper

`parseCodexNativeExecution` verifies the original parent spawn call/result and child rollout,
including actual model/effort/version, supplied context and observed elapsed time.
`parseCodexNativeRecords` is a pure fixture parser and always returns
`provenance_verified: false`; callers must require true from the trusted source wrapper.
The current native tool parser accepts only the locked literal read-only file command.
The trusted wrapper also requires `expected.intent_sha256` and
`expected.prepare_source: {path,line,sha256}`. The prepare source must be a hash-bound
original parent `functions.exec` output in the same rollout as `parentSource`, paired
with one preceding exec call and preceding the spawn. Its successful structured
stdout must contain the exact line `TEAMQA_NATIVE_PREPARED sha256=<intent_sha256>`.
This proves the hash was observed in the host log before spawn; editable timestamps
alone do not prove that order. It does not claim universal host enforcement.
The pure records parser uses `expected.prepare_line` and remains unverified.

Facts commands must explicitly disable login, for example:
`text(await tools.exec_command({"cmd":"cat '/absolute/locked-facts.json'","login":false}));`
Shell/environment overrides, omitted login, multiple calls, other JavaScript and
commands outside the locked facts path are rejected.

Packet mode is opt-in with both `expected.context_packet_path` and
`expected.context_packet_sha256` (64 lowercase hex). The packet path is a canonical
absolute path distinct from `facts_path`; packet mode also requires `facts_sha256`.
The controller prepares immutable packet bytes containing the role files, SKILL,
interfaces and prompt, then binds their path/hash into the intent whose hash is
observed in the original prepare marker. `expected.message` is the exact short
pointer supplied to spawn; the four other spawn fields still match exactly.
An encrypted `gAAAA...` spawn message is permitted only in this packet mode.

The child's first tool must be one literal read:
`text(await tools.exec_command({"cmd":"cat '/absolute/locked-context.json'","login":false}));`
Its successful original stdout must hash exactly to `context_packet_sha256` before
any facts tool or final answer. A separate facts read must then match `facts_sha256`.
Only the packet read may prepend the exact first line
`// @exec: {"max_output_tokens": 20000}` followed by one newline, to retain complete
packet output in the functions wrapper. Other values/options/formatting or added
JavaScript are rejected; facts reads remain bare literals. The stdout hash always
checks completeness, even with this fixed output budget.
Wrong/missing packet fields, paths, bytes, order, unsupported calls and followups
remain ungraded. Evidence says encrypted spawn/task text is unobservable and packet
bytes were observed; it does not claim comprehension. The legacy full-message path
still rejects an encrypted parent spawn message. Earlier runs cannot be relabelled
as packet runs. Trusted metadata retains original packet call/output line hashes.

This supports Team QA TM/Analyst bootstrap evidence; it does not certify native Code
execution, tests, GUI/Dragon or per-seat host permissions. Standalone QA Code and its
CLI execution/gates are unchanged.

## Two-phase Codex native adapter (1.8.0)

`qa-run.sh --engine codex-native --mode static --provider-model <exact-id> --reasoning <effort>`
requires `--teamqa-proof` and a canonically verified `--teamqa-runtime`. Choose exactly one:

- `--native-prepare <run>/native-dispatch/executor_code.json`: builds the packet/context/facts from the
  real judge prompt, Gate0, repo, TASK_BASE and child proof; prints the hash marker before the host spawns.
- `--native-execution <team-qa/native-evidence/v1.json>`: reads the original host/child rollouts, rebuilds
  the prompt and the lock, then runs the existing validator/receipt/child post-gate/role binding.

The host calls its own native subagent per the spawn in the intent; the adapter does not dispatch a model through a CLI
or MIXER. Run artifacts must be outside the graded repo or Git-ignored; the status/diff/index snapshot must stay intact between prepare/finalize, with no silent exclusion. One-run lock, really observed model/effort, parent spawn/prepare/turn hashes, the two
packet/facts reads and the timeout; missing evidence returns UNGRADED. Only static is supported, with a PASS-STATIC
ceiling; high-risk and product-path diffs may not be closed through this route. Broken JSON needs a new child,
never a reused rollout or a CLI fallback. `scripts/native-verify.mjs` independently verifies
the intent/evidence through the canonical proof/runtime and the rebuilt prompt, and does not accept an expected value written by the caller.

For a resumed parent, `parent_origin_version` is the original session version; `child_version` is the version
that created the child, observed from the original session_meta. `parent_turn_source {line,sha256,turn_id}` must
anchor to the last turn_context before the spawn in the same original parent. The attestation declares
`runtime.origin_version` separately and the child's `runtime.version`, and does not assert the current version
of the parent. Missing epoch parts must not let a mismatch be skipped to PASS.

The shared parser has an opt-in `trajectory_mode:"qa-gui"` and a `gui_policy` that locks the exact direct Dragon
namespace/name or command/helper path/hash. GUI calls are allowed only after the two locked reads, keep the
original call/output line hashes and timestamps in `gui_calls`; the separate semantic GUI gate is still
required. QA Code does not open this opt-in. The default readonly mode keeps rejecting MCP/helpers.

Current verification: fixtures and mutation tests check the protocol; they do not count as a live model or as
application Function/UI QA. A positive official runtime integration needs the canonical TeamQA native package
and an approved roster; an older installed TeamQA must fail closed.

Trusted original-file parsing requires every custom exec output (including parent prepare) to contain the actual completed header plus exactly one JSON payload. Pure diagnostic record fixtures keep their legacy output shape and remain unverified. The GUI call count is checked again by the shared parser as well as the GUI semantic verifier.
