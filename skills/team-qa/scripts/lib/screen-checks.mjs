// Fix round 1, D1: QA GUI's width sweep and overlay check run once per screen per run, in their own GUI executor
// dispatch ("screen check"), before the cases. Team QA orchestrates: it lists the screens of the signed plan, gives each
// screen check its dispatch (roster.mjs dispatch --screen-id, its own attempt budget and attestation), collects it into
// runs/<id>/screens/<screenId>/ and hands the results to every case on that screen at the case's collect. QA GUI owns the
// recipe (screenCheckPromptSection), the grading (screenCheckFromOps) and the fold into a case (foldScreenChecks).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const SCREENS_DIR = 'screens';
export const SCREEN_ID = /^S[1-9][0-9]{0,3}$/;
export const SCREEN_ATTEMPTS = 3;
export const SCREEN_DRAFT_MARKER = 'TEAMQA_SCREEN_DRAFT v1';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Round G (G4): the entry link of a GUI case with no route: `data.entry_url`, `data.case_url`, or the first http(s) URL
// in its first step; and its steps up to (not including) its first write. Sign-in steps never count as a write.
const URL_IN = /https?:\/\/[^\s'"\u201c\u201d<>)]+/i;
const SIGN_IN_STEP = /(?:^|[^\p{L}\p{N}])(?:log ?in|log ?on|sign ?in|sign-in|authenticate|\u0111\u0103ng nh\u1eadp)(?=$|[^\p{L}\p{N}])/iu;
const WRITE_STEP = /(?:^|[^\p{L}\p{N}])(?:save|submit|delete|remove|create|add|confirm|update|send|upload|approve|reject|l\u01b0u|x\u00f3a|xo\u00e1|th\u00eam|t\u1ea1o|g\u1eedi|c\u1eadp nh\u1eadt|x\u00e1c nh\u1eadn|duy\u1ec7t|t\u1eeb ch\u1ed1i|t\u1ea3i l\u00ean)(?=$|[^\p{L}\p{N}])/iu;
export function caseEntry(c) {
  const steps = (Array.isArray(c?.steps) ? c.steps : [c?.steps]).map((x) => String(x ?? '').normalize('NFC').trim()).filter(Boolean);
  const field = [c?.data?.entry_url, c?.data?.case_url].find((v) => typeof v === 'string' && /^https?:\/\//i.test(v.trim()));
  const url = field?.trim() ?? (steps[0]?.match(URL_IN)?.[0] ?? null);
  if (!url) return null;
  const write = steps.findIndex((step) => !SIGN_IN_STEP.test(step) && WRITE_STEP.test(step));
  return { url, steps: write < 0 ? steps : steps.slice(0, write) };
}

/**
 * The screens of a tracked plan: one per route a GUI case gives, with its role, in order of first use; their ids are
 * S1, S2, ... The overlay triggers the plan names for a route (`data.overlays`) are checked first. Round G (G4): a GUI
 * case without a route but with an entry link (caseEntry) gets its own screen after the routed ones, in plan order:
 * `route: null`, `entry` (the link), its steps up to its first write, its role and account, `cases: [caseId]`. A GUI
 * case with neither has no screen (its screen checks are N/A, SCREEN_NO_ROUTE).
 */
export function screenPlan(tracked, { origin = null } = {}) {
  const byKey = new Map();
  const noRoute = [], entries = [];
  for (const c of Array.isArray(tracked?.cases) ? tracked.cases : []) {
    if (c?.lane !== undefined && c.lane !== 'gui') continue;
    if (typeof c?.route !== 'string' || !c.route.startsWith('/')) {
      const entry = caseEntry(c);
      if (!entry) { noRoute.push(c?.id); continue; }
      const planned = (Array.isArray(c.data?.overlays) ? c.data.overlays : []).filter((x) => typeof x === 'string');
      entries.push({ route: null, role: typeof c.role === 'string' && c.role ? c.role : null, account: typeof c.data?.account === 'string' && c.data.account ? c.data.account : null,
        entry: entry.url, steps: entry.steps, cases: [c.id], planned: [...new Set(planned)] });
      continue;
    }
    const role = typeof c.role === 'string' && c.role ? c.role : null;
    const key = `${c.route}|${role ?? ''}`;
    if (!byKey.has(key)) byKey.set(key, { route: c.route, role, cases: [], planned: [] });
    const screen = byKey.get(key);
    screen.cases.push(c.id);
    for (const selector of Array.isArray(c.data?.overlays) ? c.data.overlays : []) if (typeof selector === 'string' && !screen.planned.includes(selector)) screen.planned.push(selector);
  }
  const routed = [...byKey.values()].map((s, i) => ({ id: `S${i + 1}`, ...s, url: origin ? new URL(s.route, origin).href : null }));
  const entered = entries.map((s, i) => ({ id: `S${routed.length + i + 1}`, ...s, url: (() => { try { return new URL(s.entry, origin ?? undefined).href; } catch { return null; } })() }));
  return { screens: [...routed, ...entered], noRoute };
}

// The locked tracked plan and the target origin of a run.
export function runScreenPlan(runDir) {
  const lock = JSON.parse(readFileSync(join(runDir, 'docs-lock.json'), 'utf8'));
  const tracked = JSON.parse(readFileSync(resolve(runDir, lock.artifacts.tracked.path), 'utf8'));
  let origin = null;
  for (const file of ['binding.json', 'roster.json']) {
    try { const value = JSON.parse(readFileSync(join(runDir, file), 'utf8')); origin = new URL(value.target?.preview_url ?? value.target?.url).origin; break; } catch { /* next */ }
  }
  return screenPlan(tracked, { origin });
}

export const SCREEN_ATTEMPTS_DIR = 'attempts';
// Round G (G5): where the screen is, for the entry probe of its cases: the routed screen's URL, or, for an entry screen,
// the href its latest collected check measured (null before one was collected: the executor reads it on the screen).
export function screenUrl(runDir, screen) {
  if (!screen) return null;
  if (!screen.entry) return screen.url ?? null;
  const latest = readJsonSafe(join(runDir, SCREENS_DIR, screen.id, 'result.json'));
  return typeof latest?.measuredRoute === 'string' && typeof latest.url === 'string' ? latest.url : null;
}
const readJsonSafe = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const sha256File = (file) => sha256(readFileSync(file));
const RESULT_FIELDS = ['status', 'verdict', 'issues', 'sweep', 'overlay', 'measured', 'reason'];
const sameResult = (x, y) => RESULT_FIELDS.every((k) => JSON.stringify(x?.[k] ?? null) === JSON.stringify(y?.[k] ?? null));

/**
 * Fix round 2 (E1): every attempt of a screen check is kept (screens/<screenId>/attempts/<attempt>/result.json, never
 * overwritten). A case's collect folds only attested attempts: each attempt's attestation is verified again (Team QA's
 * own verifier, the file's hash as collected, the screen it names, its stream's hash) and the check is graded again
 * from the attested stream by QA GUI; an attempt whose stored result does not follow from its stream (a stale or
 * hand-written file) is refused. Returns {attempts (regraded results, oldest first), refused: [code]}.
 */
export async function attestedScreenAttempts({ runDir, screen, assertRoleAttestation, tools }) {
  const dir = join(runDir, SCREENS_DIR, screen.id, SCREEN_ATTEMPTS_DIR);
  const stored = (existsSync(dir) ? readdirSync(dir) : []).map((name) => ({ name, value: readJsonSafe(join(dir, name, 'result.json')) }))
    .sort((x, y) => String(x.value?.collected_at ?? '').localeCompare(String(y.value?.collected_at ?? '')) || x.name.localeCompare(y.name));
  const attempts = [], refused = [];
  for (const { name, value } of stored) {
    const no = (why) => refused.push(`SCREEN_ATTEMPT_REFUSED:${screen.id}:${name}:${why}`);
    if (!object(value) || !object(value.attestation)) { no('RESULT_INVALID'); continue; }
    const path = resolve(runDir, String(value.attestation.path ?? ''));
    if (!existsSync(path) || !statSync(path).isFile()) { no('ATTESTATION_MISSING'); continue; }
    if (sha256File(path) !== value.attestation.sha256) { no('ATTESTATION_DRIFT'); continue; }
    let a;
    try { a = assertRoleAttestation({ runDir, role: 'executor_gui', attestationPath: path }); } catch { no('ATTESTATION_REFUSED'); continue; }
    if (a?.dispatch_screen_id !== screen.id || a.source?.kind !== 'claude-stream') { no('ATTESTATION_SCREEN'); continue; }
    if (a.source.sha256 !== value.attestation.stream_sha256) { no('STREAM_DRIFT'); continue; }
    let regraded;
    try { regraded = await gradeScreenAttempt({ runDir, a, screen, tools, copy: false, attemptId: name }); } catch (error) { no(String(error?.code ?? 'REGRADE_FAILED')); continue; }
    if (!sameResult(regraded, value)) { no('RESULT_DRIFT'); continue; }
    attempts.push({ ...regraded, attempt: name });
  }
  return { attempts, refused };
}

/**
 * The screen checks a case's collect folds in: one entry per screen the plan puts the case on (QA GUI
 * foldScreenChecks input), with every attested attempt. A screen with none is `missing` (a detector not run).
 */
export async function caseScreens({ runDir, plan, caseId, assertRoleAttestation, tools }) {
  if (plan.noRoute.includes(caseId)) return { screens: [{ screenId: null, route: null, status: 'no-route' }], refused: [] };
  const screens = [], refused = [];
  for (const s of plan.screens.filter((x) => x.cases.includes(caseId))) {
    const { attempts, refused: no } = await attestedScreenAttempts({ runDir, screen: s, assertRoleAttestation, tools });
    refused.push(...no);
    const usable = attempts.filter((r) => r.status !== 'refused');
    if (!usable.length) { screens.push({ screenId: s.id, route: s.route, status: 'missing' }); continue; }
    const checked = usable.filter((r) => r.status === 'checked');
    // A Dragon without R1a: the latest attested attempt says so (the stream showed it); the check is reported only.
    // Fix round 3 (F6): unless an earlier checked attempt FAILed: that FAIL stands.
    if (usable.at(-1).status === 'unavailable' && !checked.some((r) => r.verdict === 'FAIL')) { screens.push({ screenId: s.id, route: s.route, status: 'unavailable' }); continue; }
    screens.push(checked.length ? { screenId: s.id, route: s.route, status: 'checked', attempts: checked } : { screenId: s.id, route: s.route, status: 'missing' });
  }
  return { screens, refused };
}

// The screen draft the executor prints: one `TEAMQA_SCREEN_DRAFT v1` line and a fenced JSON block.
export function screenDrafts(text) {
  const drafts = [];
  for (const line of String(text).split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b?.type !== 'text' || !b.text.includes(SCREEN_DRAFT_MARKER)) continue;
      for (const m of b.text.matchAll(/TEAMQA_SCREEN_DRAFT v1\s*\n\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)) { try { drafts.push(JSON.parse(m[1])); } catch { drafts.push({ invalid: true }); } }
    }
  }
  return drafts;
}

