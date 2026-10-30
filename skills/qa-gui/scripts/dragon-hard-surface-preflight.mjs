#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDirectExecution } from './lib/is-direct-execution.mjs';

const RPC = process.env.DRAGON_RPC || 'http://localhost:9233/rpc';
const STABLE_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'service-token');
const LEGACY_TOKEN_FILE = join(homedir(), '.dragon-browser', 'auth', 'token');
const RPC_TIMEOUT_MS = 15_000;

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

function safeMessage(error, token = '') {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.split(token).join('[redacted]') : message;
}

/**
 * Return the hard GUI surfaces indicated by a Dragon snapshot.  The checks are
 * deliberately evidence-based, so an ordinary semantic page does not get a
 * synthetic hard-surface warning.
 */
export function classifyHardSurfaces(snapshot = {}) {
  const risks = [];
  const add = (type) => risks.push({ type });

  if (snapshot.csp?.scriptEvalBlocked || snapshot.csp?.policy?.includes("script-src 'none'")) add('csp-restricted');
  if (snapshot.iframes?.some((frame) => frame.sameOrigin === false && frame.interactive === true)) add('cross-origin-iframe');
  if (snapshot.shadowRoots?.some((root) => root.mode === 'open' && Number(root.interactiveCount) > 0)) add('open-shadow-root');
  if (snapshot.shadowRoots?.some((root) => root.mode === 'closed' && root.hostInteractive === true)) add('closed-shadow-root');
  if (snapshot.canvases?.some((canvas) => canvas.interactive === true && canvas.semanticFallback === false && canvas.pointerHandler === true)) add('canvas-only-control');
  if (snapshot.dragDrop?.some((item) => item.requiresTrustedPointer === true && item.dropTarget === true)) add('trusted-drag-drop');
  if (snapshot.virtualization?.windowed === true
    && Number(snapshot.virtualization.totalItems) > Number(snapshot.virtualization.renderedItems)) add('virtualized-list');
  if (snapshot.overlays?.some((overlay) => overlay.portaled === true && overlay.modal === true && overlay.ownsFocus === true)) add('portaled-overlay');
  if (snapshot.fileInputs?.some((input) => input.nativePicker === true && input.required === true)) add('native-file-picker');
  if (snapshot.editables?.some((editable) => editable.contentEditable === true && editable.customModel === true && editable.richText === true)) add('custom-contenteditable');

  return risks;
}

