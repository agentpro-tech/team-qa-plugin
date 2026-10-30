import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCorpus } from './loop6/checker/evaluate.mjs';

test('Loop 6 frozen corpus is hash-valid and deterministic by product input', async () => {
  const { manifest, corpora } = await validateCorpus();

  assert.equal(manifest.status, 'FROZEN');
  assert.equal(manifest.refreezeRevision, 3);
  assert.equal(corpora.size, 8);
});
