import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { deployedTargetBindingSha256, WEB_CONTRACT_SHA256 } from '../../scripts/lib/deployed-target.mjs';
import { claudeHostSource } from '../../scripts/lib/host-transcript.mjs';
import { selectRoster } from '../../scripts/lib/roster.mjs';
import { rosterChat } from '../../scripts/lib/chat-presentation.mjs';
import { seal, stable } from '../../scripts/lib/release-truth.mjs';
import { createRunOffer, OFFER_SCHEMA } from '../../scripts/lib/run-contract.mjs';
import { stableJson } from '../../scripts/lib/core.mjs';

// Deployed-build (web) binding chain on a Claude Code root, end to end through the CLI. A Vite build is
// identified from Claude-format root transcript lines (synthetic fixtures under a fake HOME, never evidence
// of a live run); the roster is a runtime roster approved by a typed "Approve" in that transcript.
// Controlled run contract: like test/chat-preflight/approval-integration.test.mjs, a temporary package
// copy replaces scripts/lib/run-contract.mjs with a stub that still verifies the approved roster but skips
// the phase, role attestation, operational preflight (Node 24/26 only) and board publication gates, which
// have their own suites. Everything on the web binding chain runs unmodified.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCROLL = process.env.TEAMQA_SCROLL_ROOT || join(homedir(), 'Dev', 'scroll');
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-web-home-')));
process.env.HOME = HOME;
const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => `${JSON.stringify(value, null, 2)}\n`;
const read = path => JSON.parse(readFileSync(path, 'utf8'));

const CONTROLLED_RUN_CONTRACT = `// Controlled run contract (test/claude-host/web-lane.test.mjs): real roster approval, no phase,
// attestation, preflight or publication gates.
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail, readJson } from './core.mjs';
import { assertApprovedRoster } from './roster.mjs';
export const RUN_CONTRACT = 'team-qa/run-contract/v1';
export function readLockedRunDocuments(runDir) { return readJson(join(runDir, 'docs-lock.json')); }
export function assertRunContract({ runDir }) {
  const roster = assertApprovedRoster({ runDir });
  return { runDir, roster, state: readJson(join(runDir, 'phase.json')), lock: readLockedRunDocuments(runDir) };
}
export function assertArtifactPath(contract, name, path) {
  const artifact = contract.lock.artifacts?.[name];
  if (!artifact || realpathSync(resolve(contract.runDir, artifact.path)) !== realpathSync(resolve(path))) fail(3, 'RUN_DOCUMENT_PATH_MISMATCH', name);
}
const controlled = () => fail(3, 'CONTROLLED_RUN_CONTRACT');
export const lockRunDocuments = controlled, transitionRun = controlled, assertRoleAttestation = controlled, bindRoleAttestation = controlled, roleContext = controlled;
export function validateRtmEdges() {}
`;

// The package copy drops macOS AppleDouble files (._*), which contract readers would parse as schemas.
const PACKAGE = (() => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-web-package-'))), 'team-qa');
  cpSync(ROOT, dir, { recursive: true, filter: source => !basename(source).startsWith('._') && !['.git', 'node_modules', 'dist', '.scroll'].includes(basename(source)) });
  writeFileSync(join(dir, 'scripts/lib/run-contract.mjs'), CONTROLLED_RUN_CONTRACT);
  return dir;
})();
for (const skill of ['qa-gui', 'qa-code']) {
  const dir = join(HOME, '.agents/skills', skill, 'contracts/release-truth-contract/v2');
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, 'contracts/release-truth-contract/v2', `${skill}.receipt.schema.json`), join(dir, `${skill}.receipt.schema.json`));
}

const PREVIEW = 'http://127.0.0.1:5401/intro';
const BACKEND = 'http://127.0.0.1:5411';
const BUILD = 'index-CJjkO35e';
const ENTRY = 'http://127.0.0.1:5401/assets/index-CJjkO35e.js';
const HTML = '<html lang="en"><head><meta charset="UTF-8"><title>Sample Shop</title>'
  + '<script type="module" crossorigin src="/assets/index-CJjkO35e.js"></script>'
  + '<link rel="stylesheet" crossorigin href="/assets/index-COs_Fa8L.css"></head>'
  + '<body><div id="root"><main>About Sample Shop</main></div></body></html>';
const DRAGON = { sessionId: 'dragon-session-1', nonce: 'dragon-nonce-1', browserInstanceId: 'dragon-browser-1' };
const CASES = [
  { id: 'TC-LOGIN-01', req_id: 'REQ-LOGIN', lane: 'gui', steps: ['Open /auth', 'Log in with the test account'], expected: 'Login succeeds and the overview page opens',
    data: { account: 'qa-viewer' }, priority: 'P1', kind: 'behavioral', title: 'Valid login', sourceRefs: ['SRC-AUTH'], taxonomy: ['functional'], states: ['ideal'], viewports: ['desktop'] },
  { id: 'TC-LOGIN-02', req_id: 'REQ-LOGIN', lane: 'gui', steps: ['Open /auth', 'Enter a wrong password'], expected: 'Shows the localized login error',
    data: { account: 'qa-viewer' }, priority: 'P1', kind: 'static', title: 'Wrong password', sourceRefs: ['SRC-AUTH'], taxonomy: ['negative'], states: ['error'], viewports: ['desktop'] },
  { id: 'TC-INTRO-01', req_id: 'REQ-INTRO', lane: 'gui', steps: ['Open /intro', 'Wait for the figures to settle'], expected: 'The intro page shows the figures after the data settles',
    data: { settling: { required: true, window_ms: 120000 } }, priority: 'P2', kind: 'static', title: 'Intro page', sourceRefs: ['SRC-INTRO'], taxonomy: ['state'], states: ['ideal'], viewports: ['mobile', 'desktop'] },
];
const TIERS = { 'REQ-LOGIN': 'FULL', 'REQ-INTRO': 'SMOKE' };

function cli(ws, args, env = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('TEAMQA_')));
  const merged = { ...base, HOME, TEAMQA_SCROLL_ROOT: SCROLL, TEAMQA_ROLES: ws.roles, ...env };
  for (const [name, value] of Object.entries(merged)) if (value === undefined) delete merged[name];
  const r = spawnSync(process.execPath, [join(PACKAGE, 'scripts/teamqa.mjs'), ...args], { cwd: ws.cwd, encoding: 'utf8', env: merged, timeout: 120_000 });
  return { status: r.status, out: r.stdout, text: `${r.stdout}${r.stderr}`, json: () => JSON.parse(r.stdout.trim().split('\n').at(-1)) };
}

