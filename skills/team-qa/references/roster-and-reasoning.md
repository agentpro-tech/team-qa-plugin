# Roster, reasoning and execution evidence

Required addition: [chat and operational preflight](chat-and-preflight.md); the table must be shown unchanged in the chat before the user event; a hash in tool output is not enough.

`roster.json` is the authority for the exact run, round and target. `roles.json` declares the tooling and the child skill
interfaces; `IDENTITY.md` declares the SCROLL role. Aliases in these two files do not choose a model or a fallback.
The role selection policy is in `roster-policy.json`, the role-fit metadata in `model-fit.json`; the runner
and the select tool must use the same policy. Do not embed model IDs in application code.

## Choose and confirm before dispatch

1. **Collect catalog:** collect model/provider, supported effort, tools, role-fit, availability status,
   source/date and the exact harness version/binary. A runtime catalog must still be valid per the policy; a fixture
   source is only for local acceptance and creates no official graded role/receipt. A model listing,
   CLI help or role-fit metadata is not a live model/GUI probe certification.
   The Codex default looks for the executable in PATH and for the copy bundled with ChatGPT on macOS, and picks the copy that matches
   the cached client version. A directly specified binary is never swapped; a catalog with a version mismatch
   is not enough to choose a runtime roster. A matching version still does not prove that the account may use the model.
2. **Select and show:** resolve each role by capability and by the user's direct request; print the whole
   provider/model/effort/harness/tools/permissions/caps/context/target and the exact SHA-256 of the file.
   Keep the bytes unchanged after showing them. A missing capability, or a Test Manager that cannot be resolved, stops the run.
3. **Human event:** the user confirms the exact run/round/roster hash after seeing the roster. For runtime,
   the event must point to a real user line in a host transcript that the verifier supports, with a line hash and
   evidence that the roster/hash was shown before the event; do not write a file that plays the user yourself.
4. **Approve:** save the snapshots `runs/<run_id>/roster.json` and
   `runs/<run_id>/control/approvals/roster.json`, and read back the exact hash. The `--signed-by owner` label
   is not a roster approval. A user roster approval also does not replace plan SIGN or write permission.
   The catalog validity applies when the proposal is chosen; it does not expire the user's choice of exact bytes.
   After a long wait, collect/select again to check for changes before dispatch; keep the original roster when the configuration
   has not changed, and when model/effort/context/binary/config/caps change, show and confirm a new proposal.
5. **Dispatch:** re-check approval, context bytes, harness and target before the model call; use the seat's exact
   provider/model/effort/tool route. A timeout, missing metadata or a mismatch becomes ungraded;
   changing a seat needs a new roster confirmed by the user; no automatic fallback.
6. **Documents/phases:** lock source/dossier/plan → PLAN → SIGN with the user event that signs the plan SHA →
   DESIGN with tracked v2/RTM/canonical board/template → EXECUTE with child proof → COMPLETE with
   ledger, evidence, coverage and independent readback. Do not jump phases with a side CLI.
7. **Receipt/handoff:** issue the current record only after the verifier re-checks the whole chain; a historical GO
   does not replace the approval/attestation/docs locks of a new run.

The CLI uses the same selector as the runner; replace the illustrative paths with real files:

```bash
node scripts/roster.mjs collect --provider openai --harness codex-native --host-source <original-host-rollout.jsonl> --out <catalog.json>
node scripts/roster.mjs select --catalog <catalog.json> --request <request.json> --out <roster.candidate.json>
node scripts/roster.mjs show --file <roster.candidate.json>
node scripts/roster.mjs approve --run-dir runs/<run_id> --file <roster.candidate.json> --user-event <roster-user-event.json>
node scripts/roster.mjs check --run-dir runs/<run_id>
node scripts/roster.mjs prepare-native --run-dir runs/<run_id> --role analyst --prompt <analyst-prompt.md> --facts <locked-read-only-file> --out <native-intent.json>
node scripts/roster.mjs attest-native --run-dir runs/<run_id> --intent <native-intent.json> --prepare-source <actual-prepare-output-line.json> --parent-source <actual-spawn-line.json> --child-source <original-child-rollout.jsonl> --out <analyst-attestation.json>
```

