import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { releaseEntry, signReleaseEntry, verifyInstalledRelease, verifyReleaseSignature } from '../../scripts/lib/release-signature.mjs';
import { activeRuns, applyUpdate, buildSuite, checkUpdate, installSuite, publishSuite, verifySuite } from '../../scripts/lib/suite.mjs';
import { issueLicense, verifyLicense } from '../../scripts/lib/license.mjs';
import { updateNotice } from '../../scripts/lib/suite.mjs';

const sha = buf => createHash('sha256').update(buf).digest('hex');
const tmp = name => mkdtempSync(join(tmpdir(), `teamqa-suite-${name}-`));
function ownerKey() {
  const dir = tmp('key'), { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privatePath = join(dir, 'owner.pem');
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  return { privatePath, publicKey: { schema: 'team-qa/owner-grant-key/v1', alg: 'ed25519', key_id: sha(publicKey.export({ type: 'spki', format: 'der' })), public_key_pem: pem } };
}
const OWNER = ownerKey(), OTHER = ownerKey();
const REQ = { skills: { 'qa-gui': { min: '2.15.0' }, 'qa-code': { min: '1.9.0' } } };

// A release envelope the way build-package.sh shapes it, with an install.sh that copies the skill into --dest-root.
function envelope(dir, skill, version, body = '# skill\n', extra = {}) {
  const folder = `${skill}-${version}-release`, root = join(dir, 'build-' + skill + version, folder);
  mkdirSync(root, { recursive: true });
  const manifest = JSON.stringify({ schema: 'agentpro/skill-package-manifest/v1', skill, version, files: [] }) + '\n';
  writeFileSync(join(root, 'package-manifest.json'), manifest);
  const source = { schema: 'agentpro/skill-source/v1', skill, version, repo: `https://github.com/agentpro-tech/${skill}.git`,
    commit: sha(skill + version).slice(0, 40), tree: sha('tree' + skill + version).slice(0, 40), manifest_sha256: sha(manifest), package_sha256: sha('payload' + skill), built_at: '2026-10-29T00:00:00Z' };
  writeFileSync(join(root, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n');
  writeFileSync(join(root, 'install.sh'), [
    '#!/usr/bin/env bash', 'set -euo pipefail', 'HERE="$(cd "$(dirname "$0")" && pwd)"; DEST=""',
    'while [ "$#" -gt 0 ]; do case "$1" in --dest-root) DEST="$2"; shift 2;; --compat-root) shift 2;; *) shift;; esac; done',
    `mkdir -p "$DEST/${skill}"; cp "$HERE/SOURCE.json" "$HERE/package-manifest.json" "$DEST/${skill}/"`, ''].join('\n'));
  const payload = join(dir, 'payload-' + skill + version);
  mkdirSync(join(payload, skill), { recursive: true });
  writeFileSync(join(payload, skill, 'package-files.json'), JSON.stringify({ schema: 'agentpro/skill-package-files/v1', skill, version, include: ['package-files.json', 'SKILL.md', 'package-manifest.json', ...Object.keys(extra)] }));
  writeFileSync(join(payload, skill, 'SKILL.md'), body);
  writeFileSync(join(payload, skill, 'package-manifest.json'), manifest);
  for (const [file, text] of Object.entries(extra)) { mkdirSync(join(payload, skill, file, '..'), { recursive: true }); writeFileSync(join(payload, skill, file), text); }
  assert.equal(spawnSync('zip', ['-qr', join(root, 'payload.zip'), skill], { cwd: payload }).status, 0);
  const zip = join(dir, `${folder}.zip`);
  assert.equal(spawnSync('zip', ['-qr', zip, folder], { cwd: join(root, '..') }).status, 0);
  return zip;
}
function suiteDir(version = '1.14.0', { licenseRequired = false, key = OWNER, upgradeFrom = null, changelog = '', teamqaExtra = {} } = {}) {
  const dir = tmp('build'), out = join(dir, 'suite');
  const releases = [envelope(dir, 'qa-code', '1.9.2'), envelope(dir, 'qa-gui', '2.15.0'), envelope(dir, 'team-qa', version, '# skill\n', teamqaExtra)];
  buildSuite({ releases, out, privatePath: key.privatePath, licenseRequired, requirements: { ...REQ, platforms: ['darwin', 'linux'], node: { min: '20.0.0' } }, upgradeFrom, changelog });
  return out;
}

test('a signed release entry verifies, and any change to it or a foreign key does not', () => {
  const source = { skill: 'qa-gui', version: '2.15.0', commit: 'a'.repeat(40), tree: 'b'.repeat(40), repo: 'https://github.com/agentpro-tech/qa-gui.git', manifest_sha256: 'c'.repeat(64), package_sha256: 'd'.repeat(64), built_at: 'x' };
  const doc = signReleaseEntry(releaseEntry(source), { privatePath: OWNER.privatePath });
  assert.equal(doc.key_id, OWNER.publicKey.key_id);
  assert.deepEqual(verifyReleaseSignature(doc, { publicKey: OWNER.publicKey }), releaseEntry(source));
  const reordered = { ...doc, signed: Object.fromEntries(Object.entries(doc.signed).reverse()) };
  assert.deepEqual(verifyReleaseSignature(reordered, { publicKey: OWNER.publicKey }), releaseEntry(source), 'key order in the file does not matter');
  assert.throws(() => verifyReleaseSignature({ ...doc, signed: { ...doc.signed, version: '2.15.1' } }, { publicKey: OWNER.publicKey }), /RELEASE_SIGNATURE_INVALID/);
  assert.throws(() => verifyReleaseSignature(doc, { publicKey: OTHER.publicKey }), /RELEASE_SIGNATURE_WRONG_KEY/);
  assert.throws(() => verifyReleaseSignature({ ...doc, key_id: OTHER.publicKey.key_id }, { publicKey: OTHER.publicKey }), /RELEASE_SIGNATURE_INVALID/);
  assert.throws(() => releaseEntry({ ...source, repo: '' }), /RELEASE_ENTRY_FIELD: repo/);
});

test('the suite installs the three skills in order and leaves a signature that proves each one', () => {
  const dir = suiteDir(), dest = tmp('dest'), lines = [];
  const suite = verifySuite(dir, { publicKey: OWNER.publicKey });
  assert.deepEqual(suite.skills.map(s => s.skill), ['qa-code', 'qa-gui', 'team-qa']);
  const r = installSuite(dir, { destRoot: dest, compatRoot: tmp('compat'), publicKey: OWNER.publicKey, log: l => lines.push(l) });
  assert.deepEqual(r.installed.map(s => `${s.skill}@${s.version}`), ['qa-code@1.9.2', 'qa-gui@2.15.0', 'team-qa@1.14.0']);
  assert.deepEqual(lines.map(l => l.split(' ')[0]), ['qa-code', 'qa-gui', 'team-qa']);
  for (const skill of ['qa-code', 'qa-gui', 'team-qa']) {
    const v = verifyInstalledRelease(join(dest, skill), { publicKey: OWNER.publicKey, skill });
    assert.equal(v.provenance, 'signed');
  }
  const gui = join(dest, 'qa-gui');
  writeFileSync(join(gui, 'package-manifest.json'), '{"tampered":true}\n');
  assert.throws(() => verifyInstalledRelease(gui, { publicKey: OWNER.publicKey, skill: 'qa-gui' }), /MANIFEST_DRIFT/);
  const source = JSON.parse(readFileSync(join(dest, 'qa-code', 'SOURCE.json'), 'utf8'));
  writeFileSync(join(dest, 'qa-code', 'SOURCE.json'), JSON.stringify({ ...source, commit: 'e'.repeat(40) }));
  assert.throws(() => verifyInstalledRelease(join(dest, 'qa-code'), { publicKey: OWNER.publicKey, skill: 'qa-code' }), /SOURCE_DRIFT: commit/);
  assert.throws(() => verifyInstalledRelease(join(dest, 'team-qa'), { publicKey: OWNER.publicKey, skill: 'qa-gui' }), /OTHER_SKILL/);
});

test('a suite is refused when a zip, its signature or its key is not the publisher\'s', () => {
  const dir = suiteDir();
  assert.throws(() => verifySuite(dir, { publicKey: OTHER.publicKey }), /SUITE_WRONG_KEY/);
  const suite = JSON.parse(readFileSync(join(dir, 'suite.json'), 'utf8'));
  writeFileSync(join(dir, suite.skills[1].zip), 'not the signed zip');
  assert.throws(() => verifySuite(dir, { publicKey: OWNER.publicKey }), /SUITE_ZIP_DRIFT/);
  const other = suiteDir();
  const doc = JSON.parse(readFileSync(join(other, 'suite.json'), 'utf8'));
  writeFileSync(join(other, 'suite.json'), JSON.stringify({ ...doc, license_required: true }, null, 2) + '\n');
  assert.throws(() => verifySuite(other, { publicKey: OWNER.publicKey }), /SUITE_SIGNATURE/);
  assert.throws(() => buildSuite({ releases: [envelope(tmp('x'), 'qa-gui', '2.14.0'), envelope(tmp('y'), 'qa-code', '1.9.2'), envelope(tmp('z'), 'team-qa', '1.14.0')], out: tmp('o'), privatePath: OWNER.privatePath, requirements: REQ }), /SUITE_SKILL_TOO_OLD qa-gui 2.14.0 < 2.15.0/);
  assert.throws(() => buildSuite({ releases: [envelope(tmp('x'), 'qa-gui', '2.15.0'), envelope(tmp('z'), 'team-qa', '1.14.0')], out: tmp('o'), privatePath: OWNER.privatePath, requirements: REQ }), /SUITE_SKILLS/);
  const leaky = tmp('leak'), gui = envelope(leaky, 'qa-gui', '2.15.0');
  const folder = 'qa-gui-2.15.0-release', base = join(leaky, 'build-qa-gui2.15.0');
  writeFileSync(join(base, folder, 'release-truth.json'), JSON.stringify({ repo: '/' + 'Users/someperson/Dev/qa-gui' }));
  assert.equal(spawnSync('zip', ['-qr', gui, folder], { cwd: base }).status, 0);
  const three = [envelope(tmp('a'), 'qa-code', '1.9.2'), gui, envelope(tmp('b'), 'team-qa', '1.14.0')];
  assert.throws(() => buildSuite({ releases: three, out: tmp('o'), privatePath: OWNER.privatePath, requirements: REQ }), /SUITE_ENVELOPE_HYGIENE qa-gui: PERSONAL_PATH release-truth\.json/);
  assert.equal(buildSuite({ releases: three, out: tmp('o'), privatePath: OWNER.privatePath, requirements: REQ, allowPersonalPaths: true }).skills.length, 3);
  const dirty = [envelope(tmp('c'), 'qa-code', '1.9.2', 'see ' + '/' + 'Users/someperson/Dev/notes\n'), envelope(tmp('d'), 'qa-gui', '2.15.0'), envelope(tmp('e'), 'team-qa', '1.14.0')];
  assert.throws(() => buildSuite({ releases: dirty, out: tmp('o'), privatePath: OWNER.privatePath, requirements: REQ }), /SUITE_PAYLOAD_HYGIENE qa-code: PERSONAL_PATH SKILL\.md/);
});

test('a suite marked license_required installs only with a valid licence', () => {
  const dir = suiteDir('1.14.0', { licenseRequired: true });
  assert.throws(() => installSuite(dir, { compatRoot: tmp('compat'), destRoot: tmp('d'), publicKey: OWNER.publicKey, license: { ok: false, code: 'LICENSE_NONE' } }), /SUITE_LICENSE_REQUIRED LICENSE_NONE/);
  const doc = issueLicense({ email: 'User@Example.org', days: 30, privatePath: OWNER.privatePath });
  const license = verifyLicense(doc, { publicKey: OWNER.publicKey });
  assert.equal(license.ok, true);
  assert.equal(license.license.email, 'user@example.org');
  assert.equal(installSuite(dir, { compatRoot: tmp('compat'), destRoot: tmp('d'), publicKey: OWNER.publicKey, license }).installed.length, 3);
});

test('licences: free plan, signed by the owner, with an expiry that is checked', () => {
  const doc = issueLicense({ email: 'a@b.co', days: 1, privatePath: OWNER.privatePath, now: Date.parse('2026-10-01T00:00:00Z') });
  assert.equal(verifyLicense(doc, { publicKey: OWNER.publicKey, now: Date.parse('2026-10-01T12:00:00Z') }).ok, true);
  assert.equal(verifyLicense(doc, { publicKey: OWNER.publicKey, now: Date.parse('2026-10-03T00:00:00Z') }).code, 'LICENSE_EXPIRED');
  assert.equal(verifyLicense(doc, { publicKey: OTHER.publicKey }).code, 'LICENSE_WRONG_KEY');
  assert.equal(verifyLicense({ ...doc, license: { ...doc.license, plan: 'free', expires_at: '2099-01-01T00:00:00.000Z' } }, { publicKey: OWNER.publicKey }).code, 'LICENSE_SIGNATURE');
  assert.equal(verifyLicense(null, { publicKey: OWNER.publicKey }).code, 'LICENSE_NONE');
  assert.throws(() => issueLicense({ email: 'a@b.co', plan: 'pro', days: 1, privatePath: OWNER.privatePath }), /LICENSE_PLAN_UNKNOWN/);
  assert.throws(() => issueLicense({ email: 'nope', days: 1, privatePath: OWNER.privatePath }), /LICENSE_EMAIL_INVALID/);
});

test('a channel offers the newer suite, the update installs it, and a tampered channel is not trusted', () => {
  const channel = tmp('channel'), dest = tmp('dest'), cache = join(tmp('cache'), 'update-check.json'), cwd = tmp('cwd');
  installSuite(suiteDir('1.14.0'), { compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey });
  publishSuite(suiteDir('1.14.0'), channel, { privatePath: OWNER.privatePath, publicKey: OWNER.publicKey });
  assert.equal(checkUpdate({ channel, destRoot: dest, publicKey: OWNER.publicKey, cachePath: cache }).status, 'up_to_date');
  assert.throws(() => publishSuite(suiteDir('1.13.9'), channel, { privatePath: OWNER.privatePath, publicKey: OWNER.publicKey }), /CHANNEL_NOT_NEWER/);
  publishSuite(suiteDir('1.15.0'), channel, { privatePath: OWNER.privatePath, publicKey: OWNER.publicKey });
  const check = checkUpdate({ channel, destRoot: dest, publicKey: OWNER.publicKey, cachePath: cache });
  assert.deepEqual([check.status, check.installed, check.latest], ['available', '1.14.0', '1.15.0']);
  assert.equal(JSON.parse(readFileSync(cache, 'utf8')).result.latest, '1.15.0', 'the last check is cached for the daily notice');

  mkdirSync(join(cwd, 'runs', 'r1'), { recursive: true });
  writeFileSync(join(cwd, 'runs', 'r1', 'phase.json'), JSON.stringify({ phase: 'EXECUTE' }));
  assert.deepEqual(activeRuns(cwd), ['r1']);
  assert.throws(() => applyUpdate({ channel, compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey, cwd }), /UPDATE_RUN_ACTIVE/);
  writeFileSync(join(cwd, 'runs', 'r1', 'phase.json'), JSON.stringify({ phase: 'COMPLETE' }));
  const done = applyUpdate({ channel, compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey, cwd });
  assert.deepEqual([done.status, done.from, done.to], ['updated', '1.14.0', '1.15.0']);
  assert.equal(JSON.parse(readFileSync(join(dest, 'team-qa', 'SOURCE.json'), 'utf8')).version, '1.15.0');
  assert.ok(existsSync(join(dest, 'team-qa', 'release-signature.json')));

  const index = JSON.parse(readFileSync(join(channel, 'channel.json'), 'utf8'));
  writeFileSync(join(channel, 'channel.json'), JSON.stringify({ ...index, latest: { ...index.latest, version: '9.9.9' } }, null, 2) + '\n');
  assert.deepEqual(checkUpdate({ channel, destRoot: dest, publicKey: OWNER.publicKey, cachePath: cache }), { status: 'unreachable', code: 'CHANNEL_SIGNATURE' });
  assert.equal(checkUpdate({ channel: null }).status, 'no_channel');
  assert.equal(checkUpdate({ channel: join(channel, 'absent'), destRoot: dest, publicKey: OWNER.publicKey, cachePath: cache }).code, 'CHANNEL_UNREACHABLE');
});

test('the roster proves a signed child by its signature and Team QA\'s own package tool, before any git (static)', () => {
  const source = readFileSync(new URL('../../scripts/lib/roster.mjs', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('function verifyProviderInterfaceOnce'));
  const signedAt = fn.indexOf('verifyInstalledRelease(root'), toolAt = fn.indexOf("join(ROOT,'scripts/package-tool.mjs'),'verify-runtime'"), gitAt = fn.indexOf("spawnSync('git'");
  assert.ok(signedAt > 0 && signedAt < toolAt && toolAt < gitAt, 'signature, then Team QA\'s verify-runtime, and git only on the unsigned route');
  assert.match(fn, /provenance:'signed'/);
});

test('the shipped public key is the one every signature here is checked against', async () => {
  const { readPublicKey, PUBLIC_KEY_PATH } = await import('../../scripts/lib/owner-grant.mjs');
  const doc = readPublicKey(PUBLIC_KEY_PATH);
  assert.ok(doc, 'security/owner-grant-key.json ships with Team QA');
  assert.match(doc.key_id, /^[a-f0-9]{64}$/);
});

test('a local-candidate envelope installs only when asked, and never reaches the stable channel', () => {
  const dir = tmp('cand'), out = join(dir, 'suite');
  const team = envelope(dir, 'team-qa', '1.14.0'), base = join(dir, 'build-team-qa1.14.0'), cand = 'team-qa-1.14.0-local-candidate';
  assert.equal(spawnSync('mv', [join(base, 'team-qa-1.14.0-release'), join(base, cand)]).status, 0);
  const zip = join(dir, cand + '.zip');
  assert.equal(spawnSync('zip', ['-qr', zip, cand], { cwd: base }).status, 0);
  buildSuite({ releases: [envelope(dir, 'qa-code', '1.9.2'), envelope(dir, 'qa-gui', '2.15.0'), zip], out, privatePath: OWNER.privatePath, requirements: REQ, licenseRequired: false });
  assert.throws(() => installSuite(out, { compatRoot: tmp('compat'), destRoot: tmp('d'), publicKey: OWNER.publicKey }), /SUITE_LOCAL_CANDIDATE team-qa/);
  assert.equal(installSuite(out, { compatRoot: tmp('compat'), destRoot: tmp('d'), publicKey: OWNER.publicKey, allowLocalCandidate: true }).installed.length, 3);
  assert.throws(() => publishSuite(out, tmp('ch'), { privatePath: OWNER.privatePath, publicKey: OWNER.publicKey }), /CHANNEL_LOCAL_CANDIDATE/);
});

test('by default a suite asks for the free licence; the installer activates the file it is given, and says how when it is missing', () => {
  const dir = tmp('lic'), out = join(dir, 'suite');
  buildSuite({ releases: [envelope(dir, 'qa-code', '1.9.2'), envelope(dir, 'qa-gui', '2.15.0'), envelope(dir, 'team-qa', '1.14.0')], out, privatePath: OWNER.privatePath, requirements: REQ });
  assert.equal(JSON.parse(readFileSync(join(out, 'suite.json'), 'utf8')).license_required, true);
  const licensePath = join(tmp('home'), 'license.json'), dest = tmp('dest');
  assert.throws(() => installSuite(out, { compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey, licensePath }), /SUITE_LICENSE_REQUIRED LICENSE_NONE: .*bash install\.sh --license/);
  assert.equal(existsSync(join(dest, 'qa-code')), false, 'nothing installed without a licence');
  const file = join(tmp('mail'), 'license.json');
  writeFileSync(file, JSON.stringify(issueLicense({ email: 'new@user.io', days: 365, privatePath: OWNER.privatePath })));
  const lines = [];
  assert.equal(installSuite(out, { compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey, licensePath, licenseFile: file, log: l => lines.push(l) }).installed.length, 3);
  assert.ok(existsSync(licensePath), 'the licence is kept for later updates');
  assert.match(lines[0], /^licence lic-[a-f0-9]+ \(free\) active until/);
  const forged = join(tmp('mail'), 'forged.json');
  writeFileSync(forged, JSON.stringify(issueLicense({ email: 'x@y.io', days: 365, privatePath: OTHER.privatePath })));
  assert.throws(() => installSuite(out, { compatRoot: tmp('compat'), destRoot: tmp('d'), publicKey: OWNER.publicKey, licensePath: join(tmp('h'), 'l.json'), licenseFile: forged }), /LICENSE_WRONG_KEY/);
});

test('a machine the installer cannot fix is refused before any skill is touched', () => {
  const dir = suiteDir(), dest = tmp('dest');
  assert.throws(() => installSuite(dir, { compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey, nodeVersion: '18.19.0' }), /SUITE_NODE_TOO_OLD Node\.js 18\.19\.0 < 20\.0\.0; nothing was installed/);
  assert.throws(() => installSuite(dir, { compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey, platform: 'win32' }), /SUITE_PLATFORM_UNSUPPORTED win32/);
  assert.deepEqual(spawnSync('ls', [dest], { encoding: 'utf8' }).stdout, '');
  const lines = [];
  installSuite(dir, { compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey, which: () => false, log: l => lines.push(l) });
  assert.ok(lines.some(l => /neither claude nor codex is on PATH/.test(l)));
});

test('the suite carries its own installer, which checks Node and hands over to the Team QA inside it', () => {
  const stub = "console.log('BOOT ' + process.argv.slice(2).join(' '));\n";
  const dir = suiteDir('1.14.0', { teamqaExtra: { 'scripts/teamqa.mjs': stub, 'security/owner-grant-key.json': JSON.stringify(OWNER.publicKey) } });
  const r = spawnSync('bash', [join(dir, 'install.sh'), '--license', 'my-licence.json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`publisher key: ${OWNER.publicKey.key_id}`));
  assert.match(r.stdout, new RegExp(`BOOT suite install --dir ${realpathSync(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --license my-licence\\.json`));
});

test('the channel carries the changelog and the oldest version that updates directly; older ones are told to reinstall', () => {
  const channel = tmp('channel'), dest = tmp('dest'), cache = join(tmp('cache'), 'update-check.json');
  installSuite(suiteDir('1.14.0'), { compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey });
  const c = publishSuite(suiteDir('1.16.0', { upgradeFrom: '1.15.0', changelog: 'Signed suite; update channel.' }), channel, { name: 'test', privatePath: OWNER.privatePath, publicKey: OWNER.publicKey });
  assert.deepEqual([c.latest.upgrade_from, c.latest.changelog, c.latest.skills['qa-gui'], c.latest.license_required], ['1.15.0', 'Signed suite; update channel.', '2.15.0', false]);
  const r = checkUpdate({ channel, destRoot: dest, publicKey: OWNER.publicKey, cachePath: cache });
  assert.deepEqual([r.status, r.upgrade_from, r.changelog], ['reinstall_needed', '1.15.0', 'Signed suite; update channel.']);
  assert.throws(() => applyUpdate({ channel, compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey, cwd: tmp('cwd') }), /UPDATE_TOO_OLD/);
  assert.throws(() => buildSuite({ releases: [], out: tmp('o'), privatePath: OWNER.privatePath, upgradeFrom: 'soon' }), /SUITE_UPGRADE_FROM/);
});

test('the preflight notice appears once a day, only with a channel, and never throws', () => {
  const channel = tmp('channel'), dest = tmp('dest'), cache = join(tmp('cache'), 'update-check.json');
  installSuite(suiteDir('1.14.0'), { compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey });
  publishSuite(suiteDir('1.15.0'), channel, { name: 'test', privatePath: OWNER.privatePath, publicKey: OWNER.publicKey });
  const now = Date.parse('2026-11-04T08:00:00Z');
  assert.match(updateNotice({ channel, destRoot: dest, publicKey: OWNER.publicKey, cachePath: cache, now }), /^TEAMQA_UPDATE_AVAILABLE installed=1\.14\.0 latest=1\.15\.0/);
  assert.equal(updateNotice({ channel, destRoot: dest, publicKey: OWNER.publicKey, cachePath: cache, now: now + 3600000 }), null, 'not twice the same day');
  assert.match(updateNotice({ channel, destRoot: dest, publicKey: OWNER.publicKey, cachePath: cache, now: now + 26 * 3600000 }) ?? '', /TEAMQA_UPDATE_AVAILABLE/);
  assert.equal(updateNotice({ channel: null, cachePath: cache }), null);
  assert.equal(updateNotice({ channel: join(channel, 'gone'), destRoot: dest, publicKey: OWNER.publicKey, cachePath: join(tmp('c2'), 'u.json'), now }), null, 'an unreachable channel is silent');
});

test('the Dragon runtime package can travel in the suite, covered by the suite signature', async () => {
  const { sign: edSign } = await import('node:crypto');
  const dk = generateKeyPairSync('ed25519'), fp = 'sha256:' + sha(dk.publicKey.export({ type: 'spki', format: 'der' }));
  const files = [['server.js', 'x\n'], ['package.json', '{"version":"1.6.10"}'], ['tools/macos-service.mjs', 'x\n']].map(([path, t]) => ({ path, bytes: Buffer.byteLength(t), sha256: 'sha256:' + sha(t), data: Buffer.from(t).toString('base64') }));
  const bytes = Buffer.from(JSON.stringify({ schema: 'dragon-browser-rc/v1', version: '1.6.10', kind: 'runtime', build: 'b1', files }) + '\n');
  const pkg = join(tmp('rt'), 'dragon-runtime-1.6.10.dbrc');
  writeFileSync(pkg, bytes);
  writeFileSync(pkg + '.sig.json', JSON.stringify({ algorithm: 'Ed25519', publicKeyFingerprint: fp, value: edSign(null, bytes, dk.privateKey).toString('base64') }));
  const { readRequirements } = await import('../../scripts/lib/dragon-requirements.mjs');
  const base = readRequirements();
  const requirements = { ...REQ, platforms: ['darwin', 'linux'], node: { min: '20.0.0' }, dragon: { ...base.dragon, runtime: { public_key_pem: dk.publicKey.export({ type: 'spki', format: 'pem' }), fingerprint: fp } } };
  const dir = tmp('rtsuite'), out = join(dir, 'suite');
  const suite = buildSuite({ releases: [envelope(dir, 'qa-code', '1.9.2'), envelope(dir, 'qa-gui', '2.15.0'), envelope(dir, 'team-qa', '1.14.0')], out, privatePath: OWNER.privatePath, requirements, licenseRequired: false, dragonRuntime: pkg });
  assert.deepEqual([suite.dragon_runtime.file, suite.dragon_runtime.version, suite.dragon_runtime.build], ['dragon-runtime-1.6.10.dbrc', '1.6.10', 'b1']);
  const lines = [];
  installSuite(out, { compatRoot: tmp('compat'), destRoot: tmp('dest'), publicKey: OWNER.publicKey, log: l => lines.push(l) });
  assert.ok(lines.some(l => /^Dragon runtime 1\.6\.10 is in this suite; teamqa doctor says whether to install it \(teamqa dragon install --from /.test(l)));
  writeFileSync(join(out, 'dragon-runtime-1.6.10.dbrc'), 'swapped');
  assert.throws(() => verifySuite(out, { publicKey: OWNER.publicKey }), /SUITE_DRAGON_RUNTIME_DRIFT/);
  writeFileSync(pkg + '.sig.json', JSON.stringify({ algorithm: 'Ed25519', publicKeyFingerprint: fp, value: 'AAAA' }));
  assert.throws(() => buildSuite({ releases: [envelope(dir, 'qa-code', '1.9.2'), envelope(dir, 'qa-gui', '2.15.0'), envelope(dir, 'team-qa', '1.14.0')], out: tmp('o2'), privatePath: OWNER.privatePath, requirements, dragonRuntime: pkg }), /DRAGON_RUNTIME_SIGNATURE/);
});


test('an update fetches the Dragon runtime the suite carries, refuses a suite the channel does not name, and forgets the old notice', async () => {
  const { sign: edSign } = await import('node:crypto');
  const dk = generateKeyPairSync('ed25519'), fp = 'sha256:' + sha(dk.publicKey.export({ type: 'spki', format: 'der' }));
  const files = [['server.js', 'x\n'], ['package.json', '{"version":"1.6.10"}'], ['tools/macos-service.mjs', 'x\n']].map(([path, t]) => ({ path, bytes: Buffer.byteLength(t), sha256: 'sha256:' + sha(t), data: Buffer.from(t).toString('base64') }));
  const bytes = Buffer.from(JSON.stringify({ schema: 'dragon-browser-rc/v1', version: '1.6.10', kind: 'runtime', build: 'b1', files }) + '\n');
  const pkg = join(tmp('rt2'), 'dragon-runtime-1.6.10.dbrc');
  writeFileSync(pkg, bytes);
  writeFileSync(pkg + '.sig.json', JSON.stringify({ algorithm: 'Ed25519', publicKeyFingerprint: fp, value: edSign(null, bytes, dk.privateKey).toString('base64') }));
  const { readRequirements } = await import('../../scripts/lib/dragon-requirements.mjs');
  const base = readRequirements();
  const requirements = { ...REQ, platforms: ['darwin', 'linux'], node: { min: '20.0.0' }, dragon: { ...base.dragon, runtime: { public_key_pem: dk.publicKey.export({ type: 'spki', format: 'pem' }), fingerprint: fp } } };
  const withRuntime = version => { const dir = tmp('rtu'), out = join(dir, 'suite');
    buildSuite({ releases: [envelope(dir, 'qa-code', '1.9.2'), envelope(dir, 'qa-gui', '2.15.0'), envelope(dir, 'team-qa', version)], out, privatePath: OWNER.privatePath, requirements, licenseRequired: false, dragonRuntime: pkg });
    return out; };
  const channel = tmp('rtchannel'), dest = tmp('rtdest'), cache = join(tmp('rtcache'), 'update-check.json'), cwd = tmp('rtcwd');
  installSuite(withRuntime('1.14.0'), { compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey });
  publishSuite(withRuntime('1.14.0'), channel, { privatePath: OWNER.privatePath, publicKey: OWNER.publicKey });
  publishSuite(withRuntime('1.15.0'), channel, { privatePath: OWNER.privatePath, publicKey: OWNER.publicKey });
  assert.equal(checkUpdate({ channel, destRoot: dest, publicKey: OWNER.publicKey, cachePath: cache, useCache: true }).status, 'available');
  // A wrong folder: the 1.15.0 path holds a signed but different suite.
  const folder = join(channel, 'teamqa-suite-1.15.0'), keep = readFileSync(join(folder, 'suite.json')), keepSig = readFileSync(join(folder, 'suite.sig.json'));
  const other = suiteDir('1.13.9');
  copyFileSync(join(other, 'suite.json'), join(folder, 'suite.json')); copyFileSync(join(other, 'suite.sig.json'), join(folder, 'suite.sig.json'));
  assert.throws(() => applyUpdate({ channel, compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey, cwd }), /UPDATE_SUITE_MISMATCH/);
  assert.equal(JSON.parse(readFileSync(join(dest, 'team-qa', 'SOURCE.json'), 'utf8')).version, '1.14.0', 'nothing was installed');
  writeFileSync(join(folder, 'suite.json'), keep); writeFileSync(join(folder, 'suite.sig.json'), keepSig);
  const done = applyUpdate({ channel, compatRoot: tmp('compat'), destRoot: dest, publicKey: OWNER.publicKey, cwd });
  assert.deepEqual([done.status, done.from, done.to], ['updated', '1.14.0', '1.15.0']);
  // The cached "available" answer was given for 1.14.0; after the update it no longer holds.
  assert.equal(checkUpdate({ channel, destRoot: dest, publicKey: OWNER.publicKey, cachePath: cache, useCache: true }).status, 'up_to_date');
});

test('an install outside the default root needs a compat root, and every installer must honour it', () => {
  const dir = suiteDir();
  assert.throws(() => installSuite(dir, { destRoot: tmp('dest'), publicKey: OWNER.publicKey }), /SUITE_COMPAT_ROOT_REQUIRED/);
  const old = tmp('old'), out = join(old, 'suite'), gui = envelope(old, 'qa-gui', '2.15.0');
  const folder = 'qa-gui-2.15.0-release', base = join(old, 'build-qa-gui2.15.0');
  writeFileSync(join(base, folder, 'install.sh'), '#!/usr/bin/env bash\nmkdir -p "$HOME/.claude/skills"\n');
  assert.equal(spawnSync('zip', ['-qr', gui, folder], { cwd: base }).status, 0);
  buildSuite({ releases: [envelope(old, 'qa-code', '1.9.2'), gui, envelope(old, 'team-qa', '1.14.0')], out, privatePath: OWNER.privatePath, requirements: REQ, licenseRequired: false });
  const dest = tmp('dest');
  assert.throws(() => installSuite(out, { destRoot: dest, compatRoot: tmp('compat'), publicKey: OWNER.publicKey }), /SUITE_INSTALLER_COMPAT_ROOT qa-gui/);
  assert.equal(existsSync(join(dest, 'qa-gui')), false);
});

test('a payload whose manifest names another version than SOURCE.json is refused at build time', () => {
  const dir = tmp('split'), qc = envelope(dir, 'qa-code', '1.9.2');
  const base = join(dir, 'build-qa-code1.9.2'), folder = 'qa-code-1.9.2-release', payload = join(dir, 'payload-qa-code1.9.2');
  writeFileSync(join(payload, 'qa-code', 'package-manifest.json'), JSON.stringify({ schema: 'agentpro/skill-package-manifest/v1', skill: 'qa-code', version: '1.8.1', files: [] }) + '\n');
  assert.equal(spawnSync('zip', ['-qr', join(base, folder, 'payload.zip'), 'qa-code'], { cwd: payload }).status, 0);
  assert.equal(spawnSync('zip', ['-qr', qc, folder], { cwd: base }).status, 0);
  assert.throws(() => buildSuite({ releases: [qc, envelope(dir, 'qa-gui', '2.15.0'), envelope(dir, 'team-qa', '1.14.0')], out: tmp('o'), privatePath: OWNER.privatePath, requirements: REQ }), /SUITE_PAYLOAD_HYGIENE qa-code: VERSION_SPLIT package-manifest\.json says 1\.8\.1, SOURCE\.json says 1\.9\.2/);
});
