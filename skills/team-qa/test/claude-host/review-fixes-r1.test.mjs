// Fix round 1: the Team QA review findings, each reproduced first. TQ-1 (a result Claude Code saved to tool-results/
// is read whole), D1 (the screen checks: the screens of the plan, their own dispatch scope and attempts, collect-screen
// and the fold input), D7 (a run-folder exploration policy never widens the signed plan), D6 (the timing receipt names
// screen checks and adjudications apart) and the risk policy of the probe (D3). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { streamCalls } from '../../scripts/lib/web-collect.mjs';
import { dragonR1a } from '../../scripts/lib/detector-collect.mjs';
import { caseDetectorPlan, dispatchScreenSection, riskyMainAction, runExplorationPolicy } from '../../scripts/lib/detector-dispatch.mjs';
import { SCREEN_DRAFT_MARKER, caseScreens, screenDrafts, screenPlan, webCollectScreen } from '../../scripts/lib/screen-checks.mjs';
import { runTiming } from '../../scripts/lib/timing.mjs';
import { stepsBeforeFirstScreenshot } from '../../scripts/lib/speed-cache.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const tmp = (name) => realpathSync(mkdtempSync(join(tmpdir(), `teamqa-r1-${name}-`)));
const T = 'mcp__Dragon_Browser__';
const line = (e) => JSON.stringify(e);
const use = (id, name, input, ts) => line({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } });
const answer = (id, content, ts, extra = {}) => line({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra });

// Dragon help as large as the real one (about 150 KB), as Claude Code leaves it: a preview in the message, the original
// on the same stream line (`tool_use_result`) and in the saved file.
function bigHelp({ contract }) {
  const value = { ok: true, result: { version: contract ? '1.16.0' : '1.15.1', rpcMethods: Array.from({ length: 900 }, (_, i) => `method${i}`), text: 'x'.repeat(140000),
    ...(contract ? { environmentContract: { version: 'r1a/1', methods: ['env.set', 'frames.trial', 'helpers.define'] } } : {}) } };
  return JSON.stringify(value);
}
const preview = (full, path) => `<persisted-output>\nOutput too large (${Math.round(full.length / 1024)}KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n${full.slice(0, 2048)}\n...\n</persisted-output>`;

test('TQ-1: a help result Claude Code persisted is read whole from the stream line or the saved file; R1a is seen either way', () => {
  for (const contract of [false, true]) {
    const full = bigHelp({ contract }), path = '/results/toolu_h.txt';
    const viaLine = streamCalls([use('toolu_h', `${T}help`, {}, '2026-11-05T01:00:00Z'),
      answer('toolu_h', [{ type: 'text', text: preview(full, path) }], '2026-11-05T01:00:01Z', { tool_use_result: [{ type: 'text', text: full }] })].join('\n'));
    const call = viaLine.get('toolu_h');
    assert.equal(call.text.length, full.length);
    assert.deepEqual(call.persisted, { from: 'stream' });
    assert.deepEqual(dragonR1a([...viaLine.values()]), contract ? { available: true, missing: false, unavailable: false } : { available: false, missing: true, unavailable: true });
    // Without the original on the line: the saved file, when the reader gives it and it starts with the preview.
    const text = [use('toolu_h', `${T}help`, {}, '2026-11-05T01:00:00Z'), answer('toolu_h', [{ type: 'text', text: preview(full, path) }], '2026-11-05T01:00:01Z')].join('\n');
    const viaFile = streamCalls(text, { readPersisted: (p) => (p === path ? full : null) }).get('toolu_h');
    assert.deepEqual([viaFile.text.length, viaFile.persisted], [full.length, { from: 'file', path }]);
    const forged = streamCalls(text, { readPersisted: () => JSON.stringify({ ok: true, result: { environmentContract: {} } }) }).get('toolu_h');
    assert.deepEqual([forged.json, forged.persisted], [null, { from: null }], 'a file that does not begin with the preview is not the result');
    assert.equal(dragonR1a([forged]).missing, false, 'an unread help shows nothing');
  }
});

