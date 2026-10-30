import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { renderNativeBoard } from '../scripts/teamwork/native-renderer.mjs';

const fixture = JSON.parse(await readFile(new URL('../scripts/teamwork/example-canonical.json', import.meta.url), 'utf8'));

test('closed teamwork rows remove detail controls from layout and hit testing', () => {
  const html = renderNativeBoard(fixture);
  assert.match(html, /\.item:not\(\[open\]\)>\.detail\{display:none\}/);
});

test('the pending bar stays hidden until a human stages a change', () => {
  const html = renderNativeBoard(fixture);
  assert.match(html, /\.pending-bar\[hidden\]\{display:none\}/);
  assert.match(html, /class="pending-bar" aria-live="polite" hidden/);
  assert.match(html, /@media\(max-width:560px\)\{\.pending-bar\{position:static;transform:none;width:calc\(100% - 20px\)/);
  assert.match(html, /bar\.hidden=count===0/);
});

test('the mobile renderer wraps metadata, contains titles, and exposes 44px controls', () => {
  const html = renderNativeBoard(fixture);
  assert.match(html, /\.meta span\{max-width:100%;white-space:normal;overflow-wrap:anywhere\}/);
  assert.match(html, /\.identity>div\{min-width:0\}/);
  assert.match(html, /\.evidence-tools input\[type=file\]\{min-height:36px/);
  assert.match(html, /select,input\[type=text\],input\[type=file\],\.composer button,\.packet,\.evidence-button\{min-height:44px\}/);
});
