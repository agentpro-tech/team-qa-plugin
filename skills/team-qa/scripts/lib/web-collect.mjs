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
// Correct and light evidence (QA GUI R1f): with QA GUI's evidence tools (scripts/lib/evidence-quality.mjs) each
// screenshot is fitted to at most 1,280 px and its receipt carries `screenshot.capture` (the capture's tab, URL, DOM
// hash, bytes and mask boxes, plus the build measured on that tab) and `screenshot.fit`; each recording gets its
// `qa-gui/recording-manifest/v1` built from the Dragon recording dir with the case's action receipts; the board gets
// `evidencePolicy: {version: 1}`, and evidence QA GUI's checks reject makes the case UNGRADED with the code.
// Coverage cells (R1b): for a cell case (a tracked plan case with `route` under the coverage block) each receipt also
// names its `cell` (qa-gui/coverage-cell/v1): the plan route, the state, the action the draft names (`view` by default),
// the plan row of the measured viewport size, the environment conditions (from the Dragon record of the state) and the
// row count a named read step returned. QA GUI's cell checks run on it as its gate will; a QA GUI without them gets no cell.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { siblingSkillRoot } from './install-layout.mjs';

export const DRAFT_MARKER = 'TEAMQA_EVIDENCE_DRAFT v1';
const STATE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CELL_ACTION = /^[^\s|][^|]{0,255}$/;
const ROW_STATES = ['empty', 'one-row', 'many-rows'];
const VERDICTS = ['PASS', 'FAIL', 'UNGRADED'];
export const VISION_RULES = ['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const iso = (value) => { const t = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const tri = (parts) => parts.includes('FAIL') ? 'FAIL' : parts.length && parts.every((p) => p === 'PASS') ? 'PASS' : 'UNGRADED';
const verdict = (value) => VERDICTS.includes(String(value).toUpperCase()) ? String(value).toUpperCase() : 'UNGRADED';
const raw = (id, v, evidence) => ({ id, verdict: v, evidence });
const isToolId = (value) => typeof value === 'string' && value.startsWith('toolu_');

// Claude Code saves a tool result above its inline limit to the session's tool-results/ folder and leaves a
// `<persisted-output>` preview in the message (Dragon `help` is always that large). The original is read from the same
// stream line (`tool_use_result`, as the transcript's `toolUseResult`), else from the saved file the preview names when
// `readPersisted(path)` gives it and it starts with the preview's text; otherwise the result stays the preview.
const PERSISTED = /^\s*<persisted-output>/;
const blockText = (blocks) => (Array.isArray(blocks) ? blocks.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text ?? '' : '')).join('') : typeof blocks === 'string' ? blocks : '');
function persistedOriginal(preview, event, readPersisted) {
  for (const original of [event?.tool_use_result, event?.toolUseResult]) {
    const blocks = Array.isArray(original) ? original : Array.isArray(original?.content) ? original.content : null;
    const text = blocks ? blockText(blocks) : typeof original === 'string' ? original : '';
    if (text && !PERSISTED.test(text)) return { text, from: 'stream' };
  }
  const path = /Full output saved to: (\S+)/.exec(preview)?.[1];
  if (!path || typeof readPersisted !== 'function') return null;
  let text = null;
  try { text = readPersisted(path); } catch { text = null; }
  if (typeof text !== 'string') return null;
  // The preview shows the first part of the saved output: the file must begin with it.
  const shown = /Preview \(first [^)]*\):\n([\s\S]*?)(?:\n\.\.\.\n)?\s*<\/persisted-output>/.exec(preview)?.[1]?.trim();
  if (shown && !text.startsWith(shown.slice(0, Math.min(shown.length, 512)))) return null;
  return { text, from: 'file', path };
}

