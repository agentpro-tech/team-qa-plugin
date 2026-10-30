import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const corpusUrl = new URL('./loop8/corpus/caption-cases.json', import.meta.url);

test('V8.3 validates grounded captions against the frozen corpus', async () => {
  const loop8 = await import('../scripts/loop8/index.mjs');

  assert.equal(
    typeof loop8.validateFindingCaption,
    'function',
    'V8.3 requires validateFindingCaption to be exported',
  );

  const cases = JSON.parse(await readFile(corpusUrl, 'utf8'));
  const results = cases.map((entry) => ({
    ...entry,
    actual: loop8.validateFindingCaption({
      finding: entry.finding,
      caption: entry.caption,
      language: entry.language,
    }),
  }));

  for (const result of results) {
    assert.match(result.actual, /^(PASS|FAIL|UNGRADED)$/, `${result.id} returned an invalid verdict`);
  }

  const positives = results.filter((entry) => entry.expected === 'PASS');
  const negatives = results.filter((entry) => entry.expected === 'FAIL');
  const recall = positives.filter((entry) => entry.actual === 'PASS').length / positives.length;
  const falsePositiveRate = negatives.filter((entry) => entry.actual === 'PASS').length / negatives.length;

  assert.ok(recall >= 0.9, `caption recall ${recall} must be at least 0.90`);
  assert.ok(falsePositiveRate <= 0.05, `caption false-positive rate ${falsePositiveRate} must be at most 0.05`);
});
