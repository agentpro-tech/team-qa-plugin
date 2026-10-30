import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../scripts/lib/core.mjs';
import { WEB_CONTRACT_SHA256, deployedTargetBindingSha256 } from '../../scripts/lib/deployed-target.mjs';
import * as preflight from '../../scripts/lib/tool-preflight.mjs';

// All host records below are synthetic contract fixtures, never live Codex or browser evidence.
const pageUrl = 'https://fixture.example/cart';
const backendUrl = 'https://api.fixture.example';
const build = 'fixture-build';
const assetUrls = [
  'https://fixture.example/_next/static/fixture-build/_buildManifest.js',
  'https://fixture.example/_next/static/chunks/main.js'
].sort();
const assetManifest = { kind: 'nextjs-html-assets/v1', build_id: build, urls: assetUrls };
const html = '<html><head><script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ buildId: build }) +
  '</script><script src="/_next/static/chunks/main.js"></script><script src="/_next/static/fixture-build/_buildManifest.js"></script></head><body>Synthetic fixture</body></html>';
const session = { sessionId: 'fixture-session', nonce: 'fixture-nonce', browserInstanceId: 'fixture-browser' };
const strictSession = { ...session, forbidSyntheticDOM: false, policy: { requireTrusted: true, forbidSyntheticDOM: false } };
const failCode = (fn, code) => assert.throws(fn, e => e.code === code);