function transcriptWriter(sid, path) {
  let clock = Date.now() - 120_000, n = 0;
  const lines = [];
  const entry = extra => ({ parentUuid: null, isSidechain: false, userType: 'external', cwd: '/work/shop-qa', sessionId: sid, version: '2.1.311',
    gitBranch: '', timestamp: new Date(clock += 250).toISOString(), uuid: `u-${sid.slice(0, 8)}-${n++}`, ...extra });
  const push = value => { lines.push(JSON.stringify(value)); writeFileSync(path, `${lines.join('\n')}\n`); return { line: lines.length, value }; };
  return {
    lines,
    human: value => push(entry({ type: 'user', origin: { kind: 'human' }, promptId: randomUUID(),
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>Workspace note.</system-reminder>' }, { type: 'text', text: value }] } })),
    say: value => push(entry({ type: 'assistant', message: { id: `msg-${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: value }] } })),
    rpc(method, params, result) {
      const id = `toolu_${sid.slice(0, 8)}_${n}`;
      const call = push(entry({ type: 'assistant', message: { id: `msg-${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id, name: 'mcp__Dragon_Browser__dragon_rpc', input: { method, params } }] } }));
      const content = [{ type: 'text', text: JSON.stringify({ ok: true, result }) }];
      const output = push(entry({ type: 'user', sourceToolAssistantUUID: call.value.uuid, toolUseResult: content,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } }));
      return { call, output };
    },
  };
}

