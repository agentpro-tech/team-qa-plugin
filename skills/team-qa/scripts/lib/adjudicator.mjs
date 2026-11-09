// Independent adjudicator (upgrade R2a). The contract is in docs/adjudicator-contract.md.
//
// A model of another family than the executor's (the roster's adjudicator seat) judges one executed case from the
// requirement, the case, a checklist frozen before any evidence was shown, the GUI action chain with ids and the raw
// evidence, never from the executor's verdict or narrative. Every call goes through the engine interface of
// adjudicator-engine.mjs; this module builds each exact input, audits it, validates the answer and records it:
//
//   runs/<id>/adjudication/<case>/checklist-input.txt   exact text of the checklist call (requirement + case only)
//                                 checklist.json        the frozen checklist; its SHA-256 goes into the judge payload
//                                 attempt-<n>/payload.json, input.txt, audit.json, output.txt, result.json
//   runs/<id>/dispatch/adjudicator/<attempt>/state.json (+ stdout.jsonl of a CLI harness), read by the R0 time and
//   cost receipts like any worker attempt.
//
// By default (scope pass_only) only PASS cases are adjudicated, the only verdict it can change; scope all judges every
// executed case. The adjudicator only keeps or lowers a PASS: CONTEST sends a PASS to UNGRADED, CONFIRM and ABSTAIN keep it, and no
// outcome ever makes a case PASS or FAIL. In shadow mode (the default) nothing is applied: the report shows what the
// verdicts would be if it were on. A pointer that does not resolve to the evidence the engine was given, an input that
// fails its audit, or an answer that breaks the output contract all become ABSTAIN.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { emit, fail, parseFlags, readJson, safeRunId, sha256, sha256File, stableJson, writeConfirmed } from './core.mjs';
import { streamCalls } from './web-collect.mjs';
import { attemptId, effectiveAttempt } from './attempt-sequence.mjs';
import { collectRunSecrets, isSecretKey, maskSecrets } from './test-secrets.mjs';
import { loadPlan } from './validators.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const POLICY_FILE = join(ROOT, 'references/adjudicator-policy.json');
const INSTRUCTIONS_FILE = join(ROOT, 'references/adjudicator-instructions.md');

export const SCHEMAS = {
  checklistRequest: 'team-qa/adjudicator-checklist-request/v1', checklist: 'team-qa/adjudicator-checklist/v1',
  payload: 'team-qa/adjudicator-payload/v1', audit: 'team-qa/adjudicator-input-audit/v1', result: 'team-qa/adjudication/v1',
  report: 'team-qa/adjudication-report/v1',
};
export const ITEM_STATUSES = ['SUPPORTED', 'CONTRADICTED', 'INSUFFICIENT'];
export const ADJUDICATION_OUTCOMES = ['CONFIRM', 'CONTEST', 'ABSTAIN'];
export const POINTER_KINDS = ['file', 'image_region', 'timestamp', 'selector', 'action'];
export const MARKERS = { start: 'TEAMQA_ADJUDICATOR_PAYLOAD_START', end: 'TEAMQA_ADJUDICATOR_PAYLOAD_END', checklist: 'TEAMQA_ADJUDICATOR_CHECKLIST v1', judge: 'TEAMQA_ADJUDICATION v1' };
// Standalone values that are a verdict, and keys that hold one or a narrative; neither may appear in a payload.
const VERDICT_WORDS = ['pass', 'passed', 'fail', 'failed', 'ungraded', 'blocked'];
const VERDICT_KEY = /^(?:verdicts?|[a-z0-9_]*_verdict|executor_[a-z0-9_]*|narrative|conclusion|assessment)$/i;
// Keys of an action's parameters that hold what the executor thought rather than what it did.
const THOUGHT_KEYS = new Set(['reason', 'why', 'rationale', 'description', 'note', 'notes', 'comment', 'comments', 'explanation', 'intent', 'thought', 'thoughts', 'verdict', 'assessment', 'conclusion', 'narrative']);
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RAW_TYPES = new Set(['gui-screenshot', 'gui-recording', 'recording-manifest', 'dom-snapshot', 'network-log', 'console-log']);
const IMAGE_EXT = /\.(?:png|jpe?g|webp)$/i, VIDEO_EXT = /\.(?:mp4|mov|webm)$/i, TEXT_EXT = /\.(?:html?|txt|log|json|jsonl|har|csv|xml)$/i;
// Files that hold a verdict or what a role wrote, never raw evidence.
const NOT_RAW_NAME = /(?:^|[/._-])(?:verdicts?|receipts?|attestations?|draft|report|narrative|qa-board|rtm|roster|board\.jsonl|test-plan|tracked-plan)(?:[/._-]|$)/i;
const NOT_RAW_DIRS = ['role-bindings/', 'attestations/', 'control/', 'adjudication/', 'dispatch/', 'native-dispatch/', 'prompts/', 'inputs/'];

const refuse = (code, detail = '') => fail(3, code, detail, 'ungraded');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
const equalJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const readJsonSafe = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (isObject(value)) for (const v of Object.values(value)) strings(v, out);
  return out;
}

export function adjudicatorPolicy() { return readJson(POLICY_FILE, { label: 'adjudicator-policy.json' }); }
// The seat's scope, or the policy default (pass_only) for a seat that names none.
export const scopeOf = (seat, policy = adjudicatorPolicy()) => seat?.scope ?? policy.scope;
export const adjudicationDir = (runDir, caseId) => join(resolve(runDir), 'adjudication', caseId);
export const attemptDirOf = (runDir, caseId, attempt) => join(adjudicationDir(runDir, caseId), `attempt-${attempt}`);
function checkCaseId(caseId) { if (typeof caseId !== 'string' || !CASE_ID.test(caseId)) fail(2, 'ADJUDICATE_CASE_ID', String(caseId)); return caseId; }

// What the adjudicator may do to a verdict: keep it, or lower a PASS to UNGRADED on CONTEST. Nothing else.
export function adjudicatedVerdict(verdict, outcome) { return verdict === 'pass' && outcome === 'CONTEST' ? 'ungraded' : verdict; }
// The overall outcome of judged items: CONFIRM only when every item is SUPPORTED.
export function deriveOutcome(items) { return items.length > 0 && items.every((i) => i.status === 'SUPPORTED') ? 'CONFIRM' : 'CONTEST'; }

// ---------------------------------------------------------------------------------------------------------------
// Inputs: the exact text an engine receives is a header, the instructions and one payload between markers.
export function renderInput(phase, payload) {
  return `TEAMQA_ADJUDICATOR v1 phase=${phase} run=${payload.run_id} case=${payload.case_id}\n\n${readFileSync(INSTRUCTIONS_FILE, 'utf8')}\n${MARKERS.start}\n${JSON.stringify(payload, null, 2)}\n${MARKERS.end}\n`;
}
export function payloadFromInput(text) {
  const from = text.indexOf(MARKERS.start), to = text.lastIndexOf(MARKERS.end);
  if (from < 0 || to < from) return null;
  try { return JSON.parse(text.slice(from + MARKERS.start.length, to)); } catch { return null; }
}
function maskDeep(value, secrets) {
  if (!secrets.length) return value;
  if (typeof value === 'string') return maskSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, secrets));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, secrets)]));
  return value;
}
function redactSecretKeys(value) {
  if (Array.isArray(value)) return value.map(redactSecretKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isSecretKey(k) || /^nonce$/i.test(k) ? '[redacted]' : redactSecretKeys(v)]));
}

