#!/usr/bin/env node
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), 'teamqa-adapter-'));
try {
  copyFileSync(join(repoRoot, 'fixtures', 'data', 'test-plan.md'), join(cwd, 'test-plan.md'));
  const result = spawnSync(process.execPath, [
    join(repoRoot, 'scripts', 'teamqa.mjs'),
    'gate', 'publish', '--run', 'fixture-run', '--plan', 'test-plan.md',
  ], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, TEAMQA_ROLES: join(repoRoot, 'roles.json') },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /verdict=pass/);
  assert.match(output, /mirror=doc-colab/);
  assert.match(output, /effect=confirmed/);
  console.log(`DEFAULT_DOC_COLAB_ADAPTER=PASS node=${process.version}`);
} finally {
  if (cwd.startsWith(join(tmpdir(), 'teamqa-adapter-'))) rmSync(cwd, { recursive: true, force: true });
}
