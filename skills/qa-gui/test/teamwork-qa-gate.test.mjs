import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const gate = new URL('../scripts/qa-gate.mjs', import.meta.url);
const canonical = new URL('../scripts/teamwork/example-canonical.json', import.meta.url);

test('qa-gate accepts a standalone teamwork canonical JSON file', () => {
  const result = spawnSync(process.execPath, [gate.pathname, canonical.pathname], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /QA gate: PASS/);
  assert.match(result.stdout, /Canonical: qa-board-teamwork\/v2/);
  assert.match(result.stdout, /Source traceability: 1 source · 1 case link/);
});
