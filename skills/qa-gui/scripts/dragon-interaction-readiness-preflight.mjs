#!/usr/bin/env node

// dragon-interaction-readiness-preflight.mjs — Gate-0 interaction readiness over Dragon Browser.
// Samples the SAME settled screen three times inside ONE bound `do` call and normalizes the
// evidence into the frozen readiness risk families, so a human-like GUI run knows up front
// whether the screen is actually actionable or merely looks actionable.
// Fail-closed everywhere: a denial, a malformed payload, a missing/failed read, an invalid
// sample or a failed cleanup is an error — never a silent PASS.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RPC = process.env.DRAGON_RPC || 'http://localhost:9233/rpc';
const STABLE_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'service-token');
const LEGACY_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'token');
const RPC_TIMEOUT_MS = 15_000;

/** Three reads of the same screen, separated by two settle waits, in one `do` call. */
export const SAMPLE_ALIASES = Object.freeze(['readiness0', 'readiness1', 'readiness2']);
const SETTLE_WAIT_MS = 400;
const REQUIRED_SAMPLES = SAMPLE_ALIASES.length;
// A control that drifts more than this across the settled samples is still animating into
// place; 1-2px of sub-pixel jitter on an ordinary page must stay clean.
const GEOMETRY_TOLERANCE_PX = 4;
const OVERLAY_COVERAGE = 0.5;

let redactToken = '';

function rpcToken() {
  const fromEnv = String(process.env.DRAGON_RPC_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const tokenFiles = process.env.DRAGON_RPC_TOKEN_FILE
    ? [process.env.DRAGON_RPC_TOKEN_FILE]
    : [STABLE_TOKEN_FILE, LEGACY_TOKEN_FILE];
  for (const tokenFile of tokenFiles) {
    try {
      const fromFile = readFileSync(tokenFile, 'utf8').trim();
      if (fromFile) return fromFile;
    } catch {}
  }
  throw new Error('Dragon bearer token is missing; set DRAGON_RPC_TOKEN or DRAGON_RPC_TOKEN_FILE');
}

function safeMessage(error, token = redactToken) {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.split(token).join('[redacted]') : message;
}

function entriesOf(sample, field) {
  const value = sample[field];
  if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry === 'object');
  if (value && typeof value === 'object') return [value];
  return [];
}

function keyOf(entry, index) {
  const key = entry.key ?? entry.id ?? entry.selector ?? entry.sel ?? entry.label ?? entry.name;
  return key === undefined || key === null || key === '' ? `#${index}` : String(key);
}

function normalizeRect(value) {
  if (!value || typeof value !== 'object') return null;
  const rect = {
    x: Number(value.x ?? value.left),
    y: Number(value.y ?? value.top),
    w: Number(value.w ?? value.width),
    h: Number(value.h ?? value.height),
  };
  return Object.values(rect).every((side) => Number.isFinite(side)) ? rect : null;
}

/**
 * Keys whose evidence is present in EVERY sample.  A risk that shows up in only one or two
 * reads is the screen still settling, which is exactly the transient case that must stay
 * clean, so the intersection — not the union — is what gets reported.
 */
function persistentEntries(samples, field, predicate) {
  let shared = null;
  const evidence = new Map();
  for (const sample of samples) {
    const here = new Map();
    entriesOf(sample, field).forEach((entry, index) => {
      if (!predicate(entry)) return;
      const key = keyOf(entry, index);
      if (!here.has(key)) here.set(key, entry);
    });
    for (const [key, entry] of here) if (!evidence.has(key)) evidence.set(key, entry);
    if (shared === null) shared = new Set(here.keys());
    else for (const key of [...shared]) if (!here.has(key)) shared.delete(key);
    if (shared.size === 0) break;
  }
  return [...(shared ?? [])].map((key) => ({ key, entry: evidence.get(key) }));
}

/**
 * Geometry is the one family that cannot be read from a single sample: a control is unstable
 * because it MOVED between samples, so it is measured across the whole series and only for
 * targets that were present with a real rect in every sample.
 */
