import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const board = await readFile(resolve(import.meta.dirname, '..', 'assets', 'qa-board.html'), 'utf8');

test('QA Board renders non-media evidence as links and keeps metadata controls accessible', () => {
  assert.match(board, /else if\(\/\\\.\(png\|jpe\?g\|gif\|webp\|avif\|svg\)\$\/i\.test\(src\)\)/);
  assert.match(board, /class="artifact" href=/);
  assert.match(board, /\.artifact\{width:52px;height:36px/);
  assert.match(board, /\.cbtn\{[^}]*min-height:24px/);
  assert.doesNotMatch(board, /--tx3:#9b9a97|\.v-fail\{color:#c4554d\}|\.v-warn\{color:#b8860b\}/);
});