function setup() {
  const runDir = mkdtempSync(join(tmpdir(), 'teamqa-identity-refresh-'));
  mkdirSync(join(runDir, 'tools'));
  const servicePath = join(runDir, 'tools/macos-service.mjs');
  writeFileSync(servicePath, '// synthetic fixture helper; test adapter never executes it\n');
  const native = { node_path: process.execPath, service: { path: servicePath, sha256: sha256(readFileSync(servicePath)) } };
  const roster = {
    run_id: 'fixture-identity-refresh', round: 1, roster_hash: 'a'.repeat(64),
    target: {
      project_id: 'fixture-web', preview_url: pageUrl, version: build, kind: 'deployed-build',
      environment: 'Test', backend_origin: backendUrl, frontend_build: { kind: 'nextjs', id: build },
      asset_manifest_sha256: sha256(JSON.stringify(assetManifest)), identity_proof: { path: 'proof.json', sha256: '0'.repeat(64) }
    },
    roles: [{ role: 'executor_gui' }], catalog_source: { kind: 'fixture' }
  };
  roster.target.target_binding_sha256 = deployedTargetBindingSha256(roster.target);
  const marker = `TEAMQA_PREFLIGHT run=${roster.run_id} round=${roster.round} roster=${roster.roster_hash}`;
  let sequence = 0;
  function evidence(method, params, result, binding = marker, { timeShift = 0, name = 'mcp__Dragon_Browser__dragon_rpc', timestamp = true } = {}) {
    const n = sequence++;
    const at = new Date(Date.now() - 20000 + n * 1000 + timeShift).toISOString();
    const call = { type: 'response_item', payload: { type: 'function_call', call_id: `fixture-${n}`, name, arguments: JSON.stringify({ method, params }) } };
    const output = { type: 'response_item', payload: { type: 'function_call_output', call_id: `fixture-${n}`, output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] }) } };
    const prior = { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'commentary', content: binding } };
    if (timestamp) { prior.timestamp = at; call.timestamp = at; output.timestamp = at; }
    const lines = [JSON.stringify(prior), JSON.stringify(call), JSON.stringify(output)];
    const path = join(runDir, `synthetic-original-${n}.jsonl`);
    writeFileSync(path, lines.join('\n') + '\n');
    return { path, call_line: 2, result_line: 3, call_sha256: sha256(lines[1]), result_sha256: sha256(lines[2]), host: { fixture: true } };
  }
  function passive(binding = marker, options = {}) {
    const at = Date.now() - 20000 + sequence * 1000 + Number(options.timeShift || 0);
    const observedSession = options.session ?? session;
    const tabId = options.tabId ?? 42;
    const params = { ...observedSession, tabId, maxLength: 200000, ...options.params };
    const shifted = amount => ({ ...options, timeShift: amount ?? options.timeShift });
    const page = evidence('getPageHtml', params, options.html ?? html, binding, shifted(options.pageTimeShift));
    page.network_source = evidence('getNetwork', { ...observedSession, tabId, maxBytes: 200000 }, options.network ?? {
      count: 1, requests: [{ t: at, method: 'GET', url: backendUrl + '/fixture', status: 200, type: 'xmlhttprequest' }],
      cursor: at, truncated: false, omitted: 0
    }, binding, shifted(options.networkTimeShift));
    page.tab_source = evidence('getTabInfo', { ...observedSession, tabId, ...options.tabParams }, options.tab ?? { tabId, url: pageUrl, title: 'Synthetic fixture' }, binding, shifted(options.tabTimeShift));
    return page;
  }
  function sealApprovedProof({ timeShift = -600000 } = {}) {
    const identity = Object.fromEntries(Object.entries(roster.target).filter(([key]) => !['identity_proof', 'target_binding_sha256'].includes(key)));
    const source = passive(`TEAMQA_IDENTITY_PREFLIGHT run=${roster.run_id} round=${roster.round} target=${roster.target.target_binding_sha256}`, { timeShift });
    const proof = { schema: 'team-qa/deployed-identity-proof/v1', target_binding_sha256: roster.target.target_binding_sha256, identity, sources: [source] };
    const bytes = Buffer.from(JSON.stringify(proof));
    writeFileSync(join(runDir, 'proof.json'), bytes);
    roster.target.identity_proof.sha256 = sha256(bytes);
    return { proof, bytes, source };
  }
  function status() {
    const at = new Date(Date.now() - 20000 + sequence * 1000).toISOString();
    const service = { loaded: true, loadedFromPlist: true, pid: 1234, current: 'releases/1.6.9', status: {
      ok: true, ready: true, versionMatch: true, bridgeVersion: '1.6.9', bridgeBuild: 'fixture-build', extension: { version: '1.6.9' }
    } };
    const result = { schema: 'team-qa/native-service-status-result/v1', exit_code: 0, signal: null, exceeded: false, stderr: '', output: JSON.stringify(service) };
    const lines = [
      JSON.stringify({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'assistant', channel: 'commentary', content: marker } }),
      JSON.stringify({ type: 'response_item', timestamp: at, payload: { type: 'function_call', call_id: `status-${sequence}`, name: 'mcp__node_repl__js', arguments: JSON.stringify({ code: preflight.nativeServiceStatusCode(native), title: 'Synthetic status', timeout_ms: 12000 }) } }),
      JSON.stringify({ type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: `status-${sequence}`, output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }] }) } })
    ];
    const path = join(runDir, `synthetic-status-${sequence++}.jsonl`);
    writeFileSync(path, lines.join('\n') + '\n');
    return { path, call_line: 2, result_line: 3, call_sha256: sha256(lines[1]), result_sha256: sha256(lines[2]), host: { fixture: true }, native };
  }
  function gui(currentIdentity, forbidSyntheticDOM = false) {
    const active = { ...session, alive: true, expired: false, circuitOpen: false,
      forbidSyntheticDOM, policy: { requireTrusted: true, forbidSyntheticDOM } };
    const g = {
      status: status(), session: evidence('session.create', { ...session, forbidSyntheticDOM }, active),
      open: evidence('openTab', { ...session, url: pageUrl, active: false }, { tabId: 42 }),
      fresh_status: status(), fresh_session: evidence('session.list', {}, { sessions: [active] })
    };
    g.read = passive(marker);
    delete g.read.network_source;
    return g;
  }
  function makePreflight(currentIdentity, forbidSyntheticDOM = false) {
    const g = gui(currentIdentity, forbidSyntheticDOM);
    return { schema: 'team-qa/tool-preflight/v1', run_id: roster.run_id, round: roster.round, roster_hash: roster.roster_hash,
      target: roster.target, runtime: { node_version: process.version, contract_sha256: WEB_CONTRACT_SHA256 },
      target_access: { kind: 'dragon', gui: g }, gui: g,
      ...(currentIdentity === undefined ? {} : { current_identity: currentIdentity }) };
  }
  function run(currentIdentity, forbidSyntheticDOM = false) {
    writeFileSync(join(runDir, 'preflight.json'), JSON.stringify(makePreflight(currentIdentity, forbidSyntheticDOM)));
    return preflight.assertToolPreflight({ runDir, roster, stage: 'basic', requireFresh: true });
  }
  return { runDir, roster, marker, passive, sealApprovedProof, makePreflight, run };
}

test('approved identity proof older than five minutes stays immutable while fresh final-roster evidence passes', () => {
  const f = setup();
  const { bytes, source } = f.sealApprovedProof();
  const targetBefore = JSON.stringify(f.roster.target);
  const current = f.passive(f.marker);
  assert.equal(preflight.readCurrentDeployedIdentityObservation(current, { roster: f.roster, runDir: f.runDir, requireFresh: true }).frontend_build.id, build);
  assert.equal(f.run(current).verified, true);
  assert.deepEqual(readFileSync(join(f.runDir, 'proof.json')), bytes);
  assert.equal(JSON.stringify(f.roster.target), targetBefore);
  assert.ok(Date.now() - Date.parse(JSON.parse(readFileSync(source.path, 'utf8').split('\n')[1]).timestamp) > 300000);
  failCode(() => f.run(current, true), 'PREFLIGHT_DRAGON_METADATA');
});

