// Team QA public v1 (T4): on a machine without the owner's git repositories, an installed Team QA proves where it came
// from by the publisher's signature instead of a canonical git checkout. The Team QA suite installer writes
// release-signature.json beside the installed skill; it signs the skill, version, commit, tree, repo and the manifest
// and package hashes with the owner's Ed25519 key. This file checks that signature with QA GUI's own copy of the
// public key (security/publisher-key.json) and never runs code from the runtime being checked. The file-by-file check
// against the manifest stays with QA GUI's own package-tool.mjs verify-runtime, which the caller runs next.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLISHER_KEY_PATH = fileURLToPath(new URL('../../security/publisher-key.json', import.meta.url));
export const RELEASE_SIGNATURE_SCHEMA = 'agentpro/release-signature/v1';
export const SIGNED_FIELDS = ['skill', 'version', 'commit', 'tree', 'repo', 'manifest_sha256', 'package_sha256'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const keyIdOf = pem => sha256(createPublicKey(pem).export({ type: 'spki', format: 'der' }));

export function readPublisherKey(path = PUBLISHER_KEY_PATH) {
  if (!existsSync(path)) return null;
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (doc.schema !== 'team-qa/owner-grant-key/v1' || doc.alg !== 'ed25519' || typeof doc.public_key_pem !== 'string' || keyIdOf(doc.public_key_pem) !== doc.key_id) throw new Error('PUBLISHER_KEY_INVALID');
  return doc;
}

// null when the runtime carries no signature (the caller keeps its git route); otherwise the verdict or a thrown code.
export function verifySignedRuntime(root, { skill = null, publicKey = readPublisherKey() } = {}) {
  const file = join(root, 'release-signature.json');
  if (!existsSync(file)) return null;
  if (!publicKey) throw new Error('PUBLISHER_KEY_MISSING');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc?.schema !== RELEASE_SIGNATURE_SCHEMA || !doc.signed || typeof doc.signature !== 'string') throw new Error('RELEASE_SIGNATURE_SHAPE');
  if (doc.key_id !== publicKey.key_id) throw new Error('RELEASE_SIGNATURE_WRONG_KEY');
  const signed = {};
  for (const k of SIGNED_FIELDS) {
    if (typeof doc.signed[k] !== 'string' || !doc.signed[k]) throw new Error('RELEASE_SIGNATURE_SHAPE');
    signed[k] = doc.signed[k];
  }
  let good = false;
  try { good = verify(null, Buffer.from(`${JSON.stringify(signed, null, 2)}\n`), createPublicKey(publicKey.public_key_pem), Buffer.from(doc.signature, 'base64')); } catch { good = false; }
  if (!good) throw new Error('RELEASE_SIGNATURE_INVALID');
  if (skill && signed.skill !== skill) throw new Error('RELEASE_SIGNATURE_OTHER_SKILL');
  const source = JSON.parse(readFileSync(join(root, 'SOURCE.json'), 'utf8'));
  for (const k of SIGNED_FIELDS) if (source[k] !== signed[k]) throw new Error('RELEASE_SIGNATURE_SOURCE_DRIFT');
  if (sha256(readFileSync(join(root, 'package-manifest.json'))) !== signed.manifest_sha256) throw new Error('RELEASE_SIGNATURE_MANIFEST_DRIFT');
  return { provenance: 'signed', key_id: publicKey.key_id, commit: signed.commit };
}
