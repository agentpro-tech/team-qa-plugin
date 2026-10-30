import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { renderNativeBoard } from '../scripts/teamwork/native-renderer.mjs';

const corpusUrl = new URL('./loop8/wave2/board-cases.json', import.meta.url);

test('V8.4 renders paired annotated and original finding evidence in the native board', async () => {
  const corpus = JSON.parse(await readFile(corpusUrl, 'utf8'));
  const board = structuredClone(corpus.templates.vi);
  let html;

  assert.doesNotThrow(
    () => {
      html = renderNativeBoard(board);
    },
    'V8.4 requires the frozen valid schema-v5 board to pass the canonical gate',
  );

  assert.match(
    html,
    /data-evidence-role=["']annotated["']/,
    'native defect evidence must render the annotated image with an explicit role',
  );
  assert.match(
    html,
    /<a[^>]+href=[^>]+data-evidence-role=["']annotated["'][^>]*>|<a[^>]+data-evidence-role=["']annotated["'][^>]+href=/,
    'the annotated evidence must link to its full-size image',
  );
  assert.match(
    html,
    /<a[^>]+data-evidence-role=["']original["'][^>]+(?:aria-label|title)=["'][^"']*original[^"']*["']|<a[^>]+(?:aria-label|title)=["'][^"']*original[^"']*["'][^>]+data-evidence-role=["']original["']/i,
    'native defect evidence must expose a separate accessible original-image link',
  );
  assert.match(html, /<h3>Fix evidence<\/h3>/, 'fixEvidence must retain its separate workflow section');
});