export const HARD_SURFACE_SNAPSHOT_SCRIPT = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const interactiveSelector = 'button,input,select,textarea,a[href],[role="button"],[tabindex]';
  const cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
  const cspPolicy = cspMeta?.content || '';
  const iframes = [...document.querySelectorAll('iframe')].filter(visible).map((frame) => {
    let sameOrigin = false;
    let interactive = true;
    try {
      sameOrigin = new URL(frame.src || '', location.href).origin === location.origin;
      interactive = !sameOrigin || Boolean(frame.contentDocument?.querySelector(interactiveSelector));
    } catch {}
    return { sameOrigin, interactive, src: frame.src || '' };
  });
  const shadowRoots = [];
  for (const host of document.querySelectorAll('*')) {
    if (host.shadowRoot) {
      shadowRoots.push({ mode: 'open', interactiveCount: host.shadowRoot.querySelectorAll(interactiveSelector).length });
    } else if (host.getAttribute('data-shadow-mode') === 'closed') {
      shadowRoots.push({ mode: 'closed', hostInteractive: visible(host) });
    }
  }
  const canvases = [...document.querySelectorAll('canvas')].filter(visible).map((canvas) => ({
    interactive: canvas.tabIndex >= 0 || canvas.getAttribute('role') === 'button' || Boolean(canvas.getAttribute('aria-label')) || typeof canvas.onclick === 'function',
    semanticFallback: Boolean(canvas.querySelector(interactiveSelector)),
    pointerHandler: canvas.tabIndex >= 0 || Boolean(canvas.getAttribute('aria-label')) || typeof canvas.onclick === 'function',
  }));
  const dragSources = [...document.querySelectorAll('[draggable="true"]')].filter(visible);
  const dropTargets = [...document.querySelectorAll('[data-drop-target], [aria-dropeffect], #drop')].filter(visible);
  const dragDrop = dragSources.length || dropTargets.length
    ? [{ requiresTrustedPointer: dragSources.length > 0, dropTarget: dropTargets.length > 0 }]
    : [];
  let virtualization = { windowed: false, totalItems: 0, renderedItems: 0 };
  const virtualHost = document.querySelector('[data-total-items], [aria-setsize]');
  if (virtualHost) {
    const totalItems = Number(virtualHost.getAttribute('data-total-items') || virtualHost.getAttribute('aria-setsize') || 0);
    const renderedItems = virtualHost.children.length;
    virtualization = { windowed: totalItems > renderedItems, totalItems, renderedItems };
  }
  const overlays = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible).map((overlay) => ({
    portaled: overlay.parentElement === document.body,
    modal: overlay.getAttribute('aria-modal') === 'true',
    ownsFocus: Boolean(overlay.querySelector(interactiveSelector)),
  }));
  const fileInputs = [...document.querySelectorAll('input[type="file"]')].filter(visible).map((input) => ({
    nativePicker: true,
    required: input.required,
  }));
  const editables = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible).map((editable) => ({
    contentEditable: true,
    customModel: Boolean(editable.getAttribute('data-custom-model')),
    richText: editable.getAttribute('contenteditable') !== 'plaintext-only',
  }));
  return {
    csp: { scriptEvalBlocked: /script-src\\s+['\"]?none/i.test(cspPolicy), policy: cspPolicy },
    iframes,
    shadowRoots,
    canvases,
    dragDrop,
    virtualization,
    overlays,
    fileInputs,
    editables,
  };
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

  const requestedSessionId = args.sessionId || `qa-gui-hard-surface-${randomUUID()}`;
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
    if (args.url) {
      const opened = await rpc('openTab', {
        url: args.url,
        active: false,
        sessionId,
        nonce: session.nonce,
        browserInstanceId: session.browserInstanceId,
      });
      if (!Number.isInteger(opened.tabId)) throw new Error('Dragon openTab returned no tabId');
      tabId = opened.tabId;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
      await rpc('waitForState', {
        tabId,
        sessionId,
        nonce: session.nonce,
        browserInstanceId: session.browserInstanceId,
        state: 'complete',
        timeoutMs: 10_000,
      });
    }
    const snapshotResult = await rpc('do', {
      tabId,
      sessionId,
      nonce: session.nonce,
      browserInstanceId: session.browserInstanceId,
      steps: [{ read: HARD_SURFACE_SNAPSHOT_SCRIPT, as: 'hardSurfaceSnapshot' }],
    });
    if (!Object.hasOwn(snapshotResult.reads || {}, 'hardSurfaceSnapshot')) {
      throw new Error('Dragon snapshot read returned no hardSurfaceSnapshot');
    }
    let snapshot = snapshotResult.reads.hardSurfaceSnapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('Dragon hardSurfaceSnapshot is not an object');
    }
    if (typeof snapshot.__read_error === 'string') {
      if (/content security policy|unsafe-eval|script-src/i.test(snapshot.__read_error)) {
        snapshot = { csp: { scriptEvalBlocked: true, policy: 'Dragon page evaluation blocked by CSP' } };
      } else {
        throw new Error('Dragon hardSurfaceSnapshot read failed');
      }
    }
    const nativeSnapshot = snapshotResult.snapshot || {};
    if (Number(nativeSnapshot.crossOriginFrames) > 0 && !(snapshot.iframes || []).some((frame) => frame.sameOrigin === false)) {
      snapshot.iframes = [...(snapshot.iframes || []), { sameOrigin: false, interactive: true, source: 'dragon-snapshot' }];
    }
    if (Number(nativeSnapshot.shadowClosed) > 0 && !(snapshot.shadowRoots || []).some((root) => root.mode === 'closed')) {
      snapshot.shadowRoots = [...(snapshot.shadowRoots || []), { mode: 'closed', hostInteractive: true, source: 'dragon-snapshot' }];
    }
    if (Number(nativeSnapshot.canvasRegions) > 0 && !(snapshot.canvases || []).some((canvas) => canvas.interactive && !canvas.semanticFallback)) {
      snapshot.canvases = [...(snapshot.canvases || []), { interactive: true, semanticFallback: false, pointerHandler: true, source: 'dragon-snapshot' }];
    }
    output = {
      tabId,
      risks: classifyHardSurfaces(snapshot),
      observation: snapshot,
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
  if (output) console.log(args.json ? JSON.stringify(output) : JSON.stringify(output, null, 2));
  if (taskError) {
    if (cleanupError) taskError.message = `${taskError.message}; cleanup failed: ${cleanupError.message}`;
    throw taskError;
  }
  if (cleanupError) throw cleanupError;
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
