import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, dragonStatusVerdict, inRange, parseVersion, readRequirements, validateRequirements } from '../../scripts/lib/dragon-requirements.mjs';

const ok = (bridgeVersion, extension = { version: bridgeVersion }, extra = {}) => ({ ok: true, ready: true, bridgeVersion, bridgeBuild: 'b', extension, ...extra });

test('versions compare by major.minor.patch, a build suffix is ignored', () => {
  assert.deepEqual(parseVersion('1.6.10'), [1, 6, 10]);
  assert.deepEqual(parseVersion('1.6.9-qa.991cf5d'), [1, 6, 9]);
  for (const bad of ['1.6', 'v1.6.9', '', null, undefined, '1.6.9.1']) assert.equal(parseVersion(bad), null, String(bad));
  assert.equal(compareVersions('1.6.10', '1.6.9'), 1);
  assert.equal(compareVersions('1.6.9', '1.6.9-qa.1'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('x', '1.0.0'), null);
  assert.equal(inRange('1.6.9', { min: '1.6.9', below: '2.0.0' }), 'ok');
  assert.equal(inRange('1.6.8', { min: '1.6.9', below: '2.0.0' }), 'old');
  assert.equal(inRange('2.0.0', { min: '1.6.9', below: '2.0.0' }), 'unsupported');
  assert.equal(inRange('nope', { min: '1.6.9' }), 'invalid');
});

test('the shipped scripts/requirements.json is valid and asks for the Store build of Dragon 1.6.9 or later', () => {
  const req = readRequirements();
  assert.equal(req.skill, 'team-qa');
  assert.equal(req.dragon.bridge.min, '1.6.9');
  assert.equal(req.dragon.extension.min, '1.6.9');
  assert.deepEqual(req.dragon.extension.store_ids, ['dmgoldioklileddehbjpbfacojckfkjo']);
  assert.ok(req.dragon.rpc.includes('getPageIdentity'));
  assert.match(req.dragon.store_url, /dmgoldioklileddehbjpbfacojckfkjo$/);
});

test('a malformed requirements file is refused, not guessed', () => {
  const base = JSON.parse(JSON.stringify(readRequirements()));
  const broken = [
    d => { d.schema = 'x'; }, d => { d.platforms = []; }, d => { d.dragon.bridge.min = '1.6'; },
    d => { d.dragon.bridge.below = '1.6.0'; }, d => { d.dragon.extension.store_ids = ['NOT-AN-ID']; },
    d => { d.dragon.rpc = [''] ; }, d => { d.dragon.store_url = 'https://example.com/dragon'; }, d => { d.skills['qa-gui'].min = 'latest'; },
  ];
  for (const change of broken) {
    const d = JSON.parse(JSON.stringify(base)); change(d);
    assert.throws(() => validateRequirements(d), /REQUIREMENTS_INVALID/);
  }
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-req-'));
  writeFileSync(join(dir, 'requirements.json'), '{"schema":"agentpro/skill-requirements/v1"}');
  assert.throws(() => readRequirements(join(dir, 'requirements.json')), /REQUIREMENTS_INVALID/);
});

test('each shortfall names its own code and the action that fixes it', () => {
  const cases = [
    [null, 'DRAGON_STATUS', 'install_runtime'],
    [{ ok: false }, 'DRAGON_STATUS', 'install_runtime'],
    [ok('1.6.9', { version: '1.6.9' }, { error: 'boom' }), 'DRAGON_STATUS', 'install_runtime'],
    [ok('garbage'), 'DRAGON_VERSION', 'install_runtime'],
    [ok('1.6.8'), 'DRAGON_RUNTIME_OLD', 'update_runtime'],
    [ok('2.0.0', { version: '1.6.9' }), 'DRAGON_RUNTIME_UNSUPPORTED', 'update_teamqa'],
    [ok('1.6.9', null), 'DRAGON_EXTENSION_MISSING', 'install_extension'],
    [ok('1.6.9', { version: '1.6.9', error: 'socket closed' }), 'DRAGON_EXTENSION_ERROR', 'pair'],
    [ok('1.6.9', { version: '1.6.6' }), 'DRAGON_EXTENSION_OLD', 'update_extension'],
    [ok('1.6.9', { version: '3.0.0' }), 'DRAGON_EXTENSION_UNSUPPORTED', 'update_teamqa'],
    [ok('1.6.9', { version: '1.6.9', installType: 'development' }), 'DRAGON_EXTENSION_NOT_STORE', 'install_extension'],
    [ok('1.6.9', { version: '1.6.9' }, { ready: false }), 'DRAGON_NOT_READY', 'pair'],
  ];
  for (const [status, code, action] of cases) {
    const v = dragonStatusVerdict(status);
    assert.equal(v.ok, false, code);
    assert.equal(v.code, code);
    assert.equal(v.action, action, code);
    assert.ok(v.detail.length > 10, code);
  }
});

test('a bridge and an extension of different versions pass when each is in range', () => {
  assert.deepEqual(dragonStatusVerdict(ok('1.6.10', { version: '1.6.9' })), { ok: true, bridge: '1.6.10', extension: '1.6.9', extensionId: null, installType: null, platform: 'dragon', grant_id: null });
  const store = dragonStatusVerdict(ok('1.6.9', { version: '1.7.0', id: 'dmgoldioklileddehbjpbfacojckfkjo', installType: 'normal' }));
  assert.equal(store.ok, true);
  assert.equal(store.extensionId, 'dmgoldioklileddehbjpbfacojckfkjo');
});

test('only an owner grant lets an unpacked or other extension through', () => {
  const unpacked = ok('1.6.9', { version: '1.6.9', id: 'ecidbgopafpecddiefiihnpdljacaiko', installType: 'development' });
  assert.equal(dragonStatusVerdict(unpacked).code, 'DRAGON_EXTENSION_NOT_STORE');
  const granted = dragonStatusVerdict(unpacked, undefined, { ownerGrant: { allows: p => p === 'dragon-unpacked', grant: { id: 'g-1' } } });
  assert.equal(granted.ok, true);
  assert.equal(granted.platform, 'dragon-unpacked');
  assert.equal(granted.grant_id, 'g-1');
  assert.equal(dragonStatusVerdict(unpacked, undefined, { ownerGrant: { allows: () => false } }).code, 'DRAGON_EXTENSION_NOT_STORE');
});
