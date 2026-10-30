import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { renderNativeBoard } from '../scripts/teamwork/native-renderer.mjs';

const corpusUrl = new URL('./loop8/wave2/board-cases.json', import.meta.url);

test('V8.4 marks the rendered annotated image itself with the annotated evidence role', async () => {
  const corpus = JSON.parse(await readFile(corpusUrl, 'utf8'));
  const html = renderNativeBoard(structuredClone(corpus.templates.vi));

  assert.match(
    html,
    /<img[^>]*data-evidence-role=["']annotated["'][^>]*>/,
    'the annotated role must be present on the rendered image, not only on its full-size link',
  );
});
