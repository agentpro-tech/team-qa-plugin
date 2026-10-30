import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { executorIdentity } from '../../scripts/lib/executor-identity.mjs';
import { passiveHtmlParts } from '../../scripts/lib/tool-preflight.mjs';

// Upgrade U1, step 4: a case-scoped GUI dispatch on a deployed target proves the build on the executor's own tab, in its
// own stream (Claude Code 2.1.311 stream-json shapes; synthetic fixtures, never evidence of a live QA run).
const PREVIEW = 'http://127.0.0.1:5401/intro', BACKEND = 'http://127.0.0.1:5411', BUILD = 'index-CJjkO35e';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const SESSION = { sessionId: 'exec-session', nonce: 'exec-nonce', browserInstanceId: 'browser-9' }, TAB = 31;
const TARGET = { project_id: 'sample-shop-local', preview_url: PREVIEW, version: BUILD, kind: 'deployed-build', environment: 'Local', backend_origin: BACKEND,
  frontend_build: { kind: 'vite', id: BUILD }, asset_manifest_sha256: sha(JSON.stringify({ kind: 'vite-html-assets/v1', entry: 'http://127.0.0.1:5401/assets/index-CJjkO35e.js' })) };
const html = (entry = 'index-CJjkO35e') => `<html lang="vi"><head><script type="module" crossorigin src="/assets/${entry}.js"></script>`
  + '<link rel="stylesheet" href="/assets/index-COs_Fa8L.css"></head><body><div id="root">About</div></body></html>';
function identityRead(value, extra = {}) {
  const contentHash = 'sha256:' + sha(value), ref = 'observation:' + contentHash.slice(7);
  return { v: 1, html_sha256: sha(value), html_length: value.length, html_bytes: Buffer.byteLength(value),
    complete: /^<html\b/i.test(value.trim()) && /<\/html>\s*$/i.test(value), truncated: false, ...passiveHtmlParts(value), omitted: 0,
    evidence: { v: 1, kind: 'dom', ts: 1, correlationId: null, contentHash, ref }, telemetry: { durMs: 3, bytesOut: 400, terminalReason: 'complete', retryable: false, evidenceRef: ref }, ...extra };
}
const summary = (t, origin = BACKEND, status = 200) => ({ summary: true, count: 1, cursor: t, truncated: false, omitted: 0,
  origins: [{ origin, ok: status < 400 ? 1 : 0, failed: status < 400 ? 0 : 1, other: 0, last_ok_t: status < 400 ? t : null }],
  evidence: { v: 1, kind: 'network', ts: t, correlationId: null, contentHash: 'sha256:' + 'a'.repeat(64), ref: 'observation:' + 'a'.repeat(64), meta: { cursor: t, truncated: false, omitted: 0 } } });

// A claude -p stream: each call is an assistant tool_use line and a user tool_result line, one second apart by default.
class Stream {
  constructor() { this.t = Date.parse('2026-10-29T03:00:00.000Z'); this.lines = [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'exec' })]; this.n = 0; }
  tick(ms = 1000) { this.t += ms; return new Date(this.t).toISOString(); }
  call(name, input, body, { isError = false, wait = 200 } = {}) {
    const id = `toolu_${++this.n}`;
    this.lines.push(JSON.stringify({ type: 'assistant', session_id: 'exec', timestamp: this.tick(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }));
    this.lines.push(JSON.stringify({ type: 'user', session_id: 'exec', timestamp: this.tick(wait), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(body) }], ...(isError ? { is_error: true } : {}) }] } }));
    return id;
  }
  rpc(method, params, result, options) { return this.call('mcp__Dragon_Browser__dragon_rpc', { method, params }, { ok: true, result }, options); }
  text() { return this.lines.join('\n') + '\n'; }
}
function run(o = {}) {
  const s = new Stream(), session = o.session ?? SESSION;
  s.rpc('session.create', { sessionId: session.sessionId, forbidSyntheticDOM: false }, { ...session, forbidSyntheticDOM: false, policy: { requireTrusted: true } });
  s.rpc('openTab', { ...(o.openSession ?? session), url: o.url ?? PREVIEW, active: false }, { tabId: TAB });
  if (o.shotFirst) s.rpc('screenshot', { ...session, tabId: TAB }, { savedTo: '/tmp/x.png', privacyMasked: true });
  if (o.login) s.rpc('do', { ...session, tabId: TAB, steps: [{ click: 'Log in' }] }, { ok: true, completed: true, results: [] });
  for (const method of o.order ?? [o.full ? 'getPageHtml' : 'getPageIdentity', 'getNetwork', 'getTabInfo']) {
    if (method === 'getPageIdentity') s.rpc('getPageIdentity', { ...session, tabId: TAB }, o.identity ?? identityRead(html(o.entry)), o.page);
    if (method === 'getPageHtml') s.rpc('getPageHtml', { ...session, tabId: TAB, maxLength: 1048576 }, html(o.entry));
    if (method === 'getNetwork') {
      const t = s.t - (o.requestAge ?? 1500);
      if (o.full) s.rpc('getNetwork', { ...session, tabId: TAB }, { count: 1, requests: [{ t, url: `${BACKEND}/rest/v1/x`, status: 200 }], cursor: t, truncated: false, omitted: 0 });
      else s.rpc('getNetwork', { ...session, tabId: TAB, summary: true }, o.network ?? summary(t, o.backend));
    }
    if (method === 'getTabInfo') { if (o.gap) s.tick(o.gap); s.rpc('getTabInfo', { ...session, tabId: TAB }, { tabId: TAB, url: o.tabUrl ?? PREVIEW, title: 'Sample Shop' }); }
  }
  s.rpc('screenshot', { ...session, tabId: TAB }, { savedTo: '/tmp/state.png', privacyMasked: true });
  return s.text();
}
const refused = (stream, code) => assert.throws(() => executorIdentity({ stream, target: TARGET }), (e) => e.code === code, code);

