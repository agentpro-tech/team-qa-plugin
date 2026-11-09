// The approved-baseline store (upgrade R3, vision by diff). One JSON file, `qa-gui/approved-baselines/v1`, with its
// PNGs content-addressed beside it (`png/<sha256>.png`). An entry is keyed by route, state, viewport and build and
// stores the PNG's SHA-256, the mask rectangles approved with it and the C10–C16 verdicts the state had when it was
// proposed (all PASS: only a clean state can be inherited from).
//
// Approval is explicit and separate: `proposeBaseline` adds a `proposed` entry with blank approval fields;
// `approveBaseline` needs the exact key and SHA-256 and a named approver (QA_GUI_BASELINE_APPROVER, when set, must be
// that name, as for the board's baseline manifest). A later approval for the same key supersedes the earlier one, so a
// key has at most one approved entry. A proposed or superseded entry is never compared.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { decodePng } from '../visual-diff.mjs';
import { baselineApproverError } from '../teamwork/board-gates.mjs';

export const BASELINE_STORE_SCHEMA = 'qa-gui/approved-baselines/v1';
export const VISION_RULES = Object.freeze(['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16']);
const SHA256 = /^[a-f0-9]{64}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VIEWPORT = /^\d{2,5}x\d{2,5}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const iso = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

export class BaselineStoreError extends Error {
  constructor(code, detail = '') { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}
const refuse = (code, detail) => { throw new BaselineStoreError(code, detail); };

export function emptyStore() { return { schema: BASELINE_STORE_SCHEMA, entries: [] }; }

export function keyErrors(key) {
  const errors = [];
  if (!object(key)) return ['BASELINE_KEY_OBJECT'];
  for (const field of Object.keys(key)) if (!['route', 'state', 'viewport', 'build'].includes(field)) errors.push(`BASELINE_KEY_UNKNOWN:${field}`);
  if (typeof key.route !== 'string' || !key.route.startsWith('/') || key.route.length > 512) errors.push('BASELINE_KEY_ROUTE');
  if (typeof key.state !== 'string' || !SEGMENT.test(key.state)) errors.push('BASELINE_KEY_STATE');
  if (typeof key.viewport !== 'string' || !VIEWPORT.test(key.viewport)) errors.push('BASELINE_KEY_VIEWPORT');
  if (typeof key.build !== 'string' || !key.build.trim() || key.build.length > 256) errors.push('BASELINE_KEY_BUILD');
  return errors;
}
const normKey = (key) => {
  const errors = keyErrors(key);
  if (errors.length) refuse('BASELINE_KEY_INVALID', errors.join(','));
  return { route: key.route, state: key.state, viewport: key.viewport, build: key.build };
};
const sameKey = (a, b) => a.route === b.route && a.state === b.state && a.viewport === b.viewport && a.build === b.build;
const sameView = (a, b) => a.route === b.route && a.state === b.state && a.viewport === b.viewport;

function maskErrors(mask) {
  if (!Array.isArray(mask)) return ['BASELINE_MASK_ARRAY'];
  return mask.flatMap((r, index) => (object(r) && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k]) && r[k] >= 0)
    && Object.keys(r).every((k) => ['x', 'y', 'width', 'height'].includes(k)) ? [] : [`BASELINE_MASK_RECT:${index}`]));
}

// Shape and integrity of a store; with `dir`, every listed PNG is read back and hashed.
export function storeErrors(store, { dir = null } = {}) {
  const errors = [];
  if (!object(store) || store.schema !== BASELINE_STORE_SCHEMA || !Array.isArray(store.entries)) return ['BASELINE_STORE_SCHEMA'];
  for (const key of Object.keys(store)) if (!['schema', 'entries'].includes(key)) errors.push(`BASELINE_STORE_UNKNOWN_FIELD:${key}`);
  const approved = new Map();
  store.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;
    if (!object(entry)) { errors.push(`BASELINE_ENTRY_OBJECT:${at}`); return; }
    const allowed = ['key', 'sha256', 'png', 'width', 'height', 'mask', 'vision', 'source', 'status', 'proposed_at', 'approved_by', 'approved_at'];
    for (const field of Object.keys(entry)) if (!allowed.includes(field)) errors.push(`BASELINE_ENTRY_UNKNOWN_FIELD:${at}.${field}`);
    errors.push(...keyErrors(entry.key).map((e) => `${e}:${at}`));
    if (!SHA256.test(entry.sha256 ?? '') || entry.png !== `png/${entry.sha256}.png`) errors.push(`BASELINE_ENTRY_PNG:${at}`);
    if (!Number.isInteger(entry.width) || !Number.isInteger(entry.height) || entry.width < 1 || entry.height < 1) errors.push(`BASELINE_ENTRY_SIZE:${at}`);
    errors.push(...maskErrors(entry.mask).map((e) => `${e}:${at}`));
    if (!object(entry.vision) || VISION_RULES.some((rule) => entry.vision[rule] !== 'PASS') || Object.keys(entry.vision).some((rule) => !VISION_RULES.includes(rule))) errors.push(`BASELINE_VISION_NOT_PASS:${at}`);
    if (!['proposed', 'approved', 'superseded'].includes(entry.status)) errors.push(`BASELINE_ENTRY_STATUS:${at}`);
    if (!iso(entry.proposed_at)) errors.push(`BASELINE_ENTRY_PROPOSED_AT:${at}`);
    if (entry.status === 'proposed' && (entry.approved_by !== '' || entry.approved_at !== '')) errors.push(`BASELINE_PROPOSED_HAS_APPROVAL:${at}`);
    if (entry.status !== 'proposed') {
      if (baselineApproverError(entry.approved_by, {})) errors.push(`BASELINE_APPROVER:${at}`);
      if (!iso(entry.approved_at)) errors.push(`BASELINE_ENTRY_APPROVED_AT:${at}`);
    }
    if (entry.status === 'approved' && object(entry.key)) {
      const k = JSON.stringify([entry.key.route, entry.key.state, entry.key.viewport, entry.key.build]);
      if (approved.has(k)) errors.push(`BASELINE_KEY_APPROVED_TWICE:${at}`);
      approved.set(k, index);
    }
    if (dir && SHA256.test(entry.sha256 ?? '')) {
      let bytes = null;
      try { bytes = readFileSync(join(dir, 'png', `${entry.sha256}.png`)); } catch { errors.push(`BASELINE_PNG_MISSING:${at}`); }
      if (bytes && sha256(bytes) !== entry.sha256) errors.push(`BASELINE_PNG_DRIFT:${at}`);
    }
  });
  return errors;
}