// A run directory as it stands after DESIGN: approved roster with a proven Vite target, locked source,
// plan and tracked plan, signed plan and the run files the receipt seals.
function workspace({ runId = 'shop-web-001', cases = CASES, tiers = TIERS, preflight = { code: false, gui: true, recording: false } } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-web-workspace-')));
  const runDir = join(cwd, 'runs', runId);
  mkdirSync(join(runDir, 'identity'), { recursive: true });
  const sid = randomUUID();
  const project = join(HOME, '.claude', 'projects', `-work-shop-qa-${sid.slice(0, 8)}`);
  mkdirSync(project, { recursive: true });
  const transcript = join(project, `${sid}.jsonl`);
  const t = transcriptWriter(sid, transcript);
  const identity = { project_id: 'sample-shop-local', preview_url: PREVIEW, version: BUILD, kind: 'deployed-build', environment: 'Local',
    backend_origin: BACKEND, frontend_build: { kind: 'vite', id: BUILD }, asset_manifest_sha256: hash(JSON.stringify({ kind: 'vite-html-assets/v1', entry: ENTRY })) };
  const bindingSha = deployedTargetBindingSha256(identity);
  t.human('Run QA on the Sample Shop build running locally');
  t.say(`Reading the build identity.\nTEAMQA_IDENTITY_PREFLIGHT run=${runId} round=1 target=${bindingSha}`);
  const page = t.rpc('getPageHtml', { ...DRAGON, tabId: 7, maxLength: 1048576 }, HTML);
  const pageTime = Date.parse(page.output.value.timestamp);
  const network = t.rpc('getNetwork', { ...DRAGON, tabId: 7, maxBytes: 200000 }, { count: 1, cursor: pageTime + 400, truncated: false, omitted: 0,
    requests: [{ t: pageTime - 1000, method: 'GET', url: `${BACKEND}/rest/v1/workspace_members?select=*`, status: 200, type: 'fetch' }] });
  const tab = t.rpc('getTabInfo', { ...DRAGON, tabId: 7 }, { tabId: 7, url: PREVIEW, title: 'Sample Shop' });
  const host = claudeHostSource(transcript);
  const ref = pair => ({ path: host.path, call_line: pair.call.line, result_line: pair.output.line,
    call_sha256: hash(t.lines[pair.call.line - 1]), result_sha256: hash(t.lines[pair.output.line - 1]), host });
  const proofText = text({ schema: 'team-qa/deployed-identity-proof/v1', target_binding_sha256: bindingSha, identity,
    sources: [{ ...ref(page), tab_source: ref(tab), network_source: ref(network) }] });
  writeFileSync(join(runDir, 'identity/proof.json'), proofText);
  const target = { ...identity, target_binding_sha256: bindingSha, identity_proof: { path: 'identity/proof.json', sha256: hash(proofText) } };
  const catalogPath = join(cwd, 'catalog.json');
  writeFileSync(catalogPath, text({ schema: 'team-qa/model-catalog/v1', collected_at: new Date().toISOString(),
    source: { kind: 'runtime', reference: 'controlled web lane fixture' },
    harnesses: [{ id: 'claude', version: '2.1.311', bin: join(ROOT, 'test/roster-dynamic/stub-claude.mjs') }],
    models: [{ id: 'claude-opus-5-5', provider: 'anthropic', harness: 'claude', efforts: ['low', 'medium', 'high'], tools: ['fs.read', 'dragon', 'qa-gui', 'qa-code'],
      roles: ['test_manager', 'analyst', 'designer', 'executor_gui', 'executor_code'], tier: 'general', status: 'available', quality_evidence: { fit_review: 'source-reviewed' } }] }));
  const roster = selectRoster({ catalog: read(catalogPath), catalogPath, request: { schema: 'team-qa/roster-request/v1', run_id: runId, round: 1,
    scope: 'Sample Shop deployed build (fixture)', target, provider: 'anthropic',
    manager: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium', harness: 'claude' }, caps: { timeout_ms: 600000, max_turns: 20 } } });
  const rosterText = text(roster), rosterHash = hash(rosterText);
  writeFileSync(join(runDir, 'roster.json'), rosterText);
  t.say(rosterChat(roster, rosterHash));
  const approved = t.human('Approve');
  const event = { schema: 'team-qa/roster-user-event/v1', id: 'roster-approval-1', actor: 'user', text: 'Approve', run_id: runId, round: 1, roster_hash: rosterHash,
    source: { path: host.path, sha256: hash(t.lines[approved.line - 1]), line: approved.line } };
  mkdirSync(join(runDir, 'control/approvals'), { recursive: true });
  writeFileSync(join(runDir, 'control/approvals/roster.json'), text({ schema: 'team-qa/roster-approval/v1', run_id: runId, round: 1, roster_hash: rosterHash,
    event, approved_at: new Date().toISOString(), fixture: false }));
  mkdirSync(join(runDir, 'sources'));
  writeFileSync(join(runDir, 'sources/brief.md'), '# Sample Shop\n\nLogin and intro page.\n');
  const sourceText = text({ schema: 'team-qa/source-manifest/v1', run_id: runId, version: 'sample-shop-brief-2026-10-27', target: roster.target,
    refs: [{ id: 'brief', path: 'sources/brief.md', sha256: hash(readFileSync(join(runDir, 'sources/brief.md'))) }] });
  writeFileSync(join(runDir, 'source.json'), sourceText);
  const plan = { run_id: runId, app: 'Sample Shop', plan_version: 1, lanes: [{ id: 'gui-web', scope: Object.keys(tiers), parallel_ok: false, vi_sao: '' }],
    tiers, exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 70 }, preflight };
  writeFileSync(join(runDir, 'test-plan.md'), `# Sample Shop QA plan\n\nTEAMQA_PLAN_START\n${JSON.stringify(plan, null, 2)}\nTEAMQA_PLAN_END\n`);
  writeFileSync(join(runDir, 'tracked-plan.json'), text({ schemaVersion: 2, sourceItems: [
    { id: 'SRC-AUTH', kind: 'brief', sourceSystem: 'brief', externalKey: 'SHOP-AUTH', title: 'Login', origin: 'upstream' },
    { id: 'SRC-INTRO', kind: 'brief', sourceSystem: 'brief', externalKey: 'SHOP-INTRO', title: 'Intro page', origin: 'upstream' }], cases }));
  const lockDocs = () => writeFileSync(join(runDir, 'docs-lock.json'), text({ schema: 'team-qa/docs-lock/v1', run_id: runId, round: 1, roster_hash: rosterHash,
    artifacts: Object.fromEntries([['source', 'source.json'], ['plan', 'test-plan.md'], ['tracked', 'tracked-plan.json']]
      .map(([name, path]) => [name, { path, sha256: hash(readFileSync(join(runDir, path))) }])) }));
  lockDocs();
  writeFileSync(join(runDir, 'phase.json'), text({ schema: 'team-qa/run-contract/v1', run_id: runId, round: 1, roster_hash: rosterHash, phase: 'DESIGN' }));
  const approval = text({ signed_by: 'owner', ts: new Date().toISOString(), plan_sha256: hash(readFileSync(join(runDir, 'test-plan.md'))),
    schema: 'team-qa/plan-approval/v2', run_id: runId, round: 1, roster_hash: rosterHash });
  mkdirSync(join(cwd, 'control/approvals', runId), { recursive: true });
  writeFileSync(join(cwd, 'control/approvals', runId, 'plan-v1.json'), approval);
  writeFileSync(join(runDir, 'control/approvals/plan.json'), approval);
  mkdirSync(join(runDir, 'role-bindings'));
  for (const role of ['test_manager', 'analyst', 'designer', 'executor_gui']) writeFileSync(join(runDir, 'role-bindings', `${role}.json`), text({ fixture: 'controlled run contract', role }));
  return { cwd, runDir, runId, roster, rosterText, rosterHash, transcript, cases, lockDocs, roles: join(cwd, 'config', 'teamqa-roles.json'), run: `runs/${runId}` };
}

// A QA GUI web-v1 receipt shaped like qa-gate.mjs writes it to .teamcode/runs/<run_uuid>/receipts/.
function guiReceipt(ws, { semantic = 'PASS', rows = null, runUuid = null, tamper = null } = {}) {
  const binding = read(join(ws.runDir, 'binding.json'));
  const evidence = ws.cases.map(item => {
    const path = `evidence/${item.id}/${item.states[0]}.png`;
    mkdirSync(join(ws.runDir, 'evidence', item.id), { recursive: true });
    writeFileSync(join(ws.runDir, path), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(`fixture ${item.id}`)]));
    return { path, sha256: hash(readFileSync(join(ws.runDir, path))), evidence_type: 'gui-screenshot',
      metadata: { run_uuid: binding.run_uuid, target_binding_sha256: binding.target_binding_sha256, case_id: item.id, state: item.states[0], captured_at: new Date().toISOString() } };
  });
  const atomic = rows ?? ws.cases.map((item, index) => ({ requirement_id: item.req_id, assertion_id: `${item.id}-A1`, case_id: item.id,
    evidence_ref: evidence[index].path, evidence_sha256: evidence[index].sha256, evidence_type: 'gui-screenshot', result: semantic }));
  let receipt = seal({ schema: 'qa-gui/receipt/web-v1', contract_sha256: WEB_CONTRACT_SHA256, run_uuid: runUuid ?? binding.run_uuid,
    requirements_hash: binding.requirements_hash, verification_lane: 'gui', target_kind: 'deployed-build', target_binding_sha256: binding.target_binding_sha256,
    target: binding.target, execution_status: 'completed', semantic_verdict: semantic, atomic_coverage: atomic, evidence_manifest: evidence,
    created_at: new Date().toISOString(),
    dispatch_proof: { schema: 'team-qa/role-attestation/v1', run_id: ws.runId, round: 1, roster_hash: ws.rosterHash, role: 'executor_gui', source: { kind: 'claude-stream' } },
    teamqa_provenance: { run_dir: ws.runDir, attestation_path: join(ws.runDir, 'role-bindings/executor_gui.json'), binding_sha256: hash(readFileSync(join(ws.runDir, 'binding.json'))),
      target_binding_sha256: binding.target_binding_sha256 } });
  if (tamper) receipt = tamper(receipt);
  const file = join(ws.cwd, '.teamcode/runs', binding.run_uuid, 'receipts', `qa-gui.receipt.${randomUUID().slice(0, 8)}.json`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return file;
}

function timing(offset = 0) {
  const start = Date.now() - 600_000 + offset;
  return ['--started-at', new Date(start).toISOString(), '--ended-at', new Date(start + 90_000).toISOString(), '--timeout-ms', '600000'];
}
const record = (ws, id, receipt, fn = 'pass', ui = 'pass', extra = timing()) => cli(ws, ['web', 'record', '--run', ws.runId, '--case', id, '--receipt', receipt,
  '--function', fn, '--ui', ui, ...extra, '--out', `${ws.run}/records/${id}.json`]);
const bound = ws => {
  let r = cli(ws, ['web', 'requirements', '--run', ws.runId]);
  assert.equal(r.status, 0, r.text);
  r = cli(ws, ['web', 'bind', '--run', ws.runId, '--requirements', `${ws.run}/requirements.web.json`]);
  assert.equal(r.status, 0, r.text);
  r = cli(ws, ['board', 'seed', '--run', ws.runId, '--tracked', `${ws.run}/tracked-plan.json`, '--file', `${ws.run}/board.jsonl`]);
  assert.equal(r.status, 0, r.text);
  return r;
};

test('deployed Vite build runs web requirements, web bind, web record, report, receipt and web handoff', () => {
  const ws = workspace();
  let r = cli(ws, ['web', 'requirements', '--run', ws.runId]);
  assert.equal(r.status, 0, r.text);
  const requirements = r.json();
  const graphFile = join(ws.runDir, 'requirements.web.json'), graphBytes = readFileSync(graphFile);
  const graph = JSON.parse(graphBytes);
  assert.equal(requirements.requirements_hash, hash(JSON.stringify(stable(graph))));
  assert.equal(requirements.validator, 'local');
  assert.deepEqual(Object.keys(graph), ['schema', 'contract_sha256', 'source_revision', 'target_binding_sha256', 'gate_policy', 'requirements']);
  assert.deepEqual(graph, {
    schema: 'requirements.freeze/web-v1', contract_sha256: WEB_CONTRACT_SHA256, source_revision: 'sample-shop-brief-2026-10-27',
    target_binding_sha256: ws.roster.target.target_binding_sha256, gate_policy: { coverage_threshold: 100, required_layers: ['gui'] },
    requirements: [
      { id: 'REQ-LOGIN', expectation: 'TC-LOGIN-01: Login succeeds and the overview page opens\nTC-LOGIN-02: Shows the localized login error', requirement_owner: 'Sample Shop',
        verification_lane: 'gui', risk_dimensions: [], acceptance_ids: ['TC-LOGIN-01', 'TC-LOGIN-02'], evidence_contract: { allowed_types: ['gui-screenshot'], atomic: true, multi_evidence: false } },
      { id: 'REQ-INTRO', expectation: 'TC-INTRO-01: The intro page shows the figures after the data settles', requirement_owner: 'Sample Shop',
        verification_lane: 'gui', risk_dimensions: ['live-projection-cache'], acceptance_ids: ['TC-INTRO-01'], evidence_contract: { allowed_types: ['gui-screenshot'], atomic: true, multi_evidence: false } },
    ] });
  r = cli(ws, ['web', 'requirements', '--run', ws.runId]);
  assert.equal(r.status, 0, r.text);
  assert.equal(r.json().effect, 'unchanged');
  assert.deepEqual(readFileSync(graphFile), graphBytes);
  r = cli(ws, ['web', 'requirements', '--run', ws.runId, '--threshold', '90']);
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /WEB_ARTIFACT_EXISTS/);
  assert.deepEqual(readFileSync(graphFile), graphBytes);

  r = cli(ws, ['rtm', 'build', '--plan', `${ws.run}/test-plan.md`, '--tracked', `${ws.run}/tracked-plan.json`, '--out', `${ws.run}/rtm.md`]);
  assert.equal(r.status, 0, r.text);

  const packagedRoles = readFileSync(join(PACKAGE, 'roles.json'));
  // Pre-bind overlay (eval compat 3): TEAMQA_ROLES names the overlay for the whole session.
  r = cli(ws, ['web', 'overlay']);
  assert.equal(r.status, 0, r.text);
  assert.equal(r.json().effect, 'confirmed');
  const base = read(ws.roles);
  assert.equal(Object.hasOwn(base, 'target'), false);
  assert.deepEqual(base.mirror.notion.probe, ['node', join(PACKAGE, 'scripts/adapters/notion-env.mjs'), 'probe']);
  assert.equal(cli(ws, ['web', 'overlay']).json().effect, 'unchanged');
  r = cli(ws, ['web', 'bind', '--run', ws.runId, '--requirements', `${ws.run}/requirements.web.json`]);
  assert.equal(r.status, 0, r.text);
  const bind = r.json();
  assert.equal(bind.effect.roles, 'confirmed', 'web bind replaces the pre-bind overlay');
  assert.equal(cli(ws, ['web', 'overlay']).json().effect, 'bound');
  const bindingText = readFileSync(join(ws.runDir, 'binding.json'), 'utf8'), binding = JSON.parse(bindingText);
  assert.deepEqual(Object.keys(binding), ['schema', 'run_uuid', 'requirements_hash', 'contract_sha256', 'verification_lane', 'target_kind', 'target_binding_sha256', 'target']);
  assert.equal(bind.binding_sha256, hash(bindingText));
  assert.equal(bind.requirements_hash, requirements.requirements_hash);
  assert.equal(binding.requirements_hash, requirements.requirements_hash);
  assert.equal(bind.roles_overlay, ws.roles);
  const targetText = JSON.stringify(ws.roster.target, null, 2).replaceAll('\n', '\n  ');
  assert.ok(ws.rosterText.includes(`"target": ${targetText}`) && bindingText.includes(`"target": ${targetText}`), 'binding target bytes equal roster.json target bytes');
  const overlay = read(ws.roles), packaged = JSON.parse(packagedRoles);
  assert.deepEqual(overlay.target, ws.roster.target);
  assert.deepEqual(Object.keys(overlay), [...Object.keys(packaged), 'target']);
  const { mirror: _overlayMirror, target: _overlayTarget, ...overlayRest } = overlay, { mirror: _packagedMirror, ...packagedRest } = packaged;
  assert.deepEqual(overlayRest, packagedRest);
  assert.deepEqual(overlay.mirror.notion.probe, ['node', join(PACKAGE, 'scripts/adapters/notion-env.mjs'), 'probe']);
  assert.deepEqual(readFileSync(join(PACKAGE, 'roles.json')), packagedRoles, 'packaged roles.json is never edited');
  r = cli(ws, ['web', 'bind', '--run', ws.runId, '--requirements', `${ws.run}/requirements.web.json`]);
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(r.json().effect, { binding: 'unchanged', roles: 'unchanged' });

  r = cli(ws, ['board', 'seed', '--run', ws.runId, '--tracked', `${ws.run}/tracked-plan.json`, '--file', `${ws.run}/board.jsonl`]);
  assert.equal(r.status, 0, r.text);
  const seeded = readFileSync(join(ws.runDir, 'board.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(seeded.every(row => row.target_kind === 'deployed-build' && row.target_binding_sha256 === binding.target_binding_sha256 && row.contract_sha256 === WEB_CONTRACT_SHA256));

  const receipt = guiReceipt(ws);
  for (const item of ws.cases) {
    r = record(ws, item.id, receipt);
    assert.equal(r.status, 0, r.text);
    const result = r.json(), written = read(join(ws.runDir, 'records', `${item.id}.json`));
    assert.equal(result.case_verdict, 'pass');
    assert.equal(written.child_verdict.verdict, 'pass');
    assert.deepEqual(written.evidence, [written.child_verdict.artifact]);
    assert.deepEqual(readFileSync(join(ws.runDir, written.child_verdict.artifact)), readFileSync(receipt), 'receipt copied byte for byte into the run');
    assert.equal(JSON.stringify(written.target), JSON.stringify(ws.roster.target));
    assert.equal(written.attempt_id, `${item.id}#1`);
    if (item.id === 'TC-LOGIN-01') {
      const envSet = cli(ws, ['board', 'add', '--file', `${ws.run}/board.jsonl`, '--record', `${ws.run}/records/${item.id}.json`],
        { TEAMQA_TARGET_PROJECT_ID: 'sample-shop-local', TEAMQA_TARGET_PREVIEW_URL: PREVIEW, TEAMQA_TARGET_VERSION: BUILD });
      assert.equal(envSet.status, 5, envSet.text);
      assert.match(envSet.text, /verdict=ungraded TARGET_BINDING_KIND_MISMATCH/);
    }
    r = cli(ws, ['board', 'add', '--file', `${ws.run}/board.jsonl`, '--record', `${ws.run}/records/${item.id}.json`]);
    assert.equal(r.status, 0, r.text);
    assert.match(r.out, new RegExp(`verdict=pass ${item.id} case_verdict=pass`));
  }
  r = record(ws, 'TC-LOGIN-01', receipt, 'pass', 'pass', timing(1000));
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /BOARD_RETRY_NOT_ALLOWED/);

  r = cli(ws, ['rtm', 'fill', '--rtm', `${ws.run}/rtm.md`, '--board', `${ws.run}/board.jsonl`, '--out', `${ws.run}/rtm.md`]);
  assert.equal(r.status, 0, r.text);
  r = cli(ws, ['report', 'build', '--run', ws.runId]);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /decision=GO/);
  r = cli(ws, ['report', 'verify', '--run', ws.runId]);
  assert.equal(r.status, 0, r.text);
  r = cli(ws, ['receipt', 'create', '--run', ws.runId, '--binding', `${ws.run}/binding.json`, '--out', `${ws.run}/team-qa.receipt.json`]);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /release_verdict=GO/);
  r = cli(ws, ['receipt', 'verify', '--file', `${ws.run}/team-qa.receipt.json`]);
  assert.equal(r.status, 0, r.text);
  r = cli(ws, ['handoff', 'create', '--receipt', `${ws.run}/team-qa.receipt.json`, '--producer-commit', 'a'.repeat(40), '--out', `${ws.run}/team-qa.handoff.json`]);
  assert.equal(r.status, 0, r.text);
  const handoff = read(join(ws.runDir, 'team-qa.handoff.json'));
  assert.equal(handoff.schema, 'team-qa/handoff/web-v1');
  assert.equal(handoff.target_binding_sha256, binding.target_binding_sha256);
  assert.equal(Object.hasOwn(handoff, 'capsule_digest'), false);
  r = cli(ws, ['handoff', 'verify', '--file', `${ws.run}/team-qa.handoff.json`, '--receipt', `${ws.run}/team-qa.receipt.json`]);
  assert.equal(r.status, 0, r.text);
  const gitReceipt = join(ws.runDir, 'git-receipt.json');
  writeFileSync(gitReceipt, text({ schema: 'team-qa/receipt/v2' }));
  r = cli(ws, ['handoff', 'create', '--receipt', gitReceipt, '--producer-commit', 'a'.repeat(40), '--out', join(ws.runDir, 'git.handoff.json')]);
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /verdict=fail ARG_REQUIRED --capsule/);
  // Upgrade U5: a run that completed with its board undelivered (the record board-delivery.mjs writes and COMPLETE
  // verifies; the controlled contract here does not re-verify it) says so in the report and the receipt.
  writeFileSync(join(ws.runDir, 'control/board-delivery.json'), text({ schema: 'team-qa/board-delivery/v1', run_id: ws.runId, round: 1, roster_hash: ws.rosterHash,
    run_mode: 'unattended', status: 'blocked', canonical: { path: 'qa-board.json', sha256: 'd'.repeat(64) },
    reviews: [1, 2, 3].map((n) => ({ path: `reviews/r${n}.json`, sha256: String(n).repeat(64), verdict: 'FAIL', canonical_sha256: 'd'.repeat(64) })),
    open: ['TC-LOGIN-01: image caption does not match the step'], created_at: new Date().toISOString() }));
  r = cli(ws, ['report', 'build', '--run', ws.runId]);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /decision=GO/, 'GO/NO_GO stays with the signed exit criteria');
  const summary = readFileSync(join(ws.runDir, 'summary-report.md'), 'utf8');
  assert.match(summary, /## Board not handed over\n\nThe board review is still not PASS after 3 fix rounds/);
  assert.match(summary, /- TC-LOGIN-01: image caption does not match the step/);
  r = cli(ws, ['report', 'verify', '--run', ws.runId]);
  assert.equal(r.status, 0, r.text);
  r = cli(ws, ['receipt', 'create', '--run', ws.runId, '--binding', `${ws.run}/binding.json`, '--out', `${ws.run}/team-qa.blocked.receipt.json`]);
  assert.equal(r.status, 0, r.text);
  const blocked = read(join(ws.runDir, 'team-qa.blocked.receipt.json'));
  assert.equal(blocked.board_delivery, 'blocked');
  assert.ok(blocked.run_provenance.artifacts.some((a) => a.path === 'control/board-delivery.json'));
  r = cli(ws, ['receipt', 'verify', '--file', `${ws.run}/team-qa.blocked.receipt.json`]);
  assert.equal(r.status, 0, r.text);
  r = cli(ws, ['receipt', 'verify', '--file', `${ws.run}/team-qa.receipt.json`]);
  assert.notEqual(r.status, 0, 'a receipt made before the blocked delivery no longer matches the run');
});