test('the executor proves the target build on its own tab with the compact reads, after logging in', () => {
  const proved = executorIdentity({ stream: run({ login: true }), target: TARGET });
  assert.deepEqual(proved.observation.frontend_build, { kind: 'vite', id: BUILD });
  assert.equal(proved.observation.asset_manifest_sha256, TARGET.asset_manifest_sha256);
  assert.equal(proved.observation.backend_origin, BACKEND);
  assert.deepEqual(proved.session, SESSION);
  assert.equal(proved.tabId, TAB);
  assert.deepEqual(Object.keys(proved.calls), ['open', 'page', 'network', 'tab']);
  // The whole HTML and request list are the same reads.
  assert.equal(executorIdentity({ stream: run({ full: true }), target: TARGET }).observation.frontend_build.id, BUILD);
});

test('the executor identity is refused with the code of the check that fails', () => {
  refused(run({ entry: 'index-OtHeRbLd' }), 'PREFLIGHT_WEB_CURRENT_BUILD');
  refused(run({ backend: 'http://127.0.0.1:9999' }), 'PREFLIGHT_WEB_BACKEND_OBSERVATION');
  refused(run({ requestAge: 301000 }), 'PREFLIGHT_WEB_BACKEND_OBSERVATION');
  refused(run({ shotFirst: true }), 'PREFLIGHT_WEB_EXECUTOR_IDENTITY_ORDER');
  refused(run({ order: ['getNetwork', 'getPageIdentity', 'getTabInfo'] }), 'PREFLIGHT_WEB_EXECUTOR_IDENTITY_SEQUENCE');
  refused(run({ order: ['getPageIdentity', 'getTabInfo'] }), 'PREFLIGHT_WEB_EXECUTOR_IDENTITY_SEQUENCE');
  refused(run({ url: 'http://127.0.0.1:5401/auth' }), 'PREFLIGHT_WEB_EXECUTOR_IDENTITY_MISSING');
  refused(run({ openSession: { sessionId: 'root-session', nonce: 'root-nonce', browserInstanceId: 'browser-9' } }), 'PREFLIGHT_WEB_EXECUTOR_IDENTITY_MISSING');
  refused(run({ tabUrl: 'http://127.0.0.1:5401/auth' }), 'PREFLIGHT_WEB_PASSIVE_URL');
  refused(run({ gap: 301000 }), 'PREFLIGHT_WEB_PASSIVE_ORDER');
  refused(run({ identity: identityRead(html().replace('</html>', '')) }), 'PREFLIGHT_WEB_PASSIVE_HTML');
  refused(run({ identity: identityRead(html(), { omitted: 2 }) }), 'PREFLIGHT_WEB_PASSIVE_HTML');
  refused(run({ identity: identityRead(html().replace('</head>', '<script type="module" src="/assets/admin-QwErTy12.js"></script></head>')) }), 'PREFLIGHT_WEB_PASSIVE_VITE_ENTRY');
  refused(run({ network: { ...summary(Date.now()), truncated: true } }), 'PREFLIGHT_WEB_PASSIVE_NETWORK');
  refused(run({ page: { isError: true } }), 'PREFLIGHT_DRAGON_OPERATION');
  refused(new Stream().text(), 'PREFLIGHT_WEB_EXECUTOR_IDENTITY_MISSING');
});
