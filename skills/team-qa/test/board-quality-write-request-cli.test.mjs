import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));

test('board-quality write-request CLI routes to the sealed request builder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-write-cli-'));
  const destination = join(dir, 'destination.json'); writeFileSync(destination, '{}');
  const result = spawnSync(process.execPath, [join(root, 'scripts/board-quality.mjs'), 'write-request',
    '--file', join(dir, 'missing-canonical.json'), '--payload', join(dir, 'missing-payload.json'),
    '--destination', destination, '--out', join(dir, 'missing-request.json')], { encoding: 'utf8' });
  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.match(result.stderr, /BOARD_WRITE_INPUT_MISSING/);
  assert.doesNotMatch(result.stderr, /BOARD_QUALITY_COMMAND/);
});