// A locked run with a tracked plan of three GUI cases on two routes and one case without a route.
function screenRun() {
  const runDir = join(tmp('screens'), 'runs', 'scr-run');
  mkdirSync(runDir, { recursive: true });
  const tracked = { schemaVersion: 2, cases: [
    { id: 'TC-1', lane: 'gui', route: '/orders', data: { overlays: ['#edit'] }, steps: ['Open orders'], expected: 'x' },
    { id: 'TC-2', lane: 'gui', route: '/orders?tab=2', steps: ['Open orders'], expected: 'x' },
    { id: 'TC-3', lane: 'gui', route: '/settings', steps: ['Open settings'], expected: 'x' },
    { id: 'TC-4', lane: 'gui', steps: ['Open the wizard step 2'], expected: 'x' },
    { id: 'TC-5', lane: 'api', route: '/api', steps: ['x'], expected: 'x' }] };
  const text = `${JSON.stringify(tracked)}\n`;
  writeFileSync(join(runDir, 'tracked-plan.json'), text);
  writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ artifacts: { tracked: { path: 'tracked-plan.json', sha256: sha(text) } } }));
  writeFileSync(join(runDir, 'binding.json'), JSON.stringify({ target: { preview_url: 'http://127.0.0.1:5401/' } }));
  return { runDir, tracked };
}

test('D1: one screen per route and role of the GUI cases, in order; a case without a route has no screen', async () => {
  const { runDir, tracked } = screenRun();
  const plan = screenPlan(tracked, { origin: 'http://127.0.0.1:5401' });
  assert.deepEqual(plan.screens.map((s) => [s.id, s.route, s.cases, s.planned, s.url]), [
    ['S1', '/orders', ['TC-1'], ['#edit'], 'http://127.0.0.1:5401/orders'],
    ['S2', '/orders?tab=2', ['TC-2'], [], 'http://127.0.0.1:5401/orders?tab=2'],
    ['S3', '/settings', ['TC-3'], [], 'http://127.0.0.1:5401/settings']]);
  assert.deepEqual(plan.noRoute, ['TC-4']);
  // What a case's collect folds in. Fix round 2 (E1, TQ2 minor): only attested attempts (screens/<id>/attempts/), each
  // verified and graded again from its stream; a hand-written result file, "checked" or "unavailable", is no check.
  mkdirSync(join(runDir, 'screens', 'S1'), { recursive: true });
  writeFileSync(join(runDir, 'screens', 'S1', 'result.json'), JSON.stringify({ status: 'checked', screenId: 'S1', verdict: 'PASS', issues: [] }));
  mkdirSync(join(runDir, 'screens', 'S3', 'attempts', 'forged'), { recursive: true });
  writeFileSync(join(runDir, 'screens', 'S3', 'attempts', 'forged', 'result.json'), JSON.stringify({ status: 'unavailable', screenId: 'S3', attestation: { path: 'nowhere.json', sha256: 'a'.repeat(64) } }));
  const p = screenPlan(tracked);
  const refuse = () => { throw new Error('not attested'); };
  const of = async (caseId) => caseScreens({ runDir, plan: p, caseId, assertRoleAttestation: refuse, tools: null });
  assert.deepEqual((await of('TC-1')).screens.map((s) => [s.screenId, s.status]), [['S1', 'missing']]);
  assert.deepEqual((await of('TC-2')).screens.map((s) => [s.screenId, s.status]), [['S2', 'missing']]);
  const s3 = await of('TC-3');
  assert.deepEqual([s3.screens.map((s) => [s.screenId, s.status]), s3.refused], [[['S3', 'missing']], ['SCREEN_ATTEMPT_REFUSED:S3:forged:ATTESTATION_MISSING']]);
  assert.deepEqual((await of('TC-4')).screens, [{ screenId: null, route: null, status: 'no-route' }]);
});

test('D1: `teamqa web screens` lists the screens of the locked plan and which are collected', () => {
  const { runDir } = screenRun();
  mkdirSync(join(runDir, 'screens', 'S2'), { recursive: true });
  writeFileSync(join(runDir, 'screens', 'S2', 'result.json'), '{}');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/teamqa.mjs'), 'web', 'screens', '--run', 'scr-run'], { cwd: dirname(dirname(runDir)), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.deepEqual(out.screens.map((s) => [s.id, s.route, s.cases, s.collected]), [['S1', '/orders', ['TC-1'], false], ['S2', '/orders?tab=2', ['TC-2'], true], ['S3', '/settings', ['TC-3'], false]]);
});

