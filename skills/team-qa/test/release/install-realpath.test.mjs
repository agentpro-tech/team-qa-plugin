import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// L3: macOS 12 and older have no `realpath` command. Both sides of the compat-link comparison were then empty, so the
// comparison passed: install-package.sh kept a link that pointed elsewhere and verify-install.sh accepted it.
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function envelope() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-no-realpath-')));
  const skill = join(root, 'payload', 'team-qa');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  for (const file of ['package-tool.mjs', 'verify-install.sh']) copyFileSync(join(repo, 'scripts', file), join(skill, 'scripts', file));
  writeFileSync(join(skill, 'SKILL.md'), '# team-qa\n');
  writeFileSync(join(skill, 'package-files.json'), JSON.stringify({ schema: 'agentpro/skill-package-files/v1', skill: 'team-qa', version: '0.0.1', include: ['SKILL.md', 'package-files.json', 'scripts'] }));
  const manifest = spawnSync(process.execPath, [join(skill, 'scripts', 'package-tool.mjs'), 'manifest', '--root', skill, '--out', join(skill, 'package-manifest.json')], { encoding: 'utf8' });
  assert.equal(manifest.status, 0, manifest.stderr);
  const release = join(root, 'release');
  mkdirSync(release);
  assert.equal(spawnSync('zip', ['-qr', join(release, 'payload.zip'), 'team-qa'], { cwd: join(root, 'payload') }).status, 0);
  writeFileSync(join(release, 'SOURCE.json'), JSON.stringify({ schema: 'agentpro/skill-source/v1', skill: 'team-qa', version: '0.0.1', repo: 'https://github.com/agentpro-tech/team-qa.git',
    commit: 'a'.repeat(40), tree: 'b'.repeat(40), manifest_sha256: sha(join(skill, 'package-manifest.json')), package_sha256: sha(join(release, 'payload.zip')) }));
  // The release-truth gate is not under test here: a stand-in that accepts the envelope.
  writeFileSync(join(release, 'release-truth.json'), JSON.stringify({ scope: 'release' }));
  writeFileSync(join(release, 'release-truth-gate.mjs'), 'process.exit(0);\n');
  writeFileSync(join(release, 'release-policy.mjs'), 'export {};\n');
  copyFileSync(join(repo, 'scripts', 'install-package.sh'), join(release, 'install.sh'));
  // A PATH on which `realpath` is missing, as on macOS 12 (a stand-in that fails like "command not found").
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'realpath'), '#!/bin/sh\nexit 127\n');
  chmodSync(join(bin, 'realpath'), 0o755);
  return { root, release, env: { ...process.env, HOME: join(root, 'home'), PATH: `${bin}${delimiter}${process.env.PATH}` } };
}

test('without a realpath command the installer still replaces a compat link that points elsewhere', () => {
  const { root, release, env } = envelope();
  const dest = join(root, 'skills'), compat = join(root, 'compat'), elsewhere = join(root, 'old-checkout');
  mkdirSync(join(root, 'home')); mkdirSync(elsewhere); mkdirSync(join(compat, '.claude', 'skills'), { recursive: true });
  symlinkSync(elsewhere, join(compat, '.claude', 'skills', 'team-qa'));
  const r = spawnSync('bash', [join(release, 'install.sh'), '--dest-root', dest, '--compat-root', compat], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  for (const scope of ['.claude', '.codex']) assert.equal(realpathSync(join(compat, scope, 'skills', 'team-qa')), realpathSync(join(dest, 'team-qa')), scope);
});

test('without a realpath command verify-install.sh still refuses a compat link that points elsewhere', () => {
  const { root, release, env } = envelope();
  const dest = join(root, 'skills'), compat = join(root, 'compat');
  mkdirSync(join(root, 'home'));
  assert.equal(spawnSync('bash', [join(release, 'install.sh'), '--dest-root', dest, '--compat-root', compat], { encoding: 'utf8', env }).status, 0);
  const verify = () => spawnSync('bash', [join(dest, 'team-qa', 'scripts', 'verify-install.sh'), join(dest, 'team-qa'), compat], { encoding: 'utf8', env });
  assert.equal(verify().status, 0, verify().stderr);
  const link = join(compat, '.codex', 'skills', 'team-qa'), elsewhere = join(root, 'old-checkout');
  mkdirSync(elsewhere);
  spawnSync('rm', [link]); symlinkSync(elsewhere, link);
  const wrong = verify();
  assert.equal(wrong.status, 21, wrong.stdout + wrong.stderr);
  assert.match(wrong.stderr, /compat mismatch/);
});
