// Upgrade R3 acceptance on fixtures: vision by diff and fast-click run both ways. Two runs of the same four GUI cases,
// one with the flags off and one with them on, each with its board records, dispatch state, worker transcripts and the
// R0 time receipt (timing.json) built from them. `speed compare` lists any case the off run fails that the on run does
// not, and puts the time receipts side by side. The verdicts and step durations are fixture values (a human-speed click
// about 0.9 s and a fast one 40 ms, as QA GUI's SKILL.md describes Dragon; a PNG read plus its VLM judgement about 9 s);
// the eval measures the real ones on the dev set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTiming, timingMarkdown } from '../../scripts/lib/timing.mjs';
import { compareSpeedRuns, readRunForCompare } from '../../scripts/lib/speed-compare.mjs';
import { appendSpeedDecision, DECISION_SCHEMA } from '../../scripts/lib/cost-ladder.mjs';

const CLI = join(fileURLToPath(new URL('../../', import.meta.url)), 'scripts/teamqa.mjs');
const T0 = Date.parse('2026-11-04T01:00:00.000Z');
const ids = { 'TC-01': '0b1c6a5e-1d2e-4f3a-8b4c-000000000001', 'TC-02': '0b1c6a5e-1d2e-4f3a-8b4c-000000000002', 'TC-03': '0b1c6a5e-1d2e-4f3a-8b4c-000000000003', 'TC-04': '0b1c6a5e-1d2e-4f3a-8b4c-000000000004' };
// What each case does, per state: clicks before it, and whether the executor opens the PNG for the VLM on the on run.
const CASES = {
  'TC-01': { title: 'List orders', states: [{ clicks: 1, inheritOn: true }, { clicks: 1, inheritOn: true }], off: 'pass', on: 'pass' },
  'TC-02': { title: 'Hover menu shows row actions', hover: true, states: [{ clicks: 2, inheritOn: false }], off: 'fail', on: 'fail' },
  'TC-03': { title: 'Save an order', states: [{ clicks: 3, inheritOn: false }], off: 'fail', on: 'fail' },
  'TC-04': { title: 'Submit twice', states: [{ clicks: 2, inheritOn: true }], off: 'fail', on: 'fail' },
};

