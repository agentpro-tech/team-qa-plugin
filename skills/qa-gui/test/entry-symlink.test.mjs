import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const example = join(root, 'scripts/teamwork/example-canonical.json');

// The entry scripts most often run through ~/.claude/skills/qa-gui -> ~/.agents/skills/qa-gui (or macOS /tmp ->
// /private/tmp). Node resolves the main module to its real path, so a plain string comparison of process.argv[1] with
// import.meta.url used to exit 0 silently there.
const ENTRY_SCRIPTS = [
  'scripts/teamwork/native-renderer.mjs',
  'scripts/teamwork/evidence-packager.mjs',
  'scripts/teamwork/doc-colab-renderer.mjs',
  'scripts/teamwork/doc-colab-hardener.mjs',
  'scripts/dragon-keyboard-focus-preflight.mjs',
  'scripts/dragon-interaction-readiness-preflight.mjs',
  'scripts/dragon-actionability-preflight.mjs',
  'scripts/dragon-hard-surface-preflight.mjs',
  'scripts/dragon-responsive-matrix-preflight.mjs',
];

test('entry scripts run through a symlinked skill folder: teamwork/cli.mjs validates and rejects for real', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'qa-gui-entry-symlink-'));
  const linked = join(scratch, 'skills', 'qa-gui');
  mkdirSync(join(scratch, 'skills'));
  symlinkSync(root, linked, 'dir');
  const run = (script, args) => spawnSync(process.execPath, [join(linked, script), ...args], { cwd: scratch, encoding: 'utf8' });

  const valid = run('scripts/teamwork/cli.mjs', ['validate', '--file', example]);
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  assert.equal(JSON.parse(valid.stdout).ok, true);

  const broken = join(scratch, 'broken.json');
  writeFileSync(broken, '{"schemaVersion":6}\n');
  const invalid = run('scripts/teamwork/cli.mjs', ['validate', '--file', broken]);
  assert.equal(invalid.status, 1, invalid.stdout);
  assert.notEqual(invalid.stderr.trim(), '');

  for (const script of ENTRY_SCRIPTS) {
    const result = run(script, ['--not-a-real-flag']);
    assert.notEqual(result.status, 0, `${script} exited 0 through the symlink`);
    assert.notEqual(`${result.stdout}${result.stderr}`.trim(), '', `${script} printed nothing through the symlink`);
  }
});
