#!/usr/bin/env node

// Read-only Dragon preflight for controls that render but cannot receive the intended pointer action.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDirectExecution } from './lib/is-direct-execution.mjs';

const RPC = process.env.DRAGON_RPC || 'http://localhost:9233/rpc';
const STABLE_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'service-token');
const LEGACY_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'token');
const RPC_TIMEOUT_MS = 15_000;
const SNAPSHOT_ALIAS = 'actionabilitySnapshot';

let redactToken = '';

function rpcToken() {
  const fromEnv = String(process.env.DRAGON_RPC_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const tokenFiles = process.env.DRAGON_RPC_TOKEN_FILE
    ? [process.env.DRAGON_RPC_TOKEN_FILE]
    : [STABLE_TOKEN_FILE, LEGACY_TOKEN_FILE];
  for (const tokenFile of tokenFiles) {
    try {
      const value = readFileSync(tokenFile, 'utf8').trim();
      if (value) return value;
    } catch {}
  }
  throw new Error('Dragon bearer token is missing; set DRAGON_RPC_TOKEN or DRAGON_RPC_TOKEN_FILE');
}

function safeMessage(error, token = redactToken) {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.split(token).join('[redacted]') : message;
}

function targetKey(target, index) {
  const key = target.key ?? target.id ?? target.selector ?? target.label ?? `#${index}`;
  return typeof key === 'string' ? key.trim() : String(key);
}

/** Normalize one measured snapshot into the frozen actionability risk families. */
export function classifyActionabilityObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new TypeError('actionability observation must be an object');
  }
  if (!Array.isArray(observation.targets)) {
    throw new TypeError('actionability observation needs a targets array');
  }
  observation.targets.forEach((target, index) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new TypeError(`actionability target ${index} is not an object`);
    }
  });

  const risks = [];
  const reported = new Set();
  const add = (type, key, detail) => {
    const id = JSON.stringify([type, key]);
    if (reported.has(id)) return;
    reported.add(id);
    risks.push({ type, key, detail });
  };

  observation.targets.forEach((target, index) => {
    if (target.expectedActionable === false || target.visible === false) return;
    const key = targetKey(target, index);
    const reachableByScroll = target.clipping?.reachableByScroll === true;
    if (target.pointerEvents === 'none') {
      add('action-pointer-events-none', key, `"${key}" renders with pointer-events:none`);
    }
    if (target.inert === true) {
      add('action-inert-control', key, `"${key}" is inside an inert subtree`);
    }

    const explicitArea = target.actionableArea;
    const rectArea = target.rect && Number(target.rect.width) * Number(target.rect.height);
    const actionableArea = explicitArea === undefined ? rectArea : Number(explicitArea);
    if (!reachableByScroll && Number.isFinite(actionableArea) && actionableArea <= 0) {
      add('action-zero-area', key, `"${key}" has no measurable actionable area`);
    }

    const hitTest = target.hitTest;
    if (!reachableByScroll && hitTest && typeof hitTest === 'object' && !Array.isArray(hitTest)) {
      const sampled = Number(hitTest.sampledPoints);
      const matching = Number(hitTest.matchingPoints);
      if (Number.isFinite(sampled) && sampled > 0 && matching === 0) {
        add('action-fully-occluded', key, `all ${sampled} sampled hit points for "${key}" are intercepted`);
      } else if (Number.isFinite(sampled) && sampled > 0 && hitTest.centerMatches === false) {
        add('action-center-occluded', key, `the center point of "${key}" is intercepted`);
      }

      const blocker = hitTest.blocker;
      if (blocker && typeof blocker === 'object' && !Array.isArray(blocker)) {
        const blockerKey = targetKey(blocker, 0) || '(unknown blocker)';
        if (blocker.position === 'fixed') {
          add('action-fixed-overlay-occlusion', key, `fixed overlay "${blockerKey}" intercepts "${key}"`);
        }
        if (blocker.position === 'sticky' && blocker.region === 'header') {
          add('action-sticky-header-occlusion', key, `sticky header "${blockerKey}" intercepts "${key}"`);
        }
        if (blocker.modalBackdrop === true) {
          add('action-modal-backdrop-occlusion', key, `an open modal backdrop intercepts "${key}"`);
        }
      }
    }

    const visibleRatio = Number(target.clipping?.visibleRatio);
    if (!reachableByScroll && target.clipping?.clipped === true && Number.isFinite(visibleRatio) && visibleRatio < 0.5) {
      const ancestor = target.clipping.ancestor || 'an overflow ancestor';
      add('action-overflow-clipped', key, `"${key}" is only ${Math.round(visibleRatio * 100)}% visible inside ${ancestor}`);
    }
    if (observation.scrollLocked === true && target.outsideViewport === true) {
      add('action-scroll-locked-unreachable', key, `"${key}" is outside the viewport while page scrolling is locked`);
    }
  });

  return risks;
}