test('D1: a screen check dispatch is scoped to one screen of the locked plan, three attempts, recorded before it runs', async () => {
  const { runDir } = screenRun();
  const { startScreenDispatch } = await import('../../scripts/lib/run-contract.mjs');
  await assert.rejects(() => startScreenDispatch({ runDir, role: 'executor_gui', screenId: 'S9', attempt: 'attempt-0001' }), (e) => /DISPATCH_SCREEN_NOT_IN_PLAN/.test(`${e.code} ${e.message}`));
  await assert.rejects(() => startScreenDispatch({ runDir, role: 'analyst', screenId: 'S1', attempt: 'attempt-0001' }), (e) => /DISPATCH_SCREEN_ROLE/.test(`${e.code} ${e.message}`));
  for (let n = 1; n <= 3; n += 1) assert.equal((await startScreenDispatch({ runDir, role: 'executor_gui', screenId: 'S1', attempt: `attempt-000${n}` })).used, n);
  await assert.rejects(() => startScreenDispatch({ runDir, role: 'executor_gui', screenId: 'S1', attempt: 'attempt-0004' }), (e) => /DISPATCH_SCREEN_ATTEMPTS_EXHAUSTED/.test(`${e.code} ${e.message}`));
  assert.equal((await startScreenDispatch({ runDir, role: 'executor_gui', screenId: 'S2', attempt: 'attempt-0005' })).used, 1, 'each screen has its own attempts');
  assert.equal(readFileSync(join(runDir, 'dispatch', 'executor_gui', 'screen-dispatches.jsonl'), 'utf8').trim().split('\n').length, 4);
  // The dispatch gets QA GUI's screen recipe for that screen, at its url; none for a screen not in the plan.
  const tools = { STREAM_DETECTORS_VERSION: 'qa-gui/stream-detectors/v1', screenCheckPromptSection: ({ screenId, url, route, planned }) => `recipe ${screenId} ${url} ${route} ${JSON.stringify(planned)}` };
  assert.equal(await dispatchScreenSection({ runDir, screenId: 'S1', tools }),
    'TEAMQA_SCREEN_CHECK screen=S1 (QA GUI qa-gui/stream-detectors/v1)\nrecipe S1 http://127.0.0.1:5401/orders /orders ["#edit"]\n\n');
  assert.equal(await dispatchScreenSection({ runDir, screenId: 'S9', tools }), null);
  assert.equal(await dispatchScreenSection({ runDir, screenId: 'S1', tools: null }), null);
});