function unstableGeometry(samples) {
  const series = new Map();
  for (const sample of samples) {
    entriesOf(sample, 'targets').forEach((target, index) => {
      const rect = normalizeRect(target.rect ?? target.box ?? target.bounds);
      if (!rect) return;
      const key = keyOf(target, index);
      if (!series.has(key)) series.set(key, []);
      series.get(key).push(rect);
    });
  }
  const unstable = [];
  for (const [key, rects] of series) {
    if (rects.length < samples.length) continue;
    const movement = Math.max(...['x', 'y', 'w', 'h'].map((side) => {
      const values = rects.map((rect) => rect[side]);
      return Math.max(...values) - Math.min(...values);
    }));
    if (movement > GEOMETRY_TOLERANCE_PX) unstable.push({ key, movement: Math.round(movement * 100) / 100 });
  }
  return unstable;
}

/**
 * Normalize three settled readiness samples into the frozen risk families.  Pure and
 * evidence-only: an ordinary screen — one that settles, keeps its controls still and enables
 * its primary action — comes back empty.  Invalid input throws rather than reporting clean.
 */
export function classifyInteractionReadiness(samples) {
  if (!Array.isArray(samples) || samples.length < REQUIRED_SAMPLES) {
    throw new TypeError(`interaction readiness needs at least ${REQUIRED_SAMPLES} settled samples`);
  }
  for (const [index, sample] of samples.entries()) {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
      throw new TypeError(`interaction readiness sample ${index} is not an object`);
    }
  }

  const risks = [];
  const add = (type, key, detail) => risks.push({ type, key, detail });
  const persistent = (field, predicate) => persistentEntries(samples, field, predicate);

  for (const { key, entry } of persistent('busy', () => true)) {
    add('readiness-persistent-busy', key, `busy indicator "${entry.label || key}" never cleared across ${samples.length} samples`);
  }
  for (const { key } of persistent('skeletons', () => true)) {
    add('readiness-persistent-skeleton', key, `skeleton placeholder "${key}" never resolved into content`);
  }
  for (const { key, entry } of persistent('blockingOverlays', (overlay) => Number(overlay.coverage) >= OVERLAY_COVERAGE || overlay.blocking === true)) {
    add('readiness-blocking-overlay', key, `overlay "${key}" keeps covering ${entry.coverage ?? 'most'} of the page`);
  }
  for (const { key } of persistent('targets', (target) => target.occluded === true)) {
    add('readiness-occluded-target', key, `target "${key}" stays covered by another element`);
  }
  for (const { key } of persistent('targets', (target) => target.pointerDisabled === true)) {
    add('readiness-pointer-disabled-target', key, `target "${key}" stays pointer-events:none`);
  }
  for (const { key } of persistent('targets', (target) => target.primary === true && target.disabled === true)) {
    add('readiness-disabled-primary-action', key, `primary action "${key}" stays disabled`);
  }
  for (const { key, movement } of unstableGeometry(samples)) {
    add('readiness-unstable-target-geometry', key, `target "${key}" moved ${movement}px across the settled samples`);
  }
  for (const { key } of persistent('modals', (modal) => modal.focusInside === false)) {
    add('readiness-modal-focus-escape', key, `modal "${key}" never holds focus inside the dialog`);
  }
  for (const { key, entry } of persistent('ambiguous', (candidate) => Number(candidate.count ?? candidate.matches) > 1)) {
    add('readiness-ambiguous-semantic-target', key, `"${key}" matches ${entry.count ?? entry.matches} elements`);
  }
  for (const { key } of persistent('targets', (target) => target.animated === true)) {
    add('readiness-animated-interactive-target', key, `target "${key}" is still animating in every sample`);
  }

  return risks;
}

