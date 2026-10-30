// The owner's grant (BA public v1, O1). Team QA runs on Dragon only. A run may use another browser-control platform
// (an unpacked Dragon build, Claude in Chrome, Playwright…) only on a machine holding a grant signed with the owner's
// Ed25519 key. The private key never ships: it stays on the owner's machine outside git (~/.agentpro/keys); the
// package carries only the public key (security/owner-grant-key.json). Agents and users elsewhere cannot mint a
// grant, and a copied grant is refused on another machine. Code on someone else's machine can still be edited to
// skip this check; such a package then no longer matches its signed manifest, so its results are not official.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stableJson } from './core.mjs';

export const GRANT_SCHEMA = 'team-qa/owner-grant/v1';
export const KEY_SCHEMA = 'team-qa/owner-grant-key/v1';
export const PUBLIC_KEY_PATH = fileURLToPath(new URL('../../security/owner-grant-key.json', import.meta.url));
export const PLATFORMS = ['dragon-unpacked', 'claude-in-chrome', 'playwright', 'chrome-devtools', 'codex-browser'];
const MAX_DAYS = 366;

export const defaultPrivateKeyPath = (home = homedir()) => join(home, '.agentpro', 'keys', 'teamqa-owner-ed25519.pem');
export const defaultGrantPath = (env = process.env, home = homedir()) => env.TEAMQA_OWNER_GRANT || join(home, '.agentpro', 'teamqa', 'owner-grant.json');

const asPublic = key => (typeof key === 'object' && key?.type === 'public' ? key : createPublicKey(key));
const keyId = key => createHash('sha256').update(asPublic(key).export({ type: 'spki', format: 'der' })).digest('hex');

// A stable id for this machine that does not reveal the hardware UUID itself.
export function machineFingerprint({ platform = process.platform, run = spawnSync } = {}) {
  let raw = null;
  if (platform === 'darwin') {
    const r = run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
    raw = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(r.stdout || '')?.[1] ?? null;
  } else if (existsSync('/etc/machine-id')) raw = readFileSync('/etc/machine-id', 'utf8').trim();
  return 'mfp-' + createHash('sha256').update(`team-qa/machine/v1\n${raw ?? `${hostname()}\n${homedir()}`}`).digest('hex').slice(0, 32);
}

export function generateOwnerKey({ privatePath = defaultPrivateKeyPath(), publicPath = PUBLIC_KEY_PATH } = {}) {
  if (existsSync(privatePath)) throw new Error(`GRANT_KEY_EXISTS: ${privatePath} already holds the owner key; it is never overwritten`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  const doc = { schema: KEY_SCHEMA, alg: 'ed25519', key_id: keyId(publicKey), public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }) };
  writeFileSync(publicPath, JSON.stringify(doc, null, 2) + '\n');
  return doc;
}

export function readPublicKey(path = PUBLIC_KEY_PATH) {
  if (!existsSync(path)) return null;
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (doc.schema !== KEY_SCHEMA || doc.alg !== 'ed25519' || typeof doc.public_key_pem !== 'string' || keyId(doc.public_key_pem) !== doc.key_id) throw new Error('GRANT_PUBLIC_KEY_INVALID');
  return doc;
}

export function issueGrant({ platforms, days, machine, runId = null, note = '', privatePath = defaultPrivateKeyPath(), now = Date.now(), id = 'g-' + randomBytes(6).toString('hex') } = {}) {
  if (!Array.isArray(platforms) || !platforms.length || platforms.some(p => !PLATFORMS.includes(p))) throw new Error(`GRANT_PLATFORM_UNKNOWN: use ${PLATFORMS.join(', ')}`);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`GRANT_DAYS_INVALID: 1..${MAX_DAYS}`);
  if (!/^mfp-[a-f0-9]{32}$/.test(machine || '')) throw new Error('GRANT_MACHINE_INVALID: give a machine fingerprint (teamqa grant fingerprint)');
  if (!existsSync(privatePath)) throw new Error(`GRANT_KEY_MISSING: the owner key is not on this machine (${privatePath})`);
  const privateKey = createPrivateKey(readFileSync(privatePath));
  const grant = {
    id, issued_at: new Date(now).toISOString(), expires_at: new Date(now + days * 86400000).toISOString(), machine,
    platforms: [...new Set(platforms)].sort(), scope: runId ? { kind: 'run', run_id: String(runId) } : { kind: 'all' }, note: String(note).slice(0, 200),
  };
  return { schema: GRANT_SCHEMA, key_id: keyId(createPublicKey(privateKey)), grant, signature: sign(null, Buffer.from(stableJson(grant)), privateKey).toString('base64') };
}

