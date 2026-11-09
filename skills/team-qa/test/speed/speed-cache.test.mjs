// Upgrade R3: the action cache in a Team QA run. A passed case's action steps (from its own attested stream, before its
// first screenshot) go to the run's output cache; a later dispatch with the same fingerprint gets them under `on` and
// only a log line under `shadow`. QA GUI's cache tools are stubbed unless TEAMQA_WEB_TEST_QA_GUI_ROOT is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CACHE_OUTPUT, cacheLookup, cacheStore, caseSignals, stepsBeforeFirstScreenshot } from '../../scripts/lib/speed-cache.mjs';
import { dispatchSpeedSection, qaGuiSpeedTools } from '../../scripts/lib/speed-collect.mjs';
import { readSpeedDecisions } from '../../scripts/lib/cost-ladder.mjs';
import { runSpeedPolicy } from '../../scripts/lib/speed.mjs';
import { streamCalls } from '../../scripts/lib/web-collect.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const QA_GUI = process.env.TEAMQA_WEB_TEST_QA_GUI_ROOT;
// Stub with the cache's contract: pass-only store, actions only, every signal equal for a hit.
const stub = {
  storeFromPassedRun: ({ cache, signals, to, steps, run, now }) => {
    if (!['gate_verdict', 'function_verdict', 'ui_verdict'].every((k) => run[k] === 'PASS')) throw Object.assign(new Error('ACTION_CACHE_SOURCE_NOT_PASS'), { code: 'ACTION_CACHE_SOURCE_NOT_PASS' });
    const kept = steps.filter((s) => !('read' in s) && !('assert' in s));
    const entry = { fingerprint: signals, fingerprint_sha256: sha(JSON.stringify(signals)), to, steps: kept, stored_at: now, expires_at: now, source: { run_id: run.run_id, case_id: run.case_id, receipt_sha256: run.receipt_sha256 } };
    return { cache: { ...cache, entries: [...cache.entries, entry] }, entry, stripped: steps.length - kept.length };
  },
  actionCacheErrors: () => [],
  lookupActions: ({ cache, signals, to }) => { const hit = cache.entries.find((e) => e.fingerprint_sha256 === sha(JSON.stringify(signals)) && e.to.state === to.state); return hit ? { hit, reason: 'HIT' } : { hit: null, reason: 'MISS' }; },
};

function run({ mode = 'on', verdict = 'pass', child = 'pass', cache = { schema: 'qa-gui/action-cache/v1', entries: [] } } = {}) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-r3-cache-')));
  const runDir = join(project, 'runs', 'r1');
  mkdirSync(join(runDir, 'role-bindings'), { recursive: true });
  mkdirSync(join(project, 'cache'), { recursive: true });
  writeFileSync(join(project, 'cache', 'actions.json'), JSON.stringify(cache));
  const pin = { path: 'cache/actions.json', sha256: sha(readFileSync(join(project, 'cache', 'actions.json'))) };
  const plan = { run_id: 'r1', app: 'shop', plan_version: 1, lanes: [{ id: 'gui', scope: ['REQ-1'], parallel_ok: false, vi_sao: '' }], tiers: { 'REQ-1': 'FULL' },
    exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 70 }, speed: { action_cache: mode, action_cache_store: pin } };
  writeFileSync(join(runDir, 'test-plan.md'), `TEAMQA_PLAN_START\n${JSON.stringify(plan)}\nTEAMQA_PLAN_END\n`);
  writeFileSync(join(runDir, 'tracked-plan.json'), JSON.stringify({ cases: [{ id: 'TC-01', req_id: 'REQ-1', data: { locale: 'en-US' } }] }));
  writeFileSync(join(runDir, 'board.json'), JSON.stringify({ viewport: '1280x800' }));
  writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ artifacts: { plan: { path: 'test-plan.md', sha256: sha(readFileSync(join(runDir, 'test-plan.md'))) },
    tracked: { path: 'tracked-plan.json', sha256: 'x' }, board: { path: 'board.json', sha256: 'y' } } }));
  writeFileSync(join(runDir, 'binding.json'), JSON.stringify({ target: { preview_url: 'https://app.test/orders', frontend_build: { id: 'build-3' } } }));
  const ok = (result) => [{ type: 'text', text: JSON.stringify({ ok: true, result }) }];
  const ev = [
    ['u1', 'do', { steps: [{ click: 'New order', fast: false }, { read: 'x', as: 'y' }] }, { completed: true }],
    ['u2', 'do', { steps: [{ fill: { selector: '#qty', value: '5' } }] }, { completed: true }],
    ['u3', 'screenshot', { toFile: 's.png' }, { savedTo: '/x/s.png' }],
    ['u4', 'do', { steps: [{ click: 'Save' }] }, { completed: true }],
  ].flatMap(([id, method, params, result]) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__Dragon_Browser__dragon_rpc', input: { method, params } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: ok(result) }] } }]);
  const stream = ev.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(runDir, 'stream.jsonl'), stream);
  writeFileSync(join(runDir, 'role-bindings', 'executor_gui.json'), JSON.stringify({ dispatch_case_id: 'TC-01', source: { path: 'stream.jsonl', sha256: sha(Buffer.from(stream, 'utf8')) } }));
  writeFileSync(join(runDir, 'board.jsonl'), `${JSON.stringify({ case_id: 'TC-01', verdict, child_verdict: { skill: 'qa-gui', verdict: child, sha256: 'r'.repeat(64) } })}\n`);
  return { project, runDir, pin };
}

