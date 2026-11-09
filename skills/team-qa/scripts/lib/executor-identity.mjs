// The GUI executor proves the build on its own tab (upgrade U1, step 4).
// A case-scoped claude-stream dispatch on a deployed target no longer waits for the root's dispatch-time identity read
// (`teamqa preflight build --stage execute --current`). The executor's own stream shows it instead: on a Dragon session
// the executor created, it opens the preview URL and, before any screenshot, reads that tab's identity with
// getPageIdentity (or getPageHtml) → getNetwork → getTabInfo, the first such reads on the tab. The checks are those of
// the preflight's current identity (lib/tool-preflight.mjs passiveIdentityChecks): one session triple and tab, the tab
// at the preview URL, the 300 s window, a 2xx/3xx backend request made in it, and the roster target's build kind, id
// and asset manifest. A dispatch whose stream does not prove it is not bound, and the attestation is checked again
// wherever it is used.
// Round G (G3): on a Dragon that has it, the executor opens the preview URL with openTab {url, proveIdentity:true} and
// the bridge makes the same three reads on the new tab inside that call; the answer's identity:{page,network,tab}
// counts as the triple, under the same checks, with each read timed inside the openTab call after the previous one. An
// openTab answer without identity is a Dragon without it: the three separate reads are then the proof.
import { fail } from './core.mjs';
import { streamCalls } from './web-collect.mjs';
import { dragonResult, passiveIdentityChecks, PASSIVE_PAGE_METHODS } from './tool-preflight.mjs';

const SESSION_KEYS = ['sessionId', 'nonce', 'browserInstanceId'];
const PASSIVE = [...PASSIVE_PAGE_METHODS, 'getNetwork', 'getTabInfo'];
const SHOTS = ['screenshot', 'captureTab'];
const refuse = (code, detail) => fail(3, `PREFLIGHT_${code}`, detail, 'ungraded');
const sameSession = (params, session) => SESSION_KEYS.every((k) => typeof params?.[k] === 'string' && params[k] === session[k]);
const answered = (c) => !c.error && c.json?.ok === true;

// A stream call as the passive checks read it; a failed or unanswered call is not evidence.
function usable(call) {
  if (!call.at || !call.called_at || !answered(call)) refuse('DRAGON_OPERATION', `${call.method} ${call.id}`);
  return { method: call.method, params: call.params, result: dragonResult(call.method, call.json), call_timestamp: call.called_at, output_timestamp: call.at };
}

// G3: the reads Dragon made inside openTab {proveIdentity:true}, as stream calls at the openTab's place. null when the
// answer has no identity (a Dragon without proveIdentity).
const INLINE = [['page', PASSIVE_PAGE_METHODS], ['network', ['getNetwork']], ['tab', ['getTabInfo']]];
function inlineReads(open, session, tabId) {
  const identity = open.json.result.identity;
  if (identity === undefined || identity === null) return null;
  const where = `openTab ${open.id} {proveIdentity}`;
  if (typeof identity !== 'object' || identity.ok !== true) refuse('DRAGON_OPERATION', `${where}: identity.ok is not true`);
  const answeredAt = Date.parse(open.at);
  let last = Date.parse(open.called_at);
  return INLINE.map(([key, methods]) => {
    const read = identity[key];
    if (!read || typeof read !== 'object' || !methods.includes(read.method)) {
      refuse('WEB_EXECUTOR_IDENTITY_SEQUENCE', `${where}: identity.${key} must be ${methods.join(' or ')}; found ${read?.method ?? 'none'}`);
    }
    if (!sameSession(read.params, session) || read.params.tabId !== tabId) refuse('WEB_EXECUTOR_IDENTITY_SEQUENCE', `${where}: identity.${key} is not a read of tab ${tabId} on the opening session`);
    const calledAt = Date.parse(read.called_at), readAt = Date.parse(read.answered_at);
    if (![calledAt, readAt, last, answeredAt].every(Number.isFinite) || calledAt < last || readAt < calledAt || readAt > answeredAt) {
      refuse('WEB_EXECUTOR_IDENTITY_ORDER', `${where}: identity.${key} is not timed inside the openTab call after the previous read`);
    }
    last = readAt;
    return { i: open.i, id: `${open.id}#identity.${key}`, method: read.method, params: read.params, json: { ok: true, result: read.result }, called_at: read.called_at, at: read.answered_at };
  });
}

