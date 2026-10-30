import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLockedRunDocuments } from '../scripts/lib/run-contract.mjs';
import { sha256File } from '../scripts/lib/core.mjs';

test('publication drift cannot stop independent execution or relax the final readback gate', () => {
  const run = mkdtempSync(join(tmpdir(), 'teamqa-publication-debt-'));
  const roster = { run_id: 'publication-fixture', round: 1, roster_hash: 'a'.repeat(64) };
  const plan = join(run, 'plan.md'), render = join(run, 'board.html');
  writeFileSync(plan, 'locked scope'); writeFileSync(render, 'verified export');
  for (const name of ['board_payload', 'board_quality', 'board_write']) writeFileSync(join(run, name), 'locked delivery');
  const lock = { schema: 'team-qa/docs-lock/v1', ...roster, artifacts: {
    plan: { path: 'plan.md', sha256: sha256File(plan) },
    board_render: { path: 'board.html', sha256: sha256File(render) },
    ...Object.fromEntries(['board_payload', 'board_quality', 'board_write'].map(name => [name, { path: name, sha256: sha256File(join(run, name)) }])),
  } };
  writeFileSync(join(run, 'docs-lock.json'), JSON.stringify(lock));
  assert.deepEqual(readLockedRunDocuments(run, roster), lock);
  for (const name of ['board_payload', 'board_quality', 'board_write']) {
    writeFileSync(join(run, name), 'stale delivery');
    assert.deepEqual(readLockedRunDocuments(run, roster, { requirePublication: false }), lock);
    assert.throws(() => readLockedRunDocuments(run, roster), e => e.code === 'RUN_DOCUMENT_STALE');
    writeFileSync(join(run, name), 'locked delivery');
  }
  writeFileSync(render, 'partial export from failed publication');
  assert.deepEqual(readLockedRunDocuments(run, roster, { requirePublication: false }), lock);
  assert.throws(() => readLockedRunDocuments(run, roster), e => e.code === 'RUN_DOCUMENT_STALE');
  writeFileSync(plan, 'changed scope');
  assert.throws(() => readLockedRunDocuments(run, roster, { requirePublication: false }), e => e.code === 'RUN_DOCUMENT_STALE');
});
