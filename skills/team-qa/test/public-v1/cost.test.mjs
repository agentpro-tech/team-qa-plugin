import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COST_BASELINE, assertUnderCap, costMarkdown, estimateLines, estimateRoster, runSpend } from '../../scripts/lib/cost.mjs';
import { startCaseDispatch } from '../../scripts/lib/run-contract.mjs';
import { rosterChat } from '../../scripts/lib/chat-presentation.mjs';

// Public v1, S2: an estimate before approval, a cap checked at the case boundary, and the actual cost per role.
const CLI = new URL('../../scripts/teamqa.mjs', import.meta.url).pathname;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const text = (value) => `${JSON.stringify(value, null, 2)}\n`;
const seat = (role, model) => ({ role, provider: 'anthropic', model, effort: 'medium', harness: 'claude', tools: [], permission_profile: 'p', caps: { timeout_ms: 1000, max_turns: 2 } });
const ROSTER = { run_id: 'r1', round: 1, scope: 'checkout', target: { project_id: 'sample-shop', preview_url: 'http://localhost:3000', version: 'abc' },
  roles: [seat('test_manager', 'claude-opus-5-5'), seat('analyst', 'claude-sonnet-5-5'), seat('designer', 'claude-sonnet-5-5'), seat('executor_gui', 'claude-sonnet-5-5'), seat('executor_code', 'gpt-5.5')] };
const CASES = ['TC-01', 'TC-02'].map((id) => ({ id, req_id: 'REQ-1', lane: 'gui', steps: ['Open the page'], expected: 'Shown', data: {}, priority: 'P1',
  kind: 'static', title: id, sourceRefs: ['SRC-1'], taxonomy: ['functional'], states: ['ideal'], viewports: ['desktop'] }));