// The requirement and the case, from the tracked plan (and the tier from the signed plan when it is there).
export function caseInputs(runDir, caseId) {
  const trackedPath = join(runDir, 'tracked-plan.json');
  if (!existsSync(trackedPath)) refuse('ADJUDICATE_TRACKED_PLAN_MISSING', trackedPath);
  const tracked = readJson(trackedPath, { label: 'tracked-plan.json' });
  const kase = (tracked.cases ?? []).find((c) => c?.id === caseId);
  if (!kase || !Array.isArray(kase.steps) || typeof kase.expected !== 'string') refuse('ADJUDICATE_CASE_UNKNOWN', caseId);
  let tier = null;
  const planPath = join(runDir, 'test-plan.md');
  if (existsSync(planPath)) { try { tier = loadPlan(planPath).value?.tiers?.[kase.req_id] ?? null; } catch { tier = null; } }
  const sources = (kase.sourceRefs ?? []).map((ref) => (tracked.sourceItems ?? []).find((s) => s?.id === ref)).filter(Boolean)
    .map((s) => ({ id: s.id, kind: s.kind ?? null, system: s.sourceSystem ?? null, key: s.externalKey ?? null, title: s.title ?? null }));
  return {
    requirement: { id: kase.req_id ?? null, tier, sources },
    case: { id: kase.id, title: kase.title ?? null, priority: kase.priority ?? null, kind: kase.kind ?? null,
      steps: kase.steps.map((text, i) => ({ id: `step:${i + 1}`, text: String(text) })), expected: kase.expected,
      data: redactSecretKeys(isObject(kase.data) ? kase.data : {}), states: kase.states ?? [], viewports: kase.viewports ?? [] },
  };
}
export function baselineItems(kase) {
  return [...kase.steps.map((s, i) => ({ id: `S${i + 1}`, text: `Step ${i + 1} was carried out as written: ${s.text}`, origin: 'case-step', refs: [s.id] })),
    { id: 'E1', text: `The expected result holds: ${kase.expected}`, origin: 'case-expected', refs: ['expected'] }];
}

// The JSON block after the last marker of an answer.
export function parseMarkedJson(text, marker) {
  const at = String(text ?? '').lastIndexOf(marker);
  if (at < 0) return { ok: false };
  const rest = String(text).slice(at + marker.length);
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(rest);
  const body = fenced ? fenced[1] : rest.slice(rest.indexOf('{'), rest.lastIndexOf('}') + 1);
  try { return { ok: true, value: JSON.parse(body) }; } catch { return { ok: false }; }
}

