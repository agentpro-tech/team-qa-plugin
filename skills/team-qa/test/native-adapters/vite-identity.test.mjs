import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../scripts/lib/core.mjs';
import * as preflight from '../../scripts/lib/tool-preflight.mjs';
import { assertDeployedIdentityProof, deployedTargetBindingSha256, deployedTargetShapeErrors } from '../../scripts/lib/deployed-target.mjs';

// Vite single-page build identity (eval compat 3). Synthetic fixtures shaped like the live DOM Dragon returns for a
// Vite app: one hashed module entry under /assets/, stylesheet and lazy-chunk links that come and go with navigation.
const failCode = (fn, code) => assert.throws(fn, e => e.code === code);
const pageUrl = 'http://127.0.0.1:5401/auth';
const backendUrl = 'http://127.0.0.1:5411';
const entry = 'http://127.0.0.1:5401/assets/index-CJjkO35e.js';
const build = 'index-CJjkO35e';
const manifestSha = sha256(JSON.stringify({ kind: 'vite-html-assets/v1', entry }));
const viteHtml = (extra = '') => '<html lang="en"><head><meta charset="UTF-8"><title>Sample Shop</title>'
  + '<script type="module" crossorigin src="/assets/index-CJjkO35e.js"></script>'
  + '<link rel="stylesheet" crossorigin href="/assets/index-COs_Fa8L.css">' + extra
  + '</head><body><div id="root"><main>Log in</main></div></body></html>';
const nextHtml = '<html><head><script id="__NEXT_DATA__" type="application/json">{"buildId":"fixture-build"}</script>'
  + '<script src="/_next/static/fixture-build/_buildManifest.js"></script></head><body>x</body></html>';

test('Vite live DOM yields the entry chunk as build id and a stable entry-only manifest', () => {
  const v = preflight.parsePassiveDeployedHtml(viteHtml(), { preview_url: pageUrl });
  assert.deepEqual(v, { preview_url: pageUrl, frontend_build: { kind: 'vite', id: build }, asset_manifest_sha256: manifestSha });
  const navigated = viteHtml('<link rel="modulepreload" href="/assets/Dashboard-AbCdEf12.js"><link rel="stylesheet" href="/assets/Dashboard-ZyXwVu98.css">'
    + '<script type="module" src="https://cdn.example/assets/widget-AbCdEf12.js"></script>');
  assert.deepEqual(preflight.parsePassiveDeployedHtml(navigated, { preview_url: pageUrl }), v, 'lazy chunks and foreign modules do not change identity');
});

test('Vite identity fails closed on ambiguous, foreign, malformed or truncated entries', () => {
  failCode(() => preflight.parsePassiveDeployedHtml(viteHtml('<script type="module" src="/assets/admin-QwErTy12.js"></script>'), { preview_url: pageUrl }), 'PREFLIGHT_WEB_PASSIVE_VITE_ENTRY');
  const foreign = viteHtml().replace('src="/assets/index-CJjkO35e.js"', 'src="https://cdn.example/assets/index-CJjkO35e.js"');
  failCode(() => preflight.parsePassiveDeployedHtml(foreign, { preview_url: pageUrl }), 'PREFLIGHT_WEB_PASSIVE_NEXT_DATA');
  const classic = viteHtml().replace('type="module" ', '');
  failCode(() => preflight.parsePassiveDeployedHtml(classic, { preview_url: pageUrl }), 'PREFLIGHT_WEB_PASSIVE_NEXT_DATA');
  const unhashed = viteHtml().replace('/assets/index-CJjkO35e.js', '/assets/index.js');
  failCode(() => preflight.parsePassiveDeployedHtml(unhashed, { preview_url: pageUrl }), 'PREFLIGHT_WEB_PASSIVE_NEXT_DATA');
  const query = viteHtml().replace('/assets/index-CJjkO35e.js', '/assets/index-CJjkO35e.js?v=2');
  failCode(() => preflight.parsePassiveDeployedHtml(query, { preview_url: pageUrl }), 'PREFLIGHT_WEB_PASSIVE_HTML');
  const twoTypes = viteHtml().replace('type="module" ', 'type="module" type="text/javascript" ');
  failCode(() => preflight.parsePassiveDeployedHtml(twoTypes, { preview_url: pageUrl }), 'PREFLIGHT_WEB_PASSIVE_HTML');
  failCode(() => preflight.parsePassiveDeployedHtml(viteHtml() + '\n<!-- truncated -->', { preview_url: pageUrl }), 'PREFLIGHT_WEB_PASSIVE_HTML');
  failCode(() => preflight.parsePassiveDeployedHtml('<!doctype html>' + viteHtml(), { preview_url: pageUrl }), 'PREFLIGHT_WEB_PASSIVE_HTML');
});

