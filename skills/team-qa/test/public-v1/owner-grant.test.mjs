import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserPlatformDecision, generateOwnerKey, issueGrant, loadOwnerGrant, machineFingerprint, readPublicKey, verifyGrant } from '../../scripts/lib/owner-grant.mjs';

const MACHINE = 'mfp-' + 'a'.repeat(32), OTHER = 'mfp-' + 'b'.repeat(32);
function owner() {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-grant-'));
  const privatePath = join(dir, 'keys', 'owner.pem'), publicPath = join(dir, 'owner-grant-key.json');
  generateOwnerKey({ privatePath, publicPath });
  return { dir, privatePath, publicPath, publicKey: readPublicKey(publicPath) };
}
const NOW = Date.parse('2026-11-01T00:00:00Z');

test('the owner key is created once, private 0600, and only the public half is written for the package', () => {
  const o = owner();
  assert.equal(statSync(o.privatePath).mode & 0o777, 0o600);
  assert.match(readFileSync(o.privatePath, 'utf8'), /BEGIN PRIVATE KEY/);
  const pub = readFileSync(o.publicPath, 'utf8');
  assert.doesNotMatch(pub, /PRIVATE/);
  assert.match(o.publicKey.key_id, /^[a-f0-9]{64}$/);
  assert.throws(() => generateOwnerKey({ privatePath: o.privatePath, publicPath: o.publicPath }), /GRANT_KEY_EXISTS/);
});

test('a grant for this machine allows exactly its platforms until it expires', () => {
  const o = owner();
  const doc = issueGrant({ platforms: ['playwright', 'dragon-unpacked'], days: 30, machine: MACHINE, privatePath: o.privatePath, now: NOW, id: 'g-test' });
  const v = verifyGrant(doc, { publicKey: o.publicKey, machine: MACHINE, now: NOW + 86400000 });
  assert.equal(v.ok, true);
  assert.equal(v.allows('playwright'), true);
  assert.equal(v.allows('dragon-unpacked'), true);
  assert.equal(v.allows('claude-in-chrome'), false);
  assert.equal(verifyGrant(doc, { publicKey: o.publicKey, machine: MACHINE, now: NOW + 31 * 86400000 }).code, 'GRANT_EXPIRED');
});

test('a copied, edited, foreign-key or future grant is refused', () => {
  const o = owner(), stranger = owner();
  const doc = issueGrant({ platforms: ['playwright'], days: 30, machine: MACHINE, privatePath: o.privatePath, now: NOW });
  assert.equal(verifyGrant(doc, { publicKey: o.publicKey, machine: OTHER, now: NOW }).code, 'GRANT_OTHER_MACHINE');
  const edited = JSON.parse(JSON.stringify(doc)); edited.grant.platforms = ['claude-in-chrome', 'playwright'];
  assert.equal(verifyGrant(edited, { publicKey: o.publicKey, machine: MACHINE, now: NOW }).code, 'GRANT_SIGNATURE');
  const resigned = issueGrant({ platforms: ['playwright'], days: 30, machine: MACHINE, privatePath: stranger.privatePath, now: NOW });
  assert.equal(verifyGrant(resigned, { publicKey: o.publicKey, machine: MACHINE, now: NOW }).code, 'GRANT_WRONG_KEY');
  const spoofed = { ...resigned, key_id: o.publicKey.key_id };
  assert.equal(verifyGrant(spoofed, { publicKey: o.publicKey, machine: MACHINE, now: NOW }).code, 'GRANT_SIGNATURE');
  assert.equal(verifyGrant(doc, { publicKey: o.publicKey, machine: MACHINE, now: NOW - 3600000 }).code, 'GRANT_TIME');
  assert.equal(verifyGrant(null, { publicKey: o.publicKey, machine: MACHINE }).code, 'GRANT_NONE');
  assert.equal(verifyGrant(doc, { publicKey: null, machine: MACHINE, now: NOW }).code, 'GRANT_NO_PUBLIC_KEY');
});

test('a run-scoped grant covers only that run', () => {
  const o = owner();
  const doc = issueGrant({ platforms: ['playwright'], days: 7, machine: MACHINE, runId: 'r-42', privatePath: o.privatePath, now: NOW });
  assert.equal(verifyGrant(doc, { publicKey: o.publicKey, machine: MACHINE, now: NOW, runId: 'r-42' }).ok, true);
  assert.equal(verifyGrant(doc, { publicKey: o.publicKey, machine: MACHINE, now: NOW, runId: 'r-43' }).code, 'GRANT_OTHER_RUN');
});

test('issuing needs the private key, a known platform, a bounded lifetime and a machine', () => {
  const o = owner();
  assert.throws(() => issueGrant({ platforms: ['playwright'], days: 30, machine: MACHINE, privatePath: join(o.dir, 'none.pem') }), /GRANT_KEY_MISSING/);
  assert.throws(() => issueGrant({ platforms: ['selenium'], days: 30, machine: MACHINE, privatePath: o.privatePath }), /GRANT_PLATFORM_UNKNOWN/);
  assert.throws(() => issueGrant({ platforms: ['playwright'], days: 400, machine: MACHINE, privatePath: o.privatePath }), /GRANT_DAYS_INVALID/);
  assert.throws(() => issueGrant({ platforms: ['playwright'], days: 30, machine: 'my-mac', privatePath: o.privatePath }), /GRANT_MACHINE_INVALID/);
});

test('a platform decision names why a non-Dragon platform is refused', () => {
  const o = owner();
  const doc = issueGrant({ platforms: ['playwright'], days: 30, machine: MACHINE, privatePath: o.privatePath, now: NOW });
  const path = join(o.dir, 'grant.json'); writeFileSync(path, JSON.stringify(doc));
  const grant = loadOwnerGrant({ path, publicKey: o.publicKey, machine: MACHINE, now: NOW });
  assert.deepEqual(browserPlatformDecision('dragon', grant), { allowed: true, platform: 'dragon', grant_id: null });
  assert.equal(browserPlatformDecision('playwright', grant).grant_id, doc.grant.id);
  assert.equal(browserPlatformDecision('claude-in-chrome', grant).code, 'BROWSER_PLATFORM_NOT_GRANTED');
  assert.equal(browserPlatformDecision('selenium', grant).code, 'BROWSER_PLATFORM_UNKNOWN');
  const none = loadOwnerGrant({ path: join(o.dir, 'missing.json'), publicKey: o.publicKey, machine: MACHINE });
  assert.equal(browserPlatformDecision('playwright', none).reason, 'GRANT_NONE');
});

test('the machine fingerprint is stable and does not expose the hardware id', () => {
  const run = () => ({ stdout: '"IOPlatformUUID" = "12345678-AAAA-BBBB-CCCC-1234567890AB"' });
  const a = machineFingerprint({ platform: 'darwin', run }), b = machineFingerprint({ platform: 'darwin', run });
  assert.equal(a, b);
  assert.match(a, /^mfp-[a-f0-9]{32}$/);
  assert.ok(!a.includes('12345678'));
  assert.notEqual(a, machineFingerprint({ platform: 'darwin', run: () => ({ stdout: '"IOPlatformUUID" = "OTHER"' }) }));
});

test('the package ships no private key', () => {
  const pub = new URL('../../security/owner-grant-key.json', import.meta.url);
  if (existsSync(pub)) assert.doesNotMatch(readFileSync(pub, 'utf8'), /PRIVATE/);
});