// Tool calls of a Claude stream-json log, by tool_use id: name, input, method (dragon_rpc or a direct mcp__<server>__
// tool), the call and result timestamps, the result text and its JSON, and whether the result was an error.
export function streamCalls(text, { readPersisted = null } = {}) {
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
        let out = Array.isArray(b.content) ? b.content.map((c) => c?.text ?? '').join('') : String(b.content ?? '');
        let persisted = null;
        if (PERSISTED.test(out)) { const original = persistedOriginal(out, e, readPersisted); if (original) { persisted = { from: original.from, ...(original.path ? { path: original.path } : {}) }; out = original.text; } else persisted = { from: null }; }
        let json = null; try { json = JSON.parse(out); } catch { json = null; }
        Object.assign(call, { text: out, json, error: b.is_error === true || json?.ok === false, at: iso(e.timestamp), ...(persisted ? { persisted } : {}) });
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
    // R1b: the planned action this state checks, and the read step label of its row count.
    if (s?.action !== undefined && !(typeof s.action === 'string' && CELL_ACTION.test(s.action))) issues.push(`EVIDENCE_DRAFT_ACTION_INVALID:${s?.state}`);
    if (s?.rows !== undefined && !(typeof s.rows === 'string' && s.rows.trim())) issues.push(`EVIDENCE_DRAFT_ROWS_INVALID:${s?.state}`);
    // Upgrade integration: what the executor says it ran on this state (references/executor-evidence.md).
    const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (s?.transient !== undefined && !(plain(s.transient) && (s.transient.action === undefined || plain(s.transient.action))
      && (s.transient.repeatable === undefined || typeof s.transient.repeatable === 'boolean'))) issues.push(`EVIDENCE_DRAFT_DETECTOR_INVALID:${s?.state}:transient`);
    if (s?.ux !== undefined && !(Array.isArray(s.ux) && s.ux.every((rule) => /^U(?:[1-9]|10)$/.test(String(rule))))) issues.push(`EVIDENCE_DRAFT_DETECTOR_INVALID:${s?.state}:ux`);
    for (const key of ['screen', 'explore']) if (s?.[key] !== undefined && typeof s[key] !== 'boolean') issues.push(`EVIDENCE_DRAFT_DETECTOR_INVALID:${s?.state}:${key}`);
    if (s?.detectors !== undefined && !(plain(s.detectors) && Object.keys(s.detectors).every((k) => k === 'unavailable')
      && (s.detectors.unavailable === undefined || (plain(s.detectors.unavailable) && Object.values(s.detectors.unavailable).every((v) => typeof v === 'string' && /^[A-Z0-9_]{1,64}$/.test(v)))))) {
      issues.push(`EVIDENCE_DRAFT_DETECTOR_INVALID:${s?.state}:detectors`);
    }
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

// A row count a `do` / runFlow read step returned: a non-negative integer, or {rows} / {count} holding one; else null.
function rowsValue(call, as) {
  const steps = call?.json?.result?.results;
  const step = Array.isArray(steps) ? steps.find((s) => s?.step === 'read' && s?.as === as) : null;
  if (!step) return null;
  let v = step.value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (v && typeof v === 'object') v = Number.isInteger(v.rows) ? v.rows : v.count;
  return Number.isInteger(v) && v >= 0 ? v : null;
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

// QA GUI's evidence tools (R1f), from the QA GUI next to this Team QA (TEAMQA_QA_GUI_ROOT wins); null when absent.
export const EVIDENCE_TOOL_EXPORTS = ['EVIDENCE_POLICY_VERSION', 'MAX_EVIDENCE_WIDTH', 'fitPng', 'buildRecordingManifest', 'stateImageIssues', 'recordingSegmentIssues'];
// QA GUI's coverage cell checks (R1b, scripts/lib/coverage-cell.mjs), carried with the evidence tools when present.
export const CELL_TOOL_EXPORTS = ['COVERAGE_CELL_VERSION', 'stateCellIssues'];
export async function qaGuiEvidenceTools(root = siblingSkillRoot('qa-gui')) {
  const file = join(root, 'scripts/lib/evidence-quality.mjs');
  if (!existsSync(file)) return null;
  const tools = await import(pathToFileURL(realpathSync(file)).href);
  if (!EVIDENCE_TOOL_EXPORTS.every((name) => name in tools)) return null;
  const cellFile = join(root, 'scripts/lib/coverage-cell.mjs');
  if (!existsSync(cellFile)) return tools;
  const cell = await import(pathToFileURL(realpathSync(cellFile)).href);
  return CELL_TOOL_EXPORTS.every((name) => name in cell)
    ? { ...tools, ...Object.fromEntries(CELL_TOOL_EXPORTS.map((name) => [name, cell[name]])) } : tools;
}

// The screenshot call of each drafted state: a tool_use id, or the `toFile` the executor passed (or the path Dragon saved
// it to). A file taken twice under one name is the last successful take, the one on disk. Map(state -> {call}|{problem}).
export function stateScreenshots(draft, calls) {
  const ordered = [...calls.values()].sort((a, b) => a.i - b.i);
  const succeeded = (c) => !c.error && c.json?.ok === true;
  const of = (ref) => {
    if (isToolId(ref)) {
      const c = calls.get(ref);
      if (!c) return { problem: `not in the executor stream: ${ref}` };
      if (c.method !== 'screenshot') return { problem: `call ${ref} is ${c.method ?? c.name}, not screenshot` };
      if (c.error || !c.json?.ok) return { problem: `call ${ref} did not succeed` };
      return { call: c };
    }
    if (typeof ref !== 'string' || !ref.trim()) return { problem: 'not in the executor stream: no screenshot named (give its toFile)' };
    const named = ordered.filter((c) => c.method === 'screenshot' && (c.params?.toFile === ref || c.json?.result?.savedTo === ref));
    const ok = named.filter(succeeded);
    if (ok.length) return { call: ok.at(-1) };
    return { problem: named.length ? `screenshot ${ref} did not succeed` : `not in the executor stream: no screenshot with toFile ${ref}` };
  };
  return new Map((draft.states ?? []).map((s) => [s, of(s.screenshot)]));
}

// The Dragon action receipts a call returned: `receipt`, `receipts[]` and each `do` step's `receipt`.
function callReceipts(call) {
  const r = call?.json?.result;
  if (!r || typeof r !== 'object') return [];
  return [r.receipt, ...(Array.isArray(r.receipts) ? r.receipts : []), ...(Array.isArray(r.results) ? r.results.map((step) => step?.receipt) : [])]
    .filter((x) => x && typeof x === 'object' && Number.isFinite(x.ts));
}

// One case from one draft: the files to copy, the state receipts, the board case fields, the manifest entries and the
// vision assertions. Pure: reads nothing but `calls`; `exists(path)`, `fileSha(path)` and, with `tools`, `readFile(path)`
// are the only file access. `tools` = QA GUI's evidence tools (qaGuiEvidenceTools); without them, no fit, binding or
// manifest is made (the receipts of before R1f).
export function buildCaseEvidence({ draft, calls, binding, plannedCase, boardCase, viewport, preflightRaw, fileSha, exists, dir = 'evidence/qa-gui', tools = null, readFile = null, coverage = null, detectors = null }) {
  const caseId = draft.case_id, issues = [];
  // R1b: a cell case's receipts name their coverage cell, only with a QA GUI that can check one (else its gate refuses
  // the unknown field).
  const cellCase = typeof plannedCase?.route === 'string' && plannedCase.route.length > 0;
  const cellTools = cellCase && typeof tools?.stateCellIssues === 'function' && typeof tools?.COVERAGE_CELL_VERSION === 'string';
  if (cellCase && !cellTools) issues.push(`CELL_UNSUPPORTED_BY_QA_GUI:${caseId}`);
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
      if (tools) {
        // The recording dir Dragon wrote (events.json + frames), and the action receipts of the calls made while it ran.
        const recId = stop.call.json.result?.id ?? stop.call.params?.id;
        const start = ordered.filter((c) => c.method === 'startRecording' && succeeded(c) && c.i < stop.call.i && (recId === undefined || c.json.result?.id === recId)).at(-1);
        const recDir = stop.call.json.result?.dir ?? start?.json.result?.dir;
        const receipts = ordered.filter((c) => succeeded(c) && c.i > (start?.i ?? -1) && c.i < stop.call.i).flatMap(callReceipts);
        let built = null;
        try {
          if (typeof recDir !== 'string' || !recDir) throw new Error('stopRecording/startRecording gave no recording dir');
          built = tools.buildRecordingManifest({ dir: recDir, video: readFile(video), receipts });
        } catch (error) { issues.push(`RECORDING_MANIFEST_UNAVAILABLE:${caseId}:${String(error?.message ?? error)}`); fnParts.push('UNGRADED'); }
        if (built) {
          const manRel = `${dir}/${caseId}/${caseId}-run.recording.json`;
          const data = Buffer.from(`${JSON.stringify(built, null, 2)}\n`, 'utf8');
          files.push({ data, rel: manRel });
          manifest.push({ path: manRel, sha256: sha256(data), evidence_type: 'recording-manifest', metadata: meta(firstState, asm.call.at) });
          evidence.push(manRel);
          // The segment covers every frame and every action time of the case's recording.
          recording.endMs = Math.max(recording.endMs, built.frames.at(-1)?.t ?? 0, ...built.actions.map((a) => a.t));
          recording.manifest = manRel;
          const rejected = tools.recordingSegmentIssues({ manifest: built, segment: recording, videoSha256: fileSha(video), caseId, index: 0 });
          for (const problem of rejected) issues.push(problem.message);
          if (rejected.length) fnParts.push('UNGRADED');
        }
      }
    } else issues.push(`RECORDING_UNAVAILABLE:${caseId}:${stop.problem ?? asm.problem ?? 'video file missing'}`);
  }
  const shots = stateScreenshots(draft, calls);
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
    // With QA GUI's tools the evidence PNG is the capture fitted to at most 1,280 px (mask boxes painted black again);
    // the capture binding comes from the same capture result. The app build is the target's only when the executor
    // read the page identity on that tab before the capture (executor-evidence.md); another tab has no measured build.
    let shotBytes = null, shotSha, screenshotExtra = {};
    if (tools) {
      const original = readFile(r.savedTo);
      const cssWidth = Number(/^(\d+)x\d+$/.exec(String(r.dom?.viewport ?? viewport ?? ''))?.[1]) || null;
      const tabId = String(shot.call.params?.tabId ?? '');
      // G3: an openTab {proveIdentity:true} whose identity triple succeeded read the page identity on its new tab.
      const inlineRead = (c) => c.method === 'openTab' && c.params?.proveIdentity === true && succeeded(c) && c.json?.result?.identity?.ok === true
        && String(c.json.result.identity.page?.params?.tabId ?? '') === tabId;
      const measured = ordered.some((c) => c.i < shot.call.i && ((['getPageIdentity', 'getPageHtml'].includes(c.method) && succeeded(c) && String(c.params?.tabId ?? '') === tabId) || inlineRead(c)));
      const capture = { tabId, url: r.dom?.url ?? null, build: measured ? binding.target.frontend_build.id : null, domHash: r.domHash ?? null,
        sha256: typeof r.sha256 === 'string' ? r.sha256 : sha256(original), ...(typeof r.dom?.viewport === 'string' ? { viewport: r.dom.viewport } : {}),
        maskedRects: Array.isArray(r.maskedRects) ? r.maskedRects : [], ...(typeof r.domStable === 'boolean' ? { domStable: r.domStable } : {}) };
      try {
        const fitted = tools.fitPng(original, { maxWidth: tools.MAX_EVIDENCE_WIDTH, masks: capture.maskedRects, cssWidth });
        shotBytes = fitted.png; shotSha = fitted.sha256; screenshotExtra = { capture, fit: fitted.fit };
      } catch (error) {
        issues.push(`SCREENSHOT_FIT_FAILED:${caseId}:${s.state}:${String(error?.message ?? error)}`);
        shotSha = fileSha(r.savedTo); screenshotExtra = { capture };
      }
    } else shotSha = fileSha(r.savedTo);
    files.push(shotBytes ? { data: shotBytes, rel: png } : { from: r.savedTo, rel: png });
    manifest.push({ path: png, sha256: shotSha, evidence_type: 'gui-screenshot', metadata: meta(s.state, at) });
    evidence.push(png);
    const assertions = (Array.isArray(s.assertions) ? s.assertions : []).map((a) => ({ requirement_id: plannedCase.req_id, assertion_id: String(a.assertion_id),
      verdict: verdict(a.verdict), evidence_ref: png, evidence_type: 'gui-screenshot' }));
    const fn = tri(assertions.map((a) => a.verdict));
    const win = { lo: shot.call.i, hi: anchors.find((i) => i > shot.call.i) ?? Infinity, tabId: shot.call.params?.tabId };
    let uiSanity, a11y, g0Report = null;
    const as = typeof s.gate0 === 'string' ? s.gate0 : (s.gate0?.as ?? 'g0');
    const g0call = !s.gate0 ? null : isToolId(s.gate0.call) ? own(s.gate0.call, ['do', 'runFlow'])
      : windowCall(win, ['do', 'runFlow'], `do/runFlow with a read step as "${as}"`, (c) => gate0Value(c, as) !== null);
    const g0 = g0call?.call ? gate0Value(g0call.call, as) : null;
    if (g0) {
      // A Gate-0 read gives `{v: verdict}` or the sweep's whole report (`{v: 'ui-sanity/2.0', verdict, issues, ...}`, with
      // its U rules): `verdict` wins, `v` is a verdict only in the short form.
      const tv = (x) => { const value = ['PASS', 'FAIL', 'UNGRADED'].includes(x?.verdict) ? x.verdict : x?.v; return ['PASS', 'FAIL'].includes(value) ? value : 'UNGRADED'; };
      uiSanity = raw('ui-sanity', tv(g0.ui), JSON.stringify(g0.ui ?? null));
      g0Report = g0.ui ?? null;
      a11y = raw('a11y', tv(g0.a11y), JSON.stringify(g0.a11y ?? null));
    } else {
      const why = s.gate0 ? (g0call.problem ?? 'its read step holds no Gate-0 result') : 'Gate-0 was not run at this state';
      uiSanity = raw('ui-sanity', 'UNGRADED', `not measurable: ${why}`);
      a11y = raw('a11y', 'UNGRADED', `not measurable: ${why}`);
    }
    // Requests the environment forced and their console lines are the condition under test, not a fault of the state.
    // Fix round 2 (E7): only what a request rule of this state's conditions really answered or failed (env.get's log,
    // `responded:<status>`/`failed:`), matched by method, path and status (and time when both have one), each logged
    // request excusing at most one entry; a held or released write and any other failure still count.
    // Fix round 3 (F7): by the conditions in force when the request was made, not at this state's screenshot: a request
    // with a time is excused by the rule env.get's log says answered it then (getNetwork without `since` returns the
    // tab's whole log, so an earlier forced error shows up again in a later state whose envSet replaced the rules); one
    // without a time only by a rule of this state's conditions.
    const stateConditions = detectors?.results?.env?.touched ? detectors.results.env.conditionsAt(shot.call.i) : null;
    const activeRules = new Set((Array.isArray(stateConditions?.requests) ? stateConditions.requests : []).map((rule) => rule?.id).filter(Boolean));
    const forced = detectors?.results?.forcedRequests ?? [];
    const used = new Set();
    const excuse = (x) => {
      if (typeof x?.url !== 'string' || !(Number(x.status) >= 400 || x.failed)) return false;
      const timed = Number.isFinite(x.t);
      const k = forced.findIndex((f, i) => !used.has(i) && f.url === x.url.split(/[?#]/)[0] && (!f.method || String(x.method ?? '').toUpperCase() === f.method)
        && (f.failed ? (x.failed === true || !x.status) : Number(x.status) === f.status)
        && (timed ? Number.isFinite(f.t) && Math.abs(x.t - f.t) <= 10000 : activeRules.has(f.ruleId)));
      if (k < 0) return false;
      used.add(k); return true;
    };
    const net = !s.network ? null : isToolId(s.network) ? own(s.network, ['getNetwork'])
      : windowCall(win, ['getNetwork'], 'getNetwork (without summary)', (c) => c.params?.summary !== true);
    const requests = net?.call ? (net.call.json.result?.requests ?? []) : [];
    const network = requests.filter((x) => ['Fetch', 'XHR'].includes(x?.type) && x?.method).map((x) => ({ method: x.method, url: x.url, status: x.status, ts: iso(x.t), ...(excuse(x) ? { forced: true } : {}) }));
    const excusedUrls = new Set(network.filter((x) => x.forced).map((x) => String(x.url).split(/[?#]/)[0]));
    const forcedLine = (x) => [...excusedUrls].some((url) => String(x?.text ?? x?.message ?? '').includes(url));
    const con = !s.console ? null : isToolId(s.console) ? own(s.console, ['getConsole']) : windowCall(win, ['getConsole'], 'getConsole');
    const consoleRaw = con?.call ? raw('console', (con.call.json.result?.entries ?? []).some((x) => x?.level === 'error' && !forcedLine(x)) ? 'FAIL' : 'PASS', con.call.text)
      : raw('console', 'UNGRADED', `not measurable: ${con?.problem ?? 'getConsole was not called for this state'}`);
    const networkRaw = !net?.call ? raw('network', 'UNGRADED', `not measurable: ${net?.problem ?? 'getNetwork was not called for this state'}`)
      : !requests.length ? raw('network', 'UNGRADED', `not measurable: getNetwork returned an empty window: ${net.call.text}`)
        : raw('network', network.some((x) => x.status >= 400 && !x.forced) ? 'FAIL' : 'PASS', net.call.text);
    // Upgrade integration: the U1/U2/U3 results of a forced state fold into its ui-sanity report (QA GUI's foldUx).
    const det = detectors?.results?.states.get(s.state) ?? null;
    if (det?.ux?.length) {
      // The state's own Gate-0 verdict stays what it was (an UNGRADED report with an empty issue list stays UNGRADED).
      const base = g0Report && typeof g0Report === 'object' ? { ...g0Report, issues: Array.isArray(g0Report.issues) ? g0Report.issues : [], verdict: uiSanity.verdict } : { verdict: uiSanity.verdict, issues: [] };
      const folded = detectors.tools.foldUxInto(base, det.ux, { require: det.uxRequired });
      uiSanity = raw('ui-sanity', folded.verdict, JSON.stringify(folded));
    }
    // The element under test, when the draft names the `do`/runFlow read (`as`) that measured it as {selector, rect}.
    let target = null;
    if (typeof s.target === 'string' && s.target) {
      const tcall = windowCall(win, ['do', 'runFlow'], `do/runFlow with a read step as "${s.target}"`, (c) => gate0Value(c, s.target) !== null);
      const value = tcall.call ? gate0Value(tcall.call, s.target) : null;
      if (value && typeof value.selector === 'string' && value.rect && typeof value.rect === 'object') {
        target = { selector: value.selector, rect: Object.fromEntries(['x', 'y', 'width', 'height'].map((k) => [k, value.rect[k]])) };
      } else issues.push(`TARGET_UNAVAILABLE:${caseId}:${s.state}:${tcall.problem ?? 'its read step holds no {selector, rect}'}`);
    }
    const session = tabSession(calls, shot.call.params?.tabId);
    if (!session) issues.push(`SCREENSHOT_SESSION_UNKNOWN:${caseId}:${s.state}`);
    const receipt = {
      schema: 'qa-gui/state-receipt/v1', caseId, state: s.state, capturedAt: at, url: r.dom?.url ?? null, build: binding.target.frontend_build.id,
      viewport: r.dom?.viewport ?? viewport, domHash: r.domHash ?? null,
      dragon: { sessionId: session?.sessionId ?? null, actionId: r.evidence?.ref ?? `screenshot:${shot.call.id}`, browserInstanceId: session?.browserInstanceId ?? null,
        tabId: String(shot.call.params?.tabId ?? ''), innerOk: r.privacyMasked === true && Boolean(r.savedTo) },
      screenshot: { path: png, sha256: shotSha, ...screenshotExtra },
      ...(target ? { target } : {}),
      function: { verdict: fn, assertions },
      ui: { verdict: 'UNGRADED', uiSanity, a11y, console: consoleRaw, network: networkRaw },
      preflight: preflightRaw, network, network_summary: { failed_requests: network.filter((x) => x.status >= 400 && !x.forced).length },
      readback: { value: { lifecycle: draft.lifecycle ?? null }, evidence_ref: png },
      targetBindingSha256: binding.target_binding_sha256,
    };
    // Upgrade integration: in a case that touched the Dragon environment, every state carries the conditions in force
    // when it was captured (QA GUI's env block); the case's env.reset is named on its last state below.
    const caseEnv = detectors?.results?.env ?? null;
    // Round G: a state with the main action's probe carries its env block even when nothing else touched the tab (QA
    // GUI: a transient probe ran sensors and frames, so its case ends with a verified env.reset).
    if (caseEnv?.touched || det?.probes?.some((p) => p.kind === 'transient')) receipt.env = { conditions: caseEnv?.conditionsAt(shot.call.i) ?? null };
    if (cellTools) {
      const row = (Array.isArray(coverage?.rows) ? coverage.rows : []).find((entry) => entry?.size === receipt.viewport);
      if (!row) issues.push(`CELL_VIEWPORT_ROW_UNKNOWN:${caseId}:${s.state}:${receipt.viewport}`);
      else {
        const action = typeof s.action === 'string' ? s.action : 'view';
        if (!(Array.isArray(plannedCase.actions) ? plannedCase.actions : ['view']).includes(action)) issues.push(`CELL_ACTION_NOT_PLANNED:${caseId}:${s.state}:${action}`);
        // The row count comes only from a read step of the executor's own stream, in this state's window.
        let rows = null;
        if (typeof s.rows === 'string') {
          const counted = windowCall(win, ['do', 'runFlow'], `do/runFlow with a read step as "${s.rows}"`, (c) => rowsValue(c, s.rows) !== null);
          rows = counted.call ? rowsValue(counted.call, s.rows) : null;
          if (rows === null) issues.push(`CELL_ROWS_UNAVAILABLE:${caseId}:${s.state}:${counted.problem}`);
        } else if (ROW_STATES.includes(s.state)) issues.push(`CELL_ROWS_UNAVAILABLE:${caseId}:${s.state}:the draft names no read step of the row count (rows)`);
        receipt.cell = { version: tools.COVERAGE_CELL_VERSION, route: plannedCase.route, state: s.state, action, viewport: row.id,
          conditions: receipt.env && detectors ? detectors.tools.cellConditionsOf(receipt.env.conditions) : {}, ...(rows === null ? {} : { rows }) };
        // QA GUI's own cell checks, as its gate runs them: a cell it refuses cannot back a PASS.
        const refused = tools.stateCellIssues(receipt);
        for (const problem of refused) issues.push(`${problem.code}:${caseId}:${s.state}${problem.detail ? `:${problem.detail}` : ''}`);
        if (refused.length) { fnParts.push('UNGRADED'); uiParts.push('UNGRADED'); }
      }
    }
    // Upgrade integration: the probe receipts QA GUI rebuilt from this state's calls, with their sealed cells
    // (probeCells, from this receipt's own coordinates), joined to the UI verdict by QA GUI's own grader.
    let probeVerdict = null;
    if (det?.probes?.length) {
      const entries = [];
      for (const probe of det.probes) {
        const data = Buffer.from(`${JSON.stringify(probe.receipt, null, 2)}\n`, 'utf8');
        const probeRel = `${dir}/${caseId}/${s.state}.${probe.kind}.json`, probeSha = sha256(data);
        files.push({ data, rel: probeRel });
        manifest.push({ path: probeRel, sha256: probeSha, evidence_type: 'machine-receipt', metadata: meta(s.state, at) });
        evidence.push(probeRel);
        const entry = { kind: probe.kind, path: probeRel, sha256: probeSha };
        if (!['transient', 'entry'].includes(probe.kind)) {
          const sealed = detectors.tools.probeCells({ receipt, caseId, state: s.state, kind: probe.kind, probe: probe.receipt, probeSha256: probeSha });
          const cells = Buffer.from(`${JSON.stringify(sealed, null, 2)}\n`, 'utf8');
          const cellsRel = `${dir}/${caseId}/${s.state}.${probe.kind}.cells.json`;
          files.push({ data: cells, rel: cellsRel });
          manifest.push({ path: cellsRel, sha256: sha256(cells), evidence_type: 'machine-receipt', metadata: meta(s.state, at) });
          evidence.push(cellsRel);
          entry.cells = { path: cellsRel, sha256: sha256(cells) };
        }
        entries.push(entry);
      }
      receipt.probes = entries;
      const memory = new Map(files.filter((f) => f.data).map((f) => [f.rel, f.data]));
      const graded = detectors.tools.probeVerdict({ receipt, caseId, state: s.state, read: (key) => memory.get(key),
        locate: (key) => (memory.has(key) ? { absolute: key, sha256: sha256(memory.get(key)) } : null) });
      if (graded) { for (const entry of graded.issues) issues.push(entry.message); probeVerdict = graded.verdict; }
    }
    for (const file of det ? detectors.results.files.filter((f) => f.state === s.state) : []) {
      if (files.some((f) => f.rel === file.rel)) continue;
      files.push({ from: file.from, rel: file.rel });
      manifest.push({ path: file.rel, sha256: file.sha256, evidence_type: file.evidence_type, metadata: meta(s.state, at) });
      evidence.push(file.rel);
    }
    const ui = tri([uiSanity, a11y, consoleRaw, networkRaw, preflightRaw].map((x) => x.verdict).concat(probeVerdict ? [probeVerdict] : []));
    receipt.ui.verdict = ui;
    receipt.ui.uiSanity = uiSanity;
    const rel = `${dir}/${caseId}/${s.state}.receipt.json`;
    receipts.push({ rel, value: receipt });
    manifest.push({ path: rel, sha256: null, evidence_type: 'machine-receipt', metadata: meta(s.state, at) });
    evidence.push(rel); stateLinks.push({ state: s.state, file: rel });
    fnParts.push(fn); uiParts.push(ui);
    // QA GUI's own image checks, as its gate runs them: a rejected screenshot cannot back a PASS.
    if (tools && shotBytes) {
      const rejected = tools.stateImageIssues({ png: shotBytes, receipt, caseId, state: s.state });
      for (const problem of rejected) issues.push(problem.message);
      if (rejected.length) { fnParts.push('UNGRADED'); uiParts.push('UNGRADED'); }
    }
    // QA GUI's gate wants every vision rule C10–C16 on every settled state and accepts no other rule name: a rule the
    // executor did not judge is UNGRADED, a rule name outside C10–C16 is dropped and reported.
    const judged = new Map((Array.isArray(s.vision) ? s.vision : []).map((v) => [String(v.rule), verdict(v.verdict)]));
    for (const rule of judged.keys()) if (!VISION_RULES.includes(rule)) issues.push(`VISION_RULE_UNKNOWN:${caseId}:${s.state}:${rule}`);
    for (const rule of VISION_RULES) {
      vision.push({ assertion_id: `${caseId}-${s.state}-${rule}`, case_id: caseId, state: s.state, rule, verdict: judged.get(rule) ?? 'UNGRADED', evidence_ref: png, evidence_type: 'gui-screenshot' });
    }
  }
  // Upgrade integration: the case's env.reset (the raw result, as QA GUI's env checks read it) on its last state with an
  // env block; QA GUI's env checks run as its gate will; a detector the case needed that did not run keeps it from PASS.
  if (detectors?.results) {
    const { env, caseIssues } = detectors.results;
    const withEnv = receipts.filter((r) => r.value.env);
    if (env?.reset && withEnv.length) {
      const resetRel = `${dir}/${caseId}/env-reset.json`;
      const data = Buffer.from(`${JSON.stringify(env.reset.json ?? null, null, 2)}\n`, 'utf8');
      files.push({ data, rel: resetRel });
      manifest.push({ path: resetRel, sha256: sha256(data), evidence_type: 'machine-receipt', metadata: meta(withEnv.at(-1).value.state, env.reset.at) });
      evidence.push(resetRel);
      withEnv.at(-1).value.env.reset = { evidence_ref: resetRel };
    }
    const memory = new Map(files.filter((f) => f.data).map((f) => [f.rel, f.data]));
    const envStates = receipts.map(({ value }) => {
      const checked = detectors.tools.stateEnvIssues({ receipt: value, caseId, state: value.state, read: (key) => memory.get(key), locate: (key) => (memory.has(key) ? { absolute: key } : null) });
      for (const entry of checked.issues) issues.push(entry.message);
      if (checked.issues.length) { fnParts.push('UNGRADED'); uiParts.push('UNGRADED'); }
      return checked;
    });
    for (const entry of detectors.tools.caseEnvResetIssues({ caseId, states: envStates })) { issues.push(entry.message); fnParts.push('UNGRADED'); uiParts.push('UNGRADED'); }
    for (const code of detectors.results.issues) if (!issues.includes(code)) issues.push(code);
    for (const state of detectors.results.states.values()) if (state.issues.some((code) => /_NOT_RECORDED[:]/.test(code))) uiParts.push('UNGRADED');
    if (caseIssues.length) uiParts.push('UNGRADED');
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
  return { caseId, files, receipts, manifest, vision, caseEntry, issues,
    evidencePolicy: tools ? { version: tools.EVIDENCE_POLICY_VERSION } : null };
}

// Replace the case, its manifest entries and its vision assertions on the board; other cases stay byte-for-byte.
export function mergeCaseIntoBoard(board, built) {
  const next = structuredClone(board);
  const at = (next.cases ?? []).findIndex((c) => c?.id === built.caseId);
  if (at < 0) throw Object.assign(new Error(`BOARD_CASE_UNKNOWN ${built.caseId}`), { code: 'BOARD_CASE_UNKNOWN' });
  next.cases[at] = built.caseEntry;
  // Evidence made with QA GUI's tools turns its checks on for the whole board (R1f).
  if (built.evidencePolicy) next.evidencePolicy = built.evidencePolicy;
  next.evidenceManifest = [...(next.evidenceManifest ?? []).filter((e) => e?.metadata?.case_id !== built.caseId), ...built.manifest];
  next.vision = { version: next.vision?.version ?? 2, ...(next.vision ?? {}),
    assertions: [...(next.vision?.assertions ?? []).filter((v) => v?.case_id !== built.caseId), ...built.vision] };
  return next;
}

// CLI: verify the attestation (Team QA's own verifier), read its stream, build each drafted case, write the files.
export async function webCollect(args, { parseFlags, readJson, writeConfirmed, stableJson, fail, assertRoleAttestation, lockRunDocuments, runDirectory, safeRunId, evidenceTools, speedTools, detectorTools }) {
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
  // A result Claude Code saved to the attempt's tool-results/ folder is read from there (only that folder).
  const resultsDir = typeof a.session_id === 'string' ? (await import('./roster.mjs')).claudeToolResultsDir({ runDir, attempt: a.session_id }) : null;
  const readPersisted = (path) => (resultsDir && resolve(path).startsWith(`${resolve(resultsDir)}/`) && existsSync(path) ? readFileSync(path, 'utf8') : null);
  const calls = streamCalls(streamText, { readPersisted });
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
  // A Team QA run makes the light, bound evidence QA GUI's evidence policy v1 checks; without those tools it stops.
  const tools = evidenceTools ?? await qaGuiEvidenceTools();
  if (!tools) fail(5, 'WEB_COLLECT_QA_GUI_EVIDENCE_UNAVAILABLE', `${join(siblingSkillRoot('qa-gui'), 'scripts/lib/evidence-quality.mjs')} is missing: install the QA GUI that has evidence policy v1 next to Team QA, or set TEAMQA_QA_GUI_ROOT`, 'ungraded');
  // Upgrade R3: the speed flags of the signed plan (lib/speed-collect.mjs). Every flag off: null, and nothing below changes.
  const { applySpeedToCase, speedForCollect } = await import('./speed-collect.mjs');
  let speed = null;
  try { speed = await speedForCollect({ runDir, speedTools }); } catch (error) { fail(error.code === 'SPEED_QA_GUI_TOOLS_UNAVAILABLE' ? 5 : 2, error.code ?? 'SPEED_POLICY_INVALID', String(error.message), error.code === 'SPEED_QA_GUI_TOOLS_UNAVAILABLE' ? 'ungraded' : undefined); }
  const speedDecisions = [];
  // Upgrade integration: QA GUI's stream detectors (lib/detector-collect.mjs). Without them collect runs as before.
  const dispatch = await import('./detector-dispatch.mjs');
  const { caseDetectorResults } = await import('./detector-collect.mjs');
  const detectorsOf = detectorTools === undefined ? await dispatch.qaGuiDetectorTools() : detectorTools;
  const explorationPolicy = detectorsOf && tracked.coverage ? await dispatch.runExplorationPolicy({ runDir, tracked }) : null;
  // Fix round 1 (D1): the run's screen checks, collected once per screen (screen-checks.mjs), folded into each case.
  const screenTools = await import('./screen-checks.mjs');
  let origin = null; try { origin = new URL(binding.target?.preview_url).origin; } catch { origin = null; }
  const screenPlan = screenTools.screenPlan(tracked, { origin });
  const explored = [];
  let next = board;
  const report = [];
  for (const draft of drafts) {
    const problems = draftIssues(draft, { caseIds, caseId: scope });
    if (problems.length) fail(2, problems[0], problems.slice(1).join(' '));
    const plannedCase = tracked.cases.find((c) => c.id === draft.case_id);
    // D7 (fix round 2): a case of a parallel lane proves the Dragon session and account it really used.
    const laneUse = await (await import('./parallel-lanes.mjs')).parallelLaneUseIssues({ runDir, caseId: draft.case_id, calls, draft });
    if (laneUse.length) fail(2, 'PARALLEL_LANE_USE_UNPROVEN', laneUse.join(' '));
    // Fix round 2 (E1): only attested attempts of each screen check, verified and graded again from their streams.
    const screensOf = detectorsOf ? await screenTools.caseScreens({ runDir, plan: screenPlan, caseId: draft.case_id, assertRoleAttestation, tools: detectorsOf }) : null;
    const found = detectorsOf ? await caseDetectorResults({ draft, calls, shots: stateScreenshots(draft, calls), tools: detectorsOf, plannedCase, tracked,
      explorationPolicy, exists, fileSha, screens: screensOf.screens }) : null;
    const results = found ? { ...found, issues: [...found.issues, ...screensOf.refused] } : null;
    let built = buildCaseEvidence({ draft, calls, binding, plannedCase,
      boardCase: (board.cases ?? []).find((c) => c?.id === draft.case_id), viewport: board.viewport ?? null, preflightRaw,
      fileSha, exists, tools, readFile: (path) => readFileSync(path), coverage: tracked.coverage ?? null, detectors: results ? { tools: detectorsOf, results } : null });
    if (results?.exploration) {
      const data = Buffer.from(`${JSON.stringify(results.exploration.log, null, 2)}\n`, 'utf8');
      const rel = `evidence/qa-gui/${draft.case_id}/explore.json`;
      built = { ...built, files: [...built.files, { data, rel }] };
      explored.push(rel);
    }
    if (speed) {
      const applied = applySpeedToCase({ built, draft, calls, policy: speed.policy, tools: speed.tools, baselines: speed.baselines, plannedCase, readFile: (path) => readFileSync(path) });
      if (applied.refuse) fail(2, applied.refuse.split(':')[0], applied.refuse.slice(applied.refuse.indexOf(':') + 1));
      built = { ...applied.built, issues: [...applied.built.issues, ...applied.issues] };
      speedDecisions.push(...applied.decisions);
    }
    for (const f of built.files) {
      const dest = join(runDir, f.rel); mkdirSync(dirname(dest), { recursive: true });
      if (f.data) writeFileSync(dest, f.data); else copyFileSync(f.from, dest);
    }
    for (const r of built.receipts) {
      await writeConfirmed(join(runDir, r.rel), stableJson(r.value), 'teamqa.web.collect.receipt');
      const entry = built.manifest.find((m) => m.path === r.rel); entry.sha256 = fileSha(join(runDir, r.rel));
    }
    next = mergeCaseIntoBoard(next, built);
    report.push({ case: built.caseId, status: built.caseEntry.status, function: built.caseEntry.functionVerdict, ui: built.caseEntry.uiVerdict,
      states: built.caseEntry.states.length, files: built.files.length + built.receipts.length, issues: built.issues.slice(0, 6) });
  }
  // The run's app map (QA GUI qa-gui/app-map/v2, read by the coverage map as runs/<id>/app-map.json): every exploration
  // log the executor's cases left in the run, in case order.
  if (explored.length) {
    const { APP_MAP_FILE } = await import('./coverage-cells.mjs');
    const logs = tracked.cases.map((c) => join(runDir, 'evidence/qa-gui', c.id, 'explore.json')).filter((path) => existsSync(path))
      .flatMap((path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; } });
    const map = detectorsOf.buildAppMapV2(logs.map((entry, index) => ({ ...entry, step: index + 1 })));
    await writeConfirmed(join(runDir, APP_MAP_FILE), `${JSON.stringify(map, null, 2)}\n`, 'teamqa.web.collect.app-map');
  }
  if (speed) {
    const { appendSpeedDecision } = await import('./cost-ladder.mjs');
    for (const decision of speedDecisions) await appendSpeedDecision(runDir, decision);
    const { boardSpeedPolicy } = await import('./speed.mjs');
    const policy = boardSpeedPolicy(speed.policy, { storePath: speed.baselines?.rel ?? null });
    if (policy) next = { ...next, speedPolicy: policy };
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
  return { run_id: runId, board: relative(process.cwd(), boardPath), attestation: relative(process.cwd(), attestationPath), cases: report, relocked,
    ...(speed ? { speed: { flags: speed.policy.flags, decisions: speedDecisions.length } } : {}) };
}
