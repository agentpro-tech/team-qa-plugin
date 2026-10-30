// What this package needs from Dragon, read from scripts/requirements.json (BA public v1, T1). It sits under scripts/
// so every copy of the code (mutation and acceptance harnesses copy scripts/) carries it.
// Team QA relies only on what the public Chrome Web Store build of Dragon has: a minimum bridge and extension
// version below the next major, the RPCs it calls, and, when the bridge reports them, a Store install. The Store
// updates the extension on its own, so no exact version or file hash of a Dragon release is pinned here; a newer
// minor or patch release keeps working, an older one is refused with the update it needs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REQUIREMENTS_PATH = fileURLToPath(new URL('../requirements.json', import.meta.url));
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

export function parseVersion(value) {
  const m = VERSION.exec(String(value ?? '').trim());
  return m ? m.slice(1, 4).map(Number) : null;
}

// Numeric compare of major.minor.patch; a pre-release or build suffix is ignored (1.6.9-qa.991cf5d is 1.6.9).
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function inRange(version, { min, below } = {}) {
  if (!parseVersion(version)) return 'invalid';
  if (min && compareVersions(version, min) < 0) return 'old';
  if (below && compareVersions(version, below) >= 0) return 'unsupported';
  return 'ok';
}

function range(r, label) {
  if (!r || typeof r !== 'object' || !parseVersion(r.min) || (r.below !== undefined && !parseVersion(r.below))
    || (r.below !== undefined && compareVersions(r.min, r.below) >= 0)) throw new Error(`REQUIREMENTS_INVALID: ${label}`);
  return r;
}

export function validateRequirements(doc) {
  if (!doc || doc.schema !== 'agentpro/skill-requirements/v1' || typeof doc.skill !== 'string' || !doc.skill) throw new Error('REQUIREMENTS_INVALID: schema');
  if (!Array.isArray(doc.platforms) || !doc.platforms.length || doc.platforms.some(p => typeof p !== 'string')) throw new Error('REQUIREMENTS_INVALID: platforms');
  range(doc.node, 'node');
  const d = doc.dragon;
  if (!d || typeof d !== 'object') throw new Error('REQUIREMENTS_INVALID: dragon');
  range(d.bridge, 'dragon.bridge');
  range(d.extension, 'dragon.extension');
  if (!Array.isArray(d.extension.store_ids) || d.extension.store_ids.some(id => !/^[a-p]{32}$/.test(id))) throw new Error('REQUIREMENTS_INVALID: dragon.extension.store_ids');
  if (!Array.isArray(d.rpc) || d.rpc.some(m => typeof m !== 'string' || !m)) throw new Error('REQUIREMENTS_INVALID: dragon.rpc');
  if (typeof d.store_url !== 'string' || !/^https:\/\/chromewebstore\.google\.com\/detail\//.test(d.store_url)) throw new Error('REQUIREMENTS_INVALID: dragon.store_url');
  if (d.runtime !== undefined && (typeof d.runtime?.public_key_pem !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(d.runtime.fingerprint || ''))) throw new Error('REQUIREMENTS_INVALID: dragon.runtime');
  for (const [name, r] of Object.entries(doc.skills || {})) range(r, `skills.${name}`);
  return doc;
}

let cached = null;
export function readRequirements(path = REQUIREMENTS_PATH) {
  if (path === REQUIREMENTS_PATH && cached) return cached;
  const doc = validateRequirements(JSON.parse(readFileSync(path, 'utf8')));
  if (path === REQUIREMENTS_PATH) cached = doc;
  return doc;
}

// The verdict on one /status body. ok:false carries a code, a one-line detail and the action that fixes it, so
// the preflight, the QA hook and `teamqa doctor` all say the same thing. A bridge and an extension of different
// versions are fine as long as each is inside its range: the bridge serves an older extension (versionMatch is
// informational in Dragon since 1.6.7).
export function dragonStatusVerdict(status, req = readRequirements().dragon, { ownerGrant = null } = {}) {
  const no = (code, detail, action) => ({ ok: false, code, detail, action });
  if (!status || typeof status !== 'object' || status.ok !== true) return no('DRAGON_STATUS', 'the bridge /status body is not ok:true', 'install_runtime');
  if (status.error) return no('DRAGON_STATUS', `the bridge reports an error: ${String(status.error).slice(0, 160)}`, 'install_runtime');
  const bridge = inRange(status.bridgeVersion, req.bridge);
  if (bridge === 'invalid') return no('DRAGON_VERSION', `bridgeVersion ${JSON.stringify(status.bridgeVersion)} is not a version`, 'install_runtime');
  if (bridge === 'old') return no('DRAGON_RUNTIME_OLD', `Dragon runtime ${status.bridgeVersion} is older than ${req.bridge.min}`, 'update_runtime');
  if (bridge === 'unsupported') return no('DRAGON_RUNTIME_UNSUPPORTED', `Dragon runtime ${status.bridgeVersion} is not supported by this Team QA (below ${req.bridge.below})`, 'update_teamqa');
  const ext = status.extension;
  if (!ext || typeof ext !== 'object' || !ext.version) return no('DRAGON_EXTENSION_MISSING', 'no Dragon extension is connected to the bridge', 'install_extension');
  if (ext.error) return no('DRAGON_EXTENSION_ERROR', `the extension reports an error: ${String(ext.error).slice(0, 160)}`, 'pair');
  const extension = inRange(ext.version, req.extension);
  if (extension === 'invalid') return no('DRAGON_VERSION', `extension version ${JSON.stringify(ext.version)} is not a version`, 'install_extension');
  if (extension === 'old') return no('DRAGON_EXTENSION_OLD', `Dragon extension ${ext.version} is older than ${req.extension.min}`, 'update_extension');
  if (extension === 'unsupported') return no('DRAGON_EXTENSION_UNSUPPORTED', `Dragon extension ${ext.version} is not supported by this Team QA (below ${req.extension.below})`, 'update_teamqa');
  // A bridge that reports where the extension came from (Dragon with D3) must be talking to the Store build, unless
  // the owner's grant allows another one. A bridge that does not report it yet is accepted on version alone.
  const fromStore = (ext.id === undefined || req.extension.store_ids.includes(ext.id)) && (ext.installType === undefined || ext.installType === 'normal');
  if (!fromStore && !ownerGrant?.allows?.('dragon-unpacked')) return no('DRAGON_EXTENSION_NOT_STORE', `the connected extension (${ext.id ?? 'unknown id'}, ${ext.installType ?? 'unknown install'}) is not the Chrome Web Store build`, 'install_extension');
  if (status.ready !== true) return no('DRAGON_NOT_READY', 'the bridge is up but not ready', 'pair');
  return { ok: true, bridge: status.bridgeVersion, extension: ext.version, extensionId: ext.id ?? null, installType: ext.installType ?? null,
    platform: fromStore ? 'dragon' : 'dragon-unpacked', grant_id: fromStore ? null : ownerGrant?.grant?.id ?? null };
}