// `web collect-screen` over one screen check stream, with stand-in QA GUI grading.
function screenStream({ screenId = 'S1', unavailable = false, help = null } = {}) {
  const lines = [];
  if (help) lines.push(use('toolu_1', `${T}help`, {}, '2026-11-05T02:00:00Z'), answer('toolu_1', [{ type: 'text', text: help }], '2026-11-05T02:00:01Z'));
  lines.push(use('toolu_2', `${T}do`, { tabId: 3, brief: true, steps: [{ goto: 'http://127.0.0.1:5401/orders' }] }, '2026-11-05T02:00:02Z'),
    answer('toolu_2', [{ type: 'text', text: JSON.stringify({ ok: true, result: { completed: true, brief: true } }) }], '2026-11-05T02:00:03Z'));
  const draft = { screen_id: screenId, url: 'http://127.0.0.1:5401/orders', ...(unavailable ? { unavailable: 'DRAGON_R1A_UNAVAILABLE' } : {}) };
  lines.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: `${SCREEN_DRAFT_MARKER}\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`` }] } }));
  return `${lines.join('\n')}\n`;
}
async function collectScreen(runDir, text, { screenId = 'S1', tools } = {}) {
  const rel = `dispatch/executor_gui/${screenId}/stdout.jsonl`;
  mkdirSync(dirname(join(runDir, rel)), { recursive: true });
  writeFileSync(join(runDir, rel), text);
  const fail = (exit, code, detail) => { throw Object.assign(new Error(`${code} ${detail}`), { code }); };
  return webCollectScreen(['--run', 'scr-run', '--attestation', join(runDir, 'a.json')], {
    parseFlags: (args) => ({ run: args[1], attestation: args[3] }), fail, safeRunId: (v) => v, runDirectory: () => runDir,
    assertRoleAttestation: () => ({ role: 'executor_gui', dispatch_screen_id: screenId, session_id: 'scr-session', source: { kind: 'claude-stream', path: rel, sha256: sha(Buffer.from(text, 'utf8')) } }),
    writeConfirmed: async (p, value) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, value); }, detectorTools: tools });
}

test('D1: collect-screen writes the graded screen check; a no-R1a claim is honoured only when the stream shows it', async () => {
  const { runDir } = screenRun();
  const seen = [];
  const tools = { dragonOps: (calls) => calls, screenCheckFromOps: async (ops, o) => { seen.push({ methods: ops.map((op) => op.method), ...o, captureRef: typeof o.captureRef }); return { schema: 'qa-gui/screen-check/v1', screenId: o.screenId, route: o.route, status: 'checked', verdict: 'FAIL', issues: ['SWEEP_BAND_FAIL:W2|main:741-783'] }; } };
  const out = await collectScreen(runDir, screenStream(), { tools });
  assert.deepEqual([out.screen, out.status, out.verdict], ['S1', 'checked', 'FAIL']);
  assert.deepEqual(seen.map((x) => [x.screenId, x.route, x.url, x.planned, x.captureRef]), [['S1', '/orders', 'http://127.0.0.1:5401/orders', ['#edit'], 'function']]);
  const stored = JSON.parse(readFileSync(join(runDir, 'screens', 'S1', 'result.json'), 'utf8'));
  assert.deepEqual([stored.status, stored.verdict, stored.attestation.session_id], ['checked', 'FAIL', 'scr-session']);
  // Dragon without R1a: the claim with a help that shows no environmentContract is honoured; without it, refused.
  const shown = await collectScreen(runDir, screenStream({ screenId: 'S2', unavailable: true, help: JSON.stringify({ ok: true, result: { version: '1.15.1', rpcMethods: ['do'] } }) }), { screenId: 'S2', tools });
  assert.deepEqual([shown.status, shown.verdict], ['unavailable', null]);
  const bare = await collectScreen(runDir, screenStream({ screenId: 'S3', unavailable: true }), { screenId: 'S3', tools });
  assert.deepEqual([bare.status, bare.verdict, bare.issues], ['refused', 'UNGRADED', ['DETECTOR_UNAVAILABLE_REFUSED:S3:NOT_SHOWN']]);
  // No draft for this screen, or a QA GUI without screen checks: refused, nothing graded.
  await assert.rejects(() => collectScreen(runDir, screenStream({ screenId: 'S1' }), { screenId: 'S2', tools }), (e) => e.code === 'SCREEN_DRAFT_MISSING');
  await assert.rejects(() => collectScreen(runDir, screenStream(), { tools: null }), (e) => e.code === 'SCREEN_CHECK_QA_GUI_UNAVAILABLE');
  assert.deepEqual(screenDrafts(screenStream()), [{ screen_id: 'S1', url: 'http://127.0.0.1:5401/orders' }]);
});

test('D7: an exploration-policy.json in the run folder is honoured only when it is the signed plan\'s own policy', async () => {
  const runDir = join(tmp('policy'), 'runs', 'pol-run');
  mkdirSync(runDir, { recursive: true });
  const tracked = { coverage: { version: 'team-qa/coverage-cells/v1', rows: [{ id: 'desktop-1280', size: '1280x800', classes: ['desktop'] }], dataScreens: ['/orders'] },
    cases: [{ id: 'TC-1', lane: 'gui', route: '/orders', actions: ['view'], steps: ['x'], expected: 'x' }] };
  const computed = await runExplorationPolicy({ runDir, tracked });
  const { EXPLORATION_POLICY_FILE } = await import('../../scripts/lib/coverage-cells.mjs');
  writeFileSync(join(runDir, EXPLORATION_POLICY_FILE), JSON.stringify({ ...computed, approvedDestructive: ['#delete-all'] }));
  assert.deepEqual(await runExplorationPolicy({ runDir, tracked }), computed, 'a widened file is ignored');
  writeFileSync(join(runDir, EXPLORATION_POLICY_FILE), JSON.stringify(computed));
  assert.deepEqual(await runExplorationPolicy({ runDir, tracked }), computed);
});

test('D3: the probe runs when the case\'s main action is risky (QA GUI\'s classifier), or the plan says so', () => {
  const classify = ({ target }) => ({ risky: /save|submit|delete/i.test(target.label) });
  assert.equal(riskyMainAction({ kind: 'behavioral', steps: ['Open orders', "Click 'Save'"] }, classify), true);
  assert.equal(riskyMainAction({ kind: 'behavioral', steps: ['Open the about page', 'Read the text'] }, classify), false);
  assert.equal(riskyMainAction({ kind: 'behavioral', steps: ['Drag the card to Done'] }, classify), true);
  assert.equal(riskyMainAction({ kind: 'static', steps: ["Click 'Save'"] }, classify), false);
  assert.equal(riskyMainAction({ kind: 'static', data: { transient: true } }, classify), true);
  assert.equal(riskyMainAction({ kind: 'behavioral', steps: ["Click 'Save'"], data: { transient: false } }, classify), false);
  assert.equal(caseDetectorPlan({ plannedCase: { kind: 'behavioral', steps: ['Read the text'] }, classify }).transient, false);
});

test('D6: the timing receipt names screen checks and adjudications apart from the case dispatches', () => {
  const runDir = tmp('timing');
  const state = (role, attempt, extra) => { mkdirSync(join(runDir, 'dispatch', role, attempt), { recursive: true }); writeFileSync(join(runDir, 'dispatch', role, attempt, 'state.json'), JSON.stringify({ attempt, role, status: 'done', ...extra })); };
  state('executor_gui', 'case-attempt-1', { case_id: 'TC-1', started_at: '2026-11-05T01:00:00.000Z', ended_at: '2026-11-05T01:04:00.000Z' });
  state('executor_gui', 'screen-attempt-1', { case_id: null, screen_id: 'S1', started_at: '2026-11-05T00:55:00.000Z', ended_at: '2026-11-05T00:58:00.000Z' });
  state('adjudicator', 'adj-attempt-1', { case_id: 'TC-1', phase: 'judge', started_at: '2026-11-05T01:04:10.000Z', ended_at: '2026-11-05T01:05:10.000Z' });
  const t = runTiming({ runDir, runId: 'r' });
  assert.deepEqual(Object.fromEntries(Object.entries(t.summary.attempts_by_kind).map(([k, v]) => [k, v.total_ms])), { adjudication: 60000, case: 240000, 'screen-check': 180000 });
  assert.equal(t.attempts.find((a) => a.attempt === 'screen-attempt-1').screen_id, 'S1');
});

test('D1: a screen check result is written under runs/<id>/screens/<screen>/ only', async () => {
  const { runDir } = screenRun();
  const tools = { dragonOps: (calls) => calls, screenCheckFromOps: async (ops, o) => ({ schema: 'qa-gui/screen-check/v1', screenId: o.screenId, route: o.route, status: 'checked', verdict: 'PASS', issues: [] }) };
  await collectScreen(runDir, screenStream(), { tools });
  assert.ok(existsSync(join(runDir, 'screens', 'S1', 'result.json')));
  assert.equal(existsSync(join(runDir, 'board')), false, 'the board is the cases\' collect\'s, not the screen check\'s');
});

test('D7: the action cache keeps no probe trial, no U-state setup and no step under a forced environment', () => {
  const ok = (result = { completed: true }) => [{ type: 'text', text: JSON.stringify({ ok: true, result }) }];
  const lines = [];
  let n = 0;
  const add = (name, input, result) => { const id = `toolu_${++n}`; lines.push(use(id, `${T}${name}`, input, `2026-11-05T03:00:0${n}Z`), answer(id, ok(result), `2026-11-05T03:00:0${n}Z`)); };
  add('do', { tabId: 7, steps: [{ goto: 'http://127.0.0.1:5401/login' }, { fill: { selector: '#user', value: 'qa' } }] });
  add('framesTrial', { tabId: 7, steps: [{ clickSelector: '#save' }] }, { ok: true });
  add('do', { tabId: 7, steps: [{ read: '__uxObserve()', as: 'u:hold:before' }, { clickSelector: '#submit' }] });
  add('envSet', { tabId: 7, requests: [{ id: 'write', urlPattern: '*/api/*', action: 'hold' }] }, { ok: true });
  add('do', { tabId: 7, steps: [{ clickSelector: '#submit' }] });
  add('screenshot', { tabId: 7, toFile: 'a.png' }, { savedTo: '/x/a.png' });
  const steps = stepsBeforeFirstScreenshot(streamCalls(lines.join('\n')));
  assert.deepEqual(steps, [{ goto: 'http://127.0.0.1:5401/login' }, { fill: { selector: '#user', value: 'qa' } }]);
});
