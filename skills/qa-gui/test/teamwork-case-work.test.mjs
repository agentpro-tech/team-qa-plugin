import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCanonical } from '../scripts/teamwork/canonical.mjs';
import { exportPage } from '../scripts/teamwork/page-exporter.mjs';
import { renderNativeBoard } from '../scripts/teamwork/native-renderer.mjs';

const example = JSON.parse(readFileSync(new URL('../scripts/teamwork/example-canonical.json', import.meta.url)));
const evidence = [{ path: 'evidence/work-note.json', sha256: 'a'.repeat(64) }];
const blocked = { kind: 'dependency', operation: 'read fixture state', code: 'FIXTURE_NOT_READY', owner: 'QA owner', unblockCondition: 'fixture account is available' };
const ready = { schema: 'qa-gui/case-work/v1', state: 'ready', nextAction: 'Read the saved cart state', remainingChecks: ['fresh load', 'same-session readback'], evidence };

function withWork(work) {
  const data = structuredClone(example);
  data.cases[0].work = work;
  return data;
}

test('case work is optional for existing boards and validates ready, running, and blocked plans', () => {
  assert.equal(validateCanonical(structuredClone(example)).ok, true);
  for (const work of [ready,
    { ...ready, state: 'running', workerSessionId: 'worker-17' },
    { ...ready, state: 'blocked', blocker: blocked, attemptRef: 'attempt-2' },
  ]) assert.equal(validateCanonical(withWork(work)).ok, true, JSON.stringify(work));
});

test('case work rejects incomplete, contradictory, duplicate, and unknown state fields', () => {
  const invalid = [
    { ...ready, remainingChecks: [] },
    { ...ready, remainingChecks: ['same', 'same'] },
    { ...ready, evidence: [] },
    { ...ready, state: 'running' },
    { ...ready, state: 'blocked' },
    { ...ready, state: 'ready', blocker: blocked },
    { ...ready, state: 'blocked', blocker: blocked, workerSessionId: 'worker-17' },
    { ...ready, state: 'finished' },
    { ...ready, unrecognized: true },
    { ...ready, blocker: { ...blocked, extra: true } },
  ];
  for (const work of invalid) assert.equal(validateCanonical(withWork(work)).ok, false, JSON.stringify(work));
});

test('work progress stays separate from verdicts and appears in native and Page readbacks', () => {
  const data = withWork({ ...ready, state: 'blocked', blocker: blocked });
  assert.equal(data.cases[0].functionVerdict, 'UNGRADED');
  assert.equal(data.cases[0].uiVerdict, 'UNGRADED');
  const html = renderNativeBoard(data);
  assert.match(html, /Read the saved cart state/);
  assert.match(html, /FIXTURE_NOT_READY/);
  const blocks = exportPage(data, 'b'.repeat(64)).initial_blocks.join('\n');
  assert.match(blocks, /Việc tiếp theo/);
  assert.match(blocks, /Read the saved cart state/);
  assert.match(blocks, /dependency/);
  assert.match(blocks, /work: .*remainingChecks/);
});
