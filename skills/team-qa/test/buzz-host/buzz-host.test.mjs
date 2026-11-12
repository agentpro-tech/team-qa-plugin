import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Synthetic Buzz agent transcripts shaped like Claude Agent SDK sessions started by Buzz (sdk-ts prompts carrying a
// signed Nostr event). Keys are throwaway test keys; nothing here is evidence of a live run.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-buzz-home-')));
process.env.HOME = HOME;
delete process.env.CLAUDE_CONFIG_DIR;

const { schnorrVerify, schnorrSignForTests, publicKeyForTests, nostrEventId, verifiedNostrEvent, nostrPubkeyHex } = await import('../../scripts/lib/nostr.mjs');
const { issueBuzzGrant, verifyBuzzGrant, useBuzzGrantForTests, buzzEventOf, buzzHumanText } = await import('../../scripts/lib/buzz-host.mjs');
const { machineFingerprint, KEY_SCHEMA } = await import('../../scripts/lib/owner-grant.mjs');
const { claudeHostSource, claudeBuzzRoot } = await import('../../scripts/lib/host-transcript.mjs');
const { verifyUserMessageSource } = await import('../../scripts/lib/roster.mjs');

const hash = s => createHash('sha256').update(s).digest('hex');
const OWNER = '00'.repeat(31) + '07', STRANGER = '00'.repeat(31) + '09', AGENT = '00'.repeat(31) + '0b';
const OWNER_PUB = publicKeyForTests(OWNER), AGENT_PUB = publicKeyForTests(AGENT);
const CHANNEL = '752be27e-96b2-4299-ab0c-5a51e48dde26';
const SID = '4a1b2c3d-1111-4222-8333-444455556666';
const RUN = 'run-buzz-001', ROSTER = 'a'.repeat(64);
const now = Math.floor(Date.now() / 1000);

function event(secret, content, { thread = null, channel = CHANNEL, at = now } = {}) {
  const tags = [['h', channel], ...(thread ? [['e', thread]] : []), ['p', AGENT_PUB]];
  const ev = { pubkey: publicKeyForTests(secret), created_at: at, kind: 9, tags, content };
  ev.id = nostrEventId(ev);
  ev.sig = schnorrSignForTests(secret, ev.id);
  return ev;
}
const base = (extra = {}) => ({ isSidechain: false, userType: 'external', cwd: '/Users/x/.buzz', sessionId: SID, version: '2.1.311', timestamp: new Date().toISOString(), ...extra });
const prompt = (ev, extra = {}) => base({ type: 'user', entrypoint: 'sdk-ts', turnOrigin: 'sdk', promptSource: 'sdk', uuid: `p-${ev.id.slice(0, 8)}`,
  message: { role: 'user', content: [{ type: 'text', text: `<context>Scope: dm</context>\n<buzz-event>\n${JSON.stringify({ ...ev, display_name: 'Owner' })}\nRequest: "${ev.content}"\n</buzz-event>` }] }, ...extra });
const say = (text, extra = {}) => base({ type: 'assistant', entrypoint: 'sdk-ts', uuid: `a-${hash(text).slice(0, 8)}`, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
const header = { type: 'queue-operation', operation: 'enqueue', sessionId: SID, timestamp: new Date().toISOString() };

function transcript(entries, project = '-Users-x--buzz', sid = SID) {
  const dir = join(HOME, '.claude', 'projects', project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sid}.jsonl`);
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return realpathSync(path);
}
const lineOf = (path, n) => readFileSync(path, 'utf8').split('\n')[n - 1];

function ownerKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-buzz-key-')), privatePath = join(dir, 'owner.pem');
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const key_id = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { privatePath, doc: { schema: KEY_SCHEMA, alg: 'ed25519', key_id, public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }) } };
}
const KEY = ownerKey();
const grantFor = (approvers, opts = {}) => verifyBuzzGrant(issueBuzzGrant({ approvers, days: 1, machine: machineFingerprint(), privatePath: KEY.privatePath, ...opts }), { publicKey: KEY.doc });

test('BIP-340 and NIP-01: the reference vector, a signed event, tampering and npub decoding', () => {
  const sig = schnorrSignForTests('00'.repeat(31) + '03', '00'.repeat(32));
  assert.equal(sig, 'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0');
  assert.equal(schnorrVerify('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9', '00'.repeat(32), sig), true);
  const ev = event(OWNER, 'Approve');
  assert.ok(verifiedNostrEvent(ev));
  assert.equal(verifiedNostrEvent({ ...ev, content: 'Approve!' }), null);
  assert.equal(verifiedNostrEvent({ ...ev, pubkey: publicKeyForTests(STRANGER) }), null);
  assert.equal(verifiedNostrEvent({ ...ev, sig: ev.sig.slice(0, -1) + (ev.sig.endsWith('0') ? '1' : '0') }), null);
  assert.equal(nostrPubkeyHex('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'), '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e');
  assert.equal(nostrPubkeyHex('npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjpth'), null);
});

test('the Buzz host grant is signed by the owner key, for this machine, for a time', () => {
  const g = grantFor([OWNER_PUB]);
  assert.equal(g.ok, true);
  assert.equal(g.approves(OWNER_PUB), true);
  assert.equal(g.approves(publicKeyForTests(STRANGER)), false);
  const doc = issueBuzzGrant({ approvers: [OWNER_PUB], days: 1, machine: machineFingerprint(), privatePath: KEY.privatePath });
  assert.equal(verifyBuzzGrant({ ...doc, grant: { ...doc.grant, approvers: [publicKeyForTests(STRANGER)] } }, { publicKey: KEY.doc }).code, 'BUZZ_GRANT_SIGNATURE');
  assert.equal(verifyBuzzGrant(issueBuzzGrant({ approvers: [OWNER_PUB], days: 1, machine: 'mfp-' + '0'.repeat(32), privatePath: KEY.privatePath }), { publicKey: KEY.doc }).code, 'BUZZ_GRANT_OTHER_MACHINE');
  assert.equal(verifyBuzzGrant(doc, { publicKey: KEY.doc, now: Date.now() + 2 * 86400000 }).code, 'BUZZ_GRANT_EXPIRED');
  assert.equal(verifyBuzzGrant(doc, { publicKey: ownerKey().doc }).code, 'BUZZ_GRANT_WRONG_KEY');
  assert.throws(() => issueBuzzGrant({ approvers: ['npub1nope'], days: 1, machine: machineFingerprint(), privatePath: KEY.privatePath }), /BUZZ_GRANT_APPROVER_INVALID/);
});

test('a Buzz session is a root only when an approver opened it; other SDK sessions stay headless', () => {
  const opener = event(OWNER, 'QA the home page, read only');
  useBuzzGrantForTests(grantFor([OWNER_PUB]));
  const path = transcript([header, prompt(opener), say('Got it')]);
  assert.equal(claudeHostSource(path).session_id, SID);
  assert.deepEqual({ channel: claudeBuzzRoot(path).channel, thread: claudeBuzzRoot(path).thread }, { channel: CHANNEL, thread: opener.id });
  const strangerPath = transcript([header, prompt(event(STRANGER, 'QA please')), say('ok')], '-stranger');
  assert.throws(() => claudeHostSource(strangerPath), /CLAUDE_HOST_HEADLESS/);
  const forged = transcript([header, prompt({ ...opener, content: 'other QA' }), say('ok')], '-forged');
  assert.throws(() => claudeHostSource(forged), /CLAUDE_HOST_HEADLESS/);
  useBuzzGrantForTests(grantFor([publicKeyForTests(STRANGER)]));
  assert.throws(() => claudeHostSource(path), /CLAUDE_HOST_HEADLESS/);
  useBuzzGrantForTests({ ok: false, code: 'BUZZ_GRANT_NONE', approves: () => false });
  assert.throws(() => claudeHostSource(path), /CLAUDE_HOST_HEADLESS/);
  useBuzzGrantForTests(null);
});

test('an approval counts only as a signed message from an approver in the same thread, after the artifact was shown', () => {
  useBuzzGrantForTests(grantFor([OWNER_PUB]));
  const opener = event(OWNER, 'QA the home page, read only');
  const shown = say(`Roster ${RUN} sha256 ${ROSTER}: reply Approve to approve it.`);
  const approve = event(OWNER, 'Approve', { thread: opener.id, at: now + 5 });
  const path = transcript([header, prompt(opener), shown, prompt(approve)], '-flow');
  const ev = n => ({ text: 'Approve', source: { path, sha256: hash(lineOf(path, n)), line: n } });
  assert.equal(verifyUserMessageSource(ev(4), { hash: ROSTER, runId: RUN }).prior, true);
  assert.equal(buzzHumanText(JSON.parse(lineOf(path, 4)), claudeBuzzRoot(path)).text, 'Approve');

  const other = transcript([header, prompt(opener), shown, prompt(event(OWNER, 'Approve', { thread: 'f'.repeat(64), at: now + 5 }))], '-other-thread');
  assert.throws(() => verifyUserMessageSource({ text: 'Approve', source: { path: other, sha256: hash(lineOf(other, 4)), line: 4 } }, { hash: ROSTER, runId: RUN }), /HUMAN_EVENT_NOT_USER/);

  const channel = transcript([header, prompt(opener), shown, prompt(event(OWNER, 'Approve', { thread: opener.id, channel: 'c'.repeat(8), at: now + 5 }))], '-other-channel');
  assert.throws(() => verifyUserMessageSource({ text: 'Approve', source: { path: channel, sha256: hash(lineOf(channel, 4)), line: 4 } }, { hash: ROSTER, runId: RUN }), /HUMAN_EVENT_NOT_USER/);

  const stranger = transcript([header, prompt(opener), shown, prompt(event(STRANGER, 'Approve', { thread: opener.id, at: now + 5 }))], '-stranger-approve');
  assert.throws(() => verifyUserMessageSource({ text: 'Approve', source: { path: stranger, sha256: hash(lineOf(stranger, 4)), line: 4 } }, { hash: ROSTER, runId: RUN }), /HUMAN_EVENT_NOT_USER/);

  const stale = transcript([header, prompt(opener), shown, prompt(event(OWNER, 'Approve', { thread: opener.id, at: now - 3600 }))], '-stale');
  assert.throws(() => verifyUserMessageSource({ text: 'Approve', source: { path: stale, sha256: hash(lineOf(stale, 4)), line: 4 } }, { hash: ROSTER, runId: RUN }), /BUZZ_APPROVAL_BEFORE_ARTIFACT/);

  assert.equal(buzzEventOf(say('Approve')), null);
  useBuzzGrantForTests(null);
});