test('web record grades only what board add would keep graded and chains a retry after an ungraded attempt', () => {
  const ws = workspace();
  bound(ws);
  const cases = [
    [guiReceipt(ws, { semantic: 'FAIL' }), 'CHILD_VERDICT_CONFLICT'],
    [guiReceipt(ws, { runUuid: randomUUID() }), 'CHILD_RECEIPT_SOURCE_BINDING'],
    [guiReceipt(ws, { rows: [] }), 'CHILD_RECEIPT_CASE_MISSING'],
    [guiReceipt(ws, { tamper: receipt => ({ ...receipt, created_at: '2026-01-01T00:00:00Z' }) }), 'CHILD_RECEIPT_INTEGRITY'],
  ];
  for (const [receipt, code] of cases) {
    const r = record(ws, 'TC-LOGIN-01', receipt);
    assert.equal(r.status, 2, `${code}: ${r.text}`);
    assert.match(r.text, new RegExp(`verdict=fail ${code}`));
    assert.equal(existsSync(join(ws.runDir, 'records/TC-LOGIN-01.json')), false, code);
  }
  let r = record(ws, 'TC-LOGIN-01', guiReceipt(ws), 'pass', 'pass', ['--started-at', '2026-10-27T10:00:00Z', '--ended-at', '2026-10-27T10:20:00Z', '--timeout-ms', '600000']);
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /verdict=fail ATTEMPT_TIMEOUT_EXCEEDED/);
  r = cli(ws, ['web', 'record', '--run', ws.runId, '--case', 'TC-LOGIN-01', '--receipt', guiReceipt(ws), '--function', 'pass', '--ui', 'pass', ...timing(), '--out', `${ws.run}/records/env.json`],
    { TEAMQA_TARGET_VERSION: BUILD });
  assert.equal(r.status, 5, r.text);
  assert.match(r.text, /WEB_TARGET_ENV_SET TEAMQA_TARGET_VERSION/);

  r = record(ws, 'TC-LOGIN-01', guiReceipt(ws, { semantic: 'UNGRADED' }), 'ungraded', 'ungraded');
  assert.equal(r.status, 0, r.text);
  const first = read(join(ws.runDir, 'records/TC-LOGIN-01.json'));
  assert.equal(first.verdict, 'ungraded');
  assert.equal(first.reason, 'QA_GUI_UNGRADED');
  r = cli(ws, ['board', 'add', '--file', `${ws.run}/board.jsonl`, '--record', `${ws.run}/records/TC-LOGIN-01.json`]);
  assert.equal(r.status, 1, r.text);
  assert.match(r.text, /verdict=ungraded QA_GUI_UNGRADED TC-LOGIN-01/);
  r = cli(ws, ['web', 'record', '--run', ws.runId, '--case', 'TC-LOGIN-01', '--receipt', guiReceipt(ws), '--function', 'fail', '--ui', 'pass', ...timing(5000),
    '--out', `${ws.run}/records/TC-LOGIN-01.attempt-2.json`]);
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /CHILD_VERDICT_CONFLICT/);
  const failing = guiReceipt(ws, { semantic: 'FAIL' });
  r = cli(ws, ['web', 'record', '--run', ws.runId, '--case', 'TC-LOGIN-01', '--receipt', failing, '--function', 'fail', '--ui', 'pass', ...timing(5000),
    '--out', `${ws.run}/records/TC-LOGIN-01.attempt-2.json`]);
  assert.equal(r.status, 0, r.text);
  const second = read(join(ws.runDir, 'records/TC-LOGIN-01.attempt-2.json'));
  assert.deepEqual([second.verdict, second.attempt, second.attempt_id, second.parent_attempt_id], ['fail', 2, 'TC-LOGIN-01#2', 'TC-LOGIN-01#1']);
  r = cli(ws, ['board', 'add', '--file', `${ws.run}/board.jsonl`, '--record', `${ws.run}/records/TC-LOGIN-01.attempt-2.json`]);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /verdict=pass TC-LOGIN-01 case_verdict=fail/);
});