// The blind workspace of one engine call (fix round 1, TQ-5): a fresh directory outside the run directory holding only
// byte copies of the payload's evidence at the paths the payload names (`rel`). The engine's cwd is this directory, so
// its Read/Glob/Grep (or a read-only sandbox) can open no board record, receipt, executor stream or draft. Removed
// after the call.
function blindWorkspace(runDir, files) {
  const ws = mkdtempSync(join(tmpdir(), 'teamqa-adjudicator-'));
  const base = resolve(runDir), out = new Map();
  for (const file of files) {
    const abs = resolve(base, file.rel), to = resolve(ws, file.rel);
    if (!abs.startsWith(`${base}/`) || !to.startsWith(`${ws}/`)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(abs, to);
    out.set(abs, to);
  }
  return { dir: ws, pathOf: (abs) => out.get(resolve(abs)) ?? null, remove: () => rmSync(ws, { recursive: true, force: true }) };
}

// One engine call, recorded as an attempt of role adjudicator where the R0 time and cost receipts read attempts.
async function engineCall({ runDir, engine, phase, input, caseId, images, files = [] }) {
  const attempt = randomUUID(), dir = join(runDir, 'dispatch', 'adjudicator', attempt), started = new Date().toISOString();
  const state = { schema: 'team-qa/dispatch-state/v1', attempt, role: 'adjudicator', case_id: caseId, phase, status: 'running', started_at: started, pid: process.pid };
  await writeConfirmed(join(dir, 'state.json'), stableJson(state), 'teamqa.adjudicator.state');
  let out = null, error = null, ws = null;
  try {
    ws = blindWorkspace(runDir, files);
    out = await engine.call({ phase, input, attempt, runDir: ws.dir, images: images.map((p) => ws.pathOf(p)).filter(Boolean) });
  } catch (e) { error = e; out = e?.transport ?? null; } finally { ws?.remove(); }
  if (typeof out?.stdout === 'string') await writeConfirmed(join(dir, 'stdout.jsonl'), out.stdout, 'teamqa.adjudicator.stdout');
  if (typeof out?.stderr === 'string') await writeConfirmed(join(dir, 'stderr.txt'), out.stderr, 'teamqa.adjudicator.stderr');
  const ended = new Date().toISOString(), code = error ? (/^[A-Z][A-Z_]+$/.test(String(error.code ?? '')) ? error.code : 'ENGINE_FAILED') : null;
  await writeConfirmed(join(dir, 'state.json'), stableJson({ ...state, status: error ? 'failed' : 'done', ended_at: ended, ...(error ? { code, detail: String(error.message ?? error).slice(0, 300) } : {}) }), 'teamqa.adjudicator.state');
  return { attempt, output: error ? null : String(out?.output ?? ''), session_id: out?.session_id ?? null, error: code, started_at: started, ended_at: ended };
}

// ---------------------------------------------------------------------------------------------------------------
// The checklist: one item per case step and one for the expected result, plus what the engine derives from the
// requirement alone. It is frozen (written once, hashed) before any evidence of the case is shown to an engine.
function requirementItems(value, policy) {
  const max = policy.limits.requirement_items_max, chars = policy.limits.item_text_chars_max;
  if (!isObject(value) || Object.keys(value).some((k) => k !== 'items') || !Array.isArray(value.items) || value.items.length > max) return { ok: false, code: 'CHECKLIST_OUTPUT_SCHEMA' };
  for (const item of value.items) if (!isObject(item) || Object.keys(item).some((k) => k !== 'text') || typeof item.text !== 'string' || !item.text.trim() || item.text.length > chars) return { ok: false, code: 'CHECKLIST_OUTPUT_SCHEMA' };
  return { ok: true, items: value.items.map((item, i) => ({ id: `R${i + 1}`, text: item.text.trim(), origin: 'requirement', refs: ['requirement'] })) };
}
export async function freezeChecklist({ runDir, caseId, seat, engine, policy = adjudicatorPolicy() }) {
  runDir = resolve(runDir); checkCaseId(caseId);
  const dir = adjudicationDir(runDir, caseId), path = join(dir, 'checklist.json');
  if (existsSync(path)) refuse('ADJUDICATOR_CHECKLIST_FROZEN', path);
  if (existsSync(dir) && readdirSync(dir).some((name) => name.startsWith('attempt-'))) refuse('ADJUDICATOR_EVIDENCE_ALREADY_SHOWN', caseId);
  const inputs = caseInputs(runDir, caseId), secrets = collectRunSecrets(runDir).secrets;
  const request = maskDeep({ schema: SCHEMAS.checklistRequest, run_id: basename(runDir), case_id: caseId, requirement: inputs.requirement, case: inputs.case, baseline_items: baselineItems(inputs.case) }, secrets);
  const input = renderInput('checklist', request);
  await writeConfirmed(join(dir, 'checklist-input.txt'), input, 'teamqa.adjudicator.checklist.input', { exclusive: true });
  const call = await engineCall({ runDir, engine, phase: 'checklist', input, caseId, images: [] });
  if (call.output !== null) await writeConfirmed(join(dir, 'checklist-output.txt'), call.output, 'teamqa.adjudicator.checklist.output');
  let status = call.error ?? 'OK', extra = [];
  if (!call.error) {
    const parsed = parseMarkedJson(call.output, MARKERS.checklist);
    const checked = parsed.ok ? requirementItems(parsed.value, policy) : { ok: false, code: 'ENGINE_OUTPUT_INVALID' };
    if (checked.ok) extra = maskDeep(checked.items, secrets); else status = checked.code;
  }
  const checklist = { schema: SCHEMAS.checklist, run_id: basename(runDir), case_id: caseId, input_sha256: sha256(input), output_sha256: call.output !== null ? sha256(call.output) : null,
    engine: { kind: engine.kind ?? null, provider: seat.provider, model: seat.model, family: seat.family, harness: seat.harness, attempt: call.attempt, session_id: call.session_id },
    requirement_items: status, items: [...request.baseline_items, ...extra], frozen_at: new Date().toISOString() };
  await writeConfirmed(path, stableJson(checklist), 'teamqa.adjudicator.checklist.freeze', { exclusive: true });
  return checklist;
}

// ---------------------------------------------------------------------------------------------------------------
// The executor's record, its stream and what it said: the verdict, the narrative, the evidence draft.
function executorRecord(runDir, caseId, attempt = null) {
  const path = join(runDir, 'board.jsonl');
  if (!existsSync(path)) refuse('ADJUDICATE_BOARD_MISSING', path);
  const records = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r?.case_id === caseId && ['pass', 'fail', 'ungraded'].includes(r.verdict));
  const record = attempt === null ? records.at(-1) : records.find((r) => effectiveAttempt(r) === attempt);
  if (!record) refuse('ADJUDICATE_CASE_NOT_EXECUTED', `${caseId}${attempt === null ? '' : ` attempt ${attempt}`}`);
  return record;
}
function inside(runDir, path) { try { const real = realpathSync(path), base = realpathSync(runDir); return real.startsWith(`${base}/`); } catch { return false; } }
function executorStream(runDir, attestationPath, caseId) {
  if (!attestationPath || !existsSync(attestationPath)) refuse('ADJUDICATE_ATTESTATION_REQUIRED', String(attestationPath ?? '--attestation'));
  const a = readJson(attestationPath, { label: basename(attestationPath) });
  if (a?.role !== 'executor_gui') refuse('ADJUDICATE_ATTESTATION_ROLE', String(a?.role));
  // Fix round 2 (E8): a screen check's attestation is no case's stream.
  if (Object.hasOwn(a, 'dispatch_screen_id')) refuse('ADJUDICATE_ATTESTATION_SCREEN', `${a.dispatch_screen_id} is a screen check, not ${caseId}`);
  if (Object.hasOwn(a, 'dispatch_case_id') && a.dispatch_case_id !== caseId) refuse('ADJUDICATE_ATTESTATION_CASE', `${a.dispatch_case_id} != ${caseId}`);
  const path = resolve(runDir, String(a.source?.path ?? ''));
  if (!inside(runDir, path) || !statSync(path).isFile() || sha256File(path) !== a.source?.sha256) refuse('ADJUDICATE_STREAM_HASH', path);
  return { path, rel: relative(runDir, path), sha256: a.source.sha256, text: readFileSync(path, 'utf8'), attestation: { rel: relative(runDir, resolve(attestationPath)), sha256: sha256File(attestationPath) } };
}
function assistantTexts(stream) {
  const out = [];
  for (const line of stream.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'assistant' && Array.isArray(e.message?.content)) for (const c of e.message.content) { if (c?.type === 'text' && typeof c.text === 'string') out.push(c.text); }
    if (e?.type === 'result' && typeof e.result === 'string') out.push(e.result);
    if (e?.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') out.push(e.item.text);
  }
  return out;
}
function jsonBlockStrings(text) {
  const out = [];
  for (const m of String(text).matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) { try { strings(JSON.parse(m[1]), out); } catch { /* not JSON */ } }
  return out;
}
// Prose of at least four words and the policy's length, line by line and sentence by sentence.
function fragmentsOf(text, minChars) {
  return String(text).split(/\n+|(?<=[.!?])\s+/).map((s) => norm(s.replace(/^[\s>*#`|-]+|[`*|]+$/g, ''))).filter((s) => s.length >= minChars && s.split(' ').length >= 4);
}
// What the input must not contain: the executor's prose (minus what it copied from the plan or from a tool result,
// which are not its words), its record's reason code, and references to the files that hold its verdict.
export function executorTraces({ record, stream, child = null, planTexts = [], policy = adjudicatorPolicy() }) {
  const min = policy.limits.narrative_fragment_min_chars, fragments = new Set();
  for (const text of assistantTexts(stream.text)) { for (const f of fragmentsOf(text, min)) fragments.add(f); for (const v of jsonBlockStrings(text)) for (const f of fragmentsOf(v, min)) fragments.add(f); }
  if (typeof record?.reason === 'string') for (const f of fragmentsOf(record.reason, min)) fragments.add(f);
  if (child?.text) { let parsed = null; try { parsed = JSON.parse(child.text); } catch { parsed = null; } for (const v of parsed ? strings(parsed) : [child.text]) for (const f of fragmentsOf(v, min)) fragments.add(f); }
  const copied = norm([...planTexts, ...[...streamCalls(stream.text).values()].map((c) => c.text).filter((t) => typeof t === 'string')].join('\n'));
  const tokens = [record?.child_verdict?.artifact, child?.sha256, stream.rel, stream.sha256, stream.attestation?.rel, 'board.jsonl', 'role-bindings/', '.receipt.json', 'TEAMQA_EVIDENCE_DRAFT',
    ...(typeof record?.reason === 'string' && record.reason.length >= 8 && !/\s/.test(record.reason) ? [record.reason] : [])].filter(Boolean);
  return {
    fragments: [...fragments].filter((f) => !copied.includes(f)), tokens, verdict_words: VERDICT_WORDS,
    sources: [{ kind: 'executor-stream', rel: stream.rel, sha256: stream.sha256 }, { kind: 'board-record', attempt_id: attemptId(record) },
      ...(child ? [{ kind: 'child-verdict', rel: child.rel, sha256: child.sha256 }] : [])],
  };
}

// The input audit. It runs over the exact texts an engine receives and the text files they let it read: no verdict
// key, no standalone verdict value in a payload, no fragment of the executor's prose, no reference to its verdict
// files. A finding names where, the kind and a hash of what matched, never the text itself.
function textFindings(where, text, traces) {
  const findings = [], corpus = norm(text);
  for (const f of traces.fragments ?? []) if (corpus.includes(norm(f))) findings.push({ kind: 'EXECUTOR_NARRATIVE', where, sha256: sha256(norm(f)) });
  for (const t of traces.tokens ?? traces.paths ?? []) if (text.includes(t)) findings.push({ kind: 'EXECUTOR_REFERENCE', where, sha256: sha256(t) });
  return findings;
}
function jsonFindings(where, value, words, { values = true } = {}) {
  const findings = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) { if (VERDICT_KEY.test(k)) findings.push({ kind: 'VERDICT_KEY', where: `${where}:${path}.${k}` }); walk(x, `${path}.${k}`); }
    else if (values && typeof v === 'string' && words.includes(v.trim().toLowerCase())) findings.push({ kind: 'VERDICT_VALUE', where: `${where}:${path}` });
  };
  walk(value, '$');
  return findings;
}
export function auditInput({ inputs, textFiles = [], traces }) {
  const words = traces.verdict_words ?? VERDICT_WORDS, findings = [];
  for (const { name, text } of inputs) {
    const payload = payloadFromInput(text);
    if (!payload) { findings.push({ kind: 'PAYLOAD_UNREADABLE', where: name }); continue; }
    findings.push(...jsonFindings(name, payload, words));
    const head = text.slice(0, text.indexOf(MARKERS.start));
    findings.push(...textFindings(name, `${head}\n${strings(payload).join('\n')}\n${JSON.stringify(payload)}`, traces));
  }
  for (const file of textFiles) {
    findings.push(...textFindings(file.rel, file.text, traces));
    let parsed = null; try { parsed = JSON.parse(file.text); } catch { parsed = null; }
    if (parsed !== null) findings.push(...jsonFindings(file.rel, parsed, words, { values: false }));
  }
  return { clean: findings.length === 0, findings,
    checked: { inputs: inputs.length, text_files: textFiles.length, fragments: (traces.fragments ?? []).length, tokens: (traces.tokens ?? traces.paths ?? []).length,
      verdict_words: words, verdict_keys: VERDICT_KEY.source, sources: traces.sources ?? [] } };
}

// ---------------------------------------------------------------------------------------------------------------
// The action chain: the GUI tool calls of the executor's stream, in order, with ids, parameters (without what the
// executor wrote about them), times and an excerpt of each raw tool result. No assistant text is ever part of it.
function cleanParams(value) {
  if (Array.isArray(value)) return value.map(cleanParams);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !THOUGHT_KEYS.has(k.toLowerCase())).map(([k, v]) => [k, isSecretKey(k) || /^nonce$/i.test(k) ? '[redacted]' : cleanParams(v)]));
}
export function actionChain(streamText, policy = adjudicatorPolicy()) {
  const max = policy.limits.action_result_chars;
  return [...streamCalls(streamText).values()].filter((c) => /dragon/i.test(String(c.name))).sort((a, b) => a.i - b.i).slice(0, policy.limits.actions_max)
    .map((c, n) => ({ id: `A${n + 1}`, tool_use_id: c.id, tool: c.name, method: c.method ?? null, params: cleanParams(c.params ?? {}), called_at: c.called_at ?? null, result_at: c.at ?? null,
      is_error: c.error === true, result_excerpt: typeof c.text === 'string' ? c.text.slice(0, max) : null, result_chars: typeof c.text === 'string' ? c.text.length : 0,
      result_sha256: typeof c.text === 'string' ? sha256(c.text) : null }));
}

