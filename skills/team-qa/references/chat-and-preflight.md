# Roster approval chat, QA board and preflight

The machine gate checks the real assistant message before the user event, not just a hash that appears in a log.
`roster show` generates the full table; the orchestrator puts the table unchanged into the chat and the user can answer “Approve”.
The user does not type a hash. Codex commentary/final channels and Claude assistant text are accepted; analysis,
thinking, tool stdout and a "roster sent" remark are not enough. A new proposal replaces the old one; a change of model,
effort, route, context, target or round must be shown and approved again.

## Order

1. Collect/select the roster, check runtime/schema/child packages and read access to the target; save `preflight.json`.
2. Run `roster show`, put the table unchanged into the chat, get the original human event and `roster approve`.
3. Dispatch Test Manager/Analyst separately through the approved route; lock source/dossier/plan.
4. In PLAN, create a **board draft** without cases with `board init` without `--tracked`.
   Space/Page → Notion → Doc-Colab per the existing destination policy. Read the board back independently;
   the draft records only NOT RUN and never invents cases or coverage. Keep the canonical draft immutable.
5. Save `board-link.json` and declare `preflight:{code,gui,recording}` in the plan; recording requires GUI.
   Run `teamqa run show-plan --run <id>` and put the output unchanged into the chat. The output has the whole roster,
   the link **QA board — <app name> — <environment>**, the exit criteria and a readable preflight table.
6. The user approves the plan; `gate approve` checks the chat + the exact plan hash, then opens DESIGN. After DESIGN, update
   the same remote board with a new canonical revision that holds the tracked cases; keep the signed draft/readback.
7. Before executor dispatch, re-check the preflight of the exact role. Call/result evidence is at most 5 minutes old;
   GUI also checks the current bridge/session. Refreshing `preflight.json` does not edit the signed chat snapshot.

`show-plan` only prepares the content; it does not put the content into the chat and does not grant approval.
Without a verified link or the full table, SIGN is locked. `board prepare`, creating a JSON file,
HTTP 200, an image with bytes or a rejected canary does not prove that the tools operate successfully.

```bash
teamqa preflight check --run <id> --roster <candidate.json> --stage basic
node <team-qa>/scripts/roster.mjs show --file <candidate.json>
teamqa run show-plan --run <id>
teamqa preflight check --run <id> --stage execute --role executor_gui
```

A Claude Code root does not write `preflight.json` itself. Paste the marker `TEAMQA_PREFLIGHT run=<id> round=<n>
roster=<roster_hash>` into the chat (not through Bash), then make the calls one at a time, never in parallel: Bash
`curl --fail --silent http://127.0.0.1:9233/status` (or `curl --fail --silent "$TEAMQA_DRAGON_STATUS_URL"` when this variable
has a value) → Dragon `session.create` (a new `sessionId`,
`forbidSyntheticDOM:false`) → `openTab` (the exact `preview_url`, `active:false`) → `getPageIdentity` →
`getNetwork {summary:true}` → `getTabInfo` → `screenshot` on the same session/tab (plus `startRecording` →
`stopRecording` → `assembleRecording` when the plan needs a recording). Then run
`teamqa preflight build --run <id> --stage basic|plan|execute [--roster <candidate.json>]`. The command takes the
refs after the latest visible marker of the exact roster hash, writes the file and accepts it only when `assertToolPreflight`
of that stage passes; the old copy is kept in `archive/`. Per-case dispatch (`--case-id`) on a deployed target does not need the
refresh step below: the Executor reads the identity on its own tab itself and Team QA checks it in the stream (see
[Claude host](claude-host.md) step 17). For other dispatches, before a GUI executor dispatch (5-minute window): paste the
marker again, reload the tab (same tabId, so that the app calls the backend within 300 seconds before the read), call
`getPageIdentity → getNetwork {summary:true} → getTabInfo → screenshot` again on the same session/tab, then
`teamqa preflight build --run <id> --stage execute --current`; the command keeps status/session/open unchanged,
replaces only `current_identity`, `read` and the image, then prints `fresh_until`, the dispatch deadline.

Preflight N/A comes only from the signed scope and grants no permission to run an executor outside the scope. A broken GUI blocks GUI;
Code can continue if the Code gate passes. BLOCKED/NOT RUN is not PASS/coverage. A tool error
is a QA execution error; the orchestrator is responsible for recovery and reruns a role only when the preflight passes.
`roles check`/`smoke` still check compatibility/canary; they do not replace this operational preflight.

## Machine evidence

`preflight.json` uses `team-qa/tool-preflight/v1`, with the exact run/round/roster_hash/target:

```json
{
  "schema": "team-qa/tool-preflight/v1",
  "run_id": "RUN", "round": 1, "roster_hash": "SHA256",
  "target": {"project_id": "APP", "preview_url": "https://test.example", "version": "GITSHA"},
  "runtime": {
    "node_version": "v24.x.x", "contract_sha256": "CONTRACT_SHA256",
    "children": [
      {"skill": "qa-code", "source_sha256": "SOURCE_SHA256", "manifest_sha256": "MANIFEST_SHA256"},
      {"skill": "qa-gui", "source_sha256": "SOURCE_SHA256", "manifest_sha256": "MANIFEST_SHA256"}
    ]
  },
  "target_access": {"kind": "git", "repo_root": "/repo", "source_path": "README.md", "source_sha256": "SHA256"}
}
```

