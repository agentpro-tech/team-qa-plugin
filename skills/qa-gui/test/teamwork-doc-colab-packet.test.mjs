import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { applyNativePacket } from '../scripts/teamwork/native-renderer.mjs';

const fixture = JSON.parse(await readFile(new URL('../scripts/teamwork/example-canonical.json', import.meta.url), 'utf8'));

test('Doc-Colab v2 qaDelta hardens status/priority changes and comments into canonical', () => {
  const packet = {
    protocol: 'doc-colab/v2',
    rev: fixture.rev,
    stagedRev: fixture.rev,
    qaDelta: {
      baseRev: fixture.rev,
      updates: [{
        kind: 'field-change', entity: 'defect', id: 'DF-01', field: 'priority',
        from: 'P2', to: 'P1', actor: 'Owner', actorRole: 'qa', at: '2026-08-11T08:10:00Z', source: 'native',
      }],
      comments: [{
        entity: 'defect', id: 'DF-01', author: 'Owner', text: 'Đã xem bằng chứng fix.',
        ts: '2026-08-11T08:10:00Z', source: 'native',
      }],
    },
  };

  const result = applyNativePacket(fixture, packet, {
    actor: 'Owner', now: '2026-08-11T08:10:00Z', qaActors: ['Owner'],
  });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(result.data.defects[0].priority, 'P1');
  assert.equal(result.data.defects[0].history.at(-1).source, 'native');
  assert.equal(result.data.defects[0].comments.at(-1).text, 'Đã xem bằng chứng fix.');
  assert.deepEqual(result.applied, { edits: 1, comments: 1, evidence: 0 });
});
