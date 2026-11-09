// Upgrade R0: timing receipts and the decision log, read from the run's own transcripts and dispatch state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { percentile, rootDecisions, runTiming, stepKind, timingMarkdown, transcriptSteps } from '../scripts/lib/timing.mjs';

const T0 = Date.parse('2026-11-04T01:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

function writeTranscript(path, events) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return path;
}
const user = (s, text = 'go') => ({ type: 'user', timestamp: at(s), message: { role: 'user', content: text } });
const call = (s, id, name, input) => ({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (s, id, text = 'ok', isError = false) => ({ type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) }] } });

test('step kinds name where the time goes', () => {
  assert.equal(stepKind('mcp__Dragon_Browser__do', {}), 'dragon.do');
  assert.equal(stepKind('mcp__dragon__dragon_rpc', { method: 'screenshot' }), 'dragon.screenshot');
  assert.equal(stepKind('Bash', { command: 'node scripts/qa-gate.mjs --file b.json' }), 'gate.qa-gui');
  assert.equal(stepKind('Bash', { command: 'node scripts/roster.mjs dispatch --role analyst' }), 'dispatch');
  assert.equal(stepKind('Bash', { command: 'teamqa run transition --run r --to DESIGN' }), 'teamqa.run.transition');
  assert.equal(stepKind('Bash', { command: 'sleep 4' }), 'wait.sleep');
  assert.equal(stepKind('Read', { file_path: '/x/after.png' }), 'vision.read');
  assert.equal(stepKind('Read', { file_path: '/x/plan.md' }), 'files');
  assert.equal(stepKind('mcp__Notion__notion-create-pages', {}), 'notion');
});

test('percentile is nearest rank', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

test('a transcript gives tool steps and model steps; GUI actions carry the digest of the last observation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timing-'));
  const path = writeTranscript(join(dir, 't.jsonl'), [
    user(0), call(3, 'a', 'mcp__Dragon_Browser__do', { action: 'click' }), result(5, 'a', 'clicked'),
    call(9, 'b', 'mcp__Dragon_Browser__dragon_rpc', { method: 'screenshot' }), result(10, 'b', 'png'),
    { type: 'assistant', isSidechain: true, timestamp: at(11), message: { role: 'assistant', content: [] } },
  ]);
  const { steps, actions } = transcriptSteps(path, { source: 'x', role: 'executor_gui', caseId: 'TC-01' });
  assert.deepEqual(steps.map((s) => [s.kind, s.duration_ms]), [['model', 3000], ['dragon.do', 2000], ['model', 4000], ['dragon.screenshot', 1000]]);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].observation_sha256, null);
  assert.match(actions[1].observation_sha256, /^[a-f0-9]{16}$/);
  assert.ok(steps.every((s) => s.case_id === 'TC-01'));
});

function runFixture() {
  const base = mkdtempSync(join(tmpdir(), 'timing-run-'));
  const runDir = join(base, 'runs', 'r1'), projects = join(base, 'projects');
  const attempt = 'c85f86bf-8ad1-4caa-936d-9f19a29961ee', missing = 'f03bf5ba-7dfa-4724-a7dc-f07ddef71f66';
  const root = writeTranscript(join(projects, '-ws', 'root.jsonl'), [
    user(0, 'QA this app'),
    call(10, 'r1', 'Bash', { command: 'teamqa run transition --run r1 --to DESIGN' }), result(11, 'r1'),
    call(20, 'r2', 'Bash', { command: 'teamqa run transition --run r1 --to EXECUTE' }), result(21, 'r2'),
    call(30, 'r3', 'Bash', { command: 'node scripts/roster.mjs dispatch --role executor_gui --case-id TC-01 --detach' }), result(31, 'r3'),
    call(32, 'r4', 'Bash', { command: 'node scripts/roster.mjs wait --run r1 --attempt x' }), result(392, 'r4'),
    call(400, 'r5', 'Bash', { command: 'teamqa run offer --run r1 --kind round --cases TC-02 --reason NO_VERDICT' }), result(401, 'r5'),
  ]);
  writeTranscript(join(projects, '-ws-runs-r1', `${attempt}.jsonl`), [
    user(35), call(40, 'w1', 'mcp__Dragon_Browser__do', { action: 'click' }), result(42, 'w1'), call(50, 'w2', 'Bash', { command: 'node qa-gate.mjs' }), result(80, 'w2'),
  ]);
  for (const [id, caseId, s, e] of [[attempt, 'TC-01', 33, 390], [missing, 'TC-02', 402, 700]]) {
    mkdirSync(join(runDir, 'dispatch', 'executor_gui', id), { recursive: true });
    writeFileSync(join(runDir, 'dispatch', 'executor_gui', id, 'state.json'), JSON.stringify({ case_id: caseId, status: 'done', started_at: at(s), ended_at: at(e) }));
  }
  return { runDir, root, projects };
}

test('run timing: roles, phases, cases and the decision log; a missing worker transcript is said, not counted as zero', () => {
  const f = runFixture();
  const t = runTiming({ runDir: f.runDir, runId: 'r1', rootTranscript: f.root, projectsRoot: f.projects });
  assert.equal(t.schema, 'team-qa/run-timing/v1');
  assert.equal(t.wall.duration_ms, 700000);
  assert.deepEqual(t.sources.worker_transcripts, { found: 1, missing: 1 });
  assert.equal(t.summary.cases['TC-01'].total_ms, 357000);
  assert.equal(t.summary.cases['TC-02'].total_ms, 298000);
  assert.equal(t.summary.by_kind.dispatch.total_ms, 361000);
  assert.equal(t.summary.by_kind['gate.qa-gui'].total_ms, 30000);
  const workerStep = t.steps.find((s) => s.kind === 'dragon.do');
  assert.equal(workerStep.phase, 'EXECUTE');
  assert.equal(t.steps.find((s) => s.kind === 'teamqa.run.transition' && s.started_at === at(10)).phase, 'DESIGN');
  assert.deepEqual(t.decisions.root.map((d) => d.point), ['phase', 'phase', 'dispatch', 'rerun-offer']);
  assert.deepEqual(t.decisions.root[2].chosen, { role: 'executor_gui', case_id: 'TC-01' });
  assert.equal(t.decisions.root[0].model_ms, 10000);
  assert.equal(t.decisions.gui_actions.length, 1);
  const md = timingMarkdown(t);
  assert.match(md, /## Time/);
  assert.match(md, /Not read: 1 worker transcript\(s\)/);
  assert.match(md, /\| TC-01 \| 1 \| 6\.0 \|/);
});

test('decisions: only Team QA branch points of the root are listed', () => {
  const f = runFixture();
  const d = rootDecisions(f.root);
  assert.ok(d.every((x) => ['dispatch', 'rerun-offer', 'phase', 'board'].includes(x.point)));
  assert.equal(d.filter((x) => x.point === 'dispatch').length, 1, 'wait is not a decision');
});