A placeholder is not a valid receipt. Runtime uses Node 24/26, the canonical contract and the child
package verifier; hash/binary/config are read back. Git access checks HEAD/source at the locked
version and does not yet prove deployed preview/backend parity. Browser-only access uses
`target_access:{kind:"dragon",gui:<GUI proof>}` with a real status/session/open/read chain.

Each raw tool reference has `path,call_line,result_line,call_sha256,result_sha256,host`.
`host` is the descriptor from `native-host.mjs`; the source must be in the original Codex sessions. The marker
`TEAMQA_PREFLIGHT run=RUN round=ROUND roster=HASH` must appear in the assistant chat before the probe.
A self-declared PASS summary or a source created inside the run is not accepted. Direct calls are supported, as is one literal
`exec/functions.exec` wrapper `text(await tools.exec_command({...}));` or an equivalent MCP call;
multi-output, arbitrary JavaScript, failed/running or unknown shapes are not accepted.

Code has `qa_code[]` with exactly the two tiers scanner/runner: a valid Gate0 command with repo/base,
the original stdout JSON, `runtime`, `evidence`, the binaries `tools:[{path,sha256}]` and a config pin if used.
Canonical QA Code integrity/testExecutionOutcome must pass; the runner must execute the selected files,
the report has a hash and nothing is skipped. Help/usage only, or only resolving the binary, is not enough. No LLM call in preflight.

GUI has `status,session,open,read,screenshot,image`; behavioral adds `start,recording,assemble,video`.
The status source is the real command `curl --fail --silent http://127.0.0.1:9233/status`, or the same command with
`"$TEAMQA_DRAGON_STATUS_URL"` when this variable points to another loopback bridge (eval compat 9). The status must meet
`scripts/requirements.json`: the bridge and the extension each range from the minimum version up to below the next major; the two need not match each other
(the Chrome Web Store updates the extension by itself); when the bridge reports `extension.id`/`installType`, the extension must be the Store build.
When it falls short, preflight returns a code with an action (`DRAGON_RUNTIME_OLD` → `update_runtime`, `DRAGON_EXTENSION_OLD` →
`update_extension`, `DRAGON_EXTENSION_MISSING` → `install_extension`, `DRAGON_NOT_READY` → `pair`); run
`teamqa doctor` to see the whole chain. Dragon
`dragon_rpc` uses `{method,params}`; session/create pins sessionId/nonce/browserInstanceId and
forbidSyntheticDOM=false; openTab on the exact URL; do/read return `{url,dom}`. A screenshot must have privacy
and a savedTo bound to a file hash. A recording must have interaction/events, frames/delivery/cleanup privacy,
assemble and a video file. Pin the installed Dragon server.js/mcp-server.mjs/package.json in
`runtime.dragon_files` (the folder `~/.dragon-browser/runtime/current`, or the release of a separate Dragon given in
`TEAMQA_DRAGON_RUNTIME_DIR` when `TEAMQA_DRAGON_STATUS_URL` points to that loopback bridge, eval compat 11). A nested result error is still rejected even when the outer RPC succeeds.

A media hash/signature only verifies the tool's artifact; visual review, playback and Function/UI QA
still follow qa-gui. Readiness is a snapshot with an expiry; it does not guarantee that the tools keep working forever.

## Board link and the signed snapshot

`board-link.json` uses `team-qa/board-link/v1`, with the exact run/round/roster_hash/target and
`provider,canonical,canonical_sha256,url`. Space/Notion add `snapshot,snapshot_sha256,read_source`;
the raw output from the original read connector must match the snapshot and the observed URL exactly. Space calls the
canonical `compare-page`; Notion calls `compare-notion` with a raw rows shape that the child supports.
A response without a normalizing adapter stays BLOCKED; never invent a normalized readback.
Doc-Colab adds `artifact,artifact_sha256`; the URL is an absolute file link, and the exact bytes go through the child gate.
Colab (`--to colab`, the hosted Doc-Colab) adds `artifact,artifact_sha256` (the sealed HTML board),
`snapshot,snapshot_sha256` (the doc as read back, `board-colab/readback-rev-<n>.json`) and `payload,payload_sha256`
(`board-colab/receipt-rev-<n>.json`); the URL is the doc's `https://…/d/<id>` link. Verification re-checks the sealed
HTML, the receipt binding, and that the saved readback still equals the canonical board field by field.

`plan-chat.json` locks the text and the snapshots in `plan-presentations/`; SIGN/replay re-check the hashes,
the board readback and the original assistant message. A refresh does not edit an old approval. A plan change must be shown
and signed again. The gates lock Team QA's dispatcher/phase/intake; they are not a host-wide sandbox.
