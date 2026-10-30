// Executor evidence to a QA GUI web board (upgrade U3).
//   teamqa web collect --run <id> --attestation <role-bindings/executor_gui[...].json> --board <canonical board.json>
// The GUI executor ends its turn with one evidence draft per case (references/executor-evidence.md): a line
// `TEAMQA_EVIDENCE_DRAFT v1` and a fenced JSON block naming the calls of its own stream that hold each state's
// screenshot, Gate-0 sweep, console, network and recording, with its assertions and lifecycle. A model on the Claude CLI
// does not see tool_use ids, so a call is named by what the executor itself chose or can count on: a state's screenshot
// by the `toFile` it passed; its Gate-0 read (`as` label), getConsole and getNetwork as the first such successful call on
// the same tab after that screenshot and before the next state's screenshot; the recording as the last successful
// assembleRecording and the stopRecording before it. A tool_use id (`toolu_…`) is still accepted. This command
// reads only that attested stream: every file and every raw output it writes comes from a tool result the executor
// received, never from the draft's prose, so the root no longer writes state receipts or evidence by hand. It copies the
// screenshots and recordings into the run, writes the state receipts, and replaces the case, its evidence manifest
// entries and its vision assertions on the canonical board. What the stream does not hold is UNGRADED, with the reason.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const DRAFT_MARKER = 'TEAMQA_EVIDENCE_DRAFT v1';
const STATE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const VERDICTS = ['PASS', 'FAIL', 'UNGRADED'];
export const VISION_RULES = ['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const iso = (value) => { const t = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const tri = (parts) => parts.includes('FAIL') ? 'FAIL' : parts.length && parts.every((p) => p === 'PASS') ? 'PASS' : 'UNGRADED';
const verdict = (value) => VERDICTS.includes(String(value).toUpperCase()) ? String(value).toUpperCase() : 'UNGRADED';
const raw = (id, v, evidence) => ({ id, verdict: v, evidence });
const isToolId = (value) => typeof value === 'string' && value.startsWith('toolu_');

// Tool calls of a Claude stream-json log, by tool_use id: name, input, method (dragon_rpc or a direct mcp__<server>__
// tool), the call and result timestamps, the result text and its JSON, and whether the result was an error.
export function streamCalls(text) {
  const calls = new Map();
  let order = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (e.type === 'assistant' && b?.type === 'tool_use' && typeof b.id === 'string') {
        const direct = /^mcp__[^_]+(?:_[^_]+)*__([A-Za-z.]+)$/.exec(b.name ?? '');
        const method = /__dragon_rpc$/.test(b.name ?? '') ? b.input?.method : direct ? direct[1] : null;
        calls.set(b.id, { id: b.id, i: ++order, name: b.name, input: b.input ?? {}, method, params: /__dragon_rpc$/.test(b.name ?? '') ? (b.input?.params ?? {}) : (b.input ?? {}), called_at: iso(e.timestamp) });
      }
      if (e.type === 'user' && b?.type === 'tool_result' && calls.has(b.tool_use_id)) {
        const call = calls.get(b.tool_use_id);
        const out = Array.isArray(b.content) ? b.content.map((c) => c?.text ?? '').join('') : String(b.content ?? '');
        let json = null; try { json = JSON.parse(out); } catch { json = null; }
        Object.assign(call, { text: out, json, error: b.is_error === true || json?.ok === false, at: iso(e.timestamp) });
      }
    }
  }
  return calls;
}

