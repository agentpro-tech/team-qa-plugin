import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUNDLED_SCROLL_ROOT, scrollRoot } from '../../scripts/lib/core.mjs';

// Public v1: SCROLL ships inside Team QA, so a machine without a SCROLL checkout can still write and confirm files.
const CLI = new URL('../../scripts/teamqa.mjs', import.meta.url).pathname;
const bare = () => { const home = mkdtempSync(join(tmpdir(), 'teamqa-no-scroll-')); const env = { ...process.env, HOME: home }; delete env.TEAMQA_SCROLL_ROOT; return env; };

test('the vendored SCROLL is the default; TEAMQA_SCROLL_ROOT still wins', () => {
  assert.ok(existsSync(join(BUNDLED_SCROLL_ROOT, 'lib', 'effects.js')) && existsSync(join(BUNDLED_SCROLL_ROOT, 'bin', 'scroll.js')));
  assert.match(readFileSync(join(BUNDLED_SCROLL_ROOT, 'VENDORED.md'), 'utf8'), /a134d56e66d9e797bff49d6141eca6002bb6518d/);
  assert.equal(scrollRoot({}), BUNDLED_SCROLL_ROOT);
  assert.equal(scrollRoot({ TEAMQA_SCROLL_ROOT: '/opt/scroll' }), '/opt/scroll');
});

test('a write is confirmed through the vendored SCROLL on a machine without a SCROLL checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-scroll-write-')), file = join(dir, 'note.txt');
  const script = `const { writeConfirmed } = await import(${JSON.stringify(pathToFileURL(join(BUNDLED_SCROLL_ROOT, '..', '..', 'scripts', 'lib', 'core.mjs')).href)});
    const r = await writeConfirmed(${JSON.stringify(file)}, 'hello\\n'); console.log(r.effect);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: bare() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'confirmed');
  assert.equal(readFileSync(file, 'utf8'), 'hello\n');
});

test('teamqa scroll runs the vendored SCROLL CLI and passes its exit code through', () => {
  const help = spawnSync(process.execPath, [CLI, 'scroll', '--help'], { encoding: 'utf8', env: bare() });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /scroll/);
  const missing = spawnSync(process.execPath, [CLI, 'scroll', 'check', join(tmpdir(), 'no-such-agent-folder')], { encoding: 'utf8', env: bare() });
  assert.notEqual(missing.status, 0);
  const elsewhere = spawnSync(process.execPath, [CLI, 'scroll', '--help'], { encoding: 'utf8', env: { ...bare(), TEAMQA_SCROLL_ROOT: '/nonexistent/scroll' } });
  assert.notEqual(elsewhere.status, 0);
  assert.match(elsewhere.stdout + elsewhere.stderr, /SCROLL_UNAVAILABLE/);
});
