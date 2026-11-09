import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// L3: macOS 12 and older have no `realpath` command. Both sides of the compat-link comparison were then empty, so the
// comparison passed: install-package.sh kept a link that pointed elsewhere and verify-install.sh accepted it.
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function envelope() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-no-realpath-')));
  const skill = join(root, 'payload', 'qa-gui');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  copyFileSync(join(repo, 'scripts', 'package-tool.mjs'), join(skill, 'scripts', 'package-tool.mjs'));
  writeFileSync(join(skill, 'SKILL.md'), '# qa-gui\n');
  writeFileSync(join(skill, 'package-files.json'), JSON.stringify({ schema: 'agentpro/skill-package-files/v1', skill: 'qa-gui', version: '0.0.1', include: ['SKILL.md', 'package-files.json', 'scripts'] }));
  const manifest = spawnSync(process.execPath, [join(skill, 'scripts', 'package-tool.mjs'), 'manifest', '--root', skill, '--out', join(skill, 'package-manifest.json')], { encoding: 'utf8' });
  assert.equal(manifest.status, 0, manifest.stderr);
  const release = join(root, 'release');
  mkdirSync(release);
  assert.equal(spawnSync('zip', ['-qr', join(release, 'payload.zip'), 'qa-gui'], { cwd: join(root, 'payload') }).status, 0);
  writeFileSync(join(release, 'SOURCE.json'), JSON.stringify({ schema: 'agentpro/skill-source/v1', skill: 'qa-gui', version: '0.0.1', repo: 'https://github.com/agentpro-tech/qa-gui.git',
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), manifest_sha256: sha(join(skill, 'package-manifest.json')), package_sha256: sha(join(release, 'payload.zip')) }));
  copyFileSync(join(repo, 'scripts', 'install-package.sh'), join(release, 'install.sh'));
  copyFileSync(join(repo, 'scripts', 'verify-install.sh'), join(release, 'verify-install.sh'));
  // A PATH on which `realpath` is missing, as on macOS 12 (a stand-in that fails like "command not found").
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'realpath'), '#!/bin/sh\nexit 127\n');
  chmodSync(join(bin, 'realpath'), 0o755);
  mkdirSync(join(root, 'home'));
  return { root, release, env: { ...process.env, HOME: join(root, 'home'), PATH: `${bin}:${process.env.PATH}` } };
}

test('without a realpath command the installer replaces a compat link that points elsewhere and verify refuses a wrong one', () => {
  const { root, release, env } = envelope();
  const dest = join(root, 'skills'), compat = join(root, 'compat'), elsewhere = join(root, 'old-checkout');
  mkdirSync(elsewhere); mkdirSync(join(compat, '.claude', 'skills'), { recursive: true });
  symlinkSync(elsewhere, join(compat, '.claude', 'skills', 'qa-gui'));
  const r = spawnSync('bash', [join(release, 'install.sh'), '--dest-root', dest, '--compat-root', compat], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  for (const scope of ['.claude', '.codex']) assert.equal(realpathSync(join(compat, scope, 'skills', 'qa-gui')), realpathSync(join(dest, 'qa-gui')), scope);
  const verify = () => spawnSync('bash', [join(release, 'verify-install.sh'), join(dest, 'qa-gui'), compat], { encoding: 'utf8', env });
  assert.equal(verify().status, 0, verify().stderr);
  rmSync(join(compat, '.codex', 'skills', 'qa-gui')); symlinkSync(elsewhere, join(compat, '.codex', 'skills', 'qa-gui'));
  const wrong = verify();
  assert.equal(wrong.status, 21, wrong.stdout + wrong.stderr);
  assert.match(wrong.stderr, /compat mismatch/);
});
