import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfirmed } from '../scripts/lib/core.mjs';
import { splitWrites } from './support/split-writes.mjs';

const readState = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { return error.code === 'ENOENT' ? 'missing' : 'torn'; } };

test('a reader never sees a half-written file: the content goes to a temporary file that is renamed over the target', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-atomic-'))), target = join(dir, 'state.json');
  writeFileSync(target, JSON.stringify({ status: 'running' }));
  const seen = [];
  const restore = splitWrites(dir, () => seen.push(readState(target)));
  try { await writeConfirmed(target, JSON.stringify({ status: 'done', detail: 'x'.repeat(4000) }), 'test.atomic'); }
  finally { restore(); }
  assert.ok(seen.length > 0, 'the write was observed');
  assert.ok(seen.every(state => state !== 'torn'), `a reader saw a torn file: ${JSON.stringify(seen.map(s => s?.status ?? s))}`);
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).status, 'done');
  assert.deepEqual(readdirSync(dir), ['state.json'], 'no temporary file is left');
});

test('an exclusive write is atomic too and still fails when the target exists', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-atomic-x-'))), target = join(dir, 'event.json');
  const seen = [];
  const restore = splitWrites(dir, () => seen.push(readState(target)));
  try { await writeConfirmed(target, JSON.stringify({ n: 1, pad: 'y'.repeat(2000) }), 'test.atomic', { exclusive: true }); }
  finally { restore(); }
  assert.ok(seen.length > 0 && seen.every(state => state === 'missing'), `the target appeared before it was complete: ${JSON.stringify(seen)}`);
  await assert.rejects(writeConfirmed(target, JSON.stringify({ n: 2 }), 'test.atomic', { exclusive: true }), error => error.code === 'EEXIST');
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).n, 1, 'the existing file is kept');
  assert.deepEqual(readdirSync(dir), ['event.json'], 'no temporary file is left');
});