const typed = (code, detail) => Object.assign(new Error(`${code} ${detail ?? ''}`), { code });
// The folder of one attempt of a screen check (its result, and its own copies of the band captures).
export const screenAttemptId = (a) => String(a.session_id ?? sha256(Buffer.from(a.source.sha256)).slice(0, 16)).replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * One screen check attempt graded from its attested stream by QA GUI (screenCheckFromOps), or the unavailable result a
 * Dragon without R1a gives. `copy`: the sweep's band captures are copied into the run (collect-screen); a regrade only
 * reads the copies already there. Fix round 3 (F6): each attempt's copies go to its own folder,
 * screens/<S>/attempts/<attemptId>/, so a later attempt's capture of the same name never replaces an earlier one's.
 */
export async function gradeScreenAttempt({ runDir, a, screen, tools, copy = true, attemptId = screenAttemptId(a) }) {
  if (!tools?.screenCheckFromOps) throw typed('SCREEN_CHECK_QA_GUI_UNAVAILABLE', 'the QA GUI next to Team QA has no screen checks');
  const screenId = screen.id;
  const text = readFileSync(resolve(runDir, a.source.path), 'utf8');
  if (sha256(Buffer.from(text, 'utf8')) !== a.source.sha256) throw typed('WEB_COLLECT_STREAM_DRIFT', a.source.path);
  const { streamCalls } = await import('./web-collect.mjs');
  const { claudeToolResultsDir } = await import('./roster.mjs');
  const resultsDir = typeof a.session_id === 'string' ? claudeToolResultsDir({ runDir, attempt: a.session_id }) : null;
  const calls = streamCalls(text, { readPersisted: (path) => (resultsDir && resolve(path).startsWith(`${resolve(resultsDir)}/`) && existsSync(path) ? readFileSync(path, 'utf8') : null) });
  const ordered = [...calls.values()].sort((x, y) => x.i - y.i);
  const { detectorCall, dragonR1a } = await import('./detector-collect.mjs');
  const draft = screenDrafts(text).at(-1) ?? null;
  if (!draft || draft.invalid || draft.screen_id !== screenId) throw typed('SCREEN_DRAFT_MISSING', `no ${SCREEN_DRAFT_MARKER} block for ${screenId}`);
  const r1a = dragonR1a(ordered);
  const timing = { called_at: ordered[0]?.called_at ?? null, ended_at: ordered.at(-1)?.at ?? null, calls: ordered.length };
  if (draft.unavailable !== undefined) {
    const honoured = draft.unavailable === 'DRAGON_R1A_UNAVAILABLE' && r1a.unavailable;
    return { ...(honoured ? { schema: 'qa-gui/screen-check/v1', screenId, route: screen.route, url: screen.url, status: 'unavailable', reason: 'DRAGON_R1A_UNAVAILABLE', verdict: null, issues: [] }
      : { schema: 'qa-gui/screen-check/v1', screenId, route: screen.route, url: screen.url, status: 'refused', verdict: 'UNGRADED', issues: [`DETECTOR_UNAVAILABLE_REFUSED:${screenId}:${r1a.available ? 'R1A_RECORDED' : 'NOT_SHOWN'}`] }), timing };
  }
  const captureRef = (op) => {
    const reported = /^[a-f0-9]{64}$/.test(String(op.result?.sha256 ?? '')) ? op.result.sha256 : null;
    const savedTo = typeof op.result?.savedTo === 'string' ? op.result.savedTo : null;
    const rel = savedTo ? `${SCREENS_DIR}/${screenId}/${SCREEN_ATTEMPTS_DIR}/${attemptId}/${basename(savedTo)}` : null;
    // A regrade reads the copy collect-screen made (Dragon's own file may be gone by then).
    const from = !copy && rel && existsSync(join(runDir, rel)) ? join(runDir, rel) : savedTo && existsSync(savedTo) && statSync(savedTo).isFile() ? savedTo : null;
    if (!from) return { sha256: reported };
    const digest = sha256(readFileSync(from));
    if (reported && reported !== digest) return { sha256: reported, problem: 'SWEEP_CAPTURE_HASH_MISMATCH' };
    if (copy) { mkdirSync(dirname(join(runDir, rel)), { recursive: true }); copyFileSync(savedTo, join(runDir, rel)); }
    return { path: rel, sha256: digest };
  };
  const result = await tools.screenCheckFromOps(tools.dragonOps(ordered.map(detectorCall)), { screenId, route: screen.route, url: screen.url, planned: screen.planned, captureRef,
    ...(screen.entry ? { entry: { url: screen.entry } } : {}) });
  return { ...result, timing };
}