/** One page read: the readiness evidence the classifier consumes, measured in the live DOM. */
export const READINESS_SAMPLE_SCRIPT = `(() => {
  const interactiveSelector = 'button,input,select,textarea,a[href],[role="button"],[role="link"],[role="menuitem"],[tabindex]:not([tabindex="-1"])';
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  };
  const round = (value) => Math.round(Number(value) * 100) / 100;
  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) };
  };
  const label = (element) => String(element.getAttribute('aria-label') || element.textContent || element.getAttribute('name') || element.id || '')
    .trim().replace(/\\s+/g, ' ').slice(0, 60);
  const keyOf = (element, index) => (element.tagName.toLowerCase() + ':' + (element.id || label(element) || index)).toLowerCase();
  const animating = (element) => {
    try { return element.getAnimations().some((animation) => animation.playState === 'running'); } catch { return false; }
  };
  const viewportArea = Math.max(1, innerWidth * innerHeight);
  const controls = [...document.querySelectorAll(interactiveSelector)].filter(visible);

  const busy = [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-loading="true"],.spinner,.loading')]
    .filter(visible)
    .map((element, index) => ({ key: keyOf(element, index), label: label(element) }));
  const skeletons = [...document.querySelectorAll('[data-skeleton],[class*="skeleton" i],[class*="shimmer" i],[class*="placeholder" i][aria-hidden="true"]')]
    .filter(visible)
    .map((element, index) => ({ key: keyOf(element, index) }));
  const blockingOverlays = [...document.querySelectorAll('div,section,dialog')].filter((element) => {
    const style = getComputedStyle(element);
    if (style.position !== 'fixed' && style.position !== 'absolute') return false;
    if (style.pointerEvents === 'none' || !visible(element)) return false;
    const rect = element.getBoundingClientRect();
    return (rect.width * rect.height) / viewportArea >= ${OVERLAY_COVERAGE} && element.querySelectorAll(interactiveSelector).length === 0;
  }).map((element, index) => {
    const rect = element.getBoundingClientRect();
    return { key: keyOf(element, index), coverage: round((rect.width * rect.height) / viewportArea) };
  });
  const targets = controls.map((element, index) => {
    const style = getComputedStyle(element);
    const rect = rectOf(element);
    const at = document.elementFromPoint(rect.x + rect.w / 2, rect.y + rect.h / 2);
    return {
      key: keyOf(element, index),
      rect,
      occluded: Boolean(at) && at !== element && !element.contains(at) && !at.contains(element),
      pointerDisabled: style.pointerEvents === 'none',
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
      primary: element.getAttribute('type') === 'submit'
        || element.getAttribute('data-primary') === 'true'
        || /(^|[^a-z])primary([^a-z]|$)/i.test(String(element.className || '')),
      animated: animating(element),
    };
  });
  const modals = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')].filter(visible).map((element, index) => ({
    key: keyOf(element, index),
    focusInside: element.contains(document.activeElement),
  }));
  const names = new Map();
  for (const element of controls) {
    const name = label(element);
    if (!name) continue;
    const key = (element.getAttribute('role') || element.tagName).toLowerCase() + ':' + name.toLowerCase();
    names.set(key, (names.get(key) || 0) + 1);
  }
  const ambiguous = [...names.entries()].filter((pair) => pair[1] > 1).map((pair) => ({ key: pair[0], count: pair[1] }));

  return { busy, skeletons, blockingOverlays, targets, modals, ambiguous };
})()`;

