import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'scripts/teamwork/cli.mjs');
const gate = join(root, 'scripts/qa-gate.mjs');
const example = join(root, 'scripts/teamwork/example-canonical.json');

function run(file, args) {
  return spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: 'utf8' });
}

test('Loop 8 entrypoints create and gate the current schema-v6 boards by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-loop8-schema-v6-entrypoint-'));
  const output = join(dir, 'canonical.json');
  const initialized = run(cli, [
    'init', '--out', output,
    '--board-id', 'loop8-entrypoint',
    '--title', 'Vòng kiểm thử đăng nhập',
    '--language', 'vi',
    '--at', '2026-08-15T00:00:00.000Z',
  ]);

  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const canonical = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(canonical.schemaVersion, 6);
  assert.equal(canonical.canonicalVersion, 'qa-board-teamwork/v2');
  assert.equal(canonical.boardKind, 'team-qa-board');
  assert.deepEqual(canonical.sourceItems, []);
  assert.equal(canonical.rounds[0].scope, 'Phạm vi QA ban đầu');
  assert.deepEqual(canonical.release.risks, ['QA chưa được chạy.']);
  assert.equal(run(cli, ['validate', '--file', output]).status, 0);

  const fixture = JSON.parse(readFileSync(example, 'utf8'));
  assert.equal(fixture.schemaVersion, 6);
  const gated = run(gate, [example]);
  // The example's only case is TODO, so the gate reads the v6 board in full and grades it UNGRADED, never PASS.
  assert.equal(gated.status, 20, gated.stderr || gated.stdout);
  assert.match(gated.stdout, /QA gate: UNGRADED/);
  assert.match(gated.stdout, /Canonical: qa-board-teamwork\/v2/);
  assert.match(gated.stdout, /Source traceability: 1 source · 1 case link/);
});