Between prepare and attest, the orchestrator reads `spawn` in the intent, then calls `collaboration.spawn_agent`
with exactly those fields; do not run spawn through the shell and do not embed the model in the prompt. Parent-source
points to the exact real function_call line of the tool in the original host rollout and to the hash of that line.
Prepare-source points to the successful output in the same original host rollout, with the marker
`TEAMQA_NATIVE_PREPARED sha256=<intent hash>` before the spawn line; a self-declared timestamp is not enough.
Intent v2 locks the file `native-dispatch/<role>.context.md`, which holds the binding, the exact bytes of
persona/SKILL/interfaces and the prompt. The short spawn payload requires the first tool call to read that file;
the separate facts are a required input. Intake matches the hash of the real stdout from the original child rollout
for the packet before the facts are read or a result is returned. Missing/truncated output, reading the wrong file/order,
context drift or a different tool all stay ungraded. Parent config and child model/effort/session
must still match exactly; when the spawn/task text is encrypted, record explicitly that this text could not be observed, and
certify only that the packet was supplied, through the read output; do not claim that the model understood it. An old full-message intent v1
cannot be upgraded to PASS if the parent message is encrypted.
CLI `dispatch` only uses a roster shown/confirmed with a CLI harness; do not replace a native roster with CLI.

`request.json` uses `team-qa/roster-request/v1`, with run_id, round, scope,
target `{project_id,preview_url,version}`, provider and manager `{provider,model,effort,harness}`.
Deployed build: the target is verbatim `runs/<run_id>/identity/target.json` written by `teamqa web identity prove`
(10 fields, exact key order, because every later copy is compared with `JSON.stringify`). Use
`roster.mjs select … --target runs/<run_id>/identity/target.json` to embed exactly those bytes instead of copying them
by hand; the file must be a canonical target (`ROSTER_TARGET_NOT_CANONICAL`), and a request that already has a different `target` is
rejected (`ROSTER_TARGET_CONFLICT`). The run_id/round of the request must equal the run/round of the identity marker.
Overrides need a separate user event; do not use one exception for a helper or another role. The approve event
uses `team-qa/roster-user-event/v1`, with id, actor=user, text, run_id, round, roster_hash and source
`{path,sha256,line}`. `source.sha256` hashes the exact referenced transcript line. Without a compatible host
event, keep BLOCKED; do not fall back to a fixture to issue an official receipt.

## Default and custom

By default, use one provider for all five LLM roles. If the user explicitly chooses another provider or mixed providers,
record the requested scope and show/confirm the roster again; do not treat a general request as an exception for a hidden helper.
One provider does not mean one model or one session.

| Role | OpenAI example when the catalog confirms | Effort | Session |
|---|---|---|---|
| Test Manager | `gpt-6.1-sol` | medium | separate |
| Analyst | `gpt-6-luna` | high | separate |
| Designer | `gpt-6.1-sol` | medium | separate |
| GUI Executor | `gpt-6.1-sol` | medium | separate |
| Code Executor | `gpt-6.1-sol` | high | separate, independent of the coder |
| Coverage Gate | Node deterministic | not applicable | no LLM call |

The models in the table are examples of the requested policy, not a live catalog or a measured benchmark.
Astra is excluded from the default; the user can directly request an exact model for an exact role/run/round,
but capability, provider policy and roster approval are still required. Quality metadata is not enough
to accept a model that is not available; an error/quota does not allow choosing a silent fallback.

## Harness and actual reasoning

Prefer native Codex in a chat session that has `collaboration.spawn_agent`; Codex CLI and Claude are
separate routes when the native capability does not meet the role, not a requirement for OpenAI.
The supported CLI adapters today are Codex and a compatible Claude; check version, binary hash and flags
before use. The SCROLL runtime label `claude-subagent` in IDENTITY is a descriptor and does not replace the
exact executable/harness in the roster. A SCROLL build that holds a role alias must be resolved by the adapter
to the exact confirmed model before use; do not install/run an alias as a Claude model ID. Do not assume that every native subagent API can pin the model
or prove effort: an API without compatible metadata/interception is not an official route.

