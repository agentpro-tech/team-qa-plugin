import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as loop6 from '../scripts/loop6/index.mjs';

const corpus = JSON.parse(
  await readFile(new URL('./loop6/corpus/v6.3-memory.json', import.meta.url), 'utf8'),
);

const cases = [...corpus.hard, ...corpus.ordinary];

test('V6.3 recalls all 26 revision-3 exact-app memory tuples and returns fresh clones', () => {
  assert.equal(cases.length, 26, 'the frozen revision-3 corpus must contain 26 tuples');
  assert.equal(
    typeof loop6.recallMemory,
    'function',
    'scripts/loop6/index.mjs must export recallMemory',
  );

  for (const fixture of cases) {
    const first = loop6.recallMemory(
      fixture.appIdentity,
      fixture.appMapHash,
      fixture.records,
      fixture.nextRound,
    );
    assert.deepEqual(first, fixture.expected, `${fixture.id}: exact ordered memory result`);

    const snapshot = structuredClone(first);
    first.usedRecordIds.push('__mutation_probe__');
    first.priorityPathOrder.push('/__mutation_probe__');
    first.testPlanSources.push({
      recordId: '__mutation_probe__',
      layer: 'episodic',
      path: '/__mutation_probe__',
    });

    const second = loop6.recallMemory(
      fixture.appIdentity,
      fixture.appMapHash,
      fixture.records,
      fixture.nextRound,
    );
    assert.deepEqual(second, snapshot, `${fixture.id}: repeated result must be unmodified`);
    assert.notStrictEqual(second, first, `${fixture.id}: result object must be cloned`);
  }
});