function run() {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-cost-'))), runDir = join(ws, 'runs', 'r1');
  mkdirSync(join(runDir, 'role-bindings'), { recursive: true });
  writeFileSync(join(runDir, 'roster.json'), text(ROSTER));
  writeFileSync(join(runDir, 'tracked-plan.json'), text({ schemaVersion: 2, sourceItems: [{ id: 'SRC-1', kind: 'brief', sourceSystem: 'brief', externalKey: 'K-1', title: 'One', origin: 'upstream' }], cases: CASES }));
  writeFileSync(join(runDir, 'docs-lock.json'), text({ schema: 'team-qa/docs-lock/v1', run_id: 'r1', round: 1, roster_hash: 'a'.repeat(64),
    artifacts: { tracked: { path: 'tracked-plan.json', sha256: hash(readFileSync(join(runDir, 'tracked-plan.json'))) } } }));
  return { ws, runDir };
}
function attempt(runDir, role, id, events) {
  mkdirSync(join(runDir, 'dispatch', role, id), { recursive: true });
  writeFileSync(join(runDir, 'dispatch', role, id, 'stdout.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const claudeResult = (usd, ms) => ({ type: 'result', subtype: 'success', total_cost_usd: usd, duration_ms: ms, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 200 } });

test('the estimate follows the measured baseline: planning roles per round, GUI cases per case', () => {
  const e = estimateRoster(ROSTER, { cases: 3 });
  const b = COST_BASELINE.roles;
  assert.equal(e.planning_usd.toFixed(3), (2 * (b.analyst.usd_p50 + b.designer.usd_p50 + b.test_manager.usd_p50)).toFixed(3));
  assert.equal(e.case_usd.toFixed(3), (1.4 * b.executor_gui.usd_p50).toFixed(3));
  assert.equal(e.total_usd.toFixed(3), (e.planning_usd + 3 * e.case_usd).toFixed(3));
  assert.deepEqual(e.unmeasured, ['executor_code']);
  const lines = estimateLines(ROSTER);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /planning roles about \$1\.38 per round; each GUI case about \$3\.68 and 9\.1 min \(up to \$10\.19\)/);
  assert.match(lines[0], /not measured: executor_code/);
  assert.match(lines[0], /teamqa cost cap --run r1 --usd <amount>/);
  assert.ok(rosterChat({ ...ROSTER, roles: ROSTER.roles.filter((s) => s.role !== 'executor_code') }, 'f'.repeat(64)).includes('Cost estimate at API list prices'));
  assert.deepEqual(estimateLines({ ...ROSTER, roles: [] }), []);
});

test('the actual spend is read from every worker attempt: Claude cost and tokens, Codex tokens', () => {
  const { runDir } = run();
  attempt(runDir, 'executor_gui', 'a1', [{ type: 'assistant' }, claudeResult(2.5, 360000)]);
  attempt(runDir, 'executor_gui', 'a2', [claudeResult(1.25, 120000)]);
  attempt(runDir, 'analyst', 'b1', [{ type: 'turn.completed', usage: { input_tokens: 300, cached_input_tokens: 50, output_tokens: 40 } }]);
  const spend = runSpend(runDir);
  assert.equal(spend.usd, 3.75);
  assert.equal(spend.unpriced, 1);
  assert.deepEqual([spend.roles.executor_gui.attempts, spend.roles.executor_gui.output_tokens, Math.round(spend.roles.executor_gui.minutes)], [2, 400, 8]);
  assert.deepEqual([spend.roles.analyst.input_tokens, spend.roles.analyst.cached_tokens, spend.roles.analyst.output_tokens], [300, 50, 40]);
  const md = costMarkdown(runDir);
  assert.match(md, /## Cost/);
  assert.match(md, /\| executor_gui \| 2 \| 8 \| 30 \| 2000 \| 400 \| \$3\.75 \|/);
  assert.match(md, /\| analyst \| 1 \| 0 \| 300 \| 50 \| 40 \| n\/a \|/);
  assert.match(md, /\$3\.75 \(\+1 attempts without a price\)/);
});

test('a run that has spent its cap starts no new case; the evidence of earlier cases stays', async () => {
  const { ws, runDir } = run();
  const cap = spawnSync(process.execPath, [CLI, 'cost', 'cap', '--run', 'r1', '--usd', '3'], { cwd: ws, encoding: 'utf8' });
  assert.equal(cap.status, 0, cap.stderr + cap.stdout);
  assert.match(cap.stdout, /verdict=pass COST_CAP_SET usd=3 spent=\$0\.00/);
  assert.equal((await startCaseDispatch({ runDir, role: 'executor_gui', caseId: 'TC-01', attempt: 'attempt-tc01-1' })).used, 1);
  attempt(runDir, 'executor_gui', 'attempt-tc01-1', [claudeResult(3.1, 300000)]);
  await assert.rejects(() => startCaseDispatch({ runDir, role: 'executor_gui', caseId: 'TC-02', attempt: 'attempt-tc02-1' }), (e) => e.code === 'RUN_COST_CAP_REACHED' && /spent \$3\.10 of the \$3\.00 cap/.test(e.detail));
  assert.ok(readFileSync(join(runDir, 'dispatch/executor_gui/attempt-tc01-1/stdout.jsonl'), 'utf8').includes('total_cost_usd'));
  assert.throws(() => assertUnderCap(runDir), /RUN_COST_CAP_REACHED|TeamQA/);
  const report = spawnSync(process.execPath, [CLI, 'cost', 'report', '--run', 'r1'], { cwd: ws, encoding: 'utf8' });
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /Cap: \$3\.00\./);
  const estimate = spawnSync(process.execPath, [CLI, 'cost', 'estimate', '--run', 'r1'], { cwd: ws, encoding: 'utf8' });
  assert.equal(estimate.status, 0, estimate.stderr);
  assert.match(estimate.stdout, /verdict=pass COST_ESTIMATE cases=2 typical=\$8\.74 up_to=\$22\.27 minutes=22 prices=api_list root_session=not_included/);
  assert.notEqual(spawnSync(process.execPath, [CLI, 'cost', 'cap', '--run', 'r1', '--usd', '-1'], { cwd: ws, encoding: 'utf8' }).status, 0);
});

// N7: attempts with no reported price (timed out, still running, Codex CLI or native) counted $0, and only a Claude GUI
// case checked the cap, so a Codex run never stopped at it.
const capAt = (runDir, usd) => writeFileSync(join(runDir, 'cost-cap.json'), text({ schema: 'team-qa/cost-cap/v1', usd, set_at: new Date().toISOString() }));
test('an attempt without a price counts at the measured maximum of its role toward the cap', () => {
  const b = COST_BASELINE.roles;
  const { runDir } = run();
  attempt(runDir, 'executor_gui', 'g-timeout', [{ type: 'assistant' }]);
  let spend = runSpend(runDir);
  assert.equal(spend.usd, 0); assert.equal(spend.unpriced, 1);
  assert.equal(spend.usd_cap, b.executor_gui.usd_max);
  capAt(runDir, 5);
  assert.throws(() => assertUnderCap(runDir), (e) => e.code === 'RUN_COST_CAP_REACHED' && /\$7\.28 of the \$5\.00 cap/.test(e.detail) && /without a price/.test(e.detail));
  const other = run().runDir;
  // A Codex CLI attempt reports tokens only; a worker still running has no stdout yet.
  attempt(other, 'analyst', 'a-codex', [{ type: 'turn.completed', usage: { input_tokens: 300, cached_input_tokens: 0, output_tokens: 40 } }]);
  mkdirSync(join(other, 'dispatch', 'designer', 'd-running'), { recursive: true });
  mkdirSync(join(other, 'dispatch', 'executor_gui', 'g-detached'), { recursive: true });
  writeFileSync(join(other, 'dispatch', 'executor_gui', 'g-detached', 'state.json'), text({ status: 'running' }));
  writeFileSync(join(other, 'dispatch', 'executor_gui', 'g-detached', 'progress.jsonl'), JSON.stringify({ type: 'assistant' }) + '\n');
  // A detached dispatch that failed before its worker started spent nothing.
  mkdirSync(join(other, 'dispatch', 'executor_gui', 'g-refused'), { recursive: true });
  writeFileSync(join(other, 'dispatch', 'executor_gui', 'g-refused', 'state.json'), text({ status: 'failed', code: 'ROSTER_NOT_APPROVED' }));
  // A native Codex attempt (prepared intent) reports no price either.
  mkdirSync(join(other, 'native-dispatch', 'executor_gui', 'attempt-2'), { recursive: true });
  writeFileSync(join(other, 'native-dispatch', 'executor_gui.json'), text({ role: 'executor_gui' }));
  writeFileSync(join(other, 'native-dispatch', 'executor_gui.context.md'), 'packet');
  writeFileSync(join(other, 'native-dispatch', 'executor_gui', 'attempt-2', 'intent.json'), text({ role: 'executor_gui' }));
  spend = runSpend(other);
  assert.equal(spend.usd, 0);
  assert.equal(spend.unpriced, 5);
  assert.equal(spend.usd_cap.toFixed(3), (b.analyst.usd_max + b.designer.usd_max + 3 * b.executor_gui.usd_max).toFixed(3));
  assert.equal(spend.roles.executor_gui.attempts, 3);
});

test('every dispatch checks the cap, not only a Claude GUI case; the cap warns about seats that report no price', async () => {
  const { approveRoster, dispatchRole, selectRoster } = await import('../../scripts/lib/roster.mjs');
  const ROOT = new URL('../../', import.meta.url).pathname;
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-cost-dispatch-'))), runDir = join(ws, 'runs', 'roster-acceptance-001');
  mkdirSync(runDir, { recursive: true });
  const request = JSON.parse(readFileSync(join(ROOT, 'test/roster-dynamic/request-default.json'), 'utf8'));
  const catalogPath = join(ROOT, 'test/roster-dynamic/catalog-openai-v1.json'), rosterPath = join(runDir, 'roster.json');
  writeFileSync(rosterPath, text(selectRoster({ catalog: JSON.parse(readFileSync(catalogPath, 'utf8')), request, catalogPath })));
  await approveRoster({ runDir, file: rosterPath, userEvent: { schema: 'team-qa/roster-user-event/v1', id: 'fixture-approval', actor: 'user', text: 'Approve',
    run_id: request.run_id, round: request.round, roster_hash: hash(readFileSync(rosterPath)) } });
  writeFileSync(join(runDir, 'prompt.md'), 'Fixture prompt.');
  attempt(runDir, 'analyst', 'a-codex', [{ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }]);
  capAt(runDir, 0.1);
  await assert.rejects(dispatchRole({ runDir, role: 'test_manager', prompt: join(runDir, 'prompt.md'), out: join(runDir, 'receipt.json') }), (e) => e.code === 'RUN_COST_CAP_REACHED');
  assert.equal(existsSync(join(runDir, 'dispatch', 'test_manager')), false, 'no worker ran');
  const cap = spawnSync(process.execPath, [CLI, 'cost', 'cap', '--run', 'roster-acceptance-001', '--usd', '20'], { cwd: ws, encoding: 'utf8' });
  assert.equal(cap.status, 0, cap.stderr + cap.stdout);
  assert.match(cap.stdout, /verdict=pass COST_CAP_SET usd=20 spent=\$0\.00 counted=\$0\.18 .*unpriced_seats=test_manager,analyst,designer,executor_gui,executor_code/);
  assert.match(cap.stdout + cap.stderr, /report no price/);
});
