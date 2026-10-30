# Native Codex GUI adapter

Last verified: 2026-10-15, local positive/negative tests and a real Dragon 1.6.6 local-fixture contract canary; no application QA.

`scripts/lib/native-gui-trajectory.mjs` exports pure validators:

- `nativeGuiPolicyErrors(policy)` returns policy errors without host or file I/O.
- `validateNativeGuiRequest({request,policy,lockedPolicy})` checks a proposed RPC and effective
  session policy before dispatch. It returns `{verdict,errors,requiresLive,mutating,hasTrustedAction,actionClass}`;
  action classes are `read`, `trusted-input`, `capture`, and `recording`.
- `validateNativeGuiTrajectory({calls,policy})` returns `{verdict,errors,summary}` where verdict
  is `PASS` or `UNGRADED`. PASS means trajectory policy compliance, never product acceptance.

The caller must first verify original Codex session provenance, parent prepare/spawn line
hashes, exact model/effort, independent agent/session identity, locked role context, caps,
packet and facts reads through QA Code's `parseCodexNativeExecution` with
`expected.trajectory_mode="qa-gui"`. The resulting `gui_calls` are matched actual call/output
records with `tool`, `namespace`, `input`, `output`, `command`, `call_line`, `call_sha256`,
`output_line`, `output_sha256`, `call_timestamp`, and `output_timestamp`. Trusted action receipt
`ts` must lie within the actual call/output interval with at most one second of clock skew. Calls must be sequential with distinct source lines.

For code mode, issue one RPC per call using `text(await tools.<exact_tool_name>(<JSON>));`.
The argument must be valid JSON with quoted object keys. JavaScript object literals with unquoted
keys, variables, batching, extra statements and pragmas fail the native source parser even when
Dragon executes them successfully. Never evaluate arbitrary wrapper code to recover a request.

Policy schemas are `qa-gui/native-policy/v1` for a Git target and `qa-gui/native-policy/v2` for a deployed build. `dragon.version` is the extension release the receipts carry (`env.build.extVersion`). Any release from `1.6.4` up to, not including, `2.0.0` is accepted, because the Chrome Web Store updates the extension on its own and minor and patch releases keep the receipt contract; a pre-release, a malformed version or the next major fails closed.

The v2 target uses `{url, kind:"deployed-build", target_binding_sha256}`. The 64-character target binding identifies the verified deployed build without representing it as a product Git commit. V1 continues to require `{url, commit}` with a full 40-character Git SHA.

`policy.reads` continues to pin exact JavaScript measurements. Storage access is allowed only as a standalone `localStorage.getItem(<literal string key>)` or `sessionStorage.getItem(<literal string key>)` expression (optionally prefixed by `return`); the exact expression must be declared in the policy. Semicolons, appended code, dynamic keys, bracket access, writes, removals, getters, and clearing remain rejected. This is read access to a declared key, not permission to mutate fixture state.

The request inspector requires the effective Dragon policy to allow trusted pointer and key input,
set `forbidSyntheticDOM:false`, and remain unexpired. It binds the complete request to the pinned
session, nonce, browser instance, tab, capability and exact parameter allowlist. `do` reads must
be declared; null/non-string expressions and nested or unknown `waitFor`, `assert`, or
`expectNet` fields fail closed. This is a narrow Storage expression rule, not a general JavaScript
sandbox: other declared measurement expressions still rely on the existing independent request,
provenance and execution gates.

Required fields are:

| Field | Binding |
|---|---|
| `allowed_tools` | Exact `{namespace,name}` Dragon RPC tool pairs |
| `dragon` | Supported `version` (`1.6.4` ≤ version < `2.0.0`, plain `major.minor.patch`), `sessionId`, `nonce`, `browserInstanceId`, integer `tabId` |
| `target` | V1: exact `url` and full 40-character `commit`; v2: exact `url`, `kind:"deployed-build"`, and 64-character `target_binding_sha256` |
| `capabilities` | Known allowed methods; arbitrary JS/action methods are unsupported |
| `max_calls` | Positive integer cap |
| `helpers` | `{path,sha256}` entries for canonical `scripts/qa_do.mjs` |
| `commands` | Exact `{command,helper,request}` entries; helper `do` is unsupported because it strips raw trusted receipts |
| `reads` | Exact approved measurement-only JavaScript strings |
| `behavioral` | Boolean; true requires recording lifecycle |

Team QA hash-locks the policy at prepare, verifies canonical helper/runtime roots and byte
hashes, and binds target URL/SHA to its frozen roster and execution binding before calling
the checker. Direct RPC `do` is supported with per-step trusted receipts; click input must
explicitly set `fast:false`, either per step or on the macro. Synthetic input, clipboard
paste, unknown parameters/steps and injected action JavaScript fail closed. Captures require
`privacyMasked:true`, mask metadata and `savedTo`; recording requires masked start, trusted
action between start and stop, matching recording id, frame/event counts, cleanup success,
zero capture/ingest/push errors and assembly.

Native proofs also require `metadata_source.native.gui_policy={path,sha256}` and
`gui_verification={verdict:"PASS",policy_sha256}` after independent parent verification.
Old parent native GUI proofs without these fields fail closed. These fields alone never
grant provenance or acceptance; the parent verifier recomputes original evidence first.

The existing `verifyTeamQaGuiAttestation` delegates to the verified Team QA runtime's role
source checker during receipt emission and readback. That checker must run this GUI policy
gate before granting a native executor attestation. A deployed-build run from a Claude Code
root has no native policy: its `claude-stream` GUI executor gets a web-v1 receipt only through
the separate Dragon route rule in `scripts/lib/claude-stream-route.mjs`, which is not policy
compliance (see `release-receipt-web-v1.md`). QA GUI's release-truth plan denominator,
Function/UI recomputation, state and artifact integrity, privacy recording requirements and
original/annotated finding evidence are unchanged. No new public CLI flags are introduced.

Helper commands must exactly invoke `node '<helper.path>' --method '<method>' --params
'<JSON params>' --timeout <timeout>` with proper shell quoting; timeout defaults to 15000 ms
and cannot exceed 35000 ms. Relabelling an arbitrary shell command as a pinned helper fails.

The local contract canary used a new Dragon-owned background session against
`test/fixtures/native-gui-storage-canary/index.html`, read the seeded `before` value with the exact
allowlisted expression, made a real trusted click, read back `after`, captured a privacy-attested
PNG, and recorded/assembled 239 frames. Its receipts report extension `1.6.6`, `gitSha:null`,
`requireTrusted:true`, and `forbidSyntheticDOM:false`. All seven real native request shapes and
the full trajectory pass their validators. Each RPC uses a separate literal code-mode call,
preserving distinct original Codex call/output lines, hashes and UTC intervals. The final run also
uses quoted JSON arguments accepted by the native parser. Earlier batched or unquoted wrappers
remain source-unverified; passing decoded request validators does not repair their provenance.
The canary is a skill-runtime contract check, not application QA. Native source
pairs, screenshot, video and rerunnable validation are preserved in the maintainer's evidence archive
(`dragon-native-canary/dragon-canary-20261015-json-root/`, not shipped).

Synthetic tests are parser/policy fixtures, not product QA. Unresolved product Git SHA and missing
application receipts remain UNGRADED with no finding fabricated.