test('Next.js pages keep their identity, also when a module entry is present', () => {
  const v = preflight.parsePassiveDeployedHtml(nextHtml, { preview_url: 'https://fixture.example/' });
  assert.deepEqual(v.frontend_build, { kind: 'nextjs', id: 'fixture-build' });
  const both = nextHtml.replace('</head>', '<script type="module" src="/assets/index-CJjkO35e.js"></script></head>');
  assert.equal(preflight.parsePassiveDeployedHtml(both, { preview_url: 'https://fixture.example/' }).frontend_build.kind, 'nextjs');
});

test('deployed target with Vite identity passes shape, binding and passive proof checks', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'teamqa-vite-identity-'));
  const now = Date.now() - 10000;
  const target = { project_id: 'sample-shop-local', preview_url: pageUrl, version: build, kind: 'deployed-build', environment: 'Local',
    backend_origin: backendUrl, frontend_build: { kind: 'vite', id: build }, asset_manifest_sha256: manifestSha,
    identity_proof: { path: 'proof.json', sha256: '0'.repeat(64) } };
  target.target_binding_sha256 = deployedTargetBindingSha256(target);
  const roster = { run_id: 'vite-fixture-run', round: 1, roster_hash: 'a'.repeat(64), target, roles: [{ role: 'executor_gui' }], catalog_source: { kind: 'fixture' } };
  const marker = preflight.deployedIdentityBootstrapMarker({ run_id: roster.run_id, round: 1, target });
  const session = { sessionId: 's', nonce: 'n', browserInstanceId: 'b' };
  let seq = 0;
  const evidence = (method, params, result) => {
    const n = seq++, at = new Date(now + n * 100).toISOString();
    const lines = [
      JSON.stringify({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', channel: 'commentary', content: marker } }),
      JSON.stringify({ type: 'response_item', timestamp: at, payload: { type: 'function_call', call_id: 'v-' + n, name: 'mcp__Dragon_Browser__dragon_rpc', arguments: JSON.stringify({ method, params }) } }),
      JSON.stringify({ type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: 'v-' + n, output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] }) } }),
    ];
    const path = join(runDir, `original-${n}.jsonl`);
    writeFileSync(path, lines.join('\n') + '\n');
    return { path, call_line: 2, result_line: 3, call_sha256: sha256(lines[1]), result_sha256: sha256(lines[2]), host: { fixture: true } };
  };
  const source = evidence('getPageHtml', { ...session, tabId: 7, maxLength: 200000 }, viteHtml());
  source.network_source = evidence('getNetwork', { ...session, tabId: 7, maxBytes: 200000 },
    { count: 1, requests: [{ t: now, method: 'GET', url: backendUrl + '/rest/v1/workspaces', status: 200, type: 'fetch' }], cursor: now, truncated: false, omitted: 0 });
  source.tab_source = evidence('getTabInfo', { ...session, tabId: 7 }, { tabId: 7, url: pageUrl, title: 'Sample Shop' });
  const identity = Object.fromEntries(Object.entries(target).filter(([k]) => !['identity_proof', 'target_binding_sha256'].includes(k)));
  writeFileSync(join(runDir, 'proof.json'), JSON.stringify({ schema: 'team-qa/deployed-identity-proof/v1', target_binding_sha256: target.target_binding_sha256, identity, sources: [source] }));
  target.identity_proof.sha256 = sha256(readFileSync(join(runDir, 'proof.json')));
  assert.deepEqual(deployedTargetShapeErrors(target), []);
  const observed = preflight.readDeployedIdentityObservation(source, { roster, runDir });
  assert.deepEqual(observed, { preview_url: pageUrl, frontend_build: { kind: 'vite', id: build }, asset_manifest_sha256: manifestSha, backend_origin: backendUrl });
  assert.equal(assertDeployedIdentityProof(target, { runDir, verifyOriginalSource: (ref) => preflight.readDeployedIdentityObservation(ref, { roster, runDir }) }).target_binding_sha256, target.target_binding_sha256);
  const other = { ...target, frontend_build: { kind: 'vite', id: 'index-ZZZZZZZZ' }, version: 'index-ZZZZZZZZ' };
  other.target_binding_sha256 = deployedTargetBindingSha256(other);
  failCode(() => preflight.readDeployedIdentityObservation(source, { roster: { ...roster, target: other }, runDir }), 'PREFLIGHT_CALL_BINDING');
});
