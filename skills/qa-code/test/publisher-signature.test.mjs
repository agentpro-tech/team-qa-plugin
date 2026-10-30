import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPublisherKey, SIGNED_FIELDS, verifySignedRuntime } from '../scripts/lib/publisher-signature.mjs';
import { verifyTeamQaReviewProof } from '../scripts/lib/teamqa-review-proof.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
function key() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: { schema: 'team-qa/owner-grant-key/v1', alg: 'ed25519', key_id: sha(publicKey.export({ type: 'spki', format: 'der' })), public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }) } };
}
const OWNER = key(), OTHER = key();
// A runtime the way the Team QA suite installer leaves it: SOURCE.json, the manifest, and the signed entry beside them.
function runtime(signer = OWNER, { skill = 'team-qa' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-code-signed-runtime-')));
  const manifest = '{"files":[]}\n';
  writeFileSync(join(root, 'package-manifest.json'), manifest);
  const source = { schema: 'agentpro/skill-source/v1', skill, version: '1.14.0', repo: `https://github.com/agentpro-tech/${skill}.git`, commit: 'a'.repeat(40), tree: 'b'.repeat(40), manifest_sha256: sha(manifest), package_sha256: 'c'.repeat(64) };
  writeFileSync(join(root, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n');
  const signed = Object.fromEntries(SIGNED_FIELDS.map(k => [k, source[k]]));
  writeFileSync(join(root, 'release-signature.json'), JSON.stringify({ schema: 'agentpro/release-signature/v1', key_id: signer.publicKey.key_id, signed,
    signature: sign(null, Buffer.from(JSON.stringify(signed, null, 2) + '\n'), signer.privateKey).toString('base64') }, null, 2) + '\n');
  return { root, source };
}

test('the shipped publisher key is well formed', () => {
  const doc = readPublisherKey();
  assert.ok(doc, 'security/publisher-key.json ships with QA Code');
  assert.match(doc.key_id, /^[a-f0-9]{64}$/);
});

test('a runtime without a signature keeps the git route', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-code-unsigned-')));
  assert.equal(verifySignedRuntime(root, { publicKey: OWNER.publicKey }), null);
});

test('a signed runtime passes; another key, an edited SOURCE or manifest, or another skill does not', () => {
  const ok = runtime();
  assert.deepEqual(verifySignedRuntime(ok.root, { skill: 'team-qa', publicKey: OWNER.publicKey }), { provenance: 'signed', key_id: OWNER.publicKey.key_id, commit: 'a'.repeat(40) });
  assert.throws(() => verifySignedRuntime(runtime(OTHER).root, { publicKey: OWNER.publicKey }), /RELEASE_SIGNATURE_WRONG_KEY/);
  const forged = runtime(OTHER), doc = JSON.parse(readFileSync(join(forged.root, 'release-signature.json'), 'utf8'));
  writeFileSync(join(forged.root, 'release-signature.json'), JSON.stringify({ ...doc, key_id: OWNER.publicKey.key_id }));
  assert.throws(() => verifySignedRuntime(forged.root, { publicKey: OWNER.publicKey }), /RELEASE_SIGNATURE_INVALID/);
  const edited = runtime();
  writeFileSync(join(edited.root, 'SOURCE.json'), JSON.stringify({ ...edited.source, commit: 'd'.repeat(40) }));
  assert.throws(() => verifySignedRuntime(edited.root, { publicKey: OWNER.publicKey }), /RELEASE_SIGNATURE_SOURCE_DRIFT/);
  const drift = runtime();
  writeFileSync(join(drift.root, 'package-manifest.json'), '{"files":["x"]}\n');
  assert.throws(() => verifySignedRuntime(drift.root, { publicKey: OWNER.publicKey }), /RELEASE_SIGNATURE_MANIFEST_DRIFT/);
  assert.throws(() => verifySignedRuntime(runtime(OWNER, { skill: 'qa-code' }).root, { skill: 'team-qa', publicKey: OWNER.publicKey }), /RELEASE_SIGNATURE_OTHER_SKILL/);
});

test('a Team QA runtime signed by someone else is refused before any of its code runs', () => {
  const { root } = runtime(OTHER), marker = join(root, 'untrusted-code-executed');
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  // Deliberate attacker code, never a test verifier.
  writeFileSync(join(root, 'scripts/package-tool.mjs'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'x');`);
  writeFileSync(join(root, 'scripts/lib/roster.mjs'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'x');`);
  assert.throws(() => verifyTeamQaReviewProof({ proofPath: join(root, 'absent.json'), runtimePath: root, repo: root, base: 'a', head: 'b', provider: 'openai', model: 'm', reasoning: 'high' }),
    /TEAMQA_RELEASE_SIGNATURE_INVALID:RELEASE_SIGNATURE_WRONG_KEY/);
  assert.equal(existsSync(marker), false);
});

test('the review proof checks the signature first, keeps git only for unsigned runtimes, and runs its own package tool (static)', () => {
  const source = readFileSync(new URL('../scripts/lib/teamqa-review-proof.mjs', import.meta.url), 'utf8');
  const signedAt = source.indexOf('verifySignedRuntime(runtime'), gitAt = source.indexOf("spawnSync('git'"), toolAt = source.indexOf("[packageTool,'verify-runtime'"), rosterAt = source.indexOf("'roster.mjs'");
  assert.ok(signedAt > 0 && signedAt < gitAt && gitAt < toolAt && toolAt < rosterAt);
  assert.match(source, /if\(!signed\)\{/);
});
