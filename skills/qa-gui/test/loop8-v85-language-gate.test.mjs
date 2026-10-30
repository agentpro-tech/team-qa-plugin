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

test('V8.5 gates vi/en/ko/ja prose while exempting machine values', async () => {
  const corpus = JSON.parse(await readFile(corpusUrl, 'utf8'));
  const cases = corpus.cases.filter((entry) => entry.gate === 'language');
  const results = cases.map((entry) => {
    const board = structuredClone(corpus.templates[entry.base]);
    for (const operation of entry.operations) applyOperation(board, operation);
    const validation = validateCanonical(board);
    return { ...entry, actual: validation.verdict, errors: validation.errors };
  });

  for (const result of results) {
    assert.equal(result.actual, result.expected, `${result.id} must be ${result.expected}`);
    if (result.expected === 'FAIL' && result.expectedPath) {
      assert.ok(
        result.errors.some((error) => error.path === result.expectedPath),
        `${result.id} must identify ${result.expectedPath}`,
      );
    }
  }

  const graded = results.filter((entry) => entry.expected !== 'UNGRADED');
  const positives = graded.filter((entry) => entry.expected === 'PASS');
  const negatives = graded.filter((entry) => entry.expected === 'FAIL');
  const recall = positives.filter((entry) => entry.actual === 'PASS').length / positives.length;
  const falsePositiveRate = negatives.filter((entry) => entry.actual === 'PASS').length / negatives.length;

  assert.ok(recall >= 0.9, `language recall ${recall} must be at least 0.90`);
  assert.ok(falsePositiveRate <= 0.05, `language false-positive rate ${falsePositiveRate} must be at most 0.05`);
});