function writeRun({ project, runId, mode, verdicts }) {
  const runDir = join(project, 'runs', runId), projects = join(project, 'projects');
  mkdirSync(runDir, { recursive: true });
  let clock = 0, caseStart = 0;
  const at = () => new Date(T0 + clock).toISOString();
  const records = [];
  for (const [caseId, c] of Object.entries(CASES)) {
    const attempt = ids[caseId].replace(/^0b/, mode === 'on' ? '1b' : '0b');
    const events = [];
    caseStart = clock;
    events.push({ type: 'user', timestamp: at(), message: { role: 'user', content: 'run the case' } });
    let n = 0;
    const call = (name, input, ms, thinkMs = 2000) => {
      clock += thinkMs; const id = `t${n += 1}`;
      events.push({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
      clock += ms;
      events.push({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: '{"ok":true}' }] }] } });
    };
    for (const [i, s] of c.states.entries()) {
      // Fast clicks only on the on run, never in the hover case.
      const fast = mode === 'on' && !c.hover;
      call('mcp__Dragon_Browser__dragon_rpc', { method: 'do', params: { steps: Array.from({ length: s.clicks }, () => ({ click: 'Next', fast })) } }, s.clicks * (fast ? 40 : 900));
      call('mcp__Dragon_Browser__dragon_rpc', { method: 'screenshot', params: { toFile: `${caseId}-s${i}.png` } }, 500);
      call('mcp__Dragon_Browser__dragon_rpc', { method: 'do', params: { steps: [{ read: 'gate0()', as: 'g0' }] } }, 300);
      // The VLM pass: the executor opens the PNG and judges C10–C16; on the on run an inherited state skips it.
      if (!(mode === 'on' && s.inheritOn)) call('Read', { file_path: `/dragon/out/${caseId}-s${i}.png` }, 1000, 2000), clock += 8000;
    }
    events.push({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text: 'draft' }] } });
    const dir = join(projects, `-runs-${runId}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${attempt}.jsonl`), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    mkdirSync(join(runDir, 'dispatch', 'executor_gui', attempt), { recursive: true });
    writeFileSync(join(runDir, 'dispatch', 'executor_gui', attempt, 'state.json'), JSON.stringify({ case_id: caseId, status: 'done', started_at: new Date(T0 + caseStart).toISOString(), ended_at: at() }));
    records.push({ case_id: caseId, lane: 'gui', verdict: verdicts[caseId], evidence: [`evidence/${caseId}.json`], source: 'qa-gui', run_id: runId, ts: at() });
    clock += 1000;
  }
  writeFileSync(join(runDir, 'board.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const timing = runTiming({ runDir, runId, projectsRoot: projects });
  writeFileSync(join(runDir, 'timing.json'), JSON.stringify(timing));
  return { runDir, timing };
}

test('both ways: the on run misses no case the off run fails, and its time receipt is shorter where the flags skip work', async (t) => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-r3-shadow-')));
  const off = writeRun({ project, runId: 'r-off', mode: 'off', verdicts: Object.fromEntries(Object.entries(CASES).map(([id, c]) => [id, c.off])) });
  const on = writeRun({ project, runId: 'r-on', mode: 'on', verdicts: Object.fromEntries(Object.entries(CASES).map(([id, c]) => [id, c.on])) });
  // The on run's decision log, as collect writes it: vision by diff per state, fast-click per case.
  for (const [caseId, c] of Object.entries(CASES)) {
    for (const [i, s] of c.states.entries()) {
      await appendSpeedDecision(on.runDir, { schema: DECISION_SCHEMA, kind: 'vision_by_diff', mode: 'on', case_id: caseId, state: `s${i}`, decision: s.inheritOn ? 'inherit' : 'vlm',
        reasons: s.inheritOn ? [] : ['DIFF_OVER_LIMIT'], applied: s.inheritOn, vlm_skipped: s.inheritOn, missed_rules: [] });
    }
    await appendSpeedDecision(on.runDir, { schema: DECISION_SCHEMA, kind: 'fast_click', mode: 'on', case_id: caseId, plan: { fast: !c.hover, reason: c.hover ? 'CASE_CHECKS_HOVER_OR_DRAG' : 'POLICY_ON' },
      summary: { clicks: c.states.reduce((n, s) => n + s.clicks, 0), fast_clicks: c.hover ? 0 : c.states.reduce((n, s) => n + s.clicks, 0), hover_or_drag: c.hover ? 1 : 0 }, issues: [] });
  }
  const result = compareSpeedRuns({ off: readRunForCompare(off.runDir), on: readRunForCompare(on.runDir) });
  assert.equal(result.verdict, 'no-miss');
  assert.deepEqual(result.cases.missed, []);
  assert.deepEqual(result.cases.ungraded_on, []);
  assert.equal(result.cases.compared, 4);
  // The time receipts: fewer and shorter VLM reads, shorter clicks, a shorter wall.
  const k = result.timing.by_kind;
  assert.deepEqual([k['vision.read'].off.steps, k['vision.read'].on.steps], [5, 2]);
  assert.ok(k['vision.read'].delta_ms < 0 && k['dragon.do'].delta_ms < 0 && k.model.delta_ms < 0, JSON.stringify(k));
  assert.ok(result.timing.wall_ms.delta < 0, JSON.stringify(result.timing.wall_ms));
  t.diagnostic(`wall ${result.timing.wall_ms.off} -> ${result.timing.wall_ms.on} ms; vision.read ${k['vision.read'].off.ms} -> ${k['vision.read'].on.ms} ms; dragon.do ${k['dragon.do'].off.ms} -> ${k['dragon.do'].on.ms} ms; model ${k.model.off.ms} -> ${k.model.on.ms} ms`);
  // The on run's receipt names the speed decisions it rests on.
  assert.match(timingMarkdown(runTiming({ runDir: on.runDir, runId: 'r-on', projectsRoot: join(project, 'projects') })), /## Speed[\s\S]*inherit 3, VLM 2/);
  // The CLI says the same, and exits 1 when the on run lost a FAIL (here a hover case run with fast clicks that passed).
  let r = spawnSync(process.execPath, [CLI, 'speed', 'compare', '--off', 'r-off', '--on', 'r-on'], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).verdict, 'no-miss');
  writeRun({ project, runId: 'r-bad', mode: 'on', verdicts: { 'TC-01': 'pass', 'TC-02': 'pass', 'TC-03': 'fail', 'TC-04': 'ungraded' } });
  r = spawnSync(process.execPath, [CLI, 'speed', 'compare', '--off', 'r-off', '--on', 'r-bad'], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 1);
  const bad = JSON.parse(r.stdout);
  assert.deepEqual(bad.cases.missed, [{ case_id: 'TC-02', off: 'fail', on: 'pass' }]);
  assert.deepEqual(bad.cases.ungraded_on, [{ case_id: 'TC-04', off: 'fail', on: 'ungraded' }]);
});

test('a shadow run is compared with its own decision log: a state where inheriting would have missed a VLM FAIL is a miss', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-r3-shadow1-')));
  const shadow = writeRun({ project, runId: 'r-shadow', mode: 'off', verdicts: { 'TC-01': 'pass', 'TC-02': 'fail', 'TC-03': 'fail', 'TC-04': 'fail' } });
  await appendSpeedDecision(shadow.runDir, { schema: DECISION_SCHEMA, kind: 'vision_by_diff', mode: 'shadow', case_id: 'TC-01', state: 's0', decision: 'inherit', reasons: [], agree: true, missed_rules: [] });
  const clean = compareSpeedRuns({ off: readRunForCompare(shadow.runDir), on: readRunForCompare(shadow.runDir) });
  assert.equal(clean.verdict, 'no-miss');
  await appendSpeedDecision(shadow.runDir, { schema: DECISION_SCHEMA, kind: 'vision_by_diff', mode: 'shadow', case_id: 'TC-03', state: 's0', decision: 'inherit', reasons: [], agree: false, missed_rules: ['C12'] });
  const missed = compareSpeedRuns({ off: readRunForCompare(shadow.runDir), on: readRunForCompare(shadow.runDir) });
  assert.equal(missed.verdict, 'missed');
  assert.deepEqual(missed.vision_shadow_missed, [{ case_id: 'TC-03', state: 's0', rules: ['C12'] }]);
});
