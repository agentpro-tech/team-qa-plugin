// The GUI executor proves the build on its own tab (upgrade U1, step 4).
// A case-scoped claude-stream dispatch on a deployed target no longer waits for the root's dispatch-time identity read
// (`teamqa preflight build --stage execute --current`). The executor's own stream shows it instead: on a Dragon session
// the executor created, it opens the preview URL and, before any screenshot, reads that tab's identity with
// getPageIdentity (or getPageHtml) → getNetwork → getTabInfo, the first such reads on the tab. The checks are those of
// the preflight's current identity (lib/tool-preflight.mjs passiveIdentityChecks): one session triple and tab, the tab
// at the preview URL, the 300 s window, a 2xx/3xx backend request made in it, and the roster target's build kind, id
// and asset manifest. A dispatch whose stream does not prove it is not bound, and the attestation is checked again
// wherever it is used.
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
    const reads = calls.filter((c) => c.i > open.i && PASSIVE.includes(c.method) && sameSession(c.params, session) && c.params.tabId === tabId).slice(0, 3);
    try {
      const [page, network, tab] = reads;
      if (reads.length < 3 || !PASSIVE_PAGE_METHODS.includes(page.method) || network.method !== 'getNetwork' || tab.method !== 'getTabInfo') {
        refuse('WEB_EXECUTOR_IDENTITY_SEQUENCE', `the first reads on tab ${tabId} must be getPageIdentity (or getPageHtml) → getNetwork → getTabInfo; found ${reads.map((c) => c.method).join(' → ') || 'none'}`);
      }
      const checked = passiveIdentityChecks({ page: usable(page), tab: usable(tab), network: () => usable(network) }, { target });
      const o = checked.observation;
      if (o.frontend_build.kind !== target.frontend_build.kind || o.frontend_build.id !== target.frontend_build.id || o.asset_manifest_sha256 !== target.asset_manifest_sha256) {
        refuse('WEB_CURRENT_BUILD', `the executor's tab shows ${o.frontend_build.kind}:${o.frontend_build.id}, the target is ${target.frontend_build.kind}:${target.frontend_build.id}`);
      }
      const early = calls.find((c) => SHOTS.includes(c.method) && c.i < tab.i);
      if (early) refuse('WEB_EXECUTOR_IDENTITY_ORDER', `${early.method} ${early.id} comes before the identity read on tab ${tabId}`);
      return { ...checked, calls: { open: open.id, page: page.id, network: network.id, tab: tab.id } };
    } catch (error) {
      if (!String(error?.code ?? '').startsWith('PREFLIGHT_')) throw error;
      first ??= error;
    }
  }
  throw first;
}
