// User licences (BA public v1, S1). Team QA is free for now, but every user can already hold a licence signed with
// the owner's key: e-mail, plan (today "free"), issue and expiry dates. A suite or channel that says
// license_required is installed or updated only with a valid licence; nothing checks a licence during a run, so an
// expiry never cuts a run short. Moving to paid plans later changes how licences are issued and which plan they
// name, not Team QA's code.
import { createPrivateKey, createPublicKey, createHash, randomBytes, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { stableJson } from './core.mjs';
import { defaultPrivateKeyPath, readPublicKey, PUBLIC_KEY_PATH } from './owner-grant.mjs';

export const LICENSE_SCHEMA = 'agentpro/teamqa-license/v1';
export const PLANS = ['free'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const keyIdOf = key => createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex');
export const defaultLicensePath = (env = process.env, home = homedir()) => env.TEAMQA_LICENSE || join(home, '.agentpro', 'teamqa', 'license.json');

export function issueLicense({ email, plan = 'free', days, privatePath = defaultPrivateKeyPath(), now = Date.now(), id = 'lic-' + randomBytes(6).toString('hex') } = {}) {
  if (!EMAIL.test(String(email || ''))) throw new Error('LICENSE_EMAIL_INVALID');
  if (!PLANS.includes(plan)) throw new Error(`LICENSE_PLAN_UNKNOWN: ${PLANS.join(', ')}`);
  if (!Number.isInteger(days) || days < 1 || days > 3660) throw new Error('LICENSE_DAYS_INVALID: 1..3660');
  if (!existsSync(privatePath)) throw new Error(`LICENSE_KEY_MISSING: ${privatePath}`);
  const key = createPrivateKey(readFileSync(privatePath));
  const license = { id, email: String(email).trim().toLowerCase(), plan, issued_at: new Date(now).toISOString(), expires_at: new Date(now + days * 86400000).toISOString() };
  return { schema: LICENSE_SCHEMA, key_id: keyIdOf(key), license, signature: sign(null, Buffer.from(stableJson(license)), key).toString('base64') };
}

export function verifyLicense(doc, { publicKey = readPublicKey(PUBLIC_KEY_PATH), now = Date.now() } = {}) {
  const no = code => ({ ok: false, code });
  if (!doc) return no('LICENSE_NONE');
  if (!publicKey) return no('LICENSE_NO_PUBLIC_KEY');
  if (doc.schema !== LICENSE_SCHEMA || !doc.license || typeof doc.signature !== 'string') return no('LICENSE_SHAPE');
  if (doc.key_id !== publicKey.key_id) return no('LICENSE_WRONG_KEY');
  let good = false;
  try { good = verify(null, Buffer.from(stableJson(doc.license)), createPublicKey(publicKey.public_key_pem), Buffer.from(doc.signature, 'base64')); } catch { good = false; }
  if (!good) return no('LICENSE_SIGNATURE');
  const l = doc.license;
  if (!PLANS.includes(l.plan) || !EMAIL.test(l.email || '')) return no('LICENSE_SHAPE');
  if (!(Date.parse(l.issued_at) <= now + 300000)) return no('LICENSE_TIME');
  if (!(now < Date.parse(l.expires_at))) return no('LICENSE_EXPIRED');
  return { ok: true, license: l };
}

export function loadLicense({ path = defaultLicensePath(), ...options } = {}) {
  if (!existsSync(path)) return verifyLicense(null, options);
  try { return verifyLicense(JSON.parse(readFileSync(path, 'utf8')), options); } catch { return { ok: false, code: 'LICENSE_SHAPE' }; }
}

export function activateLicense(file, { path = defaultLicensePath(), ...options } = {}) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const v = verifyLicense(doc, options);
  if (!v.ok) throw new Error(v.code);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  return v;
}

export function licenseCommand(action, args = []) {
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (action === 'issue') {
    const doc = issueLicense({ email: flag('--email'), plan: flag('--plan') || 'free', days: Number(flag('--days')) });
    const out = flag('--out'); if (!out) throw new Error('LICENSE_OUT_REQUIRED: --out <file>');
    writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    console.log(`verdict=pass LICENSE_ISSUED id=${doc.license.id} plan=${doc.license.plan} expires=${doc.license.expires_at} path=${out}`);
    return;
  }
  if (action === 'activate') {
    const v = activateLicense(args.find(a => !a.startsWith('--')) || flag('--file'));
    console.log(`verdict=pass LICENSE_ACTIVE id=${v.license.id} plan=${v.license.plan} expires=${v.license.expires_at}`);
    return;
  }
  if (action === 'show') {
    const v = loadLicense();
    console.log(v.ok ? `verdict=pass LICENSE id=${v.license.id} plan=${v.license.plan} expires=${v.license.expires_at}` : `verdict=ungraded LICENSE code=${v.code}`);
    if (!v.ok) process.exitCode = 3;
    return;
  }
  console.log('teamqa license issue --email <e-mail> --days <n> [--plan free] --out <file> (owner) | activate <license.json> | show');
  process.exitCode = 2;
}
