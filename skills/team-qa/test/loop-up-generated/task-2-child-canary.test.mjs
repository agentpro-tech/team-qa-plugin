import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('RED-TQ-CHILD-CANARY-001: smoke runs the declared qa-gui child gate canary', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'teamqa-child-canary-'));
  const roles = JSON.parse(readFileSync(join(ROOT, 'roles.json'), 'utf8'));
  roles.skills['qa-gui'].commands.gate = [process.execPath, '-e', 'process.exit(1)'];
  const rolesPath = join(tempDir, 'roles.json');
  writeFileSync(rolesPath, `${JSON.stringify(roles, null, 2)}\n`);

  const result = spawnSync(process.execPath, ['scripts/teamqa.mjs', 'smoke'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TEAMQA_ROLES: rolesPath },
  });

  assert.notEqual(result.status, 0, 'smoke must fail closed when the qa-gui child canary fails');
  assert.match(`${result.stdout}\n${result.stderr}`, /qa-gui.*ungraded|canary/i);
});