// Upgrade U2: a receipt QA GUI scoped to one case (qa-gate --case, attested by that case's own GUI dispatch) carries the
// verdict of that case's atomic rows; an unscoped receipt keeps the board's semantic verdict, as in 1.13.1.
test('a case-scoped receipt grades its own case from its rows, so another case\'s FAIL does not block it', () => {
  const ws = workspace();
  bound(ws);
  const results = { 'TC-LOGIN-01': 'PASS', 'TC-LOGIN-02': 'FAIL', 'TC-INTRO-01': 'PASS' };
  const mixed = (caseId) => guiReceipt(ws, { semantic: 'FAIL', tamper: receipt => seal({ ...receipt,
    atomic_coverage: receipt.atomic_coverage.map(row => ({ ...row, result: results[row.case_id] })),
    ...(caseId ? { teamqa_provenance: { ...receipt.teamqa_provenance, case_id: caseId } } : {}) }) });
  let r = record(ws, 'TC-LOGIN-01', mixed(null));
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /CHILD_VERDICT_CONFLICT/);
  r = record(ws, 'TC-LOGIN-01', mixed('TC-LOGIN-01'));
  assert.equal(r.status, 0, r.text);
  assert.equal(read(join(ws.runDir, 'records/TC-LOGIN-01.json')).child_verdict.verdict, 'pass');
  r = cli(ws, ['board', 'add', '--file', `${ws.run}/board.jsonl`, '--record', `${ws.run}/records/TC-LOGIN-01.json`]);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /verdict=pass TC-LOGIN-01 case_verdict=pass/);
  r = record(ws, 'TC-LOGIN-02', mixed('TC-LOGIN-02'));
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /CHILD_VERDICT_CONFLICT/);
  r = record(ws, 'TC-LOGIN-02', mixed('TC-LOGIN-02'), 'fail', 'pass');
  assert.equal(r.status, 0, r.text);
  assert.equal(read(join(ws.runDir, 'records/TC-LOGIN-02.json')).child_verdict.verdict, 'fail');
  r = record(ws, 'TC-INTRO-01', mixed('TC-LOGIN-01'));
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /CHILD_RECEIPT_CASE_SCOPE/);
});

