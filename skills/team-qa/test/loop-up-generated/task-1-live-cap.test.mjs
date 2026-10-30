import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('RED-TQ-LIVE-CAP-001: roles check is ungraded when Dragon cannot be reached', () => {
  const result = spawnSync(process.execPath, ['scripts/teamqa.mjs', 'roles', 'check'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TEAMQA_DRAGON_STATUS_URL: 'http://127.0.0.1:9/status',
    },
  });

  assert.notEqual(result.status, 0, 'roles check must fail closed without live Dragon capability');
  assert.match(`${result.stdout}\n${result.stderr}`, /verdict=ungraded/);
});