function proveOnTab(reads, { calls, open, tabId, target }) {
  const [page, network, tab] = reads;
  if (reads.length < 3 || !PASSIVE_PAGE_METHODS.includes(page.method) || network.method !== 'getNetwork' || tab.method !== 'getTabInfo') {
    refuse('WEB_EXECUTOR_IDENTITY_SEQUENCE', `the first reads on tab ${tabId} must be getPageIdentity (or getPageHtml) → getNetwork → getTabInfo, or openTab {proveIdentity:true}; found ${reads.map((c) => c.method).join(' → ') || 'none'}`);
  }
  const checked = passiveIdentityChecks({ page: usable(page), tab: usable(tab), network: () => usable(network) }, { target });
  const o = checked.observation;
  if (o.frontend_build.kind !== target.frontend_build.kind || o.frontend_build.id !== target.frontend_build.id || o.asset_manifest_sha256 !== target.asset_manifest_sha256) {
    refuse('WEB_CURRENT_BUILD', `the executor's tab shows ${o.frontend_build.kind}:${o.frontend_build.id}, the target is ${target.frontend_build.kind}:${target.frontend_build.id}`);
  }
  const early = calls.find((c) => SHOTS.includes(c.method) && c.i < tab.i);
  if (early) refuse('WEB_EXECUTOR_IDENTITY_ORDER', `${early.method} ${early.id} comes before the identity read on tab ${tabId}`);
  return { ...checked, calls: { open: open.id, page: page.id, network: network.id, tab: tab.id } };
}

export function executorIdentity({ stream, target }) {
  const calls = [...streamCalls(stream).values()].filter((c) => c.method && /dragon/i.test(c.name ?? '')).sort((a, b) => a.i - b.i);
  const sessions = calls.filter((c) => c.method === 'session.create' && answered(c) && typeof c.json.result?.sessionId === 'string')
    .map((c) => Object.fromEntries(SESSION_KEYS.map((k) => [k, c.json.result[k]])));
  const opened = calls.filter((c) => c.method === 'openTab' && answered(c) && Number.isInteger(c.json.result?.tabId)
    && c.params?.url === target.preview_url && sessions.some((s) => sameSession(c.params, s)));
  if (!opened.length) refuse('WEB_EXECUTOR_IDENTITY_MISSING', `no openTab of ${target.preview_url} on a Dragon session the executor created`);
  let first = null;
  for (const open of opened) {
    const session = Object.fromEntries(SESSION_KEYS.map((k) => [k, open.params[k]])), tabId = open.json.result.tabId;
    const separate = calls.filter((c) => c.i > open.i && PASSIVE.includes(c.method) && sameSession(c.params, session) && c.params.tabId === tabId).slice(0, 3);
    // G3: the triple inside openTab {proveIdentity} first; the separate reads on the tab stay a proof of their own (a
    // Dragon without proveIdentity, or an inline triple taken before the sign-in the app needed to call its backend).
    const inline = open.params?.proveIdentity === true && open.json.result.identity != null;
    const tries = [...(inline ? [() => inlineReads(open, session, tabId)] : []), ...(!inline || separate.length ? [() => separate] : [])];
    for (const readsOf of tries) {
      try {
        return proveOnTab(readsOf(), { calls, open, tabId, target });
      } catch (error) {
        if (!String(error?.code ?? '').startsWith('PREFLIGHT_')) throw error;
        first ??= error;
      }
    }
  }
  throw first;
}