test('signals of a case come from the plan, the target, the board and the lane; the steps are the do steps before the first screenshot', () => {
  const { runDir } = run();
  assert.deepEqual(caseSignals(runDir, runSpeedPolicy(runDir), 'TC-01'), { app: 'shop', origin: 'https://app.test', route: '/orders', build: 'build-3', viewport: '1280x800', locale: 'en-US', role: 'default' });
  const calls = streamCalls(readFileSync(join(runDir, 'stream.jsonl'), 'utf8'));
  assert.deepEqual(stepsBeforeFirstScreenshot(calls), [{ click: 'New order', fast: false }, { read: 'x', as: 'y' }, { fill: { selector: '#qty', value: '5' } }]);
});

test('cache-store keeps a passed case only, in the run\'s output cache; the pinned store is never rewritten', async () => {
  const { runDir, project, pin } = run();
  const stored = await cacheStore({ runDir, caseId: 'TC-01', tools: stub, streamCalls, now: '2026-11-04T03:00:00.000Z' });
  assert.equal(stored.output, CACHE_OUTPUT);
  assert.equal(stored.stripped, 1);
  const out = JSON.parse(readFileSync(join(runDir, CACHE_OUTPUT), 'utf8'));
  assert.deepEqual(out.entries[0].steps, [{ click: 'New order', fast: false }, { fill: { selector: '#qty', value: '5' } }]);
  assert.equal(sha(readFileSync(join(project, pin.path))), pin.sha256, 'the pinned store is unchanged');
  assert.equal(readSpeedDecisions(runDir).at(-1).reason, 'STORED');
  for (const options of [{ verdict: 'fail' }, { verdict: 'ungraded' }, { child: 'ungraded' }]) {
    const r = run(options);
    await assert.rejects(() => cacheStore({ runDir: r.runDir, caseId: 'TC-01', tools: stub, streamCalls }), /ACTION_CACHE_SOURCE_NOT_PASS/);
  }
  const off = run({ mode: 'off' });
  await assert.rejects(() => cacheStore({ runDir: off.runDir, caseId: 'TC-01', tools: stub, streamCalls }), /SPEED_FLAG_OFF/);
});

test('dispatch: on gives a hit to the executor, shadow only logs it, a miss is logged too', async () => {
  const first = run();
  await cacheStore({ runDir: first.runDir, caseId: 'TC-01', tools: stub, streamCalls, now: '2026-11-04T03:00:00.000Z' });
  const cache = JSON.parse(readFileSync(join(first.runDir, CACHE_OUTPUT), 'utf8'));
  const next = run({ cache });
  assert.match(await dispatchSpeedSection({ runDir: next.runDir, caseId: 'TC-01', speedTools: stub }), /action_cache: a passed run reached this case's first state[\s\S]*"New order"/);
  assert.equal(readSpeedDecisions(next.runDir).at(-1).reason, 'HIT');
  const shadow = run({ mode: 'shadow', cache });
  assert.equal(await dispatchSpeedSection({ runDir: shadow.runDir, caseId: 'TC-01', speedTools: stub }), '');
  assert.equal(readSpeedDecisions(shadow.runDir).at(-1).reason, 'HIT');
  const miss = run();
  assert.equal(await cacheLookup({ runDir: miss.runDir, caseId: 'TC-01', tools: stub }), null);
  assert.equal(readSpeedDecisions(miss.runDir).at(-1).reason, 'MISS');
});

test('with the real QA GUI cache tools: store from a pass, then a hit with every signal equal', { skip: QA_GUI ? false : 'set TEAMQA_WEB_TEST_QA_GUI_ROOT to a QA GUI checkout with the R3 speed tools' }, async () => {
  const tools = await qaGuiSpeedTools(QA_GUI);
  const first = run();
  const stored = await cacheStore({ runDir: first.runDir, caseId: 'TC-01', tools, streamCalls, now: new Date().toISOString() });
  assert.ok(stored.entry.steps.some((s) => s.waitFor), 'QA GUI guards each cached action');
  assert.ok(!stored.entry.steps.some((s) => 'read' in s));
  const next = run({ cache: JSON.parse(readFileSync(join(first.runDir, CACHE_OUTPUT), 'utf8')) });
  assert.ok(await cacheLookup({ runDir: next.runDir, caseId: 'TC-01', tools }));
});
