import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { applyChanges } from '../scripts/teamwork/canonical.mjs';

const fixture = JSON.parse(await readFile(new URL('../.teamcode/qa-board-teamwork/fixtures/canonical.valid.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);
const context = (actor, now) => ({ actor, now, source: 'agent', qaActors: ['qa-agent', 'qa-lead'] });

function withEvidence(id = 'DF-01') {
  const data = clone(fixture);
  data.defects.find((defect) => defect.id === id).fixEvidence.push({
    id: `${id}-proof`,
    type: 'commit',
    path: 'abc1234',
    addedBy: 'dev-agent',
    addedAt: '2026-08-11T12:00:00+07:00',
  });
  return data;
}

test('defect lifecycle requires independent QA close and reopens a failed retest', () => {
  const retest = applyChanges(withEvidence(), [
    { entity: 'defect', id: 'DF-01', field: 'status', to: 'RETEST' },
  ], context('dev-agent-a', '2026-08-11T12:01:00+07:00'));
  assert.equal(retest.ok, true);

  const verified = applyChanges(retest.data, [
    { entity: 'defect', id: 'DF-01', field: 'status', to: 'VERIFIED' },
  ], context('qa-agent', '2026-08-11T12:02:00+07:00'));
  assert.equal(verified.ok, true);

  const selfClose = applyChanges(verified.data, [
    { entity: 'defect', id: 'DF-01', field: 'status', to: 'CLOSED' },
  ], context('qa-agent', '2026-08-11T12:03:00+07:00'));
  assert.equal(selfClose.ok, false);

  const closed = applyChanges(verified.data, [
    { entity: 'defect', id: 'DF-01', field: 'status', to: 'CLOSED' },
  ], context('qa-lead', '2026-08-11T12:04:00+07:00'));
  assert.equal(closed.ok, true);
  assert.equal(closed.data.defects[0].status, 'CLOSED');

  const reopened = applyChanges(retest.data, [
    { entity: 'defect', id: 'DF-01', field: 'status', to: 'REOPENED' },
  ], context('qa-agent', '2026-08-11T12:05:00+07:00'));
  assert.equal(reopened.ok, true);
  assert.equal(reopened.data.defects[0].status, 'REOPENED');
});

test('typed rejection passes and priority keeps both last-write-wins history events', () => {
  const rejected = applyChanges(clone(fixture), [
    { entity: 'defect', id: 'DF-02', field: 'status', to: 'REJECTED', rejectionReason: 'as-designed' },
  ], context('Owner', '2026-08-11T12:10:00+07:00'));
  assert.equal(rejected.ok, true);
  assert.equal(rejected.data.defects[1].rejectionReason, 'as-designed');

  const priority = applyChanges(clone(fixture), [
    { entity: 'defect', id: 'DF-03', field: 'priority', to: 'P1' },
    { entity: 'defect', id: 'DF-03', field: 'priority', to: 'P4' },
  ], context('Owner', '2026-08-11T12:11:00+07:00'));
  assert.equal(priority.ok, true);
  const defect = priority.data.defects[2];
  assert.equal(defect.priority, 'P4');
  assert.deepEqual(defect.history.map(({ from, to }) => ({ from, to })), [
    { from: 'P3', to: 'P1' },
    { from: 'P1', to: 'P4' },
  ]);
});
