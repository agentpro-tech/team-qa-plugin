# Scoped QA continuation

This candidate requires the matching QA GUI native request and case-work interfaces. Keep installed runtimes unchanged until the candidate passes its gates. A staged hook definition is not activation or proof that Codex enforces it.

## Run setup and ownership

From the workspace containing `runs/<id>`, use the verified candidate CLI:

```sh
node <team-qa>/scripts/teamqa.mjs continuation register --run <id> --session <root-session-id> --registry <absolute-registry-directory>
node <team-qa>/scripts/teamqa.mjs continuation inspect --run <id>
node <team-qa>/scripts/teamqa.mjs continuation unregister --session <root-session-id> --registry <absolute-registry-directory>
node <team-qa>/scripts/teamqa.mjs continuation stage-hooks --registry <absolute-registry-directory> --out <candidate-hooks.json>
```

Registration verifies the original Codex host metadata, roster and target. It grants no execution permission. One root session owns one run/round; a new roster or runtime requires a fresh reviewed binding. Unregistered threads pass through without changes. `unregister` disables a registration by moving its binding file to `<registry>/archive/` (it is never deleted); never repoint an active registration to another run.

A binding drifts when its run changes under it: a new round or roster, the run directory deleted, or another Team QA runtime (`CONTINUATION_SCOPE_DRIFT`, `CONTINUATION_RUN_MISSING`, `CONTINUATION_RUNTIME_DRIFT`). The hooks then refuse only Dragon calls and board writes for that session; every other call goes ahead with a warning, and Stop is not continued. `register` again binds the run's current round after verifying the registration again, archiving the drifted binding; a binding that still matches its run is not replaced (`CONTINUATION_ALREADY_REGISTERED`).

A direct native child may inherit that binding only through its original Codex transcript under the trusted sessions directory. Both native parent fields, child identity, direct-child agent path and the registered parent host must agree. It shares the same browser owner and input lock. Child Stop records completion only; it never continues the worker. Unrelated child sessions cannot acquire authority from message text.

For `SubagentStop`, Codex supplies the parent in `transcript_path` and the child in `agent_transcript_path`. Verify both and match `agent_id` to the child; do not label the parent as the completed worker.

Review the complete generated definition before placing it in the project hook configuration. Codex requires the user to trust its exact definition via `/hooks`. Do not edit trust storage or use the trust bypass option. Inventory all project/user/plugin hooks: another Stop handler returning `continue:false` takes precedence. Preserve the former hook configuration for rollback.

Trust inventory alone does not prove activation in an already running turn. Verify a harmless negative request and a permitted positive control through the actual native path, then inspect the original hook events. Diagnose missing invocation separately from unresolved ownership; do not require an application restart without evidence. Hook input names can differ from code-mode aliases: Pages reports `mcp__codex_apps__chatgpt_space__create_page`, while JavaScript exposes `mcp__codex_apps__chatgpt_space_create_page`. The adapter recognizes these exact names and validates the same sealed payload.

## Dragon operations

Use native Dragon MCP within registered runs, including calls nested in code mode. The hook rejects the known shell helper route; it is not an operating-system sandbox for arbitrary shell/network programs. Native enforcement, including nested tool calls, must be demonstrated on the actual host before declaring activation complete.

The registered browser session ID is printed by `register`. Create only that new session with `{sessionId, forbidSyntheticDOM:false}`. The returned receipt must confirm trusted input, nonce and browser instance. Open the locked target URL once with `active:false`. The hook never changes another session's policy. Every later request binds to that confirmed session and tab. A closed/stale session cannot continue silently.

Put the QA GUI policy in `runs/<id>/native-gui-policy.json`. It names the exact target, supported Dragon version, session, tab, permitted reads and capabilities. The child request inspector owns admissibility; Team QA does not copy its JavaScript parser. Passive preparation is separate from trusted input, which also requires the existing signed execution contract. A local Storage read must be declared and use a standalone literal-key `getItem`; synthetic mutation is forbidden.

PostToolUse records the original response hash and checks nested success. It does not certify product acceptance. Recording, trusted input receipts and postconditions still pass through QA GUI's trajectory and result gates. Missing recording may leave the result UNGRADED while independent checks remain executable. Unknown outcomes keep their evidence and require reconciliation. An input whose PostToolUse never comes (the call was refused or interrupted) stops blocking later inputs once a Stop or Interrupt of the same caller and turn follows it, or once it is older than the longest role timeout of the roster (at least five minutes); the next input records it as abandoned, and with no confirmed result it never counts as verified.

Before live operations the hook rechecks the owned session, effective policy, expiry, browser and bridge/extension version. Dragon does not expose its nonce through `session.list` or `session.getPolicy`; requests therefore remain pinned to the confirmed creation nonce, with server rejection and result readback providing the final check after a nonce change.

## Decisions and progress

The decision reader validates locked tracked cases and the canonical QA GUI board, then checks append-only attempts and actual child evidence. Optional `qa-gui/case-work/v1` contains remaining checks, next action, work state and evidence references. A blocker includes operation, reason code, owner and unblock condition; its evidence bytes must match the pinned hashes. Function/UI verdicts remain independent of this work state.

Within one synchronous decision, repeated original-source reads reuse immutable lines and decoded records. Each access freshly resolves the path and checks file identity, size and nanosecond modification/change timestamps before and after reuse; changed files are reread, and changes during a read fail closed. The 32 MiB source limit remains enforced. The source scope is discarded when the decision returns or throws; no approval, permission or verdict is cached, and all validation gates still execute.

`CONTINUE` names the next executable case, preparation step, worker wait or final verification. Three unchanged attempts exhaust that branch; changing turn/dispatch IDs or board prose does not refresh the cap. A blocked case does not stop independent cases. `WAIT` leaves the run incomplete and reports exact blockers. `COMPLETE` requires the existing formal gate and final report readback; product FAIL may still be a completed QA exercise. A matching board export proves publication integrity only.

Worker waits use the elapsed roster timeout before consuming the no-progress cap; three immediate Stop events cannot exhaust a still-running worker. This timer is a recovery bound, not proof that the native worker was cancelled. A damaged attempt chain or invalid latest proof blocks its own case without selecting an earlier PASS or blocking other valid cases.

During authorized execution, stale final HTML/snapshot/evidence-map bytes create publication debt. Locked source, plan, tracked cases, canonical board, approval and role gates still apply. Final output hashes and readback are checked strictly at COMPLETE, after independent cases have been processed.

Stop continuations carry `TEAMQA_AUTOMATIC_CONTINUATION`. Approval validators reject that marker even when the host presents the continuation as a user message. The hook never signs a plan, changes verdicts, expands scope or dispatches a worker itself. `stop_hook_active` does not bypass the gate. Interrupt wins; SubagentStop only records completion. Worker retries keep the one-turn limit and use [native attempt evidence](native-attempts.md).

## Activation acceptance

Unit tests and source mutations prove the adapter's decisions, not host execution. Required host canaries: invalid direct/nested RPC blocked before dispatch, a valid control executes, Stop resumes root and the named step occurs, duplicate events do not duplicate input, and user interruption ends the turn. Save hooks/list plus original hook started/completed events before and after, including the definition hash. Until those pass, report native activation as NOT RUN or BLOCKED and keep the candidate isolated.