// The verdict on a grant file: { ok, grant, allows(platform) } or { ok:false, code }. No grant is not an error:
// it simply allows nothing.
export function verifyGrant(doc, { publicKey = readPublicKey(), machine = machineFingerprint(), now = Date.now(), runId = null } = {}) {
  const deny = code => ({ ok: false, code, allows: () => false });
  if (!doc) return { ok: false, code: 'GRANT_NONE', allows: () => false };
  if (!publicKey) return deny('GRANT_NO_PUBLIC_KEY');
  if (doc.schema !== GRANT_SCHEMA || !doc.grant || typeof doc.signature !== 'string') return deny('GRANT_SHAPE');
  if (doc.key_id !== publicKey.key_id) return deny('GRANT_WRONG_KEY');
  let good = false;
  try { good = verify(null, Buffer.from(stableJson(doc.grant)), createPublicKey(publicKey.public_key_pem), Buffer.from(doc.signature, 'base64')); } catch { good = false; }
  if (!good) return deny('GRANT_SIGNATURE');
  const g = doc.grant, issued = Date.parse(g.issued_at), expires = Date.parse(g.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 300000) return deny('GRANT_TIME');
  if (now >= expires) return deny('GRANT_EXPIRED');
  if (g.machine !== machine) return deny('GRANT_OTHER_MACHINE');
  if (g.scope?.kind === 'run' && g.scope.run_id !== runId) return deny('GRANT_OTHER_RUN');
  if (!Array.isArray(g.platforms) || g.platforms.some(p => !PLATFORMS.includes(p))) return deny('GRANT_SHAPE');
  return { ok: true, grant: g, allows: platform => g.platforms.includes(platform) };
}

export function loadOwnerGrant({ path = defaultGrantPath(), ...options } = {}) {
  if (!existsSync(path)) return verifyGrant(null, options);
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { return { ok: false, code: 'GRANT_SHAPE', allows: () => false }; }
  return verifyGrant(doc, options);
}

// For a run that wants a non-Dragon platform: either the grant allows it, or the run stops with a named reason.
export function browserPlatformDecision(platform, grant = loadOwnerGrant()) {
  if (!platform || platform === 'dragon') return { allowed: true, platform: 'dragon', grant_id: null };
  if (!PLATFORMS.includes(platform)) return { allowed: false, code: 'BROWSER_PLATFORM_UNKNOWN', platform };
  return grant.ok && grant.allows(platform) ? { allowed: true, platform, grant_id: grant.grant.id }
    : { allowed: false, code: 'BROWSER_PLATFORM_NOT_GRANTED', platform, reason: grant.code ?? 'GRANT_NOT_FOR_PLATFORM' };
}

export function grantCommand(action, args = []) {
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (action === 'fingerprint') { console.log(machineFingerprint()); return; }
  if (action === 'keygen') { const doc = generateOwnerKey(); console.log(`verdict=pass GRANT_KEYGEN key_id=${doc.key_id} public=${PUBLIC_KEY_PATH}`); return; }
  if (action === 'issue') {
    const machine = args.includes('--this-machine') ? machineFingerprint() : flag('--machine');
    const doc = issueGrant({ platforms: String(flag('--platforms') || '').split(',').filter(Boolean), days: Number(flag('--days')), machine, runId: flag('--run') ?? null, note: flag('--note') ?? '' });
    const out = flag('--out') || defaultGrantPath();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    console.log(`verdict=pass GRANT_ISSUED id=${doc.grant.id} platforms=${doc.grant.platforms.join(',')} expires=${doc.grant.expires_at} path=${out}`);
    return;
  }
  if (action === 'show') {
    const v = loadOwnerGrant({ path: flag('--file') || defaultGrantPath(), runId: flag('--run') ?? null });
    console.log(v.ok ? `verdict=pass GRANT id=${v.grant.id} platforms=${v.grant.platforms.join(',')} expires=${v.grant.expires_at}` : `verdict=ungraded GRANT code=${v.code}`);
    if (!v.ok) process.exitCode = 3;
    return;
  }
  console.log('teamqa grant fingerprint | keygen | issue --platforms <a,b> --days <n> (--this-machine | --machine <mfp-…>) [--run <id>] [--note <text>] [--out <file>] | show [--file <grant.json>] [--run <id>]');
  process.exitCode = 2;
}
