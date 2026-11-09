// Action cache for the Experience Layer (upgrade R3, flag `action_cache`). It keeps the trusted action steps that led
// to a state in a run that passed, so a later run on the same app, build, route, viewport, locale and role can replay
// them through Dragon (`do`/`saveFlow`+`runFlow`, still trusted input) instead of working out the path again.
//
// What it never does: keep a verdict, a read, an assertion or a network expectation (they are stripped at store time and
// refused in a cache file), stand in for a check (a replay plan needs the caller's own sweeps and assertions, which then
// run for real), store from a run that did not pass in every part, store a typed secret, or serve an entry older than
// 14 days. Each action is preceded by a `waitFor` guard on its own target, so a page that changed stops the replay and
// the executor goes back to working it out.
import { createHash } from 'node:crypto';

export const ACTION_CACHE_SCHEMA = 'qa-gui/action-cache/v1';
export const ACTION_CACHE_TTL_DAYS = 14;
export const FINGERPRINT_SIGNALS = Object.freeze(['app', 'origin', 'route', 'build', 'viewport', 'locale', 'role']);
const GUARD_TIMEOUT_MS = 5000;
// Dragon `do` action steps. A key press is the `key` step (with `modifiers`); `pressKey` is an RPC, not a step.
const ACTION_KEYS = ['click', 'clickSelector', 'clickXY', 'type', 'fill', 'select', 'key', 'hover', 'scroll', 'drag', 'clear', 'chord', 'menuSelect', 'dialog'];
const SYNC_KEYS = ['wait', 'waitFor'];
const MODIFIER_KEYS = ['fast', 'selector', 'nth', 'fidelity', 'modifiers'];
const CHECK_KEYS = ['read', 'as', 'assert', 'expectNet'];
const SECRET_TARGET = /pass(?:word)?|pwd|secret|token|otp|\bpin\b|cvv|card-?number/i;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const day = 24 * 3600 * 1000;

export class ActionCacheError extends Error {
  constructor(code, detail = '') { super(detail ? `${code}: ${detail}` : code); this.code = code; }
}
const refuse = (code, detail) => { throw new ActionCacheError(code, detail); };

export function emptyActionCache() { return { schema: ACTION_CACHE_SCHEMA, entries: [] }; }

// One hash over every signal; each one is required (a missing signal would match pages it should not).
export function fingerprintOf(signals) {
  if (!object(signals)) refuse('ACTION_CACHE_SIGNAL', 'signals object');
  for (const name of FINGERPRINT_SIGNALS) if (typeof signals[name] !== 'string' || !signals[name].trim()) refuse('ACTION_CACHE_SIGNAL', name);
  return sha256(JSON.stringify(FINGERPRINT_SIGNALS.map((name) => [name, signals[name]])));
}

const targetOf = (step) => {
  for (const key of ['click', 'hover', 'clickSelector']) {
    const v = step[key];
    if (typeof v === 'string' && v.trim()) return key === 'clickSelector' ? { selector: v } : { text: v };
    if (object(v) && typeof v.selector === 'string') return { selector: v.selector };
    if (object(v) && typeof v.text === 'string') return { text: v.text };
  }
  if (object(step.fill) && typeof step.fill.selector === 'string') return { selector: step.fill.selector };
  if (typeof step.selector === 'string' && step.selector.trim()) return { selector: step.selector };
  return null;
};
const typedValue = (step) => (object(step.fill) ? step.fill.value : typeof step.type === 'string' ? step.type : null);

function secretIn(step, secrets) {
  if (!Object.hasOwn(step, 'fill') && !Object.hasOwn(step, 'type')) return false;
  const target = targetOf(step);
  if (target?.selector && SECRET_TARGET.test(target.selector)) return true;
  const value = typedValue(step);
  return typeof value === 'string' && secrets.some((secret) => typeof secret === 'string' && secret && value.includes(secret));
}

// Action steps only, each after a guard on its own target. Returns {steps, stripped}.
function actionSteps(steps, secrets) {
  const out = [];
  let stripped = 0;
  for (const raw of Array.isArray(steps) ? steps : []) {
    if (!object(raw)) { stripped += 1; continue; }
    const isAction = ACTION_KEYS.some((key) => Object.hasOwn(raw, key));
    const isSync = SYNC_KEYS.some((key) => Object.hasOwn(raw, key));
    if (!isAction && !isSync) { stripped += 1; continue; }
    const step = Object.fromEntries(Object.entries(raw).filter(([key]) => [...ACTION_KEYS, ...SYNC_KEYS, ...MODIFIER_KEYS].includes(key)));
    if (Object.keys(step).length !== Object.keys(raw).length) stripped += 1;
    if (secretIn(step, secrets)) refuse('ACTION_CACHE_SECRET', 'a typed secret is never cached');
    const target = isAction ? targetOf(step) : null;
    if (target) out.push({ waitFor: { ...target, timeoutMs: GUARD_TIMEOUT_MS } });
    out.push(step);
  }
  return { steps: out, stripped };
}