// The evidence drafts in the stream's assistant text: each `TEAMQA_EVIDENCE_DRAFT v1` line followed by a fenced JSON block.
export function evidenceDrafts(text) {
  const drafts = [];
  for (const line of String(text).split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b?.type !== 'text' || !b.text.includes(DRAFT_MARKER)) continue;
      const re = /TEAMQA_EVIDENCE_DRAFT v1\s*\n\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```/g;
      for (const m of b.text.matchAll(re)) {
        try { drafts.push(JSON.parse(m[1])); } catch { drafts.push({ invalid: true }); }
      }
    }
  }
  return drafts;
}

// Checks a draft's shape; returns the list of problems (empty when usable).
export function draftIssues(draft, { caseIds, caseId = null } = {}) {
  const issues = [];
  if (!draft || typeof draft !== 'object' || draft.invalid) return ['EVIDENCE_DRAFT_INVALID'];
  if (typeof draft.case_id !== 'string' || !caseIds.includes(draft.case_id)) issues.push(`EVIDENCE_DRAFT_CASE_UNKNOWN:${draft.case_id}`);
  if (caseId !== null && draft.case_id !== caseId) issues.push(`EVIDENCE_DRAFT_CASE_SCOPE:${draft.case_id}`);
  if (!Array.isArray(draft.states) || !draft.states.length) issues.push('EVIDENCE_DRAFT_STATES_MISSING');
  const seen = new Set();
  for (const s of draft.states ?? []) {
    if (typeof s?.state !== 'string' || !STATE_ID.test(s.state) || seen.has(s.state)) issues.push(`EVIDENCE_DRAFT_STATE_INVALID:${s?.state}`);
    seen.add(s?.state);
  }
  return issues;
}

// Gate-0 read step of a `do` / runFlow call: { ui:{v,...}, a11y:{v,...} } or null.
function gate0Value(call, as) {
  const steps = call?.json?.result?.results;
  const step = Array.isArray(steps) ? steps.find((s) => s?.step === 'read' && s?.as === as) : null;
  if (!step) return null;
  let v = step.value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  return v && typeof v === 'object' ? v : null;
}

// The Dragon session that owns a tab, read from the executor's own successful calls on that tab.
function tabSession(calls, tabId) {
  for (const c of calls.values()) {
    if (c.error || !c.json?.ok) continue;
    const r = c.json.result ?? {};
    if (String(r.tabId ?? c.params?.tabId) === String(tabId) && typeof (c.params?.sessionId ?? r.sessionId) === 'string') {
      return { sessionId: c.params?.sessionId ?? r.sessionId, browserInstanceId: c.params?.browserInstanceId ?? r.receipt?.session?.browserInstanceId ?? null };
    }
  }
  return null;
}

// One case from one draft: the files to copy, the state receipts, the board case fields, the manifest entries and the
// vision assertions. Pure: reads nothing but `calls`; `exists(path)` and `fileSha(path)` are the only file access.
export function buildCaseEvidence({ draft, calls, binding, plannedCase, boardCase, viewport, preflightRaw, fileSha, exists, dir = 'evidence/qa-gui' }) {
  const caseId = draft.case_id, issues = [];
  const files = [], receipts = [], manifest = [], vision = [], stateLinks = [], evidence = [], fnParts = [], uiParts = [];
  const meta = (state, at) => ({ run_uuid: binding.run_uuid, target_binding_sha256: binding.target_binding_sha256, case_id: caseId, state, captured_at: at });
  const own = (id, methods) => {
    const c = typeof id === 'string' ? calls.get(id) : null;
    if (!c) return { problem: `not in the executor stream: ${id ?? 'no call named'}` };
    if (!methods.includes(c.method)) return { problem: `call ${id} is ${c.method ?? c.name}, not ${methods.join('/')}` };
    if (c.error || !c.json?.ok) return { problem: `call ${id} did not succeed` };
    return { call: c };
  };
  const ordered = [...calls.values()].sort((a, b) => a.i - b.i);
  const succeeded = (c) => !c.error && c.json?.ok === true;
  // A state's screenshot: a tool_use id, or the `toFile` the executor passed (or the path Dragon saved it to). A file
  // taken twice under one name is the last successful take, the one on disk.
  const screenshotOf = (ref) => {
    if (isToolId(ref)) return own(ref, ['screenshot']);
    if (typeof ref !== 'string' || !ref.trim()) return { problem: 'not in the executor stream: no screenshot named (give its toFile)' };
    const named = ordered.filter((c) => c.method === 'screenshot' && (c.params?.toFile === ref || c.json?.result?.savedTo === ref));
    const ok = named.filter(succeeded);
    if (ok.length) return { call: ok.at(-1) };
    return { problem: named.length ? `screenshot ${ref} did not succeed` : `not in the executor stream: no screenshot with toFile ${ref}` };
  };
  // The first successful call of `methods` on `tabId` inside the window (lo, hi) of stream order that `accept` takes.
  const windowCall = ({ lo, hi, tabId }, methods, what, accept = () => true) => {
    const seen = ordered.filter((c) => c.i > lo && c.i < hi && methods.includes(c.method) && String(c.params?.tabId ?? '') === String(tabId ?? '') && accept(c));
    const ok = seen.find(succeeded);
    if (ok) return { call: ok };
    return { problem: seen.length ? `${what} after this state's screenshot did not succeed` : `no ${what} on the screenshot's tab after it and before the next state's screenshot` };
  };
  const firstState = draft.states[0]?.state;
  let recording = null;
  if (draft.recording !== undefined && draft.recording !== null && draft.recording !== false) {
    const named = typeof draft.recording === 'object' && (isToolId(draft.recording.stop) || isToolId(draft.recording.assemble));
    let stop, asm;
    if (named) { stop = own(draft.recording.stop, ['stopRecording']); asm = own(draft.recording.assemble, ['assembleRecording']); }
    else {
      const last = ordered.filter((c) => c.method === 'assembleRecording' && succeeded(c) && typeof c.json.result?.video === 'string').at(-1);
      asm = last ? { call: last } : { problem: 'no successful assembleRecording in the executor stream' };
      const before = last ? ordered.filter((c) => c.method === 'stopRecording' && succeeded(c) && c.i < last.i).at(-1) : null;
      stop = before ? { call: before } : { problem: 'no successful stopRecording before the assembleRecording' };
    }
    const video = asm.call?.json.result?.video;
    if (stop.call && asm.call && typeof video === 'string' && exists(video)) {
      const rel = `${dir}/${caseId}/${caseId}-run.mp4`;
      files.push({ from: video, rel });
      manifest.push({ path: rel, sha256: fileSha(video), evidence_type: 'gui-recording', metadata: meta(firstState, asm.call.at) });
      evidence.push(rel);
      recording = { file: rel, startMs: 0, endMs: Number(stop.call.json.result?.durationMs) || 0 };
    } else issues.push(`RECORDING_UNAVAILABLE:${caseId}:${stop.problem ?? asm.problem ?? 'video file missing'}`);
  }
  const shots = new Map(draft.states.map((s) => [s, screenshotOf(s.screenshot)]));
  const anchors = [...shots.values()].filter((x) => x.call).map((x) => x.call.i).sort((a, b) => a - b);
  for (const s of draft.states) {
    const shot = shots.get(s);
    if (!shot.call) { issues.push(`SCREENSHOT_UNAVAILABLE:${caseId}:${s.state}:${shot.problem}`); fnParts.push('UNGRADED'); uiParts.push('UNGRADED'); continue; }
    const r = shot.call.json.result, at = shot.call.at ?? iso(r.evidence?.ts);
    if (typeof r.savedTo !== 'string' || !isAbsolute(r.savedTo) || !exists(r.savedTo) || (r.sha256 && fileSha(r.savedTo) !== r.sha256)) {
      issues.push(`SCREENSHOT_FILE_DRIFT:${caseId}:${s.state}`); fnParts.push('UNGRADED'); uiParts.push('UNGRADED'); continue;
    }
    if (viewport && r.dom?.viewport && r.dom.viewport !== viewport) issues.push(`VIEWPORT_MISMATCH:${caseId}:${s.state}:${r.dom.viewport}:board=${viewport}`);
    // QA GUI's receipt needs the page URL and DOM hash the screenshot reports; `domHash:false` drops both.
    // The state is still collected and the gate marks it UNGRADED; reported here first.
    if (typeof r.dom?.url !== 'string' || typeof r.domHash !== 'string') issues.push(`SCREENSHOT_DOM_MISSING:${caseId}:${s.state}`);
    const png = `${dir}/${caseId}/${s.state}.png`;
    files.push({ from: r.savedTo, rel: png });
    manifest.push({ path: png, sha256: fileSha(r.savedTo), evidence_type: 'gui-screenshot', metadata: meta(s.state, at) });
    evidence.push(png);
    const assertions = (Array.isArray(s.assertions) ? s.assertions : []).map((a) => ({ requirement_id: plannedCase.req_id, assertion_id: String(a.assertion_id),
      verdict: verdict(a.verdict), evidence_ref: png, evidence_type: 'gui-screenshot' }));
    const fn = tri(assertions.map((a) => a.verdict));
    const win = { lo: shot.call.i, hi: anchors.find((i) => i > shot.call.i) ?? Infinity, tabId: shot.call.params?.tabId };
    let uiSanity, a11y;
    const as = typeof s.gate0 === 'string' ? s.gate0 : (s.gate0?.as ?? 'g0');
    const g0call = !s.gate0 ? null : isToolId(s.gate0.call) ? own(s.gate0.call, ['do', 'runFlow'])
      : windowCall(win, ['do', 'runFlow'], `do/runFlow with a read step as "${as}"`, (c) => gate0Value(c, as) !== null);
    const g0 = g0call?.call ? gate0Value(g0call.call, as) : null;
    if (g0) {
      const tv = (x) => ['PASS', 'FAIL'].includes(x?.v) ? x.v : 'UNGRADED';
      uiSanity = raw('ui-sanity', tv(g0.ui), JSON.stringify(g0.ui ?? null));
      a11y = raw('a11y', tv(g0.a11y), JSON.stringify(g0.a11y ?? null));
    } else {
      const why = s.gate0 ? (g0call.problem ?? 'its read step holds no Gate-0 result') : 'Gate-0 was not run at this state';
      uiSanity = raw('ui-sanity', 'UNGRADED', `not measurable: ${why}`);
      a11y = raw('a11y', 'UNGRADED', `not measurable: ${why}`);
    }
    const con = !s.console ? null : isToolId(s.console) ? own(s.console, ['getConsole']) : windowCall(win, ['getConsole'], 'getConsole');
    const consoleRaw = con?.call ? raw('console', (con.call.json.result?.entries ?? []).some((x) => x?.level === 'error') ? 'FAIL' : 'PASS', con.call.text)
      : raw('console', 'UNGRADED', `not measurable: ${con?.problem ?? 'getConsole was not called for this state'}`);
    const net = !s.network ? null : isToolId(s.network) ? own(s.network, ['getNetwork'])
      : windowCall(win, ['getNetwork'], 'getNetwork (without summary)', (c) => c.params?.summary !== true);
    const requests = net?.call ? (net.call.json.result?.requests ?? []) : [];
    const network = requests.filter((x) => ['Fetch', 'XHR'].includes(x?.type) && x?.method).map((x) => ({ method: x.method, url: x.url, status: x.status, ts: iso(x.t) }));
    const networkRaw = !net?.call ? raw('network', 'UNGRADED', `not measurable: ${net?.problem ?? 'getNetwork was not called for this state'}`)
      : !requests.length ? raw('network', 'UNGRADED', `not measurable: getNetwork returned an empty window: ${net.call.text}`)
        : raw('network', network.some((x) => x.status >= 400) ? 'FAIL' : 'PASS', net.call.text);
    const ui = tri([uiSanity, a11y, consoleRaw, networkRaw, preflightRaw].map((x) => x.verdict));
    const session = tabSession(calls, shot.call.params?.tabId);
    if (!session) issues.push(`SCREENSHOT_SESSION_UNKNOWN:${caseId}:${s.state}`);
    const receipt = {
      schema: 'qa-gui/state-receipt/v1', caseId, state: s.state, capturedAt: at, url: r.dom?.url ?? null, build: binding.target.frontend_build.id,
      viewport: r.dom?.viewport ?? viewport, domHash: r.domHash ?? null,
      dragon: { sessionId: session?.sessionId ?? null, actionId: r.evidence?.ref ?? `screenshot:${shot.call.id}`, browserInstanceId: session?.browserInstanceId ?? null,
        tabId: String(shot.call.params?.tabId ?? ''), innerOk: r.privacyMasked === true && Boolean(r.savedTo) },
      screenshot: { path: png, sha256: fileSha(r.savedTo) },
      function: { verdict: fn, assertions },
      ui: { verdict: ui, uiSanity, a11y, console: consoleRaw, network: networkRaw },
      preflight: preflightRaw, network, network_summary: { failed_requests: network.filter((x) => x.status >= 400).length },
      readback: { value: { lifecycle: draft.lifecycle ?? null }, evidence_ref: png },
      targetBindingSha256: binding.target_binding_sha256,
    };
    const rel = `${dir}/${caseId}/${s.state}.receipt.json`;
    receipts.push({ rel, value: receipt });
    manifest.push({ path: rel, sha256: null, evidence_type: 'machine-receipt', metadata: meta(s.state, at) });
    evidence.push(rel); stateLinks.push({ state: s.state, file: rel });
    fnParts.push(fn); uiParts.push(ui);
    // QA GUI's gate wants every vision rule C10–C16 on every settled state and accepts no other rule name: a rule the
    // executor did not judge is UNGRADED, a rule name outside C10–C16 is dropped and reported.
    const judged = new Map((Array.isArray(s.vision) ? s.vision : []).map((v) => [String(v.rule), verdict(v.verdict)]));
    for (const rule of judged.keys()) if (!VISION_RULES.includes(rule)) issues.push(`VISION_RULE_UNKNOWN:${caseId}:${s.state}:${rule}`);
    for (const rule of VISION_RULES) {
      vision.push({ assertion_id: `${caseId}-${s.state}-${rule}`, case_id: caseId, state: s.state, rule, verdict: judged.get(rule) ?? 'UNGRADED', evidence_ref: png, evidence_type: 'gui-screenshot' });
    }
  }
  const functionVerdict = tri(fnParts), uiVerdict = tri(uiParts);
  const status = draft.blocked === true ? 'BLOCKED' : functionVerdict === 'FAIL' || uiVerdict === 'FAIL' ? 'FAIL' : functionVerdict === 'PASS' && uiVerdict === 'PASS' ? 'PASS' : 'BLOCKED';
  const now = new Date().toISOString();
  // The gate wants the case to declare the requirement its atomic rows name, as the locked tracked plan does; a board
  // made from a seed may carry only `requirement`.
  const requirementId = plannedCase?.req_id;
  const declared = Array.isArray(boardCase?.requirements) ? boardCase.requirements : [];
  const caseEntry = {
    ...(boardCase ?? {}), id: caseId, status, functionVerdict, uiVerdict,
    ...(typeof requirementId === 'string' ? { requirement: boardCase?.requirement ?? requirementId,
      requirements: declared.includes(requirementId) ? declared : [...declared, requirementId] } : {}),
    humanSummary: { function: String(draft.summary?.function ?? ''), ui: String(draft.summary?.ui ?? '') },
    states: draft.states.map((s) => s.state), stateReceipts: stateLinks,
    ...(recording ? { recordingSegments: [recording] } : {}),
    results: [...(Array.isArray(boardCase?.results) ? boardCase.results : []), { round: 1, functionVerdict, uiVerdict, recordedAt: now, evidence: [...evidence] }],
    evidence,
    history: [...(Array.isArray(boardCase?.history) ? boardCase.history : []), { who: 'qa-agent', field: 'status', from: boardCase?.status ?? 'TODO', to: status, when: now, source: 'agent' }],
  };
  return { caseId, files, receipts, manifest, vision, caseEntry, issues };
}