| Harness | Effort mapping | Required isolation and evidence |
|---|---|---|
| Native Codex | `spawn_agent` with exact `model`, `reasoning_effort`, `fork_turns: none` | `prepare-native` locks the packet; `attest-native` checks the original prepare/call/result, the child session/model/effort and the hash of the output that read the packet/facts; the tool has no per-role sandbox/timeout flag |
| Codex | `-m <exact-model> -c 'model_reasoning_effort="<effort>"'` | `exec --json --ignore-user-config`; sandbox matching the role, multi_agent off; stdout/stderr source and the actual session/model/effort |
| Claude | `--model <exact-model> --effort <effort>` | `-p --output-format stream-json --verbose`; `--setting-sources ''`, `--strict-mcp-config --mcp-config <locked-config>`, tools and permission mode matching the capability (`--safe-mode --permission-mode plan`; a GUI Executor with a Dragon route uses `--disable-slash-commands --permission-mode default --allowedTools mcp__<server> --add-dir <Dragon output root> --add-dir <the session's tool-results>`, see [Claude Code as root](claude-host.md)); actual source metadata |
| Other harness/MIXER | only when the adapter supports an exact mapping | integration guidance; not live-certified; never treat an engine name as evidence |

Do not use a "think high" prompt instead of the flag. A CLI that does not support exact effort/model, silently inherits
config/helpers or cannot output the actual metadata is blocked/ungraded. The requested argv only proves
that the request was sent; the parser must verify the actual metadata in the hashed source. A Codex source
may need host rollout metadata when the stream/banner lacks effort; only a source the verifier trusts
can supply it, and effort is never taken back from the request. Do not claim a certified live probe just because
a local fixture/CLI help is green. Do not reveal private reasoning content; only the observed configuration is needed.

The native catalog has role-fit for the five LLM roles and does not call a CLI to collect the catalog. Code uses the
canonical QA Code native two-phase static interface; GUI uses the shared original-log parser and the
canonical QA GUI Dragon trajectory checker. Readiness is not a Function/UI PASS. Adapters,
policy and the actual limits are in [native child adapters](native-child-adapters.md).

## Context and independence

Each seat locks the SHA-256 of `agents/<role>/{IDENTITY,SOUL,hard-rules,TOOLS}.md`, `SKILL.md` and
`references/interfaces.md`. Template/source docs need their own phase lock. The runner supplies the exact bytes
to the exact role before dispatch; changing a file after approval causes hash drift, and the roster must be confirmed again.
The hash proves the supplied context; it does not prove understanding or cognitive quality.

The role attestation locks the run/round/roster hash, the role, the actual agent/session IDs, the sent and observed
provider/model/effort/harness version, the context hashes and the stdout/stderr source hashes. The five LLM
roles must have separate sessions and agents; a role alias or a self-generated UUID is not enough to prove independence.
Coverage Gate must not call an LLM by itself, edit a verdict or count ungraded as coverage.

Team QA locks the skill's dispatcher, phase transitions, intake and current records. There is no
host-universal lock that blocks every shell/tool/model API on the machine; do not claim that every host call is
intercepted. Work outside the route may exist but is not accepted as official QA evidence.

The optional adjudicator seat (`adjudicator` in the roster) is independent by family, not only by session: its
provider's model line (`provider_families` in `references/adjudicator-policy.json`) must differ from every executor
seat's, and the roster validator refuses `ADJUDICATOR_SAME_FAMILY`. Its context is the hash of the adjudicator
instructions and policy; it runs through `teamqa adjudicate`, not `roster.mjs dispatch`. Its mode (`shadow`, the
default, or `enforce`) is part of the approved bytes. See [adjudicator contract](adjudicator-contract.md).

## Child interfaces and GUI

QA Code runs through the declared child interface; the executor_code seat is not dispatched directly as a
review prompt that then signs PASS by itself. Create `team-qa/child-dispatch-proof/v1` with the exact repo/base/head,
the coder identity and the roster lock; the child returns a role attestation whose source is the actual provider execution,
with hash/context and an identity different from the coder. The post verifier reads back the real attestation, not only the request.

