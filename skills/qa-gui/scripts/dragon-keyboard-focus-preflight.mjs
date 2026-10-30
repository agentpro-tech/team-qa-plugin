#!/usr/bin/env node

// dragon-keyboard-focus-preflight.mjs — Gate-0 keyboard/focus preflight over Dragon Browser.
// Reads the focusable baseline, then sends TWELVE trusted `Tab` keys inside ONE bound `do`
// call, snapshotting `document.activeElement` after every single press, and normalizes the
// resulting focus trail into the frozen keyboard/focus risk families — so a keyboard-only
// user's path through the screen is measured, not assumed.
// Fail-closed everywhere: a denial, a malformed payload, a missing/failed read, an invalid
// observation, a missing token or a failed cleanup is an error — never a silent PASS.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RPC = process.env.DRAGON_RPC || 'http://localhost:9233/rpc';
const STABLE_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'service-token');
const LEGACY_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'token');
const RPC_TIMEOUT_MS = 15_000;

/** The pre-Tab read, then one focus snapshot per trusted Tab press, all in one `do` call. */
export const BASELINE_ALIAS = 'keyboardBaseline';
export const TAB_PRESSES = 12;
export const FOCUS_ALIASES = Object.freeze(
  Array.from({ length: TAB_PRESSES }, (_, index) => `focus${index + 1}`),
);

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

function focusKey(entry) {
  const key = entry.key ?? entry.id ?? entry.selector ?? entry.label ?? entry.name ?? '';
  return typeof key === 'string' ? key.trim() : String(key);
}

/**
 * A trail stop that is not on a control: focus fell back to `body`/`documentElement`.  This is
 * only evidence of a lost stop when the page actually has somewhere else to go, so the caller
 * still has to check that reachable controls exist.
 */
function isBodyStop(step) {
  if (step.isBody === true) return true;
  const tag = String(step.tag ?? step.tagName ?? '').toLowerCase();
  if (tag === 'body' || tag === 'html') return true;
  return focusKey(step) === '';
}

/** A control the tab order is expected to visit: shown, enabled and not removed from the order. */
function isReachable(candidate) {
  const tabIndex = Number(candidate.tabIndex ?? 0);
  return candidate.visible !== false
    && candidate.hidden !== true
    && candidate.disabled !== true
    && (!Number.isFinite(tabIndex) || tabIndex > -1);
}

/**
 * Normalize one keyboard/focus observation — the focusable baseline plus the focus trail left
 * by the twelve trusted Tab presses — into the frozen risk families.  Pure and evidence-only:
 * an ordinary screen that cycles through its controls with a visible ring comes back empty, and
 * an invalid observation throws rather than reporting clean.
 */