function parseArgs(argv) {
  const args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--tab-id') args.tabId = Number(argv[++index]);
    else if (value === '--url') args.url = argv[++index];
    else if (value === '--session-id') args.sessionId = argv[++index];
    else if (value === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function rpc(method, params) {
  const token = rpcToken();
  let response;
  let payload;
  try {
    response = await fetch(RPC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const raw = await response.text();
    try { payload = JSON.parse(raw); }
    catch { throw new Error(`Dragon RPC ${method} returned malformed JSON`); }
  } catch (error) {
    throw new Error(safeMessage(error, token));
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(safeMessage(payload?.error || `Dragon RPC ${method} failed with HTTP ${response.status}`, token));
  }
  const result = payload?.result;
  // /rpc nests its denials: HTTP 200 + {ok:true, result:{ok:false, code:...}}.
  if (result?.ok === false) {
    throw new Error(safeMessage(`${method}: ${result.code || 'DENIED'} — ${result.reason || result.error || 'Dragon denied the call'}`, token));
  }
  const failedStep = Array.isArray(result?.results)
    ? result.results.find((step) => step?.ok === false)
    : null;
  if (failedStep) {
    throw new Error(safeMessage(`${method}: ${failedStep.code || 'STEP_FAILED'} — ${failedStep.reason || failedStep.error || 'Dragon denied a step'}`, token));
  }
  if (result === undefined || result === null) throw new Error(`Dragon RPC ${method} returned no result`);
  return result;
}

/** The one `do` payload: read, settle, read, settle, read — never three separate calls. */
export function readinessSteps() {
  return [
    { read: READINESS_SAMPLE_SCRIPT, as: SAMPLE_ALIASES[0] },
    // Dragon's live `do` grammar has a numeric `wait` step; `{settle:true}` is only
    // shorthand in prose and is rejected by the extension as an unknown step.
    { wait: SETTLE_WAIT_MS },
    { read: READINESS_SAMPLE_SCRIPT, as: SAMPLE_ALIASES[1] },
    { wait: SETTLE_WAIT_MS },
    { read: READINESS_SAMPLE_SCRIPT, as: SAMPLE_ALIASES[2] },
  ];
}

/**
 * Pull the three samples out of a `do` reply.  Dragon echoes the step aliases, but older
 * builds key the reads positionally, so the alias lookup falls back to read order — and a
 * short, missing or failed read is an error instead of an empty (i.e. clean) sample.
 */
function pickSamples(reads) {
  if (!reads || typeof reads !== 'object' || Array.isArray(reads)) {
    throw new Error('Dragon returned no readiness reads');
  }
  const aliased = SAMPLE_ALIASES.map((alias) => reads[alias]);
  const samples = aliased.every((sample) => sample !== undefined) ? aliased : Object.values(reads);
  if (samples.length !== REQUIRED_SAMPLES) {
    throw new Error(`Dragon returned ${samples.length} readiness reads; expected ${REQUIRED_SAMPLES}`);
  }
  samples.forEach((sample, index) => {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
      throw new Error(`Dragon readiness sample ${index} is not an object`);
    }
    if (typeof sample.__read_error === 'string') {
      throw new Error(`Dragon readiness sample ${index} read failed`);
    }
  });
  return samples;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((args.url ? 1 : 0) + (Number.isInteger(args.tabId) ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of --url or --tab-id');
  }
  // Fail before any useful work if the bearer token is unavailable.
  redactToken = rpcToken();

  const requestedSessionId = args.sessionId || `qa-gui-interaction-readiness-${randomUUID()}`;
  let session;
  let sessionId = requestedSessionId;
  let tabId = args.tabId;
  let output;
  let taskError;
  let cleanupError;
  try {
    session = await rpc('session.create', { sessionId: requestedSessionId, forbidSyntheticDOM: false });
    sessionId = session.sessionId || requestedSessionId;
    if (session.forbidSyntheticDOM !== false) throw new Error('Dragon refused forbidSyntheticDOM=false');
    if (!session.nonce || !session.browserInstanceId) throw new Error('Dragon session returned no nonce/browserInstanceId binding');
    const binding = { sessionId, nonce: session.nonce, browserInstanceId: session.browserInstanceId };

    if (args.url) {
      const opened = await rpc('openTab', { ...binding, url: args.url, active: false });
      if (!Number.isInteger(opened.tabId)) throw new Error('Dragon openTab returned no tabId');
      tabId = opened.tabId;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      await rpc('waitForState', { ...binding, tabId, state: 'complete', timeoutMs: 10_000 });
    }

    const measured = await rpc('do', { ...binding, tabId, steps: readinessSteps() });
    const samples = pickSamples(measured.reads);
    const risks = classifyInteractionReadiness(samples);
    output = {
      tabId,
      samples,
      risks,
      verdict: risks.length ? 'FAIL' : 'PASS',
    };
  } catch (error) {
    taskError = error;
  } finally {
    if (session) {
      try {
        await rpc('session.close', {
          sessionId,
          nonce: session.nonce,
          browserInstanceId: session.browserInstanceId,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (output && !cleanupError) console.log(args.json ? JSON.stringify(output) : JSON.stringify(output, null, 2));
  if (taskError) {
    if (cleanupError) taskError.message = `${safeMessage(taskError)}; cleanup failed: ${safeMessage(cleanupError)}`;
    throw taskError;
  }
  if (cleanupError) throw cleanupError;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(safeMessage(error));
    process.exitCode = 1;
  });
}
