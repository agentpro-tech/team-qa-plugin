// Upgrade R3: with every speed flag off, Team QA's outputs are what they were before R3. The fixture run
// (test/speed/fixtures/flags-off/run-fixture.mjs) drives plan validation, web collect, the GUI case dispatch start and the
// R0 time receipt with the same synthetic inputs each time; golden.json is its output on the pre-R3 code (upgrade/full).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = join(ROOT, 'test/speed/fixtures/flags-off');

test('every flag off: the fixture run gives byte-for-byte the output of the pre-R3 code', () => {
  const r = spawnSync(process.execPath, [join(FIXTURE, 'run-fixture.mjs'), ROOT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, readFileSync(join(FIXTURE, 'golden.json'), 'utf8'));
});