test('fresh deployed dispatch requires a separate current observation; historical replay remains valid outside dispatch', () => {
  const f = setup();
  f.sealApprovedProof();
  writeFileSync(join(f.runDir, 'preflight.json'), JSON.stringify(f.makePreflight()));
  assert.equal(preflight.assertToolPreflight({ runDir: f.runDir, roster: f.roster, stage: 'basic' }).verified, true);
  const p = f.makePreflight();
  writeFileSync(join(f.runDir, 'preflight.json'), JSON.stringify(p));
  failCode(() => preflight.assertToolPreflight({ runDir: f.runDir, roster: f.roster, stage: 'basic', requireFresh: true }), 'PREFLIGHT_CURRENT_IDENTITY_REQUIRED');
});

test('current identity source failures reject stale, wrong marker, changed identity and tampered source bytes', () => {
  for (const [options, code] of [
    [{ timeShift: -600000 }, 'PREFLIGHT_STALE'],
    [{}, 'PREFLIGHT_CALL_BINDING'],
    [{ tabTimeShift: -10000 }, 'PREFLIGHT_WEB_PASSIVE_ORDER'],
    [{ html: html.replaceAll('fixture-build', 'changed-build').replaceAll('/_next/static/', '/_next/static/') }, 'PREFLIGHT_WEB_CURRENT_BUILD']
  ]) {
    const f = setup(); f.sealApprovedProof();
    const marker = code === 'PREFLIGHT_CALL_BINDING' ? 'TEAMQA_PREFLIGHT run=wrong round=1 roster=' + f.roster.roster_hash : f.marker;
    const ref = f.passive(marker, options);
    failCode(() => f.run(ref), code);
  }
  for (const [options, code] of [
    [{ tabId: 43 }, 'PREFLIGHT_GUI_TAB_DRIFT'],
    [{ tab: { tabId: 42, url: 'https://fixture.example/other' } }, 'PREFLIGHT_WEB_PASSIVE_URL'],
    [{ network: { count: 0, requests: [], cursor: 0, truncated: false, omitted: 0 } }, 'PREFLIGHT_WEB_BACKEND_OBSERVATION'],
    [{ network: { count: 1, requests: [{ t: Date.now(), method: 'GET', url: 'https://other.fixture.example/fixture', status: 200 }], cursor: Date.now(), truncated: false, omitted: 0 } }, 'PREFLIGHT_WEB_BACKEND_OBSERVATION'],
    [{ html: html.replace('</head>', '<script src="/_next/static/fixture-build/extra.js"></script></head>') }, 'PREFLIGHT_WEB_CURRENT_BUILD'],
    [{ session: { ...session, nonce: 'different-nonce' } }, 'PREFLIGHT_GUI_SESSION_DRIFT']
  ]) {
    const f = setup(); f.sealApprovedProof();
    failCode(() => f.run(f.passive(f.marker, options)), code);
  }
  const wrongMarker = setup(); wrongMarker.sealApprovedProof();
  const wrongRoster = `TEAMQA_PREFLIGHT run=${wrongMarker.roster.run_id} round=${wrongMarker.roster.round} roster=${'b'.repeat(64)}`;
  failCode(() => wrongMarker.run(wrongMarker.passive(wrongRoster)), 'PREFLIGHT_CALL_BINDING');
  const f = setup(); f.sealApprovedProof();
  const ref = f.passive(f.marker); ref.call_sha256 = '0'.repeat(64);
  assert.throws(() => f.run(ref), e => e.code === 'PREFLIGHT_SOURCE_DRIFT');
  const copied = setup(); copied.sealApprovedProof();
  const copiedRoster = { ...copied.roster, catalog_source: { kind: 'runtime' } };
  assert.throws(() => preflight.readCurrentDeployedIdentityObservation(copied.passive(copied.marker), { roster: copiedRoster, runDir: copied.runDir, requireFresh: true }), e => e.code === 'PREFLIGHT_SOURCE_UNTRUSTED');
});

test('fresh dispatch rejects incomplete passive current tuple and every cross-access session field', () => {
  for (const missing of ['network_source', 'tab_source']) {
    const f = setup(); f.sealApprovedProof();
    const ref = f.passive(f.marker); delete ref[missing];
    failCode(() => f.run(ref), 'PREFLIGHT_CURRENT_IDENTITY_PASSIVE_REQUIRED');
  }
  for (const field of ['sessionId', 'nonce', 'browserInstanceId']) {
    const f = setup(); f.sealApprovedProof();
    failCode(() => f.run(f.passive(f.marker, { session: { ...session, [field]: 'different-' + field } })), 'PREFLIGHT_GUI_SESSION_DRIFT');
  }
});

test('changed approved proof bytes fail even when a fresh observation matches the former target', () => {
  const f = setup();
  f.sealApprovedProof();
  const proofPath = join(f.runDir, 'proof.json');
  const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
  proof.identity.backend_origin = 'https://altered.fixture.example';
  writeFileSync(proofPath, JSON.stringify(proof));
  assert.throws(() => f.run(f.passive(f.marker)));
});
