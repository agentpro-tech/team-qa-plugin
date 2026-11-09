// Upgrade R3: with every speed flag off, QA GUI grades exactly as before R3. The fixture run (test/fixtures/r3-flags-off/
// run-fixture.mjs) builds the same synthetic boards each time; golden.json is its output on the pre-R3 code (upgrade/full).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = join(ROOT, 'test/fixtures/r3-flags-off');

test('every flag off: the fixture run gives byte-for-byte the output of the pre-R3 code', () => {
  const r = spawnSync(process.execPath, [join(FIXTURE, 'run-fixture.mjs'), ROOT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, readFileSync(join(FIXTURE, 'golden.json'), 'utf8'));
});
