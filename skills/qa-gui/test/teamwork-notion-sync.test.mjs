import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { reconcileChanges } from '../scripts/teamwork/canonical.mjs';
import { applyNotionPull, compareNotionRows, mapCanonicalRows, syncCanonicalToNotion } from '../scripts/teamwork/notion-sync.mjs';

const fixture = JSON.parse(await readFile(new URL('../.teamcode/qa-board-teamwork/fixtures/canonical.valid.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);

test('Notion rows keep 13 machine statuses and separate Function/UI verdicts', () => {
  const rows = mapCanonicalRows(clone(fixture), { language: 'vi' });
  const caseRow = rows.find((row) => row.externalId === 'TC-01');
  assert.deepEqual(caseRow.status, { machine: 'PASS', label: 'Đạt' });
  assert.equal(caseRow.functionVerdict, 'PASS');
  assert.equal(caseRow.uiVerdict, 'PASS');
  assert.match(caseRow.machineLine, /STATUS PASS/);
  const changed = clone(rows);
  changed[0].uiVerdict = 'FAIL';
  const comparison = compareNotionRows(clone(fixture), changed, { language: 'vi' });
  assert.ok(comparison.matchPercent < 100);
  assert.deepEqual(comparison.mismatches[0].externalId, 'TC-01');
  assert.deepEqual(comparison.mismatches[0].field, 'uiVerdict');
});

test('Notion projection and readback preserve optional case work without changing verdict fields', () => {
  const data = clone(fixture);
  data.cases[0].work = { schema: 'qa-gui/case-work/v1', state: 'ready', nextAction: 'Read saved state',
    remainingChecks: ['fresh load'], evidence: [{ path: 'evidence/work.json', sha256: 'a'.repeat(64) }] };
  const rows = mapCanonicalRows(data);
  const caseRow = rows.find((row) => row.externalId === data.cases[0].id);
  assert.deepEqual(caseRow.work, data.cases[0].work);
  assert.equal(caseRow.functionVerdict, data.cases[0].functionVerdict);
  assert.equal(compareNotionRows(data, clone(rows)).matchPercent, 100);
  const stale = clone(rows); stale.find((row) => row.externalId === data.cases[0].id).work.nextAction = 'different action';
  assert.ok(compareNotionRows(data, stale).mismatches.some((item) => item.field === 'work'));
});

test('Notion pull maps localized status and hardens status, priority, assignee, and comment', () => {
  const result = applyNotionPull(clone(fixture), [{
    externalId: 'DF-01',
    entity: 'defect',
    status: 'Bị chặn',
    priority: 'P2',
    assignee: 'human-dev',
    comment: 'Đã khoanh vùng log lỗi.',
    commentId: 'notion-comment-1',
    editedBy: 'human-dev',
    editedAt: '2026-08-11T14:00:00+07:00',
  }], { language: 'vi', qaActors: ['qa-agent'] });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  const defect = result.data.defects[0];
  assert.equal(defect.status, 'BLOCKED');
  assert.equal(defect.priority, 'P2');
  assert.equal(defect.assignee, 'human-dev');
  assert.deepEqual(defect.history.map(({ field }) => field), ['status', 'priority', 'assignee']);
  assert.equal(defect.comments[0].id, 'notion-comment-1');
});

test('sync gates invalid canonical before transport and skips exact rows on rerun', async () => {
  const invalid = clone(fixture);
  delete invalid.language;
  let calls = 0;
  const transport = {
    async listRows() { calls += 1; return []; },
    async upsertRow() { calls += 1; },
  };
  const blocked = await syncCanonicalToNotion(invalid, transport);
  assert.equal(blocked.ok, false);
  assert.equal(calls, 0);

  const rows = new Map();
  const stable = {
    async listRows() { return [...rows.values()]; },
    async upsertRow(row) { rows.set(row.externalId, clone(row)); },
  };
  const first = await syncCanonicalToNotion(clone(fixture), stable, { language: 'vi' });
  assert.equal(first.ok, true);
  assert.equal(first.synced, 4);
  const second = await syncCanonicalToNotion(clone(fixture), stable, { language: 'vi' });
  assert.equal(second.ok, true);
  assert.equal(second.synced, 0);
  assert.equal(second.skipped, 4);
});

test('QA wins a status conflict even when the Notion event is later', () => {
  const result = reconcileChanges(clone(fixture), [
    { entity: 'defect', id: 'DF-02', field: 'status', from: 'FIXING', to: 'REOPENED', who: 'qa-agent', when: '2026-08-11T14:10:00+07:00', source: 'native' },
    { entity: 'defect', id: 'DF-02', field: 'status', from: 'FIXING', to: 'BLOCKED', who: 'human-dev', when: '2026-08-11T14:11:00+07:00', source: 'notion' },
  ], { qaActors: ['qa-agent'] });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(result.data.defects[1].status, 'REOPENED');
  assert.equal(result.conflicts[0].winner, 'qa-agent');
  assert.deepEqual(result.data.defects[1].history.slice(-2).map(({ source }) => source), ['native', 'notion']);
});