// Upgrade U4: `teamqa run offer` checks an offer to run again and gives the marker the harness and the user read.
test('run offer writes the offer and its marker; refuses cases outside the plan or out of attempts, and a COMPLETE run', async () => {
  const ws = workspace({ runId: 'shop-web-offer' });
  const code = async (fn) => { try { await fn(); return 'NO_ERROR'; } catch (e) { return e.code; } };
  const offer = (o) => createRunOffer({ runDir: ws.runDir, kind: 'round', cases: 'TC-LOGIN-02', reason: 'DISPATCH_UNGRADED', ...o });
  const made = await offer();
  assert.match(made.marker, /^TEAMQA_OFFER run=shop-web-offer round=1 kind=round next=2 cases=TC-LOGIN-02 reason=DISPATCH_UNGRADED sha256=[0-9a-f]{64}$/);
  assert.equal(made.sha256, hash(readFileSync(made.path)));
  assert.equal(made.path, join(ws.runDir, 'control/offers/1.json'));
  const file = read(made.path);
  assert.equal(file.schema, OFFER_SCHEMA);
  assert.deepEqual([file.n, file.kind, file.next, file.cases, file.roster_hash, file.phase], [1, 'round', 2, ['TC-LOGIN-02'], ws.rosterHash, 'DESIGN']);
  assert.equal(file.target_sha256, hash(stableJson(ws.roster.target)));
  assert.equal(await code(() => offer({ cases: 'TC-LOGIN-02,TC-NOPE' })), 'RUN_OFFER_NOT_IN_PLAN');
  assert.equal(await code(() => offer({ kind: 'resume' })), 'RUN_OFFER_KIND');
  assert.equal(await code(() => offer({ reason: 'please retry' })), 'RUN_OFFER_REASON');
  assert.equal(await code(() => offer({ cases: 'TC-LOGIN-02,TC-LOGIN-02' })), 'RUN_OFFER_CASES');
  assert.equal(await code(() => offer({ kind: 'attempt' })), 'RUN_PHASE_REQUIRED');
  const phase = read(join(ws.runDir, 'phase.json'));
  writeFileSync(join(ws.runDir, 'phase.json'), text({ ...phase, phase: 'EXECUTE' }));
  // The run's first bound GUI dispatch names its case (U2), so it counts only against that case.
  writeFileSync(join(ws.runDir, 'role-bindings/executor_gui.json'), text({ fixture: 'controlled run contract', role: 'executor_gui', dispatch_case_id: 'TC-LOGIN-02' }));
  mkdirSync(join(ws.runDir, 'dispatch/executor_gui'), { recursive: true });
  writeFileSync(join(ws.runDir, 'dispatch/executor_gui/case-dispatches.jsonl'), ['a1', 'a2'].map((attempt) => JSON.stringify({ case_id: 'TC-LOGIN-01', attempt })).join('\n') + '\n');
  const attempt = await offer({ kind: 'attempt', cases: 'TC-LOGIN-01,TC-INTRO-01', reason: 'TOOL_FAILED' });
  assert.match(attempt.marker, / kind=attempt next=3 cases=TC-LOGIN-01,TC-INTRO-01 reason=TOOL_FAILED sha256=/);
  assert.equal(attempt.path, join(ws.runDir, 'control/offers/2.json'));
  writeFileSync(join(ws.runDir, 'dispatch/executor_gui/case-dispatches.jsonl'), ['a1', 'a2', 'a3'].map((a) => JSON.stringify({ case_id: 'TC-LOGIN-01', attempt: a })).join('\n') + '\n');
  assert.equal(await code(() => offer({ kind: 'attempt', cases: 'TC-LOGIN-01' })), 'RUN_OFFER_ATTEMPTS_EXHAUSTED');
  writeFileSync(join(ws.runDir, 'phase.json'), text({ ...phase, phase: 'COMPLETE' }));
  assert.equal(await code(() => offer()), 'RUN_OFFER_COMPLETE');
  assert.ok(!existsSync(join(ws.runDir, 'control/offers/3.json')), 'a refused offer writes nothing');
  // The CLI prints the marker line on its own.
  writeFileSync(join(ws.runDir, 'phase.json'), text({ ...phase, phase: 'EXECUTE' }));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/teamqa.mjs'), 'run', 'offer', '--run', ws.runId, '--kind', 'round', '--cases', 'TC-INTRO-01', '--reason', 'DISPATCH_UNGRADED'],
    { cwd: ws.cwd, encoding: 'utf8', env: { ...process.env, HOME, TEAMQA_SCROLL_ROOT: SCROLL } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('TEAMQA_OFFER '));
  assert.equal(line, `TEAMQA_OFFER run=${ws.runId} round=1 kind=round next=2 cases=TC-INTRO-01 reason=DISPATCH_UNGRADED sha256=${hash(readFileSync(join(ws.runDir, 'control/offers/3.json')))}`);
});

