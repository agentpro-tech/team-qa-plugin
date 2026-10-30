// Publisher signatures for the Team QA suite (BA public v1, R1 and T4). The suite builder signs each skill's release
// entry (skill, version, commit, manifest and package hashes) with the owner's Ed25519 key; the installer writes the
// signed entry beside the installed skill as release-signature.json. A machine without the owner's git repositories
// then proves where an installed skill came from by that signature and the files it still matches, instead of by a
// canonical git checkout it cannot have.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stableJson } from './core.mjs';
import { readPublicKey, PUBLIC_KEY_PATH, defaultPrivateKeyPath } from './owner-grant.mjs';

export const RELEASE_SIGNATURE_SCHEMA = 'agentpro/release-signature/v1';
export const SIGNED_FIELDS = ['skill', 'version', 'commit', 'tree', 'repo', 'manifest_sha256', 'package_sha256'];
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const keyIdOf = pem => sha256(createPublicKey(pem).export({ type: 'spki', format: 'der' }));

export function releaseEntry(source) {
  const entry = {};
  for (const k of SIGNED_FIELDS) {
    if (typeof source?.[k] !== 'string' || !source[k]) throw new Error(`RELEASE_ENTRY_FIELD: ${k}`);
    entry[k] = source[k];
  }
  return entry;
}

export function signReleaseEntry(entry, { privatePath = defaultPrivateKeyPath() } = {}) {
  if (!existsSync(privatePath)) throw new Error(`RELEASE_KEY_MISSING: ${privatePath}`);
  const key = createPrivateKey(readFileSync(privatePath));
  const signed = releaseEntry(entry);
  return { schema: RELEASE_SIGNATURE_SCHEMA, key_id: keyIdOf(key), signed, signature: sign(null, Buffer.from(stableJson(signed)), key).toString('base64') };
}

export function verifyReleaseSignature(doc, { publicKey = readPublicKey(PUBLIC_KEY_PATH) } = {}) {
  if (!publicKey) throw new Error('RELEASE_NO_PUBLIC_KEY');
  if (doc?.schema !== RELEASE_SIGNATURE_SCHEMA || !doc.signed || typeof doc.signature !== 'string') throw new Error('RELEASE_SIGNATURE_SHAPE');
  if (doc.key_id !== publicKey.key_id) throw new Error('RELEASE_SIGNATURE_WRONG_KEY');
  // The bytes signed are the fields in SIGNED_FIELDS order (QA GUI's publisher-signature.mjs checks the same bytes).
  let signed; try { signed = releaseEntry(doc.signed); } catch { throw new Error('RELEASE_SIGNATURE_SHAPE'); }
  let good = false;
  try { good = verify(null, Buffer.from(stableJson(signed)), createPublicKey(publicKey.public_key_pem), Buffer.from(doc.signature, 'base64')); } catch { good = false; }
  if (!good) throw new Error('RELEASE_SIGNATURE_INVALID');
  return signed;
}

// An installed skill directory: its SOURCE.json and package-manifest.json must be exactly what the publisher signed.
// The file-by-file check against the manifest stays with package-tool.mjs verify-runtime, which every caller runs.
export function verifyInstalledRelease(root, { publicKey = readPublicKey(PUBLIC_KEY_PATH), skill = null } = {}) {
  const path = join(root, 'release-signature.json');
  if (!existsSync(path)) throw new Error('RELEASE_SIGNATURE_MISSING');
  const entry = verifyReleaseSignature(JSON.parse(readFileSync(path, 'utf8')), { publicKey });
  const source = JSON.parse(readFileSync(join(root, 'SOURCE.json'), 'utf8'));
  if (skill && entry.skill !== skill) throw new Error('RELEASE_SIGNATURE_OTHER_SKILL');
  for (const k of SIGNED_FIELDS) if (source[k] !== entry[k]) throw new Error(`RELEASE_SIGNATURE_SOURCE_DRIFT: ${k}`);
  if (sha256(readFileSync(join(root, 'package-manifest.json'))) !== entry.manifest_sha256) throw new Error('RELEASE_SIGNATURE_MANIFEST_DRIFT');
  return { provenance: 'signed', key_id: publicKey.key_id, entry };
}