export function classifyKeyboardFocusTrail(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new TypeError('keyboard/focus observation must be an object');
  }
  const { candidates, trail } = observation;
  if (!Array.isArray(candidates) || !Array.isArray(trail)) {
    throw new TypeError('keyboard/focus observation needs a candidates array and a trail array');
  }
  for (const [index, entry] of [...candidates.entries()]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`keyboard/focus candidate ${index} is not an object`);
    }
  }
  for (const [index, step] of trail.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new TypeError(`keyboard/focus trail step ${index} is not an object`);
    }
  }

  const risks = [];
  const reported = new Set();
  // One control can be hit by the same family on several presses; report the family once per
  // control so a twelve-press trail does not inflate a single defect into twelve findings.
  const add = (type, key, detail) => {
    const id = `${type}\u0000${key}`;
    if (reported.has(id)) return;
    reported.add(id);
    risks.push({ type, key, detail });
  };

  const byKey = new Map();
  candidates.forEach((candidate, index) => {
    const key = focusKey(candidate) || `#${index}`;
    if (!byKey.has(key)) byKey.set(key, candidate);
  });
  const reachable = candidates
    .map((candidate, index) => ({ key: focusKey(candidate) || `#${index}`, candidate }))
    .filter(({ candidate }) => isReachable(candidate));
  const visitedBeforeChromeHandoff = new Set();

  for (const [index, step] of trail.entries()) {
    const press = index + 1;
    const key = focusKey(step);
    if (isBodyStop(step)) {
      // An empty page has nowhere to put focus; body is the only honest answer there.
      const unvisited = reachable.filter(({ key: reachableKey }) => !visitedBeforeChromeHandoff.has(reachableKey));
      const returnsToPage = trail.slice(index + 1).some((laterStep) => !isBodyStop(laterStep));
      if (reachable.length > 0 && (unvisited.length > 0 || !returnsToPage)) {
        const detail = unvisited.length > 0
          ? `while ${unvisited.length} reachable control(s) remain`
          : 'without returning to a page control';
        add('keyboard-focus-lost', key || '(body)', `Tab ${press} dropped focus to the document body ${detail}`);
      }
      continue;
    }
    visitedBeforeChromeHandoff.add(key);
    const candidate = byKey.get(key);
    if (step.hidden === true || step.ariaHidden === true || step.visible === false) {
      add('keyboard-hidden-focus', key, `Tab ${press} focused "${key}", which is hidden from sight`);
    }
    if (step.indicator === false) {
      add('keyboard-no-focus-indicator', key, `Tab ${press} focused "${key}" with no visible focus indicator`);
    }
    if (step.withinViewport === false) {
      add('keyboard-offscreen-focus', key, `Tab ${press} focused "${key}" outside the viewport`);
    }
    if (step.disabled === true || candidate?.disabled === true) {
      add('keyboard-disabled-focus', key, `Tab ${press} focused "${key}", which is disabled`);
    }
    const tabIndex = Number(step.tabIndex ?? candidate?.tabIndex ?? 0);
    if (Number.isFinite(tabIndex) && tabIndex > 0) {
      add('keyboard-positive-tabindex', key, `"${key}" uses tabindex=${tabIndex} and reorders the natural flow`);
    }
    if (step.modalOpen === true && step.focusInsideModal === false) {
      add('keyboard-modal-focus-escape', key, `Tab ${press} moved focus to "${key}" outside the open modal`);
    }
  }

  for (let index = 1; index < trail.length; index += 1) {
    const previous = trail[index - 1];
    const current = trail[index];
    if (isBodyStop(previous) || isBodyStop(current)) continue;
    const key = focusKey(current);
    if (key && key === focusKey(previous)) {
      add('keyboard-duplicate-focus-stop', key, `Tab ${index + 1} left focus on "${key}" instead of advancing`);
    }
  }

  // Trap vs skip: both look like "the cycle closed without covering everything".  What separates
  // them is how many times the cycle closed — one closed cycle proves a control was skipped,
  // a cycle that keeps repeating over the same subset is a trap.  A trail that never closed a
  // cycle proves neither, and a modal that legitimately holds focus is not either one.
  const stops = trail.filter((step) => !isBodyStop(step)).map(focusKey).filter(Boolean);
  const modalHoldsFocus = trail.some((step) => step.modalOpen === true && step.focusInsideModal !== false);
  if (stops.length > 1 && reachable.length > 0 && !modalHoldsFocus) {
    const first = stops[0];
    const cycles = stops.slice(1).filter((key) => key === first).length;
    const visited = new Set(stops);
    const missed = reachable.map(({ key }) => key).filter((key) => !visited.has(key));
    if (cycles >= 1 && missed.length > 0) {
      if (cycles >= 2) {
        add('keyboard-focus-trap', first, `focus cycled ${cycles} times through ${visited.size} control(s) and never escaped to ${missed.join(', ')}`);
      } else {
        add('keyboard-skipped-control', missed[0], `the Tab cycle closed without ever focusing ${missed.join(', ')}`);
      }
    }
  }

  return risks;
}

/** Shared in-page helpers so the baseline and the focus snapshots key controls identically. */
const KEYBOARD_DOM_PRELUDE = `
  const FOCUSABLE = 'a[href],area[href],button,input,select,textarea,summary,iframe,[contenteditable="true"],[tabindex]';
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  };
  const label = (element) => String(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || element.getAttribute('name') || element.id || '')
    .trim().replace(/\\s+/g, ' ').slice(0, 60);
  const keyOf = (element, index) => (element.tagName.toLowerCase() + ':' + (element.id || label(element) || index)).toLowerCase();
  const tabIndexOf = (element) => {
    const raw = element.getAttribute('tabindex');
    const parsed = raw === null ? NaN : Number(raw);
    if (Number.isFinite(parsed)) return parsed;
    return Number.isFinite(element.tabIndex) ? element.tabIndex : 0;
  };
  const isDisabled = (element) => element.disabled === true || element.getAttribute('aria-disabled') === 'true';
  const isHidden = (element) => element.hasAttribute('hidden') || Boolean(element.closest('[aria-hidden="true"]'));
  const controls = () => [...document.querySelectorAll(FOCUSABLE)].filter((element) => tabIndexOf(element) > -1);
  const openModal = () => [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open]')].filter(isVisible)[0] || null;
`;

