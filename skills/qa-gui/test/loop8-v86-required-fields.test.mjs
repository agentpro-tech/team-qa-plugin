import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateCanonical } from '../scripts/teamwork/canonical.mjs';

const corpusUrl = new URL('./loop8/wave2/board-cases.json', import.meta.url);

function applyOperation(board, operation) {
  const segments = operation.path.split('.');
  const key = segments.pop();
  const parent = segments.reduce((value, segment) => value[segment], board);
  if (operation.op === 'delete') delete parent[key];
  else if (operation.op === 'set') parent[key] = structuredClone(operation.value);
  else assert.fail(`unsupported corpus operation ${operation.op}`);
}

test('V8.6 requires complete non-TODO cases and four-part schema-v5 defects deterministically', async () => {
  const corpus = JSON.parse(await readFile(corpusUrl, 'utf8'));
  const cases = corpus.cases.filter((entry) => entry.gate === 'structure');

  for (const entry of cases) {
    const board = structuredClone(corpus.templates[entry.base]);
    for (const operation of entry.operations) applyOperation(board, operation);

    const first = validateCanonical(board);
    const second = validateCanonical(structuredClone(board));

    assert.equal(first.verdict, entry.expected, `${entry.id} must be ${entry.expected}`);
    assert.deepEqual(first.errors, second.errors, `${entry.id} must return identical errors on two runs`);
    assert.equal(first.verdict, second.verdict, `${entry.id} must return an identical verdict on two runs`);

    if (entry.expected === 'FAIL') {
      assert.ok(
        first.errors.some(
          (error) => error.path === entry.expectedPath && error.message.includes(entry.expectedText),
        ),
        `${entry.id} must identify ${entry.expectedPath} and name ${entry.expectedText}`,
      );
    }
  }
});