/** One in-page read: geometry, hit testing, clipping, and scroll reachability. */
export const ACTIONABILITY_SNAPSHOT_SCRIPT = `(() => {
  const SELECTOR = 'button,input,select,textarea,a[href],summary,[role="button"],[role="link"],[contenteditable="true"],[tabindex]';
  const styleOf = (element) => getComputedStyle(element);
  const label = (element) => String(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || element.getAttribute('name') || element.id || '')
    .trim().replace(/\\s+/g, ' ').slice(0, 60);
  const keyOf = (element, index) => (element.tagName.toLowerCase() + ':' + (element.id || label(element) || index)).toLowerCase();
  const isDisabled = (element) => element.disabled === true || element.getAttribute('aria-disabled') === 'true';
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = styleOf(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none'
      && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  };
  const intersection = (a, b) => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const area = (rect) => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
  const clippingOf = (element, rect) => {
    let visibleRect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    let ancestor = element.parentElement;
    let clippingAncestor = null;
    let scrollable = false;
    let hardClipped = false;
    while (ancestor && ancestor !== document.documentElement) {
      const style = styleOf(ancestor);
      const overflowX = style.overflowX || style.overflow || 'visible';
      const overflowY = style.overflowY || style.overflow || 'visible';
      if (/(auto|scroll|hidden|clip)/.test(overflowX + ' ' + overflowY)) {
        const ancestorRect = ancestor.getBoundingClientRect();
        const clippedX = visibleRect.left < ancestorRect.left || visibleRect.right > ancestorRect.right;
        const clippedY = visibleRect.top < ancestorRect.top || visibleRect.bottom > ancestorRect.bottom;
        const nextVisibleRect = intersection(visibleRect, ancestorRect);
        if (area(nextVisibleRect) < area(visibleRect)) {
          clippingAncestor ||= ancestor;
          scrollable ||= (clippedX && /(auto|scroll)/.test(overflowX))
            || (clippedY && /(auto|scroll)/.test(overflowY));
          hardClipped ||= (clippedX && /(hidden|clip)/.test(overflowX))
            || (clippedY && /(hidden|clip)/.test(overflowY));
        }
        visibleRect = nextVisibleRect;
      }
      ancestor = ancestor.parentElement;
    }
    const fullArea = Math.max(0, rect.width * rect.height);
    const visibleArea = area(visibleRect);
    return {
      clipped: fullArea > 0 && visibleArea < fullArea,
      visibleRatio: fullArea > 0 ? visibleArea / fullArea : 0,
      ancestor: clippingAncestor ? keyOf(clippingAncestor, 0) : '',
      visibleArea,
      scrollable,
      hardClipped,
      reachableByScroll: fullArea > 0 && visibleArea < fullArea && scrollable && !hardClipped,
    };
  };
  const blockerOf = (blocker, openModal, target) => {
    if (!blocker) return null;
    let layer = blocker;
    for (let ancestor = blocker; ancestor; ancestor = ancestor.parentElement) {
      if (/^(fixed|sticky)$/.test(styleOf(ancestor).position)) {
        layer = ancestor;
        break;
      }
      if (ancestor === document.body) break;
    }
    const style = styleOf(layer);
    const rect = layer.getBoundingClientRect();
    const region = rect.bottom <= innerHeight / 3 ? 'header'
      : rect.top >= innerHeight * 2 / 3 ? 'footer' : 'content';
    const blockerMarksModal = blocker === openModal || openModal?.contains(blocker)
      || Boolean(blocker.closest?.('[data-backdrop],.backdrop,[aria-modal="true"],[role="dialog"],dialog'));
    return {
      key: keyOf(layer, 0),
      position: style.position,
      region,
      modalBackdrop: Boolean(openModal && !openModal.contains(target) && blockerMarksModal),
    };
  };
  const openModal = [...document.querySelectorAll('[aria-modal="true"],[role="dialog"],dialog[open]')].find(isVisible) || null;
  const viewportRect = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const rootStyle = styleOf(document.documentElement);
  const bodyStyle = styleOf(document.body);
  const scrollLocked = /(hidden|clip)/.test(rootStyle.overflowY + ' ' + bodyStyle.overflowY)
    && Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) > innerHeight;
  const targets = [...document.querySelectorAll(SELECTOR)].map((element, index) => {
    const rect = element.getBoundingClientRect();
    const style = styleOf(element);
    const clipping = clippingOf(element, rect);
    const insetX = Math.min(4, Math.max(0, rect.width / 4));
    const insetY = Math.min(4, Math.max(0, rect.height / 4));
    const center = [rect.left + rect.width / 2, rect.top + rect.height / 2];
    const points = [
      center,
      [rect.left + insetX, rect.top + insetY],
      [rect.right - insetX, rect.top + insetY],
      [rect.left + insetX, rect.bottom - insetY],
      [rect.right - insetX, rect.bottom - insetY],
    ].filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
    const matches = (hit) => Boolean(hit && (hit === element || element.contains(hit)));
    const hits = points.map(([x, y]) => document.elementFromPoint(x, y));
    const centerInViewport = center[0] >= 0 && center[1] >= 0 && center[0] < innerWidth && center[1] < innerHeight;
    const centerHit = centerInViewport ? document.elementFromPoint(center[0], center[1]) : null;
    const centerMatches = centerInViewport ? matches(centerHit) : null;
    const blocker = centerMatches === false ? centerHit : null;
    return {
      key: keyOf(element, index),
      expectedActionable: !isDisabled(element),
      visible: isVisible(element),
      pointerEvents: style.pointerEvents,
      inert: Boolean(element.closest('[inert]')),
      rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      actionableArea: clipping.visibleArea,
      outsideViewport: area(intersection(rect, viewportRect)) === 0,
      clipping: {
        clipped: clipping.clipped,
        visibleRatio: clipping.visibleRatio,
        ancestor: clipping.ancestor,
        scrollable: clipping.scrollable,
        hardClipped: clipping.hardClipped,
        reachableByScroll: clipping.reachableByScroll,
      },
      hitTest: {
        sampledPoints: points.length,
        matchingPoints: hits.filter(matches).length,
        centerMatches,
        blocker: blockerOf(blocker, openModal, element),
      },
    };
  });
  return { url: location.href, viewport: { width: innerWidth, height: innerHeight }, scrollLocked, targets };
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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
  if (result?.ok === false) {
    throw new Error(safeMessage(`${method}: ${result.code || 'DENIED'} — ${result.reason || result.error || 'Dragon denied the call'}`, token));
  }
  const failedStep = Array.isArray(result?.results) ? result.results.find((step) => step?.ok === false) : null;
  if (failedStep) {
    throw new Error(safeMessage(`${method}: ${failedStep.code || 'STEP_FAILED'} — ${failedStep.reason || failedStep.error || 'Dragon denied a step'}`, token));
  }
  if (result === undefined || result === null) throw new Error(`Dragon RPC ${method} returned no result`);
  return result;
}

function pickObservation(reads) {
  if (!reads || typeof reads !== 'object' || Array.isArray(reads)) {
    throw new Error('Dragon returned no actionability reads');
  }
  const observation = reads[SNAPSHOT_ALIAS];
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new Error(`Dragon returned no "${SNAPSHOT_ALIAS}" read`);
  }
  if (typeof observation.__read_error === 'string') {
    throw new Error(`Dragon "${SNAPSHOT_ALIAS}" read failed`);
  }
  if (!Array.isArray(observation.targets)) {
    throw new Error('Dragon actionability snapshot returned no targets array');
  }
  return observation;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((args.url ? 1 : 0) + (Number.isInteger(args.tabId) ? 1 : 0) !== 1) {
    throw new Error('Provide exactly one of --url or --tab-id');
  }
  redactToken = rpcToken();

  const requestedSessionId = args.sessionId || `qa-gui-actionability-${randomUUID()}`;
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

    const measured = await rpc('do', {
      ...binding,
      tabId,
      steps: [{ read: ACTIONABILITY_SNAPSHOT_SCRIPT, as: SNAPSHOT_ALIAS }],
    });
    const observation = pickObservation(measured.reads);
    const risks = classifyActionabilityObservation(observation);
    output = { tabId, observation, risks, verdict: risks.length ? 'FAIL' : 'PASS' };
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

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error(safeMessage(error));
    process.exitCode = 1;
  });
}