export function readStore(file) {
  const path = resolve(file);
  let bytes;
  try { bytes = readFileSync(path); } catch (error) { refuse('BASELINE_STORE_UNREADABLE', error.message); }
  let store;
  try { store = JSON.parse(bytes.toString('utf8')); } catch (error) { refuse('BASELINE_STORE_JSON', error.message); }
  return { store, sha256: sha256(bytes), dir: dirname(path), path };
}

export function writeStore(file, store) {
  const errors = storeErrors(store);
  if (errors.length) refuse('BASELINE_STORE_INVALID', errors.join(','));
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const text = `${JSON.stringify(store, null, 2)}\n`;
  writeFileSync(resolve(file), text);
  return sha256(Buffer.from(text, 'utf8'));
}

// Adds a proposed entry and writes its PNG beside the store. `vision` holds the seven verdicts the state had.
export function proposeBaseline({ store, dir, key, png, mask = [], vision, source = {}, now = new Date().toISOString() }) {
  const k = normKey(key);
  if (!Buffer.isBuffer(png)) refuse('BASELINE_PNG_REQUIRED');
  let image;
  try { image = decodePng(png); } catch (error) { refuse('BASELINE_PNG_INVALID', error.message); }
  if (maskErrors(mask).length) refuse('BASELINE_MASK_INVALID', maskErrors(mask).join(','));
  if (!object(vision) || VISION_RULES.some((rule) => vision[rule] !== 'PASS')) refuse('BASELINE_VISION_NOT_PASS', 'a baseline to inherit from needs C10–C16 all PASS');
  const digest = sha256(png);
  if (store.entries.some((entry) => sameKey(entry.key, k) && entry.sha256 === digest && entry.status !== 'superseded')) refuse('BASELINE_ALREADY_LISTED', `${digest} for ${JSON.stringify(k)}`);
  mkdirSync(join(dir, 'png'), { recursive: true });
  writeFileSync(join(dir, 'png', `${digest}.png`), png);
  const entry = {
    key: k, sha256: digest, png: `png/${digest}.png`, width: image.width, height: image.height,
    mask: mask.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
    vision: Object.fromEntries(VISION_RULES.map((rule) => [rule, 'PASS'])),
    source: object(source) ? source : {}, status: 'proposed', proposed_at: now, approved_by: '', approved_at: '',
  };
  return { store: { ...store, entries: [...store.entries, entry] }, entry };
}

// Approves the proposed entry with exactly this key and SHA-256; the key's earlier approved entry is superseded.
export function approveBaseline({ store, key, sha256: digest, by, now = new Date().toISOString(), env = process.env }) {
  const k = normKey(key);
  const approverError = baselineApproverError(by, env);
  if (approverError) refuse('BASELINE_APPROVER', approverError);
  const index = store.entries.findIndex((entry) => entry.status === 'proposed' && sameKey(entry.key, k) && entry.sha256 === digest);
  if (index < 0) refuse('BASELINE_NOT_PROPOSED', `no proposed entry ${digest} for ${JSON.stringify(k)}`);
  const entries = store.entries.map((entry, i) => {
    if (i === index) return { ...entry, status: 'approved', approved_by: by, approved_at: now };
    if (entry.status === 'approved' && sameKey(entry.key, k)) return { ...entry, status: 'superseded' };
    return entry;
  });
  return { store: { ...store, entries }, entry: entries[index] };
}

// The approved entry to compare a state against: the one approved for this exact build, else the most recently
// approved entry of the same route, state and viewport on another build (`sameBuild: false`), else null.
export function findApprovedBaseline(store, key) {
  if (!object(store) || !Array.isArray(store.entries) || keyErrors(key).length) return null;
  const approved = store.entries.filter((entry) => entry?.status === 'approved' && object(entry.key) && sameView(entry.key, key));
  const exact = approved.find((entry) => entry.key.build === key.build);
  if (exact) return { entry: exact, sameBuild: true };
  const latest = approved.filter((entry) => iso(entry.approved_at)).sort((a, b) => Date.parse(b.approved_at) - Date.parse(a.approved_at))[0];
  return latest ? { entry: latest, sameBuild: false } : null;
}
