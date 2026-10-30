import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const root = new URL('../../', import.meta.url).pathname;
const entry = join(root, 'scripts/teamqa.mjs');
function cli(cwd, ...args) { const r = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8' }); return { status: r.status, text: `${r.stdout}${r.stderr}` }; }
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'tq-current-contract-'));
  cpSync(join(root, 'test/acceptance/fixtures/report/base'), cwd, { recursive: true });
  return { cwd, run: join(cwd, 'runs/tq-report') };
}
test('direct board intake cannot create a current official run from legacy files', () => {
  const { cwd, run } = fixture();
  writeFileSync(join(run, 'phase.json'), JSON.stringify({ schema: 'team-qa/run-contract/v1', phase: 'EXECUTE' }));
  const row = JSON.parse(readFileSync(join(run, 'board.jsonl'), 'utf8').split('\n')[0]);
  row.case_id = 'CASE-HIGH-1';
  writeFileSync(join(run, 'record.json'), JSON.stringify(row));
  const initial = readFileSync(join(run, 'board.jsonl'), 'utf8').split('\n').slice(1).join('\n');
  writeFileSync(join(run, 'board.jsonl'), initial);
  const r = cli(cwd, 'board', 'add', '--file', join(run, 'board.jsonl'), '--record', join(run, 'record.json'));
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.text, /ROSTER_(MISSING|UNAPPROVED)|RUN_CONTRACT_MISSING/);
  assert.equal(readFileSync(join(run, 'board.jsonl'), 'utf8'), initial);
});
test('direct plan approval cannot authorize a run without its roster', () => {
  const { cwd, run } = fixture();
  writeFileSync(join(run, 'phase.json'), JSON.stringify({ schema: 'team-qa/run-contract/v1', phase: 'SIGN' }));
  const r = cli(cwd, 'gate', 'approve', '--run', 'tq-report', '--plan', join(run, 'test-plan.md'), '--signed-by', 'owner');
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.text, /ROSTER_(MISSING|UNAPPROVED)|RUN_CONTRACT_MISSING/);
});
test('read-only plan validation remains available for diagnostics', () => {
  const { cwd, run } = fixture();
  const r = cli(cwd, 'plan', 'validate', join(run, 'test-plan.md'));
  assert.equal(r.status, 0, r.text);
});
test('phase entry cannot proceed without a current roster and role binding', () => {
  const { cwd } = fixture();
  const r = cli(cwd, 'run', 'transition', '--run', 'tq-report', '--to', 'EXECUTE');
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.text, /ROSTER_(MISSING|UNAPPROVED)|RUN_CONTRACT_MISSING/);
});