GUI needs a direct Dragon MCP stdio config hashed in the roster, with only the `dragon` or
`Dragon_Browser` server, exact command/args and no arbitrary helper server. The adapter must isolate
the user config, allow only the declared Dragon tools and block Task/collaboration/helpers outside the roster.
A missing config/capability is blocked before the model call. The qa-gui child keeps its receipt/evidence,
with the GUI role attestation; Team QA intake checks the context, the observed model/effort/session and the source
MCP trajectory. Missing metadata, a forged helper source or a mismatched MCP route never becomes PASS.

A compatible config is a condition to run; it does not prove that the endpoint works. An old/missing route on
the current machine is not live-certified by this change; probe/readback/canary for real per
qa-gui before graded GUI QA. Function and UI are independent; behavioral GUI needs a recording per the contract.
Do not copy the gates or parsers of qa-code/qa-gui into Team QA.

## SIGN, retest and current records

The source manifest locks the exact source refs/version/target; the dossier locks the source hash and the Analyst
attestation. The current SIGN uses a read-back plan user event, bound to the run/round/roster hash/plan SHA;
`--signed-by` is only a historical label. Tracked v2 links the exact source → case; the RTM, the canonical board and
the template must match every edge. A retest needs a selection by impact/change hash and a new fix proof,
and never shrinks the denominator or reuses a PASS from another build. COMPLETE checks child evidence, coverage and
the canonical artifact/Page readback, then the receipt/handoff re-checks the keys.

A legacy utility without a current roster/phase can read, sign or compute a historical report with
`historical_diagnostic=true current_run_graded=false`. The historical calculation can give GO; that output
does not certify the current run. A historical receipt that can still be read does not make the full machine chain of
a new run valid. A current receipt needs provenance/the current verifier; do not use a legacy helper to
get past a gate. Fixture catalogs/attestations are always local diagnostics.

Roster, plan SIGN and release permission are separate permissions. Keep SCROLL approvals, confirmed writes,
the ledger/proof pack and independent readback; do not add a separate approval framework. No Production
write while choosing the roster/during QA without a Production grant for the exact target/action/scope.

## Verified limits

The catalog separates a listed model, a model with a source-reviewed fit whose entitlement is not yet probed, and a new model that is not yet evaluated. A verified fit with `unknown` availability is only proposed as an unprobed candidate; only the runtime source of the later confirmed run certifies the actual configuration. Never promote a new model from a self-declared quality object. An old Claude CLI or an unobservable effort stays BLOCKED/UNGRADED; with Claude, effort is accepted only from the worker's original transcript (see [Claude Code as root](claude-host.md)), never from the `--effort` flag that was sent.

The timeout comes from the caps of the confirmed seat. Claude uses `--max-turns`; the Codex adapter runs one invocation, turns multi-agent off and applies the timeout, and the CLI currently has no equivalent turn-cap flag; do not claim that an internal turn count was enforced when the harness does not support it.

The QA Code standalone installer does not create `release-truth.json`. Team QA matches the parser against the Git
object of the canonical checkout `~/Dev/qa-code` when the runtime does not have that anchor; when an installed anchor exists,
it uses the anchor's repo. Always check the origin URL, the exact commit/manifest and the payload with Team QA's
verifier before import. A candidate must not declare its own repo path as the authority; without the canonical Git
object database it is BLOCKED; the provenance check is never skipped.

Receipt/v2 carries the roster/role/docs provenance, and the handoff locks the exact receipt bytes/verdict. Verification currently needs the producer host with the same original transcript/rollout source and the canonical Git object; a separately copied receipt file is not a portable/offline proof. The locks apply to the skill's controlled entrypoints and do not control every host tool with arbitrary permissions.

## Explicit Dragon catalog input

Native GUI uses the policy `qa-gui/native-policy/v1` with the tools observed in the host and the locked preflight
session; it needs no CLI MCP config. `--mcp-config` is the contract of the CLI route the user
chooses separately; it is not a readiness or entitlement attestation.