// Upgrade U5: the run mode comes from the roster the user approved; a different TEAMQA_RUN_MODE refuses the next command.
test('the run mode is written into the roster and fixed for the run', async () => {
  const ws = workspace({ runId: 'shop-web-mode' });
  const { assertApprovedRoster, checkRoster } = await import('../../scripts/lib/roster.mjs');
  assert.equal(assertApprovedRoster({ runDir: ws.runDir }).run_mode, undefined, 'interactive by default, 1.13.1 roster fields');
  const saved = process.env.TEAMQA_RUN_MODE;
  try {
    process.env.TEAMQA_RUN_MODE = 'interactive';
    assert.equal(assertApprovedRoster({ runDir: ws.runDir }).run_id, ws.runId);
    process.env.TEAMQA_RUN_MODE = 'unattended';
    assert.throws(() => assertApprovedRoster({ runDir: ws.runDir }), (e) => e.code === 'RUN_MODE_DRIFT');
    process.env.TEAMQA_RUN_MODE = 'sometimes';
    assert.throws(() => assertApprovedRoster({ runDir: ws.runDir }), (e) => e.code === 'ROSTER_RUN_MODE');
  } finally { if (saved === undefined) delete process.env.TEAMQA_RUN_MODE; else process.env.TEAMQA_RUN_MODE = saved; }
  const unattended = { ...ws.roster, run_mode: 'unattended' };
  checkRoster(unattended);
  assert.throws(() => checkRoster({ ...ws.roster, run_mode: 'interactive' }), (e) => e.code === 'ROSTER_RUN_MODE');
  assert.match(rosterChat(unattended, 'c'.repeat(64)), /\nRun mode: unattended .*board_delivery: blocked\.\n/);
  assert.equal(rosterChat(ws.roster, 'c'.repeat(64)).includes('Run mode'), false);
});

test('web bind refuses TEAMQA_TARGET_* and a roles overlay that is unset, relative or inside the package', () => {
  const ws = workspace();
  assert.equal(cli(ws, ['web', 'requirements', '--run', ws.runId]).status, 0);
  const bind = env => cli(ws, ['web', 'bind', '--run', ws.runId, '--requirements', `${ws.run}/requirements.web.json`], env);
  const link = join(ws.cwd, 'package-link'), dangling = join(ws.cwd, 'dangling-roles.json');
  symlinkSync(PACKAGE, link);
  symlinkSync(join(ws.cwd, 'missing-dir', 'roles.json'), dangling);
  for (const [env, code, exit] of [
    [{ TEAMQA_TARGET_PROJECT_ID: 'sample-shop-local' }, 'WEB_TARGET_ENV_SET TEAMQA_TARGET_PROJECT_ID', 5],
    [{ TEAMQA_ROLES: undefined }, 'WEB_ROLES_REQUIRED', 5],
    [{ TEAMQA_ROLES: 'config/teamqa-roles.json' }, 'WEB_ROLES_RELATIVE', 5],
    [{ TEAMQA_ROLES: join(PACKAGE, 'roles.json') }, 'WEB_ROLES_INSIDE_PACKAGE', 5],
    [{ TEAMQA_ROLES: join(PACKAGE, 'config', 'web-roles.json') }, 'WEB_ROLES_INSIDE_PACKAGE', 5],
    [{ TEAMQA_ROLES: join(link, 'web-roles.json') }, 'WEB_ROLES_INSIDE_PACKAGE', 5],
    [{ TEAMQA_ROLES: dangling }, 'WEB_ROLES_NOT_FILE', 5],
  ]) {
    const r = bind(env);
    assert.equal(r.status, exit, `${code}: ${r.text}`);
    assert.match(r.text, new RegExp(`verdict=ungraded ${code}`));
    assert.equal(existsSync(join(ws.runDir, 'binding.json')), false, code);
  }
  assert.equal(existsSync(join(PACKAGE, 'config')), false);
  mkdirSync(join(ws.cwd, 'config'));
  writeFileSync(ws.roles, '{"schema_version":1}\n');
  let r = bind({});
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /WEB_ARTIFACT_EXISTS/);
  assert.equal(existsSync(join(ws.runDir, 'binding.json')), false);
  r = bind({ TEAMQA_ROLES: ws.roles.replace('teamqa-roles.json', 'fresh-roles.json') });
  assert.equal(r.status, 0, r.text);
  assert.equal(r.json().roles_overlay, ws.roles.replace('teamqa-roles.json', 'fresh-roles.json'));
});

