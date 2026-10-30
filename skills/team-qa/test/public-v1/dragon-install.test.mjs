import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDragonRuntime, installDragonRuntime, locateDragonRuntime, verifyDragonRuntime } from '../../scripts/lib/dragon-install.mjs';
import { readRequirements } from '../../scripts/lib/dragon-requirements.mjs';

const sha = buf => createHash('sha256').update(buf).digest('hex');
const tmp = name => mkdtempSync(join(tmpdir(), `teamqa-dragon-${name}-`));
function dragonKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, fingerprint: 'sha256:' + sha(publicKey.export({ type: 'spki', format: 'der' })), pem: publicKey.export({ type: 'spki', format: 'pem' }) };
}
const DRAGON = dragonKey(), OTHER = dragonKey();
const base = readRequirements();
const REQ = { ...base, dragon: { ...base.dragon, runtime: { public_key_pem: DRAGON.pem, fingerprint: DRAGON.fingerprint } } };

// A package the way Dragon's tools/runtime-release.mjs writes it: a dragon-browser-rc/v1 bundle of kind "runtime",
// signed over its exact bytes, with the signer's fingerprint in the detached signature.
function runtimePackage({ version = '1.6.10', kind = 'runtime', key = DRAGON, files = null, sigFingerprint } = {}) {
  const list = files ?? [['server.js', 'console.log(1)\n'], ['package.json', JSON.stringify({ version })], ['tools/macos-service.mjs', 'console.log(process.argv.slice(2).join(" "))\n']];
  const body = { schema: 'dragon-browser-rc/v1', version, ...(kind ? { kind } : {}), build: 'abc123def456',
    files: list.map(([path, text]) => { const b = Buffer.from(text); return { path, bytes: b.length, sha256: 'sha256:' + sha(b), data: b.toString('base64') }; }) };
  const dir = tmp('pkg'), file = join(dir, `dragon-runtime-${version}.dbrc`), bytes = Buffer.from(JSON.stringify(body) + '\n');
  writeFileSync(file, bytes);
  writeFileSync(file + '.sig.json', JSON.stringify({ algorithm: 'Ed25519', publicKeyFingerprint: sigFingerprint ?? key.fingerprint, value: sign(null, bytes, key.privateKey).toString('base64') }));
  return file;
}

test('the shipped requirements carry the Dragon release key and its fingerprint', () => {
  assert.match(base.dragon.runtime.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(base.dragon.runtime.public_key_pem, /BEGIN PUBLIC KEY/);
});

test('a runtime package signed by Dragon verifies; another key, a changed byte, a wrong kind or version does not', () => {
  const ok = verifyDragonRuntime(runtimePackage(), undefined, { requirements: REQ });
  assert.deepEqual([ok.version, ok.build, ok.files.length], ['1.6.10', 'abc123def456', 3]);
  assert.throws(() => verifyDragonRuntime(runtimePackage({ key: OTHER }), undefined, { requirements: REQ }), /DRAGON_RUNTIME_WRONG_KEY/);
  assert.throws(() => verifyDragonRuntime(runtimePackage({ key: OTHER, sigFingerprint: DRAGON.fingerprint }), undefined, { requirements: REQ }), /DRAGON_RUNTIME_SIGNATURE/);
  const changed = runtimePackage(), bytes = readFileSync(changed);
  bytes[bytes.length - 20] ^= 1; writeFileSync(changed, bytes);
  assert.throws(() => verifyDragonRuntime(changed, undefined, { requirements: REQ }), /DRAGON_RUNTIME_SIGNATURE/);
  assert.throws(() => verifyDragonRuntime(runtimePackage({ kind: null }), undefined, { requirements: REQ }), /DRAGON_RUNTIME_KIND/);
  assert.throws(() => verifyDragonRuntime(runtimePackage({ version: '1.6.8' }), undefined, { requirements: REQ }), /DRAGON_RUNTIME_PACKAGE_OLD 1\.6\.8/);
  assert.throws(() => verifyDragonRuntime(runtimePackage({ version: '2.0.0' }), undefined, { requirements: REQ }), /DRAGON_RUNTIME_PACKAGE_UNSUPPORTED/);
  assert.throws(() => verifyDragonRuntime(runtimePackage({ files: [['server.js', 'x'], ['package.json', '{}'], ['tools/macos-service.mjs', 'x'], ['../evil.sh', 'x']] }), undefined, { requirements: REQ }), /DRAGON_RUNTIME_PATH/);
  assert.throws(() => verifyDragonRuntime(runtimePackage({ files: [['package.json', '{}']] }), undefined, { requirements: REQ }), /DRAGON_RUNTIME_SHAPE missing server\.js/);
});

test('install verifies, extracts into a fresh folder and hands over to the package\'s own installer', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args); return { status: 0, stdout: '{"ok":true}', stderr: '' }; };
  const r = installDragonRuntime({ source: runtimePackage(), platform: 'darwin', run, requirements: REQ });
  assert.equal(r.version, '1.6.10');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1), ['install', '--source', r.source, '--build', 'abc123def456']);
  assert.equal(calls[0][0], join(r.source, 'tools', 'macos-service.mjs'));
  assert.equal(readFileSync(join(r.source, 'server.js'), 'utf8'), 'console.log(1)\n');
  assert.throws(() => installDragonRuntime({ source: runtimePackage(), platform: 'linux', run, requirements: REQ }), /DRAGON_PLATFORM_UNSUPPORTED linux/);
  assert.throws(() => installDragonRuntime({ source: runtimePackage({ key: OTHER }), platform: 'darwin', run, requirements: REQ }), /DRAGON_RUNTIME_WRONG_KEY/);
  assert.equal(calls.length, 1, 'a refused package never reaches an installer');
  assert.throws(() => installDragonRuntime({ source: runtimePackage(), platform: 'darwin', run: () => ({ status: 1, stderr: 'PORT_IN_USE: busy' }), requirements: REQ }), /DRAGON_RUNTIME_INSTALL_FAILED PORT_IN_USE/);
});

test('a suite folder that carries the runtime package is a source too', () => {
  const pkg = runtimePackage(), suite = tmp('suite');
  writeFileSync(join(suite, 'suite.json'), JSON.stringify({ dragon_runtime: { file: 'dragon-runtime-1.6.10.dbrc' } }));
  writeFileSync(join(suite, 'dragon-runtime-1.6.10.dbrc'), readFileSync(pkg));
  writeFileSync(join(suite, 'dragon-runtime-1.6.10.dbrc.sig.json'), readFileSync(pkg + '.sig.json'));
  assert.equal(locateDragonRuntime(suite), join(suite, 'dragon-runtime-1.6.10.dbrc'));
  assert.equal(verifyDragonRuntime(locateDragonRuntime(suite), undefined, { requirements: REQ }).version, '1.6.10');
  const empty = tmp('suite2'); writeFileSync(join(empty, 'suite.json'), '{}');
  assert.throws(() => locateDragonRuntime(empty), /DRAGON_RUNTIME_NOT_IN_SUITE/);
});