// Replace the case, its manifest entries and its vision assertions on the board; other cases stay byte-for-byte.
export function mergeCaseIntoBoard(board, built) {
  const next = structuredClone(board);
  const at = (next.cases ?? []).findIndex((c) => c?.id === built.caseId);
  if (at < 0) throw Object.assign(new Error(`BOARD_CASE_UNKNOWN ${built.caseId}`), { code: 'BOARD_CASE_UNKNOWN' });
  next.cases[at] = built.caseEntry;
  next.evidenceManifest = [...(next.evidenceManifest ?? []).filter((e) => e?.metadata?.case_id !== built.caseId), ...built.manifest];
  next.vision = { version: next.vision?.version ?? 2, ...(next.vision ?? {}),
    assertions: [...(next.vision?.assertions ?? []).filter((v) => v?.case_id !== built.caseId), ...built.vision] };
  return next;
}

// CLI: verify the attestation (Team QA's own verifier), read its stream, build each drafted case, write the files.
export async function webCollect(args, { parseFlags, readJson, writeConfirmed, stableJson, fail, assertRoleAttestation, lockRunDocuments, runDirectory, safeRunId }) {
  const o = parseFlags(args, { '--run': { key: 'run', required: true }, '--attestation': { key: 'attestation', required: true }, '--board': { key: 'board', required: true } });
  const runId = safeRunId(o.run), runDir = runDirectory(runId);
  const attestationPath = resolve(o.attestation);
  const a = assertRoleAttestation({ runDir, role: 'executor_gui', attestationPath });
  if (a.source?.kind !== 'claude-stream') fail(2, 'WEB_COLLECT_CLAUDE_STREAM_REQUIRED', a.source?.kind);
  const binding = readJson(join(runDir, 'binding.json'));
  const tracked = readJson(join(runDir, 'tracked-plan.json'));
  const boardPath = resolve(o.board);
  if (relative(runDir, boardPath).startsWith('..')) fail(2, 'WEB_COLLECT_BOARD_OUTSIDE_RUN', boardPath);
  const board = readJson(boardPath);
  // QA GUI's gate finds the run's receipts by the board's runUuid and wants the binding's: a board made in DESIGN before
  // `web bind` holds another one. Refused here, with the fix, before any write.
  if (board.runUuid !== binding.run_uuid) fail(2, 'WEB_COLLECT_BOARD_RUN_UUID', `board runUuid ${board.runUuid ?? 'missing'} is not the binding's ${binding.run_uuid}: create the board with QA GUI teamwork init --run-uuid ${binding.run_uuid} --target-binding-sha256 ${binding.target_binding_sha256} (claude-host.md steps 12 and 14)`);
  const streamText = readFileSync(resolve(runDir, a.source.path), 'utf8');
  if (sha256(Buffer.from(streamText, 'utf8')) !== a.source.sha256) fail(2, 'WEB_COLLECT_STREAM_DRIFT', a.source.path);
  const calls = streamCalls(streamText);
  const caseIds = tracked.cases.map((c) => c.id);
  const scope = typeof a.dispatch_case_id === 'string' ? a.dispatch_case_id : null;
  const drafts = evidenceDrafts(streamText);
  if (!drafts.length) fail(2, 'EVIDENCE_DRAFT_MISSING', 'the executor printed no TEAMQA_EVIDENCE_DRAFT v1 block');
  const preflightFile = join(runDir, 'preflight.json');
  const preflightRaw = existsSync(preflightFile)
    ? raw('preflight', 'PASS', `team-qa preflight.json sha256=${sha256(readFileSync(preflightFile))} roster=${a.roster_hash}`)
    : raw('preflight', 'UNGRADED', 'not measurable: runs/<id>/preflight.json missing');
  const fileSha = (path) => sha256(readFileSync(path));
  const exists = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
  let next = board;
  const report = [];
  for (const draft of drafts) {
    const problems = draftIssues(draft, { caseIds, caseId: scope });
    if (problems.length) fail(2, problems[0], problems.slice(1).join(' '));
    const built = buildCaseEvidence({ draft, calls, binding, plannedCase: tracked.cases.find((c) => c.id === draft.case_id),
      boardCase: (board.cases ?? []).find((c) => c?.id === draft.case_id), viewport: board.viewport ?? null, preflightRaw,
      fileSha, exists });
    for (const f of built.files) { const dest = join(runDir, f.rel); mkdirSync(dirname(dest), { recursive: true }); copyFileSync(f.from, dest); }
    for (const r of built.receipts) {
      await writeConfirmed(join(runDir, r.rel), stableJson(r.value), 'teamqa.web.collect.receipt');
      const entry = built.manifest.find((m) => m.path === r.rel); entry.sha256 = fileSha(join(runDir, r.rel));
    }
    next = mergeCaseIntoBoard(next, built);
    report.push({ case: built.caseId, status: built.caseEntry.status, function: built.caseEntry.functionVerdict, ui: built.caseEntry.uiVerdict,
      states: built.caseEntry.states.length, files: built.files.length + built.receipts.length, issues: built.issues.slice(0, 6) });
  }
  await writeConfirmed(boardPath, `${JSON.stringify(next, null, 2)}\n`, 'teamqa.web.collect.board');
  // The docs lock pins the canonical board's hash; this command is the board's sanctioned writer in EXECUTE, so it locks
  // the new revision itself (the previous lock is archived) instead of leaving the gate to refuse a stale board
  // (otherwise the root has to re-lock by hand after every collect).
  let relocked = null;
  const lockFile = join(runDir, 'docs-lock.json');
  if (lockRunDocuments && existsSync(lockFile)) {
    const lock = readJson(lockFile);
    const pinned = Object.entries(lock.artifacts ?? {}).find(([, x]) => typeof x?.path === 'string' && resolve(runDir, x.path) === boardPath);
    if (pinned) {
      await lockRunDocuments({ runDir, artifacts: { ...lock.artifacts, [pinned[0]]: { path: pinned[1].path, sha256: sha256(readFileSync(boardPath)) } } });
      relocked = pinned[0];
    }
  }
  return { run_id: runId, board: relative(process.cwd(), boardPath), attestation: relative(process.cwd(), attestationPath), cases: report, relocked };
}