// Stores the actions of a passed case. `run` must show PASS for the gate, the Function and the UI verdicts; nothing of
// it but its identity (run, case, receipt hash) is kept. `to` names the state the actions lead to.
export function storeFromPassedRun({ cache, signals, to, steps, run, now = new Date().toISOString(), secrets = [] }) {
  if (!object(run) || run.gate_verdict !== 'PASS' || run.function_verdict !== 'PASS' || run.ui_verdict !== 'PASS') refuse('ACTION_CACHE_SOURCE_NOT_PASS', 'only a run that passed (gate, Function and UI) is cached');
  if (!object(to) || typeof to.state !== 'string' || !to.state.trim()) refuse('ACTION_CACHE_TARGET', 'to.state');
  const fingerprint = fingerprintOf(signals);
  const { steps: kept, stripped } = actionSteps(steps, secrets);
  if (!kept.some((step) => ACTION_KEYS.some((key) => Object.hasOwn(step, key)))) refuse('ACTION_CACHE_NO_ACTION');
  const at = Date.parse(now);
  if (!Number.isFinite(at)) refuse('ACTION_CACHE_TIME', String(now));
  const entry = {
    fingerprint: Object.fromEntries(FINGERPRINT_SIGNALS.map((name) => [name, signals[name]])), fingerprint_sha256: fingerprint,
    to: { state: to.state }, steps: kept, stored_at: new Date(at).toISOString(), expires_at: new Date(at + ACTION_CACHE_TTL_DAYS * day).toISOString(),
    source: { run_id: String(run.run_id ?? ''), case_id: String(run.case_id ?? ''), receipt_sha256: String(run.receipt_sha256 ?? '') },
  };
  const entries = (cache?.entries ?? []).filter((e) => !(e.fingerprint_sha256 === fingerprint && e.to?.state === to.state));
  return { cache: { schema: ACTION_CACHE_SCHEMA, entries: [...entries, entry] }, entry, stripped };
}

export function lookupActions({ cache, signals, to, now = new Date().toISOString() }) {
  let fingerprint;
  try { fingerprint = fingerprintOf(signals); } catch { return { hit: null, reason: 'MISS' }; }
  const entry = (cache?.entries ?? []).find((e) => e.fingerprint_sha256 === fingerprint && e.to?.state === to?.state);
  if (!entry) return { hit: null, reason: 'MISS' };
  if (!(Date.parse(entry.expires_at) > Date.parse(now))) return { hit: null, reason: 'EXPIRED' };
  return { hit: entry, reason: 'HIT' };
}

export function pruneActionCache(cache, now = new Date().toISOString()) {
  return { schema: ACTION_CACHE_SCHEMA, entries: (cache?.entries ?? []).filter((e) => Date.parse(e.expires_at) > Date.parse(now)) };
}

// The steps of a replay: the cached actions, then the caller's sweeps and assertions, which always run for real.
export function replayPlan({ entry, sweeps, assertions }) {
  if (!Array.isArray(sweeps) || !sweeps.length || !Array.isArray(assertions) || !assertions.length) refuse('ACTION_CACHE_REPLAY_NEEDS_CHECKS', 'a replay runs the state\'s sweeps and assertions for real');
  return { steps: [...entry.steps, ...sweeps, ...assertions], cached_steps: entry.steps.length };
}

export function actionCacheErrors(cache) {
  const errors = [];
  if (!object(cache) || cache.schema !== ACTION_CACHE_SCHEMA || !Array.isArray(cache.entries)) return ['ACTION_CACHE_SCHEMA'];
  cache.entries.forEach((entry, index) => {
    const at = `entries[${index}]`;
    if (!object(entry)) { errors.push(`ACTION_CACHE_ENTRY:${at}`); return; }
    if (JSON.stringify(entry).includes('"verdict"') || Object.hasOwn(entry, 'verdict')) errors.push(`ACTION_CACHE_VERDICT:${at}`);
    for (const key of Object.keys(entry)) if (!['fingerprint', 'fingerprint_sha256', 'to', 'steps', 'stored_at', 'expires_at', 'source'].includes(key)) errors.push(`ACTION_CACHE_FIELD:${at}.${key}`);
    try { if (fingerprintOf(entry.fingerprint) !== entry.fingerprint_sha256) errors.push(`ACTION_CACHE_FINGERPRINT:${at}`); } catch { errors.push(`ACTION_CACHE_FINGERPRINT:${at}`); }
    if (!Array.isArray(entry.steps) || entry.steps.some((step) => !object(step) || CHECK_KEYS.some((key) => Object.hasOwn(step, key)))) errors.push(`ACTION_CACHE_STEP:${at}`);
    const stored = Date.parse(entry.stored_at), expires = Date.parse(entry.expires_at);
    if (!Number.isFinite(stored) || !Number.isFinite(expires) || expires - stored > ACTION_CACHE_TTL_DAYS * day) errors.push(`ACTION_CACHE_EXPIRY:${at}`);
  });
  return errors;
}