// ---------------------------------------------------------------------------------------------------------------
// Raw evidence: images, recordings and text captures of the case, never a verdict, receipt or role-written file.
export function imageSize(b) {
  if (!Buffer.isBuffer(b)) return null;
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), media_type: 'image/png' };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i += 1; continue; }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
      if (m === 0xd9 || m === 0xda) break;
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), media_type: 'image/jpeg' };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), media_type: 'image/webp' };
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, media_type: 'image/webp' };
    if (kind === 'VP8L') { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, media_type: 'image/webp' }; }
  }
  return null;
}
// The duration in its movie header (moov/mvhd) of an MP4 or QuickTime file; null for anything else.
export function mp4DurationMs(b) {
  if (!Buffer.isBuffer(b) || b.length < 8) return null;
  const find = (start, end, type) => {
    for (let i = start; i + 8 <= end;) {
      let size = b.readUInt32BE(i), header = 8;
      const t = b.toString('latin1', i + 4, i + 8);
      if (size === 1) { if (i + 16 > end) return null; size = Number(b.readBigUInt64BE(i + 8)); header = 16; } else if (size === 0) size = end - i;
      if (size < header || i + size > end) return null;
      if (t === type) return { start: i + header, end: i + size };
      i += size;
    }
    return null;
  };
  try {
    const moov = find(0, b.length, 'moov'), mvhd = moov && find(moov.start, moov.end, 'mvhd');
    if (!mvhd) return null;
    const v1 = b[mvhd.start] === 1, timescale = b.readUInt32BE(mvhd.start + (v1 ? 20 : 12)), duration = v1 ? Number(b.readBigUInt64BE(mvhd.start + 24)) : b.readUInt32BE(mvhd.start + 16);
    return timescale > 0 ? Math.round((duration * 1000) / timescale) : null;
  } catch { return null; }
}
const TEXT_TYPES = { '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain', '.log': 'text/plain', '.json': 'application/json', '.jsonl': 'application/jsonl', '.har': 'application/json', '.csv': 'text/csv', '.xml': 'application/xml' };
const lineCount = (text) => (text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
function describeEvidence(runDir, abs, id) {
  const bytes = readFileSync(abs), ext = extname(abs).toLowerCase();
  const base = { id, rel: relative(runDir, abs), path: abs, sha256: sha256(bytes), bytes: bytes.length };
  if (IMAGE_EXT.test(abs)) { const size = imageSize(bytes); return size ? { ...base, kind: 'image', media_type: size.media_type, width: size.width, height: size.height } : null; }
  if (VIDEO_EXT.test(abs)) return { ...base, kind: 'video', media_type: ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4', duration_ms: ext === '.webm' ? null : mp4DurationMs(bytes) };
  if (TEXT_EXT.test(abs)) return { ...base, kind: 'text', media_type: TEXT_TYPES[ext] ?? 'text/plain', lines: lineCount(bytes.toString('utf8')) };
  return null;
}
function collectEvidence({ runDir, caseId, boardPath, evidencePaths, record, traces, policy }) {
  const wanted = [], excluded = [], seen = new Set();
  const exclude = (rel, reason) => { if (!excluded.some((e) => e.rel === rel)) excluded.push({ rel, reason }); };
  if (boardPath) {
    const board = readJson(resolve(boardPath), { label: basename(boardPath) });
    for (const e of Array.isArray(board?.evidenceManifest) ? board.evidenceManifest : []) {
      if (e?.metadata?.case_id !== caseId || typeof e.path !== 'string') continue;
      if (!RAW_TYPES.has(e.evidence_type)) exclude(e.path, 'NOT_RAW_EVIDENCE'); else wanted.push(e.path);
    }
  }
  wanted.push(...evidencePaths);
  const child = record?.child_verdict?.artifact ? resolve(runDir, record.child_verdict.artifact) : null;
  const evidence = [], textFiles = [];
  let bytes = 0;
  for (const value of wanted) {
    const abs = isAbsolute(value) ? resolve(value) : resolve(runDir, value), rel = relative(runDir, abs);
    if (seen.has(abs) || excluded.some((e) => e.rel === rel)) continue;
    seen.add(abs);
    if (!existsSync(abs) || !statSync(abs).isFile()) { exclude(rel, 'MISSING'); continue; }
    if (!inside(runDir, abs)) { exclude(rel, 'OUTSIDE_RUN'); continue; }
    if (abs === child || NOT_RAW_NAME.test(rel) || NOT_RAW_DIRS.some((d) => rel.startsWith(d))) { exclude(rel, 'NOT_RAW_EVIDENCE'); continue; }
    if (evidence.length >= policy.limits.evidence_files_max || bytes + statSync(abs).size > policy.limits.evidence_bytes_max) { exclude(rel, 'LIMIT'); continue; }
    const item = describeEvidence(runDir, abs, null);
    if (!item) { exclude(rel, 'UNSUPPORTED_TYPE'); continue; }
    if (item.kind === 'text') {
      const text = readFileSync(abs, 'utf8');
      const findings = auditInput({ inputs: [], textFiles: [{ rel, text }], traces }).findings;
      if (findings.length) { exclude(rel, 'EXECUTOR_TEXT'); continue; }
      textFiles.push({ rel, text });
    }
    bytes += item.bytes;
    evidence.push(item);
  }
  evidence.forEach((item, i) => { item.id = `E${i + 1}`; });
  return { evidence: evidence.map(({ id, ...rest }) => ({ id, ...rest })), excluded, textFiles };
}

// ---------------------------------------------------------------------------------------------------------------
// Pointers. Each resolves only to evidence the engine was given, unchanged since, and only inside it.
export function pointerContext({ runDir, payload }) {
  const evidence = new Map([...(payload.evidence ?? []), ...(payload.baseline ? [payload.baseline] : [])].map((e) => [e.id, e]));
  const actions = new Map((payload.action_chain ?? []).map((a) => [a.id, a]));
  const times = [...actions.values()].flatMap((a) => [a.called_at, a.result_at]).map((t) => Date.parse(t)).filter(Number.isFinite);
  const used = new Set([...actions.values()].flatMap((a) => strings(a.params)));
  return { runDir: resolve(runDir), payload, evidence, actions, used, window: times.length ? { from: Math.min(...times), to: Math.max(...times) } : null, cache: new Map() };
}
const no = (reason) => ({ ok: false, reason });
function evidenceBytes(ctx, id) {
  const item = ctx.evidence.get(id);
  if (!item) return { error: 'EVIDENCE_UNKNOWN' };
  if (!ctx.cache.has(id)) {
    const abs = resolve(ctx.runDir, item.rel);
    let bytes = null; try { bytes = readFileSync(abs); } catch { bytes = null; }
    ctx.cache.set(id, bytes === null ? { error: 'EVIDENCE_MISSING' } : sha256(bytes) !== item.sha256 ? { error: 'EVIDENCE_CHANGED' } : { item, bytes });
  }
  return ctx.cache.get(id);
}
const POINTER_FIELDS = { file: ['kind', 'evidence', 'line'], image_region: ['kind', 'evidence', 'x', 'y', 'w', 'h'], timestamp: ['kind', 'evidence', 't_ms', 'at'], selector: ['kind', 'selector', 'evidence'], action: ['kind', 'action'] };
const SIMPLE_SELECTOR = /^([A-Za-z][\w-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\]\s"']+))?\])*)$/;
function parseSelector(selector) {
  const m = SIMPLE_SELECTOR.exec(selector);
  if (!m || (!m[1] && !m[2])) return null;
  const parts = { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, ids: [], classes: [], attrs: [] };
  for (const p of m[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) ?? []) {
    if (p[0] === '#') parts.ids.push(p.slice(1));
    else if (p[0] === '.') parts.classes.push(p.slice(1));
    else { const a = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|(.+)))?\]$/.exec(p); parts.attrs.push({ name: a[1].toLowerCase(), value: a[2] ?? a[3] ?? a[4] ?? null }); }
  }
  return parts;
}
function htmlMatches(html, parts) {
  for (const tag of html.matchAll(/<([A-Za-z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)) {
    if (parts.tag && tag[1].toLowerCase() !== parts.tag) continue;
    const attrs = new Map();
    for (const a of tag[2].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    const classes = String(attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
    if (parts.ids.every((id) => attrs.get('id') === id) && parts.classes.every((c) => classes.includes(c))
      && parts.attrs.every((a) => attrs.has(a.name) && (a.value === null || attrs.get(a.name) === a.value))) return true;
  }
  return false;
}
export function resolvePointer(p, ctx) {
  if (!isObject(p)) return no('POINTER_FIELDS');
  const fields = POINTER_FIELDS[p.kind];
  if (!fields) return no('POINTER_KIND_UNKNOWN');
  if (Object.keys(p).some((k) => !fields.includes(k))) return no('POINTER_FIELDS');
  const ev = () => (typeof p.evidence === 'string' ? evidenceBytes(ctx, p.evidence) : { error: 'POINTER_FIELDS' });
  if (p.kind === 'action') return typeof p.action === 'string' && ctx.actions.has(p.action) ? { ok: true } : no('ACTION_UNKNOWN');
  if (p.kind === 'file') {
    const e = ev(); if (e.error) return no(e.error);
    if (p.line === undefined) return { ok: true };
    if (e.item.kind !== 'text') return no('FILE_NOT_TEXT');
    if (!Number.isInteger(p.line) || p.line < 1) return no('POINTER_FIELDS');
    return p.line <= lineCount(e.bytes.toString('utf8')) ? { ok: true } : no('FILE_LINE_OUTSIDE');
  }
  if (p.kind === 'image_region') {
    const e = ev(); if (e.error) return no(e.error);
    if (e.item.kind !== 'image') return no('NOT_IMAGE');
    if (![p.x, p.y, p.w, p.h].every(Number.isInteger) || p.x < 0 || p.y < 0 || p.w < 1 || p.h < 1) return no('IMAGE_REGION_INVALID');
    const size = imageSize(e.bytes);
    return size && p.x + p.w <= size.width && p.y + p.h <= size.height ? { ok: true } : no('IMAGE_REGION_OUTSIDE');
  }
  if (p.kind === 'timestamp') {
    if ((p.evidence === undefined) === (p.at === undefined)) return no('POINTER_FIELDS');
    if (p.at !== undefined) {
      const t = typeof p.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p.at) ? Date.parse(p.at) : NaN;
      if (!Number.isFinite(t)) return no('TIMESTAMP_INVALID');
      return ctx.window && t >= ctx.window.from && t <= ctx.window.to ? { ok: true } : no('TIMESTAMP_OUTSIDE');
    }
    const e = ev(); if (e.error) return no(e.error);
    if (!Number.isInteger(p.t_ms) || p.t_ms < 0) return no('TIMESTAMP_INVALID');
    const duration = e.item.kind === 'video' && e.item.media_type !== 'video/webm' ? mp4DurationMs(e.bytes) : null;
    if (duration === null) return no('TIMESTAMP_NO_DURATION');
    return p.t_ms <= duration ? { ok: true } : no('TIMESTAMP_OUTSIDE');
  }
  // selector
  if (typeof p.selector !== 'string' || !p.selector.trim() || p.selector.length > 500) return no('POINTER_FIELDS');
  if (p.evidence === undefined) return ctx.used.has(p.selector) ? { ok: true } : no('SELECTOR_NOT_FOUND');
  const e = ev(); if (e.error) return no(e.error);
  if (e.item.kind !== 'text' || e.item.media_type !== 'text/html') return no('NOT_DOM_SNAPSHOT');
  const parts = parseSelector(p.selector.trim());
  if (!parts) return ctx.used.has(p.selector) ? { ok: true } : no('SELECTOR_UNSUPPORTED');
  return htmlMatches(e.bytes.toString('utf8'), parts) ? { ok: true } : no('SELECTOR_NOT_FOUND');
}

// ---------------------------------------------------------------------------------------------------------------
// The answer: the documented JSON after the marker, every checklist item judged once with pointers that resolve,
// and an overall equal to the one its items imply. Anything else is ABSTAIN with the reason.
export function validateResponse({ output, checklist, ctx, policy = adjudicatorPolicy() }) {
  const abstain = (codes, extra = {}) => ({ items: [], model_overall: null, outcome: 'ABSTAIN', codes, ...extra });
  const parsed = parseMarkedJson(output, MARKERS.judge);
  if (!parsed.ok) return abstain(['ENGINE_OUTPUT_INVALID']);
  const r = parsed.value;
  if (!isObject(r) || Object.keys(r).some((k) => !['items', 'overall', 'abstain_reason'].includes(k)) || !ADJUDICATION_OUTCOMES.includes(r.overall)) return abstain(['RESPONSE_SCHEMA']);
  if (r.overall === 'ABSTAIN') return abstain(['MODEL_ABSTAINED'], { model_overall: 'ABSTAIN' });
  const ids = checklist.items.map((i) => i.id), seen = new Set(), codes = [], items = [];
  if (!Array.isArray(r.items)) codes.push('RESPONSE_SCHEMA');
  for (const [n, it] of (Array.isArray(r.items) ? r.items : []).entries()) {
    if (!isObject(it) || Object.keys(it).some((k) => !['id', 'status', 'pointers', 'note'].includes(k))) { codes.push(`ITEM_SCHEMA:${n}`); continue; }
    if (!ids.includes(it.id)) { codes.push(`ITEM_UNKNOWN:${String(it.id).slice(0, 40)}`); continue; }
    if (seen.has(it.id)) { codes.push(`ITEM_DUPLICATE:${it.id}`); continue; }
    seen.add(it.id);
    if (!ITEM_STATUSES.includes(it.status)) { codes.push(`ITEM_STATUS:${it.id}`); continue; }
    if (it.note !== undefined && (typeof it.note !== 'string' || it.note.length > policy.limits.note_chars_max)) { codes.push(`ITEM_NOTE:${it.id}`); continue; }
    if (!Array.isArray(it.pointers) || it.pointers.length === 0) { codes.push(`ITEM_NO_POINTER:${it.id}`); continue; }
    if (it.pointers.length > policy.limits.pointers_per_item_max) { codes.push(`ITEM_POINTERS_MAX:${it.id}`); continue; }
    const checks = it.pointers.map((p) => resolvePointer(p, ctx));
    checks.forEach((c, k) => { if (!c.ok) codes.push(`POINTER_UNRESOLVED:${it.id}:${k}:${c.reason}`); });
    items.push({ id: it.id, status: it.status, pointers: it.pointers, pointer_checks: checks.map((c) => (c.ok ? 'OK' : c.reason)), ...(it.note !== undefined ? { note: it.note } : {}) });
  }
  for (const id of ids) if (!seen.has(id)) codes.push(`ITEM_MISSING:${id}`);
  items.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  if (codes.length) return { items, model_overall: r.overall, outcome: 'ABSTAIN', codes };
  const derived = deriveOutcome(items);
  if (derived !== r.overall) return { items, model_overall: r.overall, outcome: 'ABSTAIN', codes: ['OVERALL_INCONSISTENT'] };
  return { items, model_overall: r.overall, outcome: derived, codes: items.filter((i) => i.status !== 'SUPPORTED').map((i) => `ITEM_${i.status}:${i.id}`) };
}

// ---------------------------------------------------------------------------------------------------------------
function childArtifact(runDir, record) {
  const rel = record?.child_verdict?.artifact;
  if (typeof rel !== 'string') return null;
  const abs = resolve(runDir, rel), text = readText(abs);
  return text === null ? null : { rel: relative(runDir, abs), sha256: sha256(text), text };
}
const planTextsOf = (inputs, checklist) => [...strings(inputs.requirement), ...strings(inputs.case), ...checklist.items.map((i) => i.text)];

// One adjudication of the latest (or the named) executed attempt of a case. The checklist is frozen first when it is
// not yet; the payload, its exact input text and the audit are written before the engine is called.
export async function adjudicateCase({ runDir, caseId, seat, engine, attestationPath, attempt = null, boardPath = null, evidencePaths = [], baselinePath = null, fixture = false, policy = adjudicatorPolicy() }) {
  runDir = resolve(runDir); checkCaseId(caseId);
  const record = executorRecord(runDir, caseId, attempt), n = effectiveAttempt(record), scope = scopeOf(seat, policy);
  // PASS-only scope: a case it could not change is skipped before any file, checklist or engine call (no cost).
  if (scope === 'pass_only' && record.verdict !== 'pass') return { skipped: true, reason: 'verdict_not_pass', scope, case_id: caseId, executor_attempt: n, executor_verdict: record.verdict };
  const dir = attemptDirOf(runDir, caseId, n);
  if (existsSync(join(dir, 'payload.json')) || existsSync(join(dir, 'result.json'))) refuse('ADJUDICATION_EXISTS', `${caseId} attempt ${n}`);
  const stream = executorStream(runDir, attestationPath ? resolve(attestationPath) : null, caseId);
  (await import('./cost.mjs')).assertUnderCap(runDir);
  const checklistPath = join(adjudicationDir(runDir, caseId), 'checklist.json');
  const checklist = existsSync(checklistPath) ? readJson(checklistPath, { label: 'checklist.json' }) : await freezeChecklist({ runDir, caseId, seat, engine, policy });
  if (checklist?.schema !== SCHEMAS.checklist || checklist.case_id !== caseId || !Array.isArray(checklist.items) || !checklist.items.length) refuse('ADJUDICATOR_CHECKLIST_INVALID', checklistPath);
  const inputs = caseInputs(runDir, caseId), child = childArtifact(runDir, record);
  const traces = executorTraces({ record, stream, child, planTexts: planTextsOf(inputs, checklist), policy });
  const { evidence, excluded, textFiles } = collectEvidence({ runDir, caseId, boardPath, evidencePaths, record, traces, policy });
  let baseline = null;
  if (baselinePath) {
    const abs = resolve(runDir, baselinePath);
    if (!existsSync(abs) || !inside(runDir, abs) || !IMAGE_EXT.test(abs)) refuse('ADJUDICATE_BASELINE_INVALID', baselinePath);
    baseline = describeEvidence(runDir, abs, 'B1');
    if (!baseline) refuse('ADJUDICATE_BASELINE_INVALID', baselinePath);
  }
  const secrets = collectRunSecrets(runDir).secrets;
  const payload = maskDeep({ schema: SCHEMAS.payload, run_id: basename(runDir), case_id: caseId, built_at: new Date().toISOString(), requirement: inputs.requirement, case: inputs.case,
    checklist: { sha256: sha256File(checklistPath), items: checklist.items }, action_chain: actionChain(stream.text, policy), evidence, baseline, pointer_kinds: POINTER_KINDS }, secrets);
  const input = renderInput('judge', payload), checklistInput = readFileSync(join(adjudicationDir(runDir, caseId), 'checklist-input.txt'), 'utf8');
  await writeConfirmed(join(dir, 'payload.json'), stableJson(payload), 'teamqa.adjudicator.payload', { exclusive: true });
  await writeConfirmed(join(dir, 'input.txt'), input, 'teamqa.adjudicator.input', { exclusive: true });
  const audit = { schema: SCHEMAS.audit, run_id: basename(runDir), case_id: caseId, executor_attempt: n, input_sha256: sha256(input), checklist_input_sha256: sha256(checklistInput),
    ...auditInput({ inputs: [{ name: 'checklist-input', text: checklistInput }, { name: 'input', text: input }], textFiles, traces }), excluded, audited_at: new Date().toISOString() };
  const auditText = stableJson(audit);
  await writeConfirmed(join(dir, 'audit.json'), auditText, 'teamqa.adjudicator.audit', { exclusive: true });
  let call = null, validation;
  if (!audit.clean) validation = { items: [], model_overall: null, outcome: 'ABSTAIN', codes: ['INPUT_AUDIT_FAILED'] };
  else {
    const shown = [...evidence, ...(baseline ? [baseline] : [])];
    call = await engineCall({ runDir, engine, phase: 'judge', input, caseId, files: shown, images: shown.filter((e) => e.kind === 'image').map((e) => e.path) });
    if (call.error) validation = { items: [], model_overall: null, outcome: 'ABSTAIN', codes: [call.error] };
    else {
      await writeConfirmed(join(dir, 'output.txt'), call.output, 'teamqa.adjudicator.output', { exclusive: true });
      validation = validateResponse({ output: call.output, checklist, ctx: pointerContext({ runDir, payload }), policy });
    }
  }
  const result = { schema: SCHEMAS.result, run_id: basename(runDir), case_id: caseId, executor_attempt: n, executor_attempt_id: attemptId(record), mode: seat.mode ?? 'shadow', fixture,
    engine: { kind: engine.kind ?? null, provider: seat.provider, model: seat.model, family: seat.family, harness: seat.harness, effort: seat.effort ?? null,
      attempt: call?.attempt ?? null, checklist_attempt: checklist.engine?.attempt ?? null, session_id: call?.session_id ?? null },
    checklist_sha256: payload.checklist.sha256, payload_sha256: sha256(stableJson(payload)), input_sha256: sha256(input), audit_sha256: sha256(auditText),
    output_sha256: call?.output != null ? sha256(call.output) : null, items: validation.items, model_overall: validation.model_overall ?? null,
    outcome: validation.outcome, codes: validation.codes, started_at: call?.started_at ?? audit.audited_at, ended_at: call?.ended_at ?? audit.audited_at,
    duration_ms: call ? Date.parse(call.ended_at) - Date.parse(call.started_at) : 0 };
  await writeConfirmed(join(dir, 'result.json'), stableJson(result), 'teamqa.adjudicator.result', { exclusive: true });
  await recordVerdictSettlement({ runDir, caseId, record, result });
  return result;
}

// Upgrade R3 x R2a: the adjudicator settles the case verdict at tier 3 of the cost ladder. The executor's verdict is
// tier 2 (it escalates); the adjudicator's is what the verdict is (enforce) or would be (shadow). One ladder decision in
// runs/<id>/decisions.jsonl, through R3's ladderDecision, so timing.json and the report's Speed section count it.
// A plan that sets min_tier.verdict to 3 starts the ladder at the adjudicator.
async function recordVerdictSettlement({ runDir, caseId, record, result }) {
  const { appendSpeedDecision, ladderDecision } = await import('./cost-ladder.mjs');
  const { minTier, runSpeedPolicy, speedMode } = await import('./speed.mjs');
  let policy = null;
  try { policy = runSpeedPolicy(runDir); } catch { policy = null; }
  // D6 (fix round 2): the ladder row is written only when the plan turns the cost ladder on (or shadow).
  if (!policy || speedMode(policy, 'cost_ladder') === 'off') return;
  const min = minTier(policy, 'verdict');
  const settled = { tier: 3, outcome: 'settled', verdict: adjudicatedVerdict(record.verdict, result.outcome), reason: result.outcome };
  const steps = min <= 2 ? [{ tier: 2, outcome: 'escalate', verdict: record.verdict, reason: 'EXECUTOR_VERDICT' }, settled] : [settled];
  await appendSpeedDecision(runDir, ladderDecision({ check: 'verdict', minTier: min, mode: result.mode === 'enforce' ? 'on' : 'shadow', steps,
    caseId, at: result.ended_at, latencyMs: result.duration_ms }));
}

// ---------------------------------------------------------------------------------------------------------------
// The check a reader (the report) runs on a recorded adjudication: the hash chain from the frozen checklist to the
// result, the audit again over the exact recorded inputs, and the answer validated again against the evidence as it is
// now. Any break is ABSTAIN with its code; a result that does not follow from its own files is RESULT_DRIFT.
export function verifyAdjudication({ runDir, caseId, attempt, seat = null, policy = adjudicatorPolicy() }) {
  runDir = resolve(runDir);
  const dir = attemptDirOf(runDir, caseId, attempt), caseDir = adjudicationDir(runDir, caseId);
  const result = readJsonSafe(join(dir, 'result.json'));
  const out = (codes, extra = {}) => ({ outcome: 'ABSTAIN', codes, items: null, result, ...extra });
  if (result?.schema !== SCHEMAS.result || result.case_id !== caseId || result.executor_attempt !== attempt) return out(['RESULT_SCHEMA']);
  const payloadText = readText(join(dir, 'payload.json')), input = readText(join(dir, 'input.txt')), auditText = readText(join(dir, 'audit.json'));
  const checklistText = readText(join(caseDir, 'checklist.json')), checklistInput = readText(join(caseDir, 'checklist-input.txt'));
  if ([payloadText, input, auditText, checklistText, checklistInput].includes(null)) return out(['ADJUDICATION_FILES_MISSING']);
  const payload = JSON.parse(payloadText), audit = JSON.parse(auditText), checklist = JSON.parse(checklistText), codes = [];
  if (sha256(payloadText) !== result.payload_sha256) codes.push('PAYLOAD_DRIFT');
  if (sha256(input) !== result.input_sha256 || audit.input_sha256 !== result.input_sha256) codes.push('INPUT_DRIFT');
  if (!equalJson(payloadFromInput(input), payload)) codes.push('INPUT_PAYLOAD_MISMATCH');
  if (sha256(auditText) !== result.audit_sha256 || audit.checklist_input_sha256 !== sha256(checklistInput)) codes.push('AUDIT_DRIFT');
  if (sha256(checklistText) !== payload.checklist?.sha256 || sha256(checklistText) !== result.checklist_sha256 || !equalJson(checklist.items, payload.checklist.items) || checklist.input_sha256 !== sha256(checklistInput)) codes.push('CHECKLIST_DRIFT');
  else if (!(Date.parse(checklist.frozen_at) <= Date.parse(payload.built_at))) codes.push('CHECKLIST_AFTER_EVIDENCE');
  if (seat && ['provider', 'model', 'family', 'harness'].some((k) => result.engine?.[k] !== seat[k])) codes.push('ADJUDICATOR_SEAT_MISMATCH');
  if (codes.length) return out(codes);
  // The audit again, from its recorded sources.
  const streamSource = (audit.checked?.sources ?? []).find((s) => s.kind === 'executor-stream');
  const streamText = streamSource ? readText(resolve(runDir, streamSource.rel)) : null;
  const record = (readText(join(runDir, 'board.jsonl')) ?? '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((r) => r?.case_id === caseId && effectiveAttempt(r) === attempt && attemptId(r) === result.executor_attempt_id);
  if (!streamText || sha256(streamText) !== streamSource.sha256 || !record) return out(['AUDIT_SOURCE_DRIFT']);
  const traces = executorTraces({ record, stream: { text: streamText, rel: streamSource.rel, sha256: streamSource.sha256, attestation: null }, child: childArtifact(runDir, record),
    planTexts: [...strings(payload.requirement), ...strings(payload.case), ...payload.checklist.items.map((i) => i.text)], policy });
  const textFiles = (payload.evidence ?? []).filter((e) => e.kind === 'text').map((e) => ({ rel: e.rel, text: readText(resolve(runDir, e.rel)) })).filter((f) => f.text !== null && sha256(f.text) === payload.evidence.find((e) => e.rel === f.rel).sha256);
  const reaudit = auditInput({ inputs: [{ name: 'checklist-input', text: checklistInput }, { name: 'input', text: input }], textFiles, traces });
  let recomputed;
  if (!audit.clean || !reaudit.clean) recomputed = { items: [], model_overall: null, outcome: 'ABSTAIN', codes: ['INPUT_AUDIT_FAILED'] };
  else if (result.output_sha256 === null) {
    // No answer was recorded: only an engine failure explains that.
    const engineFailure = result.codes.length > 0 && result.codes.every((c) => /^ENGINE_/.test(c));
    recomputed = { items: [], model_overall: null, outcome: 'ABSTAIN', codes: engineFailure ? result.codes : ['RESULT_DRIFT'] };
  } else {
    const output = readText(join(dir, 'output.txt'));
    if (output === null || sha256(output) !== result.output_sha256) return out(['OUTPUT_DRIFT']);
    recomputed = validateResponse({ output, checklist, ctx: pointerContext({ runDir, payload }), policy });
  }
  const counts = (items) => Object.fromEntries(ITEM_STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]));
  if (recomputed.outcome === 'ABSTAIN' && !(result.outcome === 'ABSTAIN' && equalJson(recomputed.codes, result.codes))) {
    return recomputed.codes.some((c) => /^POINTER_UNRESOLVED:/.test(c)) || recomputed.codes.includes('INPUT_AUDIT_FAILED') ? out(recomputed.codes) : out(['RESULT_DRIFT']);
  }
  if (recomputed.outcome !== result.outcome || !equalJson(recomputed.codes, result.codes) || !equalJson(recomputed.items, result.items)) return out(['RESULT_DRIFT']);
  return { outcome: recomputed.outcome, codes: recomputed.codes, items: counts(recomputed.items), result };
}

// ---------------------------------------------------------------------------------------------------------------
// What the adjudications mean for the run's verdicts. `board` holds the latest record of each case. Shadow: the rows
// say what each verdict would be if the adjudicator were on, and `board` is returned unchanged. Enforce (the
// approved roster's seat says so): a contested PASS is UNGRADED in the returned board.
// The roster whose bytes the user approved; a roster edited after its approval counts as none (read as shadow).
export function rosterOf(runDir) {
  const file = join(runDir, 'roster.json'), approval = readJsonSafe(join(runDir, 'control/approvals/roster.json'));
  return existsSync(file) && typeof approval?.roster_hash === 'string' && sha256File(file) === approval.roster_hash ? readJsonSafe(file) : null;
}
function attemptsOf(runDir, caseId) {
  const dir = adjudicationDir(runDir, caseId);
  return existsSync(dir) ? readdirSync(dir).map((n) => /^attempt-(\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b) : [];
}
export function adjudicationOverlay({ runDir, board, roster = rosterOf(resolve(runDir)) }) {
  runDir = resolve(runDir);
  const seat = roster?.adjudicator ?? null, mode = seat?.mode === 'enforce' ? 'enforce' : 'shadow', scope = scopeOf(seat);
  if (!seat && !existsSync(join(runDir, 'adjudication'))) return null;
  const rows = [];
  for (const record of board) {
    if (typeof record?.case_id !== 'string' || !CASE_ID.test(record.case_id)) continue;
    const n = effectiveAttempt(record), recorded = attemptsOf(runDir, record.case_id);
    if (!recorded.length) continue;
    const v = recorded.includes(n) ? verifyAdjudication({ runDir, caseId: record.case_id, attempt: n, seat }) : { outcome: 'ABSTAIN', codes: ['ADJUDICATION_STALE'], items: null };
    const ifEnabled = adjudicatedVerdict(record.verdict, v.outcome);
    rows.push({ case_id: record.case_id, executor_attempt: n, executor_verdict: record.verdict, outcome: v.outcome, if_enabled_verdict: ifEnabled,
      applied: mode === 'enforce' && ifEnabled !== record.verdict, codes: v.codes, items: v.items });
  }
  const lowered = new Set(rows.filter((r) => r.applied).map((r) => r.case_id));
  // Executed cases without a result: skipped by the PASS-only scope (verdict_not_pass), or in scope and missing.
  const without = board.filter((r) => ['pass', 'fail', 'ungraded'].includes(r?.verdict) && !rows.some((x) => x.case_id === r.case_id));
  const skipped = scope === 'pass_only' ? without.filter((r) => r.verdict !== 'pass') : [];
  return {
    mode, scope, seat: seat ? { provider: seat.provider, model: seat.model, family: seat.family, harness: seat.harness, effort: seat.effort } : null,
    executor_families: seat?.executor_families ?? null, rows,
    executed: board.filter((r) => ['pass', 'fail', 'ungraded'].includes(r?.verdict)).length,
    not_adjudicated: { verdict_not_pass: skipped.map((r) => r.case_id), missing: without.filter((r) => !skipped.includes(r)).map((r) => r.case_id) },
    board: board.map((r) => (lowered.has(r?.case_id) ? { ...r, verdict: 'ungraded', reason: 'ADJUDICATOR_CONTEST' } : r)),
  };
}

// The report's `adjudication` field (additive; absent when the run has neither a seat nor a result). `metrics` and
// `decision` are the report's own. Shadow: `if_enabled` lowers each contested PASS (UNGRADED_PRESENT is always a
// NO_GO reason, so any lowered case makes the decision NO_GO). Enforce: the metrics already hold the lowered cases.
export function adjudicationReportField(overlay, { decision, metrics }) {
  if (!overlay) return {};
  const count = (outcome) => overlay.rows.filter((r) => r.outcome === outcome).length;
  const lowered = overlay.rows.filter((r) => r.if_enabled_verdict !== r.executor_verdict).map((r) => r.case_id);
  const actual = { pass: metrics.pass, fail: metrics.fail, ungraded: metrics.ungraded, decision };
  const ifEnabled = overlay.mode === 'enforce' ? { pass: metrics.pass, fail: metrics.fail, ungraded: metrics.ungraded, lowered, decision }
    : { pass: metrics.pass - lowered.length, fail: metrics.fail, ungraded: metrics.ungraded + lowered.length, lowered, decision: lowered.length ? 'NO_GO' : decision };
  const not = overlay.not_adjudicated;
  return { adjudication: { schema: SCHEMAS.report, mode: overlay.mode, scope: overlay.scope, seat: overlay.seat, executor_families: overlay.executor_families, cases: overlay.rows,
    counts: { executed: overlay.executed, adjudicated: overlay.rows.length, confirm: count('CONFIRM'), contest: count('CONTEST'), abstain: count('ABSTAIN'),
      not_adjudicated: { verdict_not_pass: not.verdict_not_pass.length, missing: not.missing.length } },
    not_adjudicated: { verdict_not_pass: [...not.verdict_not_pass], missing: [...not.missing] }, actual, if_enabled: ifEnabled } };
}
const upper = (v) => String(v ?? '—').toUpperCase();
export function adjudicationMarkdown(field) {
  if (!field) return [];
  const enforced = field.mode === 'enforce', c = field.counts, a = field.actual, e = field.if_enabled;
  const seat = field.seat ? `Seat: ${field.seat.provider} / ${field.seat.model} (family ${field.seat.family}; executor families: ${Object.entries(field.executor_families ?? {}).map(([r, f]) => `${r}=${f}`).join(', ')}).`
    : 'Seat: none in an approved roster, so the results are read as shadow.';
  return [`## Adjudicator (${enforced ? 'enforced' : 'shadow'})`, '',
    enforced ? 'Enforced by the approved roster: a contested PASS counts as UNGRADED; the adjudicator never makes a case PASS or FAIL.' : 'Shadow: the results are recorded only; no verdict and no decision changed.',
    seat, `Adjudicated ${c.adjudicated} of ${c.executed} executed case(s): CONFIRM ${c.confirm}, CONTEST ${c.contest}, ABSTAIN ${c.abstain}.`,
    `Not adjudicated: ${c.not_adjudicated.verdict_not_pass} not PASS (scope ${field.scope}), ${c.not_adjudicated.missing} without a result${field.not_adjudicated.missing.length ? ` (${field.not_adjudicated.missing.join(', ')})` : ''}.`,
    enforced ? `Applied: ${e.lowered.length ? `PASS → UNGRADED for ${e.lowered.join(', ')}` : 'no verdict lowered'}.`
      : `If it had been on: PASS ${a.pass} → ${e.pass}, UNGRADED ${a.ungraded} → ${e.ungraded}, decision ${a.decision} → ${e.decision}.`,
    '', '| Case | Executor verdict | Adjudicator | If on | Codes |', '|---|---|---|---|---|',
    ...field.cases.map((r) => `| ${r.case_id} | ${upper(r.executor_verdict)} | ${r.outcome} | ${upper(r.if_enabled_verdict)} | ${r.codes.length ? r.codes.join(', ') : '—'} |`), ''];
}
// For an enforcing seat, the change QA GUI's `board apply --change` takes (doc-colab/v1): each contested PASS case
// goes to BLOCKED, the board status of UNGRADED, with a comment. Shadow changes nothing on the board (null).
export function boardChangePacket({ overlay, board }) {
  if (!overlay || overlay.mode !== 'enforce') return null;
  const edits = [], comments = [];
  for (const row of overlay.rows.filter((r) => r.applied)) {
    if ((board?.cases ?? []).find((c) => c?.id === row.case_id)?.status !== 'PASS') continue;
    edits.push({ entity: 'case', id: row.case_id, field: 'status', from: 'PASS', to: 'BLOCKED' });
    comments.push({ entity: 'case', entityId: row.case_id, text: `Adjudicator CONTEST: ${row.codes.join(', ') || 'no item was supported'}. An independent check of the raw evidence did not support the PASS; the case is UNGRADED until it runs again.` });
  }
  return { protocol: 'doc-colab/v1', baseRev: board?.rev ?? null, edits, comments };
}

// The latest executed record of each case in a ledger file (for `adjudicate show`; the report uses its own).
function latestRecords(runDir) {
  const records = (readText(join(runDir, 'board.jsonl')) ?? '').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.verdict !== 'pending');
  const latest = new Map();
  for (const r of records) latest.set(r.case_id, r);
  return [...latest.values()];
}

// ---------------------------------------------------------------------------------------------------------------
// teamqa adjudicate checklist|run|show|board-change --run <id> ...
export async function adjudicatorCommand(action, args) {
  const commands = ['checklist', 'run', 'show', 'board-change'];
  if (!commands.includes(action)) fail(2, 'ADJUDICATE_COMMAND', commands.join('|'));
  const flags = { '--run': { key: 'run', required: true }, ...(['checklist', 'run'].includes(action) ? { '--case': { key: 'caseId', required: true } } : {}) };
  if (action === 'run') Object.assign(flags, { '--attestation': { key: 'attestation', required: true }, '--board': { key: 'board' }, '--evidence': { key: 'evidence' }, '--baseline': { key: 'baseline' }, '--attempt': { key: 'attempt' } });
  if (action === 'board-change') Object.assign(flags, { '--board': { key: 'board', required: true }, '--out': { key: 'out', required: true } });
  const options = parseFlags(args, flags);
  const runDir = join(process.cwd(), 'runs', safeRunId(options.run));
  if (action === 'show') {
    const overlay = adjudicationOverlay({ runDir, board: latestRecords(runDir) });
    console.log(JSON.stringify(overlay ? { mode: overlay.mode, scope: overlay.scope, seat: overlay.seat, executor_families: overlay.executor_families, cases: overlay.rows, not_adjudicated: overlay.not_adjudicated } : { mode: null, cases: [] }, null, 2));
    return;
  }
  const { assertApprovedRoster, seatExecutionErrors } = await import('./roster.mjs');
  const roster = assertApprovedRoster({ runDir });
  if (action === 'board-change') {
    const boardPath = resolve(process.cwd(), options.board), out = resolve(process.cwd(), options.out);
    const packet = boardChangePacket({ overlay: adjudicationOverlay({ runDir, board: latestRecords(runDir), roster }), board: readJson(boardPath, { label: basename(boardPath) }) });
    if (!packet) { emit('pass', 'ADJUDICATOR_SHADOW', 'changes=0', 'board=unchanged'); return; }
    if (!packet.edits.length) { emit('pass', 'ADJUDICATOR_BOARD_CHANGE', 'changes=0', 'board=unchanged'); return; }
    if (existsSync(out)) refuse('ADJUDICATOR_OUTPUT_EXISTS', out);
    await writeConfirmed(out, stableJson(packet), 'teamqa.adjudicator.board-change', { exclusive: true });
    emit('pass', 'ADJUDICATOR_BOARD_CHANGE', `changes=${packet.edits.length}`, `packet=${out}`, `next=${JSON.stringify(`teamqa board apply --file ${boardPath} --change ${out} --actor adjudicator`)}`);
    return;
  }
  const seat = roster.adjudicator;
  if (!seat) refuse('ADJUDICATOR_SEAT_MISSING', 'the approved roster has no adjudicator seat (roster request field "adjudicator")');
  const { cliEngine } = await import('./adjudicator-engine.mjs');
  const runtime = roster.catalog_source.kind === 'runtime';
  const engine = cliEngine(seat, { attest: runtime ? ({ stdout, stderr }) => seatExecutionErrors({ seat, stdout, stderr }) : null });
  checkCaseId(options.caseId);
  if (action === 'checklist') {
    const checklist = await freezeChecklist({ runDir, caseId: options.caseId, seat, engine });
    emit('pass', 'ADJUDICATOR_CHECKLIST_FROZEN', `case=${options.caseId}`, `items=${checklist.items.length}`, `sha256=${sha256File(join(adjudicationDir(runDir, options.caseId), 'checklist.json'))}`,
      `requirement_items=${checklist.requirement_items}`);
    return;
  }
  const attempt = options.attempt === undefined ? null : Number(options.attempt);
  if (attempt !== null && !(Number.isInteger(attempt) && attempt > 0)) fail(2, 'ADJUDICATE_ATTEMPT', options.attempt);
  const result = await adjudicateCase({ runDir, caseId: options.caseId, seat, engine, attestationPath: resolve(process.cwd(), options.attestation), attempt,
    boardPath: options.board ? resolve(process.cwd(), options.board) : null, evidencePaths: options.evidence ? options.evidence.split(',').map((p) => p.trim()).filter(Boolean) : [],
    baselinePath: options.baseline ?? null, fixture: roster.catalog_source.kind === 'fixture' });
  if (result.skipped) { emit('pass', 'ADJUDICATION_SKIPPED', `case=${options.caseId}`, `attempt=${result.executor_attempt}`, `reason=${result.reason}`, `scope=${result.scope}`, 'effect=none'); return; }
  const record = executorRecord(runDir, options.caseId, result.executor_attempt);
  emit('pass', 'ADJUDICATION', `case=${options.caseId}`, `attempt=${result.executor_attempt}`, `outcome=${result.outcome}`, `mode=${seat.mode}`,
    `if_enabled=${adjudicatedVerdict(record.verdict, result.outcome)}`, seat.mode === 'enforce' ? 'effect=report' : 'effect=none',
    ...(result.codes.length ? [`codes=${result.codes.join(',')}`] : []), `result=${join(attemptDirOf(runDir, options.caseId, result.executor_attempt), 'result.json')}`);
}