/**
 * `teamqa web collect-screen --run <id> --attestation <screen dispatch attestation>`: QA GUI rebuilds and grades the
 * screen check from the attested stream; the attempt (result, attestation file and hash) and the sweep's band captures
 * (hash for hash) go to runs/<id>/screens/<screenId>/attempts/<attempt>/ (fix round 2: every attempt is kept). A claim
 * that Dragon has no R1a is honoured only when the stream shows it.
 */
export async function webCollectScreen(args, { parseFlags, fail, assertRoleAttestation, runDirectory, safeRunId, writeConfirmed, detectorTools }) {
  const o = parseFlags(args, { '--run': { key: 'run', required: true }, '--attestation': { key: 'attestation', required: true } });
  const runId = safeRunId(o.run), runDir = runDirectory(runId);
  const attestationPath = resolve(o.attestation);
  const a = assertRoleAttestation({ runDir, role: 'executor_gui', attestationPath });
  if (a.source?.kind !== 'claude-stream') fail(2, 'WEB_COLLECT_CLAUDE_STREAM_REQUIRED', a.source?.kind);
  const screenId = a.dispatch_screen_id;
  if (typeof screenId !== 'string' || !SCREEN_ID.test(screenId)) fail(2, 'SCREEN_ATTESTATION_REQUIRED', 'the attestation is not a screen check dispatch (--screen-id)');
  const plan = runScreenPlan(runDir);
  const screen = plan.screens.find((s) => s.id === screenId);
  if (!screen) fail(2, 'SCREEN_NOT_IN_PLAN', screenId);
  const tools = detectorTools === undefined ? await (await import('./detector-dispatch.mjs')).qaGuiDetectorTools() : detectorTools;
  if (!tools?.screenCheckFromOps) fail(5, 'SCREEN_CHECK_QA_GUI_UNAVAILABLE', 'the QA GUI next to Team QA has no screen checks', 'ungraded');
  const attemptId = screenAttemptId(a);
  let result;
  try { result = await gradeScreenAttempt({ runDir, a, screen, tools, attemptId }); } catch (error) { fail(2, error.code ?? 'SCREEN_CHECK_FAILED', String(error.message)); }
  const out = join(runDir, SCREENS_DIR, screenId, SCREEN_ATTEMPTS_DIR, attemptId);
  mkdirSync(out, { recursive: true });
  const attestation = { path: relative(runDir, attestationPath), sha256: existsSync(attestationPath) ? sha256File(attestationPath) : null, session_id: a.session_id ?? null, stream_sha256: a.source.sha256 };
  const record = `${JSON.stringify({ ...result, attestation, collected_at: new Date().toISOString() }, null, 2)}\n`;
  await writeConfirmed(join(out, 'result.json'), record, 'teamqa.web.collect.screen');
  // The latest attempt, for a reader that lists what was collected; the fold reads the attempts only.
  await writeConfirmed(join(runDir, SCREENS_DIR, screenId, 'result.json'), record, 'teamqa.web.collect.screen');
  return { run_id: runId, screen: screenId, route: screen.route, ...(screen.entry ? { entry: screen.entry, measuredRoute: result.measuredRoute ?? null } : {}), status: result.status, verdict: result.verdict,
    issues: result.issues.slice(0, 8), calls: result.timing.calls, attempt: attemptId };
}
