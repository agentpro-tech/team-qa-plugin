// Nostr event checks for the Buzz host (Team QA 1.17.0). A Buzz agent session receives each human message as a
// signed Nostr event (NIP-01). Team QA trusts such a message only when the event id is the hash of its own fields and
// the BIP-340 Schnorr signature over secp256k1 holds for its pubkey: an agent can copy a message into its transcript,
// but it cannot write one in the owner's name. Pure JavaScript, no dependency.
import { createHash } from 'node:crypto';

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const HEX64 = /^[0-9a-f]{64}$/, HEX128 = /^[0-9a-f]{128}$/;

const mod = (a, m = P) => ((a % m) + m) % m;
function powMod(b, e, m) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
const inv = a => powMod(a, P - 2n, P);
const big = hex => BigInt('0x' + hex);
const hex32 = n => n.toString(16).padStart(64, '0');

// Points in Jacobian coordinates [X, Y, Z]; null is the point at infinity.
function double(p) {
  if (!p) return null;
  const [X, Y, Z] = p;
  if (Y === 0n) return null;
  const S = mod(4n * X * Y * Y), M = mod(3n * X * X), X3 = mod(M * M - 2n * S);
  return [X3, mod(M * (S - X3) - 8n * Y * Y * Y * Y), mod(2n * Y * Z)];
}
function add(p, q) {
  if (!p) return q; if (!q) return p;
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q;
  const Z1Z1 = mod(Z1 * Z1), Z2Z2 = mod(Z2 * Z2);
  const U1 = mod(X1 * Z2Z2), U2 = mod(X2 * Z1Z1), S1 = mod(Y1 * Z2 * Z2Z2), S2 = mod(Y2 * Z1 * Z1Z1);
  if (U1 === U2) return S1 === S2 ? double(p) : null;
  const H = mod(U2 - U1), R = mod(S2 - S1), HH = mod(H * H), HHH = mod(H * HH), V = mod(U1 * HH);
  const X3 = mod(R * R - HHH - 2n * V);
  return [X3, mod(R * (V - X3) - S1 * HHH), mod(H * Z1 * Z2)];
}
function mul(p, k) { let r = null; for (let q = p; k > 0n; k >>= 1n, q = double(q)) if (k & 1n) r = add(r, q); return r; }
function affine(p) { if (!p) return null; const zi = inv(p[2]), zi2 = mod(zi * zi); return [mod(p[0] * zi2), mod(p[1] * zi2 * zi)]; }
const jac = ([x, y]) => [x, y, 1n];

function liftX(x) {
  if (x >= P) return null;
  const c = mod(x * x * x + 7n), y = powMod(c, (P + 1n) / 4n, P);
  if (mod(y * y) !== c) return null;
  return [x, (y & 1n) ? P - y : y];
}
const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
function taggedHash(tag, ...parts) { const t = sha256(Buffer.from(tag, 'utf8')); return sha256(t, t, ...parts); }

// BIP-340 verification. Inputs are lowercase hex: a 32-byte x-only public key, a 32-byte message, a 64-byte signature.
export function schnorrVerify(pubkey, message, signature) {
  if (!HEX64.test(pubkey) || !HEX64.test(message) || !HEX128.test(signature)) return false;
  const point = liftX(big(pubkey));
  if (!point) return false;
  const r = big(signature.slice(0, 64)), s = big(signature.slice(64));
  if (r >= P || s >= N) return false;
  const e = mod(big(taggedHash('BIP0340/challenge', Buffer.from(signature.slice(0, 64), 'hex'), Buffer.from(pubkey, 'hex'),
    Buffer.from(message, 'hex')).toString('hex')), N);
  const R = affine(add(mul(jac(G), s), mul(jac(point), mod(N - e, N))));
  return Boolean(R) && (R[1] & 1n) === 0n && R[0] === r;
}

// BIP-340 signing, for test fixtures only: Team QA never holds a person's key.
export function schnorrSignForTests(secret, message, aux = '00'.repeat(32)) {
  const d0 = big(secret);
  if (d0 <= 0n || d0 >= N) throw new Error('NOSTR_TEST_KEY_INVALID');
  const pub = affine(mul(jac(G), d0)), d = (pub[1] & 1n) ? N - d0 : d0;
  const t = big(taggedHash('BIP0340/aux', Buffer.from(aux, 'hex')).toString('hex')) ^ d;
  const k0 = mod(big(taggedHash('BIP0340/nonce', Buffer.from(hex32(t), 'hex'), Buffer.from(hex32(pub[0]), 'hex'),
    Buffer.from(message, 'hex')).toString('hex')), N);
  if (k0 === 0n) throw new Error('NOSTR_TEST_NONCE');
  const R = affine(mul(jac(G), k0)), k = (R[1] & 1n) ? N - k0 : k0;
  const e = mod(big(taggedHash('BIP0340/challenge', Buffer.from(hex32(R[0]), 'hex'), Buffer.from(hex32(pub[0]), 'hex'),
    Buffer.from(message, 'hex')).toString('hex')), N);
  return hex32(R[0]) + hex32(mod(k + e * d, N));
}
export function publicKeyForTests(secret) { return hex32(affine(mul(jac(G), big(secret)))[0]); }

// NIP-01: the id is the SHA-256 of the serialized [0, pubkey, created_at, kind, tags, content].
export function nostrEventId(ev) {
  return sha256(Buffer.from(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]), 'utf8')).toString('hex');
}

const isTags = tags => Array.isArray(tags) && tags.every(t => Array.isArray(t) && t.length > 0 && t.every(v => typeof v === 'string'));

// The checked event, reduced to its signed fields, or null when any field, the id or the signature is wrong.
export function verifiedNostrEvent(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null;
  const { id, pubkey, created_at, kind, tags, content, sig } = ev;
  if (!HEX64.test(id ?? '') || !HEX64.test(pubkey ?? '') || !HEX128.test(sig ?? '')) return null;
  if (!Number.isSafeInteger(created_at) || created_at < 0 || !Number.isSafeInteger(kind) || kind < 0) return null;
  if (!isTags(tags) || typeof content !== 'string') return null;
  const signed = { id, pubkey, created_at, kind, tags, content, sig };
  if (nostrEventId(signed) !== id || !schnorrVerify(pubkey, id, sig)) return null;
  return signed;
}

// NIP-19 npub → hex (bech32, no checksum shortcuts). Hex input is returned lowercased.
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]; }
  return chk >>> 0;
}
export function nostrPubkeyHex(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (HEX64.test(text)) return text;
  const m = /^(npub)1([qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,})$/.exec(text);
  if (!m) return null;
  const data = [...m[2]].map(c => BECH32.indexOf(c));
  const expanded = [...[...m[1]].map(c => c.charCodeAt(0) >> 5), 0, ...[...m[1]].map(c => c.charCodeAt(0) & 31)];
  if (bech32Polymod([...expanded, ...data]) !== 1) return null;
  let acc = 0, bits = 0; const out = [];
  for (const v of data.slice(0, -6)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
  if (bits >= 5 || (acc & ((1 << bits) - 1))) return null;
  const hex = Buffer.from(out).toString('hex');
  return HEX64.test(hex) ? hex : null;
}
