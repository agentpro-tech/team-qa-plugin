// Upgrade R2a: `teamqa adjudicate` runs the approved roster's adjudicator seat (here a fixture harness stub).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { approveRoster, selectRoster } from '../../scripts/lib/roster.mjs';
import { sha256File } from '../../scripts/lib/core.mjs';
import { failRecord, fixtureRun, here, root } from './support.mjs';

const cli = join(root, 'scripts/teamqa.mjs');
const run = (cwd, args, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

async function approvedRun({ adjudicator = { provider: 'anthropic' } } = {}) {
  const f = fixtureRun({ missingStep: true });
  const catalogPath = join(root, 'test/roster-dynamic/catalog-openai-v1.json'), adjudicatorCatalogPath = join(here, 'catalog-adjudicator.json');
  const request = { ...JSON.parse(readFileSync(join(root, 'test/roster-dynamic/request-default.json'), 'utf8')), run_id: f.runId, ...(adjudicator ? { adjudicator } : {}) };
  const roster = selectRoster({ catalog: JSON.parse(readFileSync(catalogPath, 'utf8')), catalogPath, request,
    adjudicatorCatalog: JSON.parse(readFileSync(adjudicatorCatalogPath, 'utf8')), adjudicatorCatalogPath });
  const file = join(f.base, 'roster.candidate.json');
  writeFileSync(file, JSON.stringify(roster));
  await approveRoster({ runDir: f.runDir, file, userEvent: { schema: 'team-qa/roster-user-event/v1', actor: 'user', id: 'fixture-user', text: 'I approve this fixture roster', run_id: roster.run_id, round: roster.round, roster_hash: sha256File(file) } });
  return f;
}

test('adjudicate checklist, run and show use the approved seat; shadow changes no verdict', async () => {
  const f = await approvedRun();
  const frozen = run(f.base, ['adjudicate', 'checklist', '--run', f.runId, '--case', f.caseId]);
  assert.equal(frozen.status, 0, frozen.stderr || frozen.stdout);
  assert.match(frozen.stdout, /verdict=pass ADJUDICATOR_CHECKLIST_FROZEN case=TC-01 items=5 sha256=[a-f0-9]{64}/);
  const judged = run(f.base, ['adjudicate', 'run', '--run', f.runId, '--case', f.caseId, '--attestation', f.attestation, '--board', f.qaBoard, '--evidence', f.rel.dom]);
  assert.equal(judged.status, 0, judged.stderr || judged.stdout);
  assert.match(judged.stdout, /verdict=pass ADJUDICATION case=TC-01 attempt=1 outcome=CONTEST mode=shadow if_enabled=ungraded effect=none/);
  const result = JSON.parse(readFileSync(join(f.runDir, 'adjudication/TC-01/attempt-1/result.json'), 'utf8'));
  assert.equal(result.engine.model, 'claude-sonnet-5-5');
  assert.equal(result.engine.family, 'claude');
  assert.equal(result.fixture, true);
  assert.equal(readFileSync(join(f.runDir, 'board.jsonl'), 'utf8').includes('"verdict":"pass"'), true, 'the ledger keeps the executor verdict');
  const shown = run(f.base, ['adjudicate', 'show', '--run', f.runId]);
  assert.equal(shown.status, 0, shown.stderr);
  const summary = JSON.parse(shown.stdout);
  assert.equal(summary.mode, 'shadow');
  assert.deepEqual(summary.cases.map((c) => [c.case_id, c.executor_verdict, c.outcome, c.if_enabled_verdict, c.applied]), [['TC-01', 'pass', 'CONTEST', 'ungraded', false]]);
});

test('adjudicate board-change writes a packet for board apply only when the seat enforces', async () => {
  for (const mode of ['shadow', 'enforce']) {
    const f = await approvedRun({ adjudicator: { provider: 'anthropic', mode } });
    const judged = run(f.base, ['adjudicate', 'run', '--run', f.runId, '--case', f.caseId, '--attestation', f.attestation, '--board', f.qaBoard]);
    assert.equal(judged.status, 0, judged.stderr || judged.stdout);
    const out = join(f.base, 'adjudicator-change.json');
    const r = run(f.base, ['adjudicate', 'board-change', '--run', f.runId, '--board', f.qaBoard, '--out', out]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    if (mode === 'shadow') {
      assert.match(r.stdout, /verdict=pass ADJUDICATOR_SHADOW changes=0 board=unchanged/);
      assert.equal(existsSync(out), false);
    } else {
      assert.match(r.stdout, /verdict=pass ADJUDICATOR_BOARD_CHANGE changes=1/);
      const packet = JSON.parse(readFileSync(out, 'utf8'));
      assert.deepEqual(packet.edits, [{ entity: 'case', id: 'TC-01', field: 'status', from: 'PASS', to: 'BLOCKED' }]);
      assert.match(r.stdout, /next=.*board apply --file .* --change .*adjudicator-change\.json/);
    }
  }
});

test('adjudicate run skips a case that is not PASS under the default scope', async () => {
  const f = await approvedRun();
  failRecord(f);
  const r = run(f.base, ['adjudicate', 'run', '--run', f.runId, '--case', f.caseId, '--attestation', f.attestation, '--board', f.qaBoard]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verdict=pass ADJUDICATION_SKIPPED case=TC-01 attempt=1 reason=verdict_not_pass scope=pass_only/);
  assert.equal(existsSync(join(f.runDir, 'adjudication')), false);
  const shown = JSON.parse(run(f.base, ['adjudicate', 'show', '--run', f.runId]).stdout);
  assert.equal(shown.scope, 'pass_only');
  assert.deepEqual(shown.not_adjudicated, { verdict_not_pass: ['TC-01'], missing: [] });
});

test('without an adjudicator seat in the approved roster nothing runs', async () => {
  const f = await approvedRun({ adjudicator: null });
  const r = run(f.base, ['adjudicate', 'run', '--run', f.runId, '--case', f.caseId, '--attestation', f.attestation]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /ADJUDICATOR_SEAT_MISSING/);
  const unknown = run(f.base, ['adjudicate', 'judge', '--run', f.runId]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /COMMAND_UNKNOWN|ADJUDICATE_COMMAND/);
});
