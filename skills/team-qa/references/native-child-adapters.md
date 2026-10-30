# Native Codex for the QA roles

The native catalog uses the original host log and the model cache; it does not call Codex CLI or MIXER to choose models.
The five LLM roles can choose `codex-native`, but a model listing does not prove entitlement or quota.
The roster must show the table unchanged in the chat, and the user approves it before the intent is created. Declare `caps.max_turns:1`;
the timeout is checked only by the observed time, not by a host timeout or a separate sandbox.

## TM, Analyst, Designer

`prepare-native` creates a packet that holds the exact context and prompt; the agent then reads the facts separately.
The first tool call is the literal read printed in `spawn.message`; the output-raising pragma is used only on
the packet read. The facts read adds no pragma. No helper or other tool is accepted.
The final response is at most 140 whitespace-separated words; the machine checks the cap after execution.
Prepare adds the exact facts-read recipe to the effective prompt itself before hashing and locking the packet;
the operator does not need to copy the path again. An old intent is still checked against its locked packet/hash.

## Code

Native Code uses QA Code 1.8.0 or a newer version with the same interface, not an arbitrary review prompt:

```bash
node <team-qa>/scripts/roster.mjs code-proof --run-dir <run> --repo <repo> --base <SHA> --head <SHA> --coder <identity.json> --out <proof.json>
bash <qa-code>/scripts/qa-run.sh --repo <repo> --base <SHA> --head <SHA> --mode static --gate0 <gate0.json> --receipt <run/qa-code.receipt.json> --engine codex-native --provider-model <exact-model> --reasoning <exact-effort> --teamqa-proof <proof.json> --teamqa-runtime <team-qa> --native-prepare <run/native-dispatch/executor_code.json>
```

Call `collaboration.spawn_agent` with the exact `intent.spawn`; the prepare output must come from one
completed exec call, never merged from several outputs. After the child finishes, create a
`team-qa/native-evidence/v1` descriptor with the intent path/hash, the original prepare/spawn source and the child rollout.
Run the same QA Code command again, replacing `--native-prepare` with `--native-execution <descriptor>`.
QA Code checks Gate0, a prompt built from the real diff, the repo snapshot, an independent reviewer and the verdict schema;
Team QA reads the original source back before bind/intake. `stage:sealed` only checks the locks on replay and
grants no dispatch permission; the prepare/finalize entrypoints must still go through the phase/preflight gate.

Native Code currently grades only static: PASS-STATIC does not prove test execution of the product.
Place run/Gate0/artifacts outside the target repo or in a path Git already ignores; creating artifacts
in the target repo can change the snapshot and is blocked. Do not drop files from the snapshot yourself.
The verdict JSON follows the QA Code schema; the 140-word prose cap does not apply.

## GUI

QA GUI 2.14.0 provides the shared semantic checker and request inspector; QA Code provides the shared original host parser.
After GUI preflight passes and the plan is signed, create a `qa-gui/native-policy/v1` policy per the
QA GUI schema, locking the target URL + full Git SHA, the preflight sessionId/nonce/browserInstanceId/tabId,
the allowed Dragon tools, methods, read strings, max_calls and the signed recording scope.

```bash
node <team-qa>/scripts/roster.mjs prepare-native --run-dir <run> --role executor_gui --prompt <prompt.md> --facts <facts.md> --gui-policy <policy.json> --out <intent.json>
```

The two packet/facts reads are still required; only after them may the agent call `dragon_rpc` directly or a literal
wrapper `text(await tools.mcp__Dragon_Browser__dragon_rpc({...}));`. The policy uses the exact namespace/name
observed in the host's tools. The only helper is the canonical `qa-gui/scripts/qa_do.mjs`, with a locked
path/hash and an exact command; the `do` helper is not accepted because it does not keep a full receipt.

GUI uses the tab opened in preflight; the adapter grants no arbitrary navigation/tools. The machine checks source pairs,
timestamps, session binding, trusted input, nested operation results, screenshot privacy and
recording/delivery when the scope is behavioral. Final ≤140 words; product verdicts/artifacts still follow
QA GUI. The attestation has the policy/hash and semantic verification; the child checks again through Team QA
and never trusts a self-declared PASS flag. A trajectory PASS does not replace Function/UI acceptance or video review.

## Runtime and resume

Lock the parent origin version in the roster; after spawn, read the actual child creation version from
the original child metadata and the latest turn_context before the original parent spawn. The two versions
can differ after a Codex upgrade. The runtime receipt records the child version and the parent origin separately;
both are matched again against the source hash. Never infer the child version as the current parent version.
A missing epoch, wrong model/effort/context, a facts pragma, multi-output or a tool outside the policy is
UNGRADED. When native lacks a capability, keep BLOCKED; to change the route, show a new roster and get it approved.

`close-native` keeps a finished attempt that does not qualify for attestation under the type
`rejected_execution`, with all parser/trajectory errors and the hash of the original transcript. It accepts only the set of
execution errors listed in the dispatcher; a wrong identity, prepare, packet, hash, cap or an invalid terminal
state is still blocked. A parent correction can be closed only when there is still exactly one task/turn with the same
parent/recipient. A closure creates no attestation or product verdict; a retry uses the old chain and
keeps the limit of three attempts for the same case.
An added correction message still makes the attestation rejected; the closure only records that the execution was
rejected, and never treats several messages in one turn as a valid execution.
A GUI request with a wrong envelope can be closed only when one literal Dragon call matches the original host output through
`call_id`, the output has `client_authored:false` and exactly the PreToolUse error `DRAGON_REQUEST_INVALID`.
The dispatcher checks the locked session, facts and identity, stores separate hashes of request/output, then
replays the whole proof; a session/capability error without this denial is still blocked. A new GUI prompt
states that the RPC uses nested `method` and `params` before the prompt hash is computed; an old intent stays valid.

## CI dependency access

CI fetches the exact pinned commits of the two private repos with two read-only deploy keys, each key bound to
one repo: `QA_CODE_READ_DEPLOY_KEY` and `QA_GUI_READ_DEPLOY_KEY` in Team QA's Actions secrets.
This workflow needs no PAT. A missing key, or GitHub host keys that cannot be downloaded over HTTPS,
stops the job before the clone; SSH must verify the host, use only the key of the matching repo and use no
agent forwarding. The key is written into the job folder with mode 600 and never goes into Git arguments/logs.
This CI permission does not replace the run's roster/preflight gates and is not needed for native QA on a local machine.