/** The pre-Tab read: every control the tab order is expected to be able to reach. */
export const KEYBOARD_BASELINE_SCRIPT = `(() => {${KEYBOARD_DOM_PRELUDE}
  return {
    url: location.href,
    candidates: controls().map((element, index) => ({
      key: keyOf(element, index),
      visible: isVisible(element),
      hidden: isHidden(element),
      disabled: isDisabled(element),
      tabIndex: tabIndexOf(element),
    })),
  };
})()`;

/** One post-Tab read: where focus actually landed, and whether that landing is usable. */
export const FOCUS_SNAPSHOT_SCRIPT = `(() => {${KEYBOARD_DOM_PRELUDE}
  const modal = openModal();
  const modalOpen = Boolean(modal);
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) {
    return { key: '', isBody: true, modalOpen, focusInsideModal: false };
  }
  const rect = active.getBoundingClientRect();
  const style = getComputedStyle(active);
  const outlineWidth = parseFloat(style.outlineWidth) || 0;
  return {
    key: keyOf(active, controls().indexOf(active)),
    isBody: false,
    visible: isVisible(active),
    hidden: isHidden(active),
    disabled: isDisabled(active),
    tabIndex: tabIndexOf(active),
    indicator: (style.outlineStyle !== 'none' && outlineWidth > 0)
      || (style.boxShadow !== 'none' && style.boxShadow !== ''),
    withinViewport: rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    modalOpen,
    focusInsideModal: modalOpen ? modal.contains(active) : false,
  };
})()`;

/**
 * The one `do` payload: baseline, then Tab/read, Tab/read … twelve times.  Every Tab is a
 * trusted `{key:"Tab"}` step — synthetic dispatch would not move real focus — and each read
 * sits immediately after its own press so the trail cannot be reordered or coalesced.
 */
export function keyboardFocusSteps() {
  const steps = [{ read: KEYBOARD_BASELINE_SCRIPT, as: BASELINE_ALIAS }];
  for (const alias of FOCUS_ALIASES) {
    steps.push({ key: 'Tab' });
    steps.push({ read: FOCUS_SNAPSHOT_SCRIPT, as: alias });
  }
  return steps;
}

/**
 * Pull the baseline and the twelve focus snapshots out of a `do` reply.  A missing, short or
 * failed read is an error rather than an empty (i.e. clean) trail.
 */
function pickObservation(reads) {
  if (!reads || typeof reads !== 'object' || Array.isArray(reads)) {
    throw new Error('Dragon returned no keyboard/focus reads');
  }
  const readAlias = (alias) => {
    const value = reads[alias];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Dragon returned no "${alias}" read`);
    }
    if (typeof value.__read_error === 'string') throw new Error(`Dragon "${alias}" read failed`);
    return value;
  };
  const baseline = readAlias(BASELINE_ALIAS);
  if (!Array.isArray(baseline.candidates)) {
    throw new Error('Dragon keyboard baseline returned no candidate list');
  }
  const trail = FOCUS_ALIASES.map(readAlias);
  if (trail.length !== TAB_PRESSES) {
    throw new Error(`Dragon returned ${trail.length} focus reads; expected ${TAB_PRESSES}`);
  }
  return { url: baseline.url, candidates: baseline.candidates, trail };
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((args.url ? 1 : 0) + (Number.isInteger(args.tabId) ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of --url or --tab-id');
  }
  // Fail before any useful work if the bearer token is unavailable.
  redactToken = rpcToken();

  const requestedSessionId = args.sessionId || `qa-gui-keyboard-focus-${randomUUID()}`;
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

    const measured = await rpc('do', { ...binding, tabId, steps: keyboardFocusSteps() });
    const observation = pickObservation(measured.reads);
    const risks = classifyKeyboardFocusTrail(observation);
    output = {
      tabId,
      observation,
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