test('web bind rejects requirement graphs QA GUI would reject or that do not match the run', () => {
  const ws = workspace();
  assert.equal(cli(ws, ['web', 'requirements', '--run', ws.runId]).status, 0);
  const good = read(join(ws.runDir, 'requirements.web.json'));
  const variants = [
    ['git-field', graph => ({ ...graph, repo: '/product' }), 'WEB_REQUIREMENTS_INVALID requirements.freeze/web-v1:UNKNOWN_FIELD:repo'],
    ['layers', graph => ({ ...graph, gate_policy: { ...graph.gate_policy, required_layers: ['gui', 'code'] } }), 'WEB_REQUIREMENTS_INVALID WEB_GATE_LAYERS'],
    ['lane', graph => ({ ...graph, requirements: graph.requirements.map(item => ({ ...item, verification_lane: 'code' })) }), 'WEB_REQUIREMENTS_INVALID WEB_REQUIREMENT_LANE:REQ-LOGIN'],
    ['risk', graph => ({ ...graph, requirements: graph.requirements.map(item => ({ ...item, risk_dimensions: ['made-up'] })) }), 'WEB_REQUIREMENTS_INVALID REQUIREMENT_RISK:REQ-LOGIN'],
    ['atomic', graph => ({ ...graph, requirements: graph.requirements.map(item => ({ ...item, evidence_contract: { ...item.evidence_contract, atomic: false } })) }), 'WEB_REQUIREMENTS_INVALID EVIDENCE_CONTRACT:REQ-LOGIN'],
    ['contract', graph => ({ ...graph, contract_sha256: '0'.repeat(64) }), 'WEB_REQUIREMENTS_INVALID WEB_REQUIREMENT_CONTRACT_SHA'],
    ['target', graph => ({ ...graph, target_binding_sha256: 'f'.repeat(64) }), 'WEB_GRAPH_TARGET_BINDING_MISMATCH'],
    ['acceptance', graph => ({ ...graph, requirements: graph.requirements.map(item => ({ ...item, acceptance_ids: item.acceptance_ids.slice(0, 1) })) }),
      'WEB_GRAPH_TRACKED_MISMATCH WEB_GRAPH_ACCEPTANCE_ID_MISSING:TC-LOGIN-02:REQ-LOGIN'],
    ['missing', graph => ({ ...graph, requirements: graph.requirements.slice(0, 1) }), 'WEB_GRAPH_TRACKED_MISMATCH TRACKED_PLAN_REQUIREMENT:TC-INTRO-01:REQ-INTRO'],
  ];
  for (const [name, change, code] of variants) {
    writeFileSync(join(ws.runDir, `requirements.${name}.json`), text(change(structuredClone(good))));
    const r = cli(ws, ['web', 'bind', '--run', ws.runId, '--requirements', `${ws.run}/requirements.${name}.json`]);
    assert.equal(r.status, 2, `${name}: ${r.text}`);
    assert.ok(r.text.includes(`verdict=fail ${code}`), `${name}: ${r.text}`);
    assert.equal(existsSync(join(ws.runDir, 'binding.json')), false, name);
  }
  writeFileSync(join(ws.cwd, 'requirements.outside.json'), text(good));
  let r = cli(ws, ['web', 'bind', '--run', ws.runId, '--requirements', 'requirements.outside.json']);
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /WEB_REQUIREMENTS_OUTSIDE_RUN/);
  // A changed identity transcript line no longer proves the target.
  const lines = readFileSync(ws.transcript, 'utf8').split('\n');
  const tabResult = lines.findIndex(line => line.includes('"getTabInfo"')) + 1;
  lines[tabResult] = lines[tabResult].replace('Sample Shop', 'Sample Shop (edited)');
  writeFileSync(ws.transcript, lines.join('\n'));
  r = cli(ws, ['web', 'bind', '--run', ws.runId, '--requirements', `${ws.run}/requirements.web.json`]);
  assert.equal(r.status, 3, r.text);
  assert.match(r.text, /verdict=ungraded WEB_IDENTITY_PROOF_INVALID PREFLIGHT_SOURCE_DRIFT/);
  assert.equal(existsSync(join(ws.runDir, 'binding.json')), false);
});

test('web requirements derives defaults from the signed plan and refuses non-GUI, stale or invalid input', () => {
  const recording = workspace({ preflight: { code: false, gui: true, recording: true }, tiers: { 'REQ-LOGIN': 'FULL', 'REQ-INTRO': 'SMOKE', 'REQ-REPORTS': 'SMOKE' } });
  let r = cli(recording, ['web', 'requirements', '--run', recording.runId]);
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(r.json().uncovered_requirements, ['REQ-REPORTS']);
  let graph = read(join(recording.runDir, 'requirements.web.json'));
  assert.deepEqual(graph.requirements.map(item => item.evidence_contract.allowed_types), [['gui-screenshot', 'gui-recording'], ['gui-screenshot', 'gui-recording']]);
  const smoke = workspace({ tiers: { 'REQ-LOGIN': 'SMOKE', 'REQ-INTRO': 'SMOKE' } });
  r = cli(smoke, ['web', 'requirements', '--run', smoke.runId, '--allowed-types', 'gui-screenshot,gui-recording,machine-receipt']);
  assert.equal(r.status, 0, r.text);
  graph = read(join(smoke.runDir, 'requirements.web.json'));
  assert.equal(graph.gate_policy.coverage_threshold, 70);
  assert.deepEqual(graph.requirements[0].evidence_contract.allowed_types, ['gui-screenshot', 'gui-recording', 'machine-receipt']);
  const ws = workspace();
  for (const [args, code] of [[['--allowed-types', 'machine-receipt'], 'WEB_ALLOWED_TYPES_NO_GUI'], [['--allowed-types', 'gui-screenshot,,x'], 'WEB_ALLOWED_TYPES_INVALID'],
    [['--threshold', '101'], 'WEB_THRESHOLD_INVALID'], [['--threshold', '7.5'], 'WEB_THRESHOLD_INVALID']]) {
    r = cli(ws, ['web', 'requirements', '--run', ws.runId, ...args]);
    assert.equal(r.status, 2, `${code}: ${r.text}`);
    assert.match(r.text, new RegExp(`verdict=fail ${code}`));
  }
  r = cli(ws, ['web', 'requirements', '--run', ws.runId], { TEAMQA_TARGET_PREVIEW_URL: PREVIEW });
  assert.equal(r.status, 5, r.text);
  assert.match(r.text, /WEB_TARGET_ENV_SET/);
  writeFileSync(join(ws.runDir, 'tracked-plan.json'), readFileSync(join(ws.runDir, 'tracked-plan.json'), 'utf8').replace('"lane": "gui"', '"lane": "code"'));
  r = cli(ws, ['web', 'requirements', '--run', ws.runId]);
  assert.equal(r.status, 3, r.text);
  assert.match(r.text, /verdict=fail WEB_DOCUMENT_STALE tracked/);
  ws.lockDocs();
  r = cli(ws, ['web', 'requirements', '--run', ws.runId]);
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /verdict=fail WEB_CASE_LANE_NOT_GUI TC-LOGIN-01:code/);
  assert.equal(existsSync(join(ws.runDir, 'requirements.web.json')), false);
});

const QA_GUI = process.env.TEAMQA_WEB_TEST_QA_GUI_ROOT;
test('QA GUI own web reader validates the graph when its root is resolvable', { skip: QA_GUI ? false : 'set TEAMQA_WEB_TEST_QA_GUI_ROOT to a QA GUI 2.15+ checkout' }, () => {
  const ws = workspace();
  let r = cli(ws, ['web', 'requirements', '--run', ws.runId], { TEAMQA_QA_GUI_ROOT: QA_GUI });
  assert.equal(r.status, 0, r.text);
  assert.equal(r.json().validator, `qa-gui:${realpathSync(QA_GUI)}`);
  const graph = read(join(ws.runDir, 'requirements.web.json'));
  writeFileSync(join(ws.runDir, 'requirements.git.json'), text({ ...graph, task_base: 'a'.repeat(40) }));
  r = cli(ws, ['web', 'bind', '--run', ws.runId, '--requirements', `${ws.run}/requirements.git.json`], { TEAMQA_QA_GUI_ROOT: QA_GUI });
  assert.equal(r.status, 2, r.text);
  assert.match(r.text, /WEB_REQUIREMENTS_INVALID requirements\.freeze\/web-v1:UNKNOWN_FIELD:task_base/);
  r = cli(ws, ['web', 'bind', '--run', ws.runId, '--requirements', `${ws.run}/requirements.web.json`], { TEAMQA_QA_GUI_ROOT: QA_GUI });
  assert.equal(r.status, 0, r.text);
  assert.equal(r.json().validator, `qa-gui:${realpathSync(QA_GUI)}`);
});
