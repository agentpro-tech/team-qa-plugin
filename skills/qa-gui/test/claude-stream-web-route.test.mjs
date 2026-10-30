import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNativeGuiPolicyGuard } from '../scripts/lib/teamqa-attestation.mjs';
import {
  CLAUDE_STREAM_ROUTE_RULE, caseEvidenceSessionIssues,
  FOREIGN_BROWSER_COMMAND_PATTERNS,
  assertClaudeStreamWebRoute,
  foreignBrowserCommand,
  inspectClaudeStreamDragonRoute,
} from '../scripts/lib/claude-stream-route.mjs';
import { requirementsHash, webTargetBindingSha256, WEB_CONTRACT_SHA256 } from '../scripts/lib/release-truth-v2.mjs';

// Synthetic parser and seam fixtures only: never a host attestation, live Dragon run or product PASS.
// Event shapes follow a Claude Code 2.1.311 `-p --output-format stream-json --verbose` run with a stub
// stdio MCP server named Dragon_Browser (init mcp_servers/tools, tool_use with caller, MCP tool_result
// without is_error on success, rate_limit_event, terminal result).
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SID = '22222222-3333-4444-8555-666666666666';
const UUID = '11111111-1111-4111-8111-111111111111';
const ROUTE = 'Dragon_Browser';
const RPC = `mcp__${ROUTE}__dragon_rpc`;
const TEAMQA_REPO = 'https://github.com/agentpro-tech/team-qa.git';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value) + '\n'); };
const jsonl = (events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

const init = (over = {}) => ({ type: 'system', subtype: 'init', cwd: '/fixture/run', session_id: SID,
  tools: ['Bash', 'Glob', 'Grep', 'Read', RPC, `mcp__${ROUTE}__listTabs`],
  mcp_servers: [{ name: ROUTE, status: 'connected', source: 'dynamic' }], model: 'claude-fixture',
  permissionMode: 'default', slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.311', uuid: 'init', ...over });
const use = (id, name, input) => ({ type: 'assistant', message: { model: 'claude-fixture', id: `msg_${id}`, type: 'message',
  role: 'assistant', content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }], stop_reason: null },
  parent_tool_use_id: null, session_id: SID, uuid: `use-${id}` });
const answer = (id, content, block = {}) => ({ type: 'user', message: { role: 'user',
  content: [{ tool_use_id: id, type: 'tool_result', content, ...block }] }, parent_tool_use_id: null, session_id: SID, uuid: `result-${id}` });
const say = (text) => ({ type: 'assistant', message: { model: 'claude-fixture', id: 'msg_text', type: 'message', role: 'assistant',
  content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: SID, uuid: 'text' });
const done = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 4,
  result: 'GUI evidence collected; the verdict stays with QA GUI.', session_id: SID, permission_denials: [], uuid: 'done', ...over });
const dragon = (result) => [{ type: 'text', text: JSON.stringify({ ok: true, result }) }];

function cleanEvents() {
  return [
    init(),
    use('toolu_1', RPC, { method: 'listTabs', params: {} }),
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: 'rate', session_id: SID },
    answer('toolu_1', dragon({ tabs: [{ tabId: 7, url: 'http://127.0.0.1:5401/intro' }] })),
    use('toolu_2', 'Bash', { command: 'curl --fail --silent http://127.0.0.1:9233/status', description: 'Check the Dragon bridge' }),
    answer('toolu_2', '{"ok":true}', { is_error: false }),
    use('toolu_3', RPC, { method: 'screenshot', params: { tabId: 7, toFile: '/fixture/run/evidence/C1-loaded.png' } }),
    answer('toolu_3', dragon({ savedTo: '/fixture/run/evidence/C1-loaded.png', privacyMasked: true, maskedRects: [] })),
    say('GUI evidence collected.'),
    done(),
  ];
}
const inspect = (events, over = {}) => inspectClaudeStreamDragonRoute({ stream: jsonl(events), sessionId: SID, server: ROUTE, ...over });
const codes = (result) => result.errors.map((error) => error.split(':')[0]);
const withEvent = (index, ...events) => { const list = cleanEvents(); list.splice(index, 0, ...events); return list; };

test('clean Claude stream on the roster Dragon route passes deterministically', () => {
  const first = inspect(cleanEvents());
  assert.deepEqual(first.errors, []);
  assert.equal(first.summary.dragon_rpc_ok, 2);
  assert.equal(first.summary.init_events, 1);
  assert.deepEqual(inspect(cleanEvents()), first);
  assert.ok(Object.isFrozen(FOREIGN_BROWSER_COMMAND_PATTERNS));
});

test('init must list exactly the roster Dragon server, connected, and no foreign MCP tools', () => {
  for (const servers of [
    [{ name: ROUTE, status: 'connected' }, { name: 'playwright', status: 'connected' }],
    [{ name: 'dragon', status: 'connected' }],
    [],
  ]) {
    const events = cleanEvents(); events[0] = init({ mcp_servers: servers });
    assert.equal(codes(inspect(events))[0], 'TEAMQA_WEB_CLAUDE_MCP_ROUTE_MISMATCH', JSON.stringify(servers));
  }
  const tools = cleanEvents(); tools[0] = init({ tools: [...init().tools, 'mcp__claude-in-chrome__navigate'] });
  assert.equal(inspect(tools).errors[0], 'TEAMQA_WEB_CLAUDE_MCP_ROUTE_MISMATCH:line=1:mcp__claude-in-chrome__navigate');
  const failed = cleanEvents(); failed[0] = init({ mcp_servers: [{ name: ROUTE, status: 'failed', source: 'dynamic' }] });
  assert.equal(inspect(failed).errors[0], 'TEAMQA_WEB_CLAUDE_DRAGON_NOT_CONNECTED:line=1:failed');
  assert.equal(inspect(cleanEvents().slice(1)).errors[0], 'TEAMQA_WEB_CLAUDE_STREAM_INVALID:init');
});

test('a successful dragon_rpc call/result pair is required', () => {
  const failures = {
    'error flag': (e) => { e[3] = answer('toolu_1', dragon({}), { is_error: true }); e[7] = answer('toolu_3', dragon({}), { is_error: true }); },
    'non-boolean error flag': (e) => { e[3] = answer('toolu_1', dragon({}), { is_error: 'false' }); e[7] = answer('toolu_3', dragon({}), { is_error: 'false' }); },
    'envelope not ok': (e) => { for (const i of [3, 7]) e[i] = answer(e[i].message.content[0].tool_use_id, [{ type: 'text', text: '{"ok":false,"error":"session mismatch"}' }]); },
    'inner failure': (e) => { e[3] = answer('toolu_1', dragon({ completed: false })); e[7] = answer('toolu_3', dragon({ results: [{ ok: false }] })); },
    'human needed': (e) => { e[3] = answer('toolu_1', dragon({ human_needed: true })); e[7] = answer('toolu_3', dragon({ ok: false })); },
    'not JSON': (e) => { e[3] = answer('toolu_1', 'Error: tab closed'); e[7] = answer('toolu_3', [{ type: 'text', text: '<persisted-output>' }]); },
    'truncated': (e) => { for (const i of [3, 7]) e[i] = answer(e[i].message.content[0].tool_use_id, [{ type: 'text', text: '{"ok":true,"truncated":true,"result":{}}' }]); },
    'unanswered': (e) => { e.splice(7, 1); e.splice(3, 1); },
    'convenience tools only': (e) => { e[1] = use('toolu_1', `mcp__${ROUTE}__listTabs`, {}); e[6] = use('toolu_3', `mcp__${ROUTE}__screenshot`, {}); },
    'method missing': (e) => { e[1] = use('toolu_1', RPC, { params: {} }); e[6] = use('toolu_3', RPC, { method: '' }); },
  };
  for (const [name, mutate] of Object.entries(failures)) {
    const events = cleanEvents(); mutate(events);
    assert.ok(codes(inspect(events)).includes('TEAMQA_WEB_CLAUDE_DRAGON_CALL_REQUIRED'), name);
  }
});

test('non-Dragon browser routes are rejected even when attempted next to Dragon calls', () => {
  const routes = [
    ['Bash', { command: 'npx playwright test --headed' }],
    ['Bash', { command: 'pla"y"wright open http://127.0.0.1:5401/' }],
    ['Bash', { command: 'node shot.js # puppeteer-core' }],
    ['Bash', { command: 'python3 -m selenium --browser chrome' }],
    ['Bash', { command: '/Applications/Chromium.app/Contents/MacOS/Chromium --remote-debugging-port=9333' }],
    ['Bash', { command: 'curl -s http://127.0.0.1:9222/json/version' }],
    ['Bash', { command: 'open -a "Google Chrome" http://127.0.0.1:5401/intro' }],
    ['Bash', { command: 'cd /tmp && open http://127.0.0.1:5401/' }],
    ['Bash', { command: 'osascript -e \'tell application "Safari" to open location "http://127.0.0.1:5401"\'' }],
    ['Bash', { command: 'xdg-open http://127.0.0.1:5401/' }],
    [`mcp__claude-in-chrome__navigate`, { url: 'http://127.0.0.1:5401/' }],
    ['mcp__playwright__browser_navigate', { url: 'http://127.0.0.1:5401/' }],
    ['WebFetch', { url: 'http://127.0.0.1:5401/', prompt: 'Read the page' }],
    ['WebSearch', { query: 'acme supply' }],
    ['Task', { description: 'Browse', prompt: 'Open the app' }],
    ['Agent', { description: 'Browse', prompt: 'Open the app' }],
  ];
  for (const [name, input] of routes) {
    // Denied attempts count: the check is on tool use, not on what the host allowed.
    const result = inspect(withEvent(8, use('toolu_x', name, input), answer('toolu_x', 'Permission denied', { is_error: true })));
    assert.deepEqual(codes(result), ['TEAMQA_WEB_CLAUDE_FOREIGN_BROWSER_ROUTE'], `${name} ${JSON.stringify(input)}`);
  }
  const server = say('');
  server.message.content = [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: { url: 'http://127.0.0.1:5401/' } }];
  assert.equal(inspect(withEvent(8, server)).errors[0], 'TEAMQA_WEB_CLAUDE_FOREIGN_BROWSER_ROUTE:line=9:server_tool_use:web_fetch');
  const sub = use('toolu_sub', 'Bash', { command: 'npx playwright screenshot http://127.0.0.1:5401/' });
  sub.parent_tool_use_id = 'toolu_task';
  assert.equal(inspect(withEvent(8, sub)).errors[0], 'TEAMQA_WEB_CLAUDE_FOREIGN_BROWSER_ROUTE:line=9:Bash:playwright');
});

test('read-only shell use and the Dragon bridge status check are not browser routes', () => {
  for (const command of ['ls -la evidence', 'cat runs/fixture/tracked-plan.json', 'curl --fail --silent http://127.0.0.1:9233/status',
    'grep -n "open tab" notes.md', 'node --version', 'shasum -a 256 evidence/C1-loaded.png', 'wc -c /tmp/openapi.json']) {
    assert.equal(foreignBrowserCommand(command), null, command);
  }
  assert.equal(foreignBrowserCommand('npx  Playwright test'), 'playwright');
});

test('every event must belong to the attested session', () => {
  const events = cleanEvents(); events[3] = { ...events[3], session_id: 'other-session' };
  assert.equal(inspect(events).errors[0], 'TEAMQA_WEB_CLAUDE_STREAM_SESSION:line=4');
  assert.equal(inspect(cleanEvents(), { sessionId: '33333333-3333-4333-8333-333333333333' }).errors[0], 'TEAMQA_WEB_CLAUDE_STREAM_SESSION:line=1');
  const noSession = cleanEvents(); delete noSession.at(-1).session_id;
  assert.ok(codes(inspect(noSession)).includes('TEAMQA_WEB_CLAUDE_STREAM_SESSION'));
});

test('the stream must end in exactly one successful result', () => {
  assert.equal(inspect(cleanEvents().slice(0, -1)).errors[0], 'TEAMQA_WEB_CLAUDE_STREAM_INCOMPLETE:results=0');
  const maxTurns = cleanEvents(); maxTurns[maxTurns.length - 1] = done({ subtype: 'error_max_turns', is_error: true });
  assert.equal(inspect(maxTurns).errors[0], 'TEAMQA_WEB_CLAUDE_STREAM_INCOMPLETE:error_max_turns');
  const late = cleanEvents(); late.push(say('late'));
  assert.deepEqual(codes(inspect(late)), ['TEAMQA_WEB_CLAUDE_STREAM_INCOMPLETE']);
  const twice = cleanEvents(); twice.push(done());
  assert.deepEqual(codes(inspect(twice)), ['TEAMQA_WEB_CLAUDE_STREAM_INCOMPLETE']);
});

test('malformed or reordered streams fail closed', () => {
  assert.equal(inspectClaudeStreamDragonRoute({ stream: jsonl(cleanEvents()) + 'not json\n', sessionId: SID, server: ROUTE }).errors[0],
    'TEAMQA_WEB_CLAUDE_STREAM_INVALID:line=11');
  const early = cleanEvents(); early.unshift(early.splice(1, 1)[0]);
  assert.equal(inspect(early).errors[0], 'TEAMQA_WEB_CLAUDE_STREAM_INVALID:init');
  const orphan = cleanEvents(); orphan.splice(3, 0, answer('toolu_9', dragon({})));
  assert.equal(inspect(orphan).errors[0], 'TEAMQA_WEB_CLAUDE_STREAM_INVALID:line=4:tool_result');
  const replay = withEvent(4, answer('toolu_1', dragon({})));
  assert.equal(inspect(replay).errors[0], 'TEAMQA_WEB_CLAUDE_STREAM_INVALID:line=5:tool_result');
  const reused = withEvent(4, use('toolu_1', RPC, { method: 'listTabs', params: {} }));
  assert.equal(inspect(reused).errors[0], 'TEAMQA_WEB_CLAUDE_STREAM_INVALID:line=5:tool_use');
  assert.deepEqual(inspect(cleanEvents(), { server: 'playwright' }).errors, ['TEAMQA_WEB_CLAUDE_STREAM_INVALID:input']);
});

function routeFixture(events = cleanEvents()) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-claude-route-')));
  const runDir = join(root, 'run'), config = join(root, 'catalog', 'dragon-mcp.json');
  json(config, { mcpServers: { [ROUTE]: { command: process.execPath, args: ['/fixture/dragon-mcp.mjs'] } } });
  const targetBindingSha256 = 'c'.repeat(64), stream = join(runDir, 'dispatch', 'executor_gui', SID, 'stdout.jsonl');
  mkdirSync(dirname(stream), { recursive: true });
  writeFileSync(stream, jsonl(events));
  const f = { root, runDir, config, stream, targetBindingSha256 };
  f.pin = () => {
    json(join(runDir, 'roster.json'), { schema: 'team-qa/roster/v1', run_id: 'run', round: 1,
      target: { kind: 'deployed-build', target_binding_sha256: targetBindingSha256 },
      roles: [{ role: 'executor_gui', provider: 'anthropic', model: 'claude-fixture', effort: 'high', harness: 'claude',
        mcp_config: { path: config, sha256: sha(readFileSync(config)) } }] });
    f.attestation = claudeAttestation({ rosterHash: sha(readFileSync(join(runDir, 'roster.json'))), stream });
  };
  f.pin();
  f.check = (attestation = f.attestation, target = targetBindingSha256) => assertClaudeStreamWebRoute(attestation, { runDir, targetBindingSha256: target });
  return f;
}
function claudeAttestation({ rosterHash, stream }) {
  return { schema: 'team-qa/role-attestation/v1', run_id: 'run', round: 1, roster_hash: rosterHash, role: 'executor_gui',
    agent_id: `claude:${SID}`, session_id: SID,
    runtime: { provider: 'anthropic', model: 'claude-fixture', effort: 'high', harness: 'claude', version: '2.1.311',
      sent: { model: 'claude-fixture', effort: 'high' }, observed: { model: 'claude-fixture', effort: 'high', session_id: SID } },
    context: [], source: { kind: 'claude-stream', path: stream, sha256: sha(readFileSync(stream)),
      stderr_path: join(dirname(stream), 'stderr.txt'), stderr_sha256: sha(''),
      metadata_source: { kind: 'claude-transcript', path: `/fixture/home/.claude/projects/-run/${SID}.jsonl` } }, graded: true };
}

test('route check binds the stream bytes, roster, pinned MCP config and target', () => {
  const f = routeFixture();
  assert.deepEqual(f.check(), { rule: CLAUDE_STREAM_ROUTE_RULE, mcp_server: ROUTE,
    mcp_config_sha256: sha(readFileSync(f.config)), dragon_rpc_ok: 2 });
  writeFileSync(f.stream, readFileSync(f.stream, 'utf8') + '\n');
  assert.throws(() => f.check(), /^Error: TEAMQA_WEB_CLAUDE_STREAM_DRIFT$/);

  const outside = routeFixture(), copy = join(outside.root, 'stdout.jsonl');
  copyFileSync(outside.stream, copy);
  assert.throws(() => outside.check({ ...outside.attestation, source: { ...outside.attestation.source, path: copy } }), /TEAMQA_WEB_CLAUDE_STREAM_DRIFT/);

  const roster = routeFixture();
  assert.throws(() => roster.check({ ...roster.attestation, roster_hash: '0'.repeat(64) }), /TEAMQA_WEB_CLAUDE_ROSTER_DRIFT/);
  assert.throws(() => roster.check(roster.attestation, 'd'.repeat(64)), /TEAMQA_WEB_CLAUDE_TARGET_MISMATCH/);

  const route = routeFixture();
  json(route.config, { mcpServers: { [ROUTE]: { command: process.execPath, args: ['/other/server.mjs'] } } });
  assert.throws(() => route.check(), /TEAMQA_WEB_CLAUDE_ROUTE_DRIFT/);
  json(route.config, { mcpServers: { [ROUTE]: { command: process.execPath, args: [] }, playwright: { command: process.execPath, args: [] } } });
  route.pin();
  assert.throws(() => route.check(), /TEAMQA_WEB_CLAUDE_ROUTE_REQUIRED/);

  const shape = routeFixture();
  for (const attestation of [
    { ...shape.attestation, runtime: { ...shape.attestation.runtime, provider: 'openai' } },
    { ...shape.attestation, source: { ...shape.attestation.source, kind: 'codex-stream' } },
    { ...shape.attestation, role: 'analyst' },
    { ...shape.attestation, graded: false },
  ]) assert.throws(() => shape.check(attestation), /TEAMQA_WEB_CLAUDE_ATTESTATION_SHAPE/);
});

test('route check surfaces the first stream rule failure as a stable code', () => {
  const f = routeFixture(withEvent(8, use('toolu_x', 'Bash', { command: 'npx playwright test' })));
  assert.throws(() => f.check(), /^Error: TEAMQA_WEB_CLAUDE_FOREIGN_BROWSER_ROUTE:line=9:Bash:playwright$/);
});

test('native GUI policy guard itself is unchanged for web claude-stream and codex-stream sources', () => {
  for (const kind of ['claude-stream', 'codex-stream', 'codex-rollout']) {
    assert.throws(() => assertNativeGuiPolicyGuard({ source: { kind } }, { targetBindingSha256: 'c'.repeat(64) }), /TEAMQA_WEB_NATIVE_SOURCE_REQUIRED/);
    const value = { source: { kind } };
    assert.equal(assertNativeGuiPolicyGuard(value), value);
  }
});

// ---- End-to-end seam: verifyTeamQaGuiAttestation, receipt emission/readback and qa-gate under a fake HOME.
const url = (path) => pathToFileURL(join(ROOT, path)).href;
// Test seam standing in for Team QA's verified run contract; never a product or host attestation.
const STUB_RUN_CONTRACT = `import{readFileSync}from'node:fs';import{join}from'node:path';
export function assertRunContract({runDir}){return{roster:JSON.parse(readFileSync(join(runDir,'roster.json'),'utf8'))};}
export function assertRoleAttestation({runDir,role,attestationPath}){return JSON.parse(readFileSync(attestationPath??join(runDir,'role-bindings',role+'.json'),'utf8'));}
`;
const RUNNER = `import{readFileSync,writeFileSync}from'node:fs';
import{verifyTeamQaGuiAttestation}from${JSON.stringify(url('scripts/lib/teamqa-attestation.mjs'))};
import{createGuiReceiptWeb,validateGuiReceipt}from${JSON.stringify(url('scripts/lib/release-receipt-v2.mjs'))};
import{readGuiWebContext,webBindingAfterAttestation}from${JSON.stringify(url('scripts/lib/release-truth-v2.mjs'))};
const spec=JSON.parse(process.argv[2]);const out={};
try{
  if(spec.op==='verify')out.value=verifyTeamQaGuiAttestation(spec.options);
  if(spec.op==='receipt'){const teamqa=verifyTeamQaGuiAttestation(spec.options);
    const context=readGuiWebContext({...spec.context,verifyWebBinding:webBindingAfterAttestation});
    out.value=createGuiReceiptWeb({context,data:{runUuid:spec.options.runUuid,evidenceManifest:[]},semanticVerdict:'UNGRADED',atomicCoverage:[],teamqa,createdAt:'2026-10-27T00:00:00.000Z'});
    writeFileSync(spec.out,JSON.stringify(out.value,null,2)+'\\n');}
  if(spec.op==='readback')out.value=validateGuiReceipt(JSON.parse(readFileSync(spec.receipt,'utf8')));
  out.ok=true;
}catch(error){out.ok=false;out.error=error.message;}
process.stdout.write(JSON.stringify(out));
`;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}
function teamqaFixture({ kind = 'claude-stream', lane = 'web', events = cleanEvents() } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `qa-gui-claude-web-${kind}-${lane}-`)));
  const home = join(root, 'home'), runtime = join(root, 'runtime'), canonical = join(root, 'canonical'), runDir = join(root, 'run');
  json(join(runtime, 'package-files.json'), { schema: 'agentpro/skill-package-files/v1', skill: 'team-qa', version: '0.0.0-fixture', include: ['package-files.json', 'scripts'] });
  mkdirSync(join(runtime, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(runtime, 'scripts', 'lib', 'run-contract.mjs'), STUB_RUN_CONTRACT);
  run(process.execPath, [join(ROOT, 'scripts', 'package-tool.mjs'), 'manifest', '--root', runtime]);
  mkdirSync(canonical);
  run('git', ['-c', 'init.defaultBranch=main', 'init', '-q', canonical]);
  copyFileSync(join(runtime, 'package-manifest.json'), join(canonical, 'package-manifest.json'));
  run('git', ['-C', canonical, 'add', 'package-manifest.json']);
  run('git', ['-C', canonical, '-c', 'user.name=fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'fixture']);
  const commit = run('git', ['-C', canonical, 'rev-parse', 'HEAD']), tree = run('git', ['-C', canonical, 'rev-parse', 'HEAD^{tree}']);
  json(join(runtime, 'SOURCE.json'), { schema: 'agentpro/skill-source/v1', skill: 'team-qa', version: '0.0.0-fixture', repo: TEAMQA_REPO,
    commit, tree, manifest_sha256: sha(readFileSync(join(runtime, 'package-manifest.json'))), package_sha256: '0'.repeat(64), built_at: '2026-10-27T00:00:00.000Z' });
  json(join(home, '.agents', 'skills', 'team-qa', 'release-truth.json'), { schema: 'team-code/release-truth/v1', repo: canonical, repo_url: TEAMQA_REPO, head: commit });

  const target = { project_id: 'acme-supply', preview_url: 'http://127.0.0.1:5401/intro', version: 'index-CJjkO35e', kind: 'deployed-build',
    environment: 'Local', backend_origin: 'http://127.0.0.1:5411', frontend_build: { kind: 'vite', id: 'index-CJjkO35e' },
    asset_manifest_sha256: 'b'.repeat(64), target_binding_sha256: '', identity_proof: { path: 'identity/proof.json', sha256: '' } };
  target.target_binding_sha256 = webTargetBindingSha256(target);
  const { target_binding_sha256: _hash, identity_proof: _proof, ...identity } = target;
  const proofRaw = JSON.stringify({ schema: 'team-qa/deployed-identity-proof/v1', target_binding_sha256: target.target_binding_sha256, identity,
    sources: [{ path: 'original-host-ref', call_line: 1, result_line: 2, call_sha256: 'c'.repeat(64), result_sha256: 'd'.repeat(64), host: 'claude' }] }) + '\n';
  mkdirSync(join(runDir, 'identity'), { recursive: true });
  writeFileSync(join(runDir, 'identity', 'proof.json'), proofRaw);
  target.identity_proof.sha256 = sha(proofRaw);
  const graph = { schema: 'requirements.freeze/web-v1', contract_sha256: WEB_CONTRACT_SHA256, source_revision: 'acme-supply-brief-1',
    target_binding_sha256: target.target_binding_sha256, gate_policy: { coverage_threshold: 100, required_layers: ['gui'] },
    requirements: [{ id: 'R1', expectation: 'Intro page renders', requirement_owner: 'fixture', verification_lane: 'gui', risk_dimensions: [],
      acceptance_ids: ['C1'], evidence_contract: { allowed_types: ['gui-screenshot'], atomic: true, multi_evidence: false } }] };
  json(join(runDir, 'REQUIREMENTS.json'), graph);
  json(join(runDir, 'tracked-plan.json'), { cases: [{ id: 'C1', req_id: 'R1', lane: 'gui' }] });
  const webBinding = { schema: 'team-qa/web-binding/v1', run_uuid: UUID, requirements_hash: requirementsHash(graph), contract_sha256: WEB_CONTRACT_SHA256,
    verification_lane: 'gui', target_kind: 'deployed-build', target_binding_sha256: target.target_binding_sha256, target };
  json(join(runDir, 'binding.json'), lane === 'web' ? webBinding : { run_uuid: UUID, exact_final_sha: 'a'.repeat(40), requirements_hash: 'e'.repeat(64) });

  const config = join(root, 'catalog', 'dragon-mcp.json');
  json(config, { mcpServers: { [ROUTE]: { command: process.execPath, args: ['/fixture/dragon-mcp.mjs'] } } });
  json(join(runDir, 'roster.json'), { schema: 'team-qa/roster/v1', run_id: 'run', round: 1, target, roles: [{ role: 'executor_gui',
    provider: kind === 'claude-stream' ? 'anthropic' : 'openai', model: 'fixture-model', effort: 'high', harness: kind === 'claude-stream' ? 'claude' : 'codex-native',
    mcp_config: kind === 'claude-stream' ? { path: config, sha256: sha(readFileSync(config)) } : null }] });
  const stream = join(runDir, 'dispatch', 'executor_gui', SID, 'stdout.jsonl');
  mkdirSync(dirname(stream), { recursive: true });
  writeFileSync(stream, jsonl(events));
  let attestation = claudeAttestation({ rosterHash: sha(readFileSync(join(runDir, 'roster.json'))), stream });
  const policy = join(root, 'policy', 'gui-policy.json');
  if (kind !== 'claude-stream') {
    json(policy, { schema: 'qa-gui/native-policy/v2', allowed_tools: [{ namespace: `mcp__${ROUTE}`, name: 'dragon_rpc' }],
      dragon: { version: '1.6.6', sessionId: 'session', nonce: 'nonce', browserInstanceId: 'browser', tabId: 7 },
      target: { url: target.preview_url, kind: 'deployed-build', target_binding_sha256: target.target_binding_sha256 },
      capabilities: ['screenshot'], max_calls: 4, helpers: [], commands: [], reads: [], behavioral: false });
    const evidence = join(runDir, 'native-dispatch', 'evidence.json');
    json(evidence, { schema: 'team-qa/native-evidence/v1', fixture: true });
    const native = { gui_policy: { path: policy, sha256: sha(readFileSync(policy)) }, gui_verification: { verdict: 'PASS', policy_sha256: sha(readFileSync(policy)) } };
    attestation = { ...attestation, agent_id: `codex-native:${SID}`,
      runtime: { ...attestation.runtime, provider: 'openai', harness: kind === 'codex-native' ? 'codex-native' : 'codex' },
      source: { kind, path: evidence, sha256: sha(readFileSync(evidence)), ...(kind === 'codex-native' ? { metadata_source: { native } } : {}) } };
  }
  const attestationPath = join(runDir, 'role-bindings', 'executor_gui.json');
  json(attestationPath, attestation);
  const options = lane === 'web'
    ? { attestationPath, runtimeRoot: runtime, runUuid: UUID, requirementsHash: webBinding.requirements_hash, targetBindingSha256: target.target_binding_sha256 }
    : { attestationPath, runtimeRoot: runtime, runUuid: UUID, exactFinalSha: 'a'.repeat(40), requirementsHash: 'e'.repeat(64) };
  const context = { bindingPath: join(runDir, 'binding.json'), requirementsPath: join(runDir, 'REQUIREMENTS.json'), planPath: join(runDir, 'tracked-plan.json'), runDir };
  const runner = join(root, 'runner.mjs');
  writeFileSync(runner, RUNNER);
  const call = (spec) => {
    const result = spawnSync(process.execPath, [runner, JSON.stringify(spec)], { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, home, runtime, runDir, stream, policy, attestationPath, options, context, target, call };
}

test('web lane: verified claude-stream executor with a clean Dragon route gets a sealed web receipt', () => {
  const f = teamqaFixture();
  const verified = f.call({ op: 'verify', options: f.options });
  assert.equal(verified.ok, true, verified.error);
  assert.deepEqual(verified.value.dispatch_proof, JSON.parse(readFileSync(f.attestationPath, 'utf8')));
  assert.deepEqual(Object.keys(verified.value.teamqa_provenance), ['run_dir', 'attestation_path', 'attestation_sha256', 'runtime_root', 'binding_sha256', 'target_binding_sha256', 'executor_route']);
  assert.deepEqual(verified.value.teamqa_provenance.executor_route, { rule: CLAUDE_STREAM_ROUTE_RULE, mcp_server: ROUTE,
    mcp_config_sha256: sha(readFileSync(join(f.root, 'catalog', 'dragon-mcp.json'))), dragon_rpc_ok: 2 });
  assert.equal(verified.value.teamqa_provenance.runtime_root, f.runtime);

  const receiptPath = join(f.root, 'qa-gui.receipt.json');
  const emitted = f.call({ op: 'receipt', options: f.options, context: f.context, out: receiptPath });
  assert.equal(emitted.ok, true, emitted.error);
  assert.equal(emitted.value.schema, 'qa-gui/receipt/web-v1');
  assert.deepEqual(f.call({ op: 'readback', receipt: receiptPath }).value, []);

  const tampered = JSON.parse(readFileSync(receiptPath, 'utf8'));
  tampered.teamqa_provenance.executor_route.dragon_rpc_ok = 9;
  delete tampered.integrity;
  tampered.integrity = sha(canonical(tampered));
  writeFileSync(join(f.root, 'tampered.json'), JSON.stringify(tampered));
  assert.ok(f.call({ op: 'readback', receipt: join(f.root, 'tampered.json') }).value.includes('TEAMQA_GUI_PROVENANCE_INVALID:TEAMQA_GUI_PROVENANCE_DRIFT'));

  writeFileSync(f.stream, readFileSync(f.stream, 'utf8').replace('"tabId":7', '"tabId":8'));
  const drifted = f.call({ op: 'verify', options: f.options });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.error, 'TEAMQA_WEB_CLAUDE_STREAM_DRIFT');
  assert.ok(f.call({ op: 'readback', receipt: receiptPath }).value.includes('TEAMQA_GUI_PROVENANCE_INVALID:TEAMQA_WEB_CLAUDE_STREAM_DRIFT'));
});
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

test('web lane: claude-stream rejections reach verifyTeamQaGuiAttestation with stable codes', () => {
  const foreignServer = cleanEvents(); foreignServer[0] = init({ mcp_servers: [{ name: ROUTE, status: 'connected' }, { name: 'playwright', status: 'connected' }] });
  const noDragonCall = cleanEvents(); noDragonCall[3] = answer('toolu_1', dragon({}), { is_error: true }); noDragonCall[7] = answer('toolu_3', 'Error: tab closed');
  const foreignRoute = withEvent(8, use('toolu_x', 'Bash', { command: 'npx playwright test --headed' }), answer('toolu_x', 'ok', { is_error: false }));
  for (const [events, code] of [
    [foreignServer, /^TEAMQA_WEB_CLAUDE_MCP_ROUTE_MISMATCH:line=1:Dragon_Browser\+playwright$/],
    [noDragonCall, /^TEAMQA_WEB_CLAUDE_DRAGON_CALL_REQUIRED$/],
    [foreignRoute, /^TEAMQA_WEB_CLAUDE_FOREIGN_BROWSER_ROUTE:line=9:Bash:playwright$/],
  ]) {
    const f = teamqaFixture({ events });
    const result = f.call({ op: 'verify', options: f.options });
    assert.equal(result.ok, false);
    assert.match(result.error, code);
  }
});

test('web lane: codex-native acceptance and rejection are unchanged', () => {
  const f = teamqaFixture({ kind: 'codex-native' });
  const accepted = f.call({ op: 'verify', options: f.options });
  assert.equal(accepted.ok, true, accepted.error);
  assert.deepEqual(accepted.value.dispatch_proof, JSON.parse(readFileSync(f.attestationPath, 'utf8')));
  assert.deepEqual(Object.keys(accepted.value.teamqa_provenance), ['run_dir', 'attestation_path', 'attestation_sha256', 'runtime_root', 'binding_sha256', 'target_binding_sha256']);
  const receiptPath = join(f.root, 'qa-gui.receipt.json');
  assert.equal(f.call({ op: 'receipt', options: f.options, context: f.context, out: receiptPath }).ok, true);
  assert.deepEqual(f.call({ op: 'readback', receipt: receiptPath }).value, []);

  const policy = JSON.parse(readFileSync(f.policy, 'utf8'));
  json(f.policy, { ...policy, target: { ...policy.target, target_binding_sha256: '0'.repeat(64) } });
  assert.equal(f.call({ op: 'verify', options: f.options }).error, 'TEAMQA_NATIVE_GUI_POLICY_DRIFT');
  const rebound = JSON.parse(readFileSync(f.attestationPath, 'utf8'));
  rebound.source.metadata_source.native.gui_policy.sha256 = sha(readFileSync(f.policy));
  rebound.source.metadata_source.native.gui_verification.policy_sha256 = sha(readFileSync(f.policy));
  json(f.attestationPath, rebound);
  assert.equal(f.call({ op: 'verify', options: f.options }).error, 'TEAMQA_WEB_NATIVE_POLICY_MISMATCH');
  delete rebound.source.metadata_source.native.gui_verification;
  json(f.attestationPath, rebound);
  assert.equal(f.call({ op: 'verify', options: f.options }).error, 'TEAMQA_NATIVE_GUI_POLICY_REQUIRED');

  const stream = teamqaFixture({ kind: 'codex-stream' });
  assert.equal(stream.call({ op: 'verify', options: stream.options }).error, 'TEAMQA_WEB_NATIVE_SOURCE_REQUIRED');
});

test('Git lane: claude-stream attestation keeps the existing contract without web route checks', () => {
  const f = teamqaFixture({ lane: 'git', events: [say('no Dragon call, no result event')] });
  const result = f.call({ op: 'verify', options: f.options });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value.dispatch_proof, JSON.parse(readFileSync(f.attestationPath, 'utf8')));
  assert.deepEqual(Object.keys(result.value.teamqa_provenance), ['run_dir', 'attestation_path', 'attestation_sha256', 'runtime_root']);
});

test('qa-gate web mode uses --teamqa-runtime and surfaces claude route codes', () => {
  const gate = (f, extra = []) => {
    const board = join(f.root, 'board.json');
    json(board, { schemaVersion: 5, runUuid: UUID });
    return spawnSync(process.execPath, [join(ROOT, 'scripts', 'qa-gate.mjs'), board, '--web-binding', f.context.bindingPath, '--run-dir', f.runDir,
      '--plan', f.context.planPath, '--requirements', f.context.requirementsPath, '--evidence-root', f.runDir,
      '--teamqa-attestation', f.attestationPath, ...extra], { encoding: 'utf8', cwd: f.root, env: { ...process.env, HOME: f.home } });
  };
  const f = teamqaFixture();
  const clean = gate(f, ['--teamqa-runtime', f.runtime]);
  assert.equal(clean.status, 20, clean.stderr);
  assert.doesNotMatch(clean.stderr, /TEAMQA_|ENOENT/);
  assert.match(clean.stderr, /WEB_CASES_NOT_EXECUTED/);
  assert.equal(existsSync(join(f.root, '.teamcode')), false);
  assert.match(gate(f).stderr, /ENOENT[^\n]*\.agents\/skills\/team-qa/);

  const foreign = teamqaFixture({ events: withEvent(8, use('toolu_x', 'WebFetch', { url: 'http://127.0.0.1:5401/', prompt: 'read' })) });
  const rejected = gate(foreign, ['--teamqa-runtime', foreign.runtime]);
  assert.equal(rejected.status, 20);
  assert.match(rejected.stderr, /UNGRADED TEAMQA_WEB_CLAUDE_FOREIGN_BROWSER_ROUTE:line=9:WebFetch/);
});

test('qa-gate web mode takes a canonical deployed-build board past schema validation into web grading', () => {
  const f = teamqaFixture();
  const board = join(f.runDir, 'board.json');
  run(process.execPath, [join(ROOT, 'scripts', 'teamwork', 'cli.mjs'), 'init', '--title', 'ACME Supply', '--board-id', 'acme-web', '--language', 'en',
    '--run-uuid', UUID, '--at', '2026-10-27T00:00:00.000Z', '--build', f.target.frontend_build.id, '--environment', f.target.environment,
    '--target-binding-sha256', f.target.target_binding_sha256, '--out', board]);
  const data = JSON.parse(readFileSync(board, 'utf8'));
  assert.equal(data.targetBindingSha256, f.target.target_binding_sha256);
  assert.equal(Object.hasOwn(data, 'commit'), false);
  data.sourceItems = [{ id: 'S1', kind: 'brief', sourceSystem: 'fixture', externalKey: 'R1', title: 'Intro page renders', origin: 'upstream' }];
  data.cases = [{ id: 'C1', title: 'Intro page renders', requirement: 'R1', requirements: ['R1'], sourceRefs: ['S1'], steps: '1. Open the intro page.',
    expected: 'The intro page renders.', status: 'PASS', priority: 'P1', assignee: 'qa-agent', functionVerdict: 'PASS', uiVerdict: 'PASS',
    humanSummary: { function: 'The intro page rendered.', ui: 'The layout looked right.' }, machine: { rule: 'R1', selector: 'main' },
    kind: 'static', states: ['loaded'], stateReceipts: [],
    results: [{ round: 1, functionVerdict: 'PASS', uiVerdict: 'PASS', recordedAt: '2026-10-27T00:00:02.000Z', evidence: [] }],
    evidence: [], comments: [], history: [] }];
  data.evidenceManifest = [];
  json(board, data);
  const runGate = () => spawnSync(process.execPath, [join(ROOT, 'scripts', 'qa-gate.mjs'), board, '--web-binding', f.context.bindingPath, '--run-dir', f.runDir,
    '--plan', f.context.planPath, '--requirements', f.context.requirementsPath, '--evidence-root', f.runDir,
    '--teamqa-attestation', f.attestationPath, '--teamqa-runtime', f.runtime], { encoding: 'utf8', cwd: f.root, env: { ...process.env, HOME: f.home } });
  const gate = runGate();
  // The board claims PASS without state receipts: the web gate grades it and fails it.
  assert.equal(gate.status, 1, gate.stderr);
  assert.doesNotMatch(gate.stderr, /L22|missing required field|TEAMQA_|ENOENT|BOARD_OUTSIDE_EVIDENCE_ROOT/);
  // The board's own web bindings match the verified run: target hash, build, environment, run UUID, no commit.
  assert.doesNotMatch(gate.stderr, /WEB_BOARD_COMMIT_FORBIDDEN|WEB_TARGET_BINDING_MISMATCH|WEB_BUILD_ID_MISMATCH|WEB_ENVIRONMENT_MISMATCH|WEB_RUN_UUID_MISMATCH/);
  // Reached only after canonical validation, the Team QA attestation and the web context all passed.
  assert.match(gate.stderr, /UNGRADED WEB_RECEIPT_EVIDENCE_INELIGIBLE/);
  assert.match(gate.stderr, /UNGRADED STATE_RECEIPT_COUNT:C1:loaded:0/);
  assert.match(gate.stderr, /BOARD_FUNCTION_VERDICT_MISMATCH:C1:PASS:UNGRADED/);
  assert.equal(existsSync(join(f.root, '.teamcode')), false);
  assert.equal(existsSync(join(f.runDir, '.teamcode')), false);

  // A behavioral case: the board can now name its recording segment, and the web gate checks that recording.
  data.cases[0].kind = 'behavioral';
  json(board, data);
  assert.match(runGate().stderr, /UNGRADED BEHAVIORAL_RECORDING_REQUIRED:C1/);
  data.cases[0].recordingSegments = [{ file: 'qa-evidence/C1-run.mp4', startMs: 0, endMs: 41250 }];
  json(board, data);
  const behavioral = runGate();
  assert.doesNotMatch(behavioral.stderr, /L22|BEHAVIORAL_RECORDING_REQUIRED/);
  assert.match(behavioral.stderr, /UNGRADED BEHAVIORAL_RECORDING_MISSING:C1:qa-evidence\/C1-run\.mp4/);
});

// ---- Case-scoped web receipts (Team QA case-scoped GUI dispatch, upgrade U2).
const sessionEvents = () => {
  const list = cleanEvents();
  list.splice(1, 0, use('toolu_s', RPC, { method: 'session.create', params: { forbidSyntheticDOM: false } }),
    answer('toolu_s', dragon({ sessionId: 'dragon-s1', nonce: 'n1', browserInstanceId: 'b1' })),
    use('toolu_t', RPC, { method: 'openTab', params: { sessionId: 'dragon-s1', nonce: 'n1', browserInstanceId: 'b1', url: 'http://127.0.0.1:5401/intro' } }),
    answer('toolu_t', dragon({ tabId: 7 })),
    use('toolu_f', RPC, { method: 'getTabInfo', params: { sessionId: 'dragon-failed', tabId: 7 } }),
    answer('toolu_f', 'Error: no such session'));
  return list;
};

test('the stream route lists the Dragon sessions the executor used in successful calls', () => {
  const result = inspect(sessionEvents());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.sessions, ['dragon-s1']);
  assert.deepEqual(inspect(cleanEvents()).sessions, []);
});

test('web lane: a later GUI attestation is accepted only for a case-scoped receipt of its own case', () => {
  const f = teamqaFixture({ events: sessionEvents() });
  const first = JSON.parse(readFileSync(f.attestationPath, 'utf8'));
  const later = join(f.runDir, 'role-bindings', 'executor_gui', 'attempt-2.json');
  json(later, { ...first, schema: 'team-qa/role-attestation/v2', dispatch_case_id: 'C1', dispatch_attempt_id: SID, dispatch_attempt_seq: 2, dispatch_chain_sha256: 'f'.repeat(64) });
  // No --case: refused (the run's later attestations only attest one case).
  const unscoped = f.call({ op: 'verify', options: { ...f.options, attestationPath: later } });
  assert.equal(unscoped.ok, false); assert.equal(unscoped.error, 'TEAMQA_GUI_CASE_SCOPE_REQUIRED');
  // Its own case: accepted; the provenance names the case and the executor's Dragon sessions.
  const scoped = f.call({ op: 'verify', options: { ...f.options, attestationPath: later, caseId: 'C1' } });
  assert.equal(scoped.ok, true, scoped.error);
  assert.equal(scoped.value.teamqa_provenance.case_id, 'C1');
  assert.equal(scoped.value.teamqa_provenance.attestation_path, later);
  assert.deepEqual(scoped.value.teamqa_provenance.executor_route.dragon_sessions, ['dragon-s1']);
  // Another case, a malformed case id, or a path outside role-bindings: refused.
  assert.equal(f.call({ op: 'verify', options: { ...f.options, attestationPath: later, caseId: 'C2' } }).error, 'TEAMQA_GUI_CASE_SCOPE_MISMATCH');
  assert.equal(f.call({ op: 'verify', options: { ...f.options, attestationPath: later, caseId: '../C1' } }).error, 'TEAMQA_GUI_CASE_SCOPE_INVALID');
  const stray = join(f.runDir, 'role-bindings', 'executor_gui', 'attempt-1.json');
  json(stray, JSON.parse(readFileSync(later, 'utf8')));
  assert.equal(f.call({ op: 'verify', options: { ...f.options, attestationPath: stray, caseId: 'C1' } }).error, 'TEAMQA_GUI_BINDING_PATH_REQUIRED');
  // The first attestation without a case: --case is refused, the unscoped receipt is unchanged (no case, no sessions).
  assert.equal(f.call({ op: 'verify', options: { ...f.options, caseId: 'C1' } }).error, 'TEAMQA_GUI_CASE_SCOPE_MISMATCH');
  const plain = f.call({ op: 'verify', options: f.options });
  assert.equal(plain.ok, true, plain.error);
  assert.equal(Object.hasOwn(plain.value.teamqa_provenance, 'case_id'), false);
  assert.equal(Object.hasOwn(plain.value.teamqa_provenance.executor_route, 'dragon_sessions'), false);
  // A sealed case-scoped receipt reads back clean, and a case swapped after sealing is drift.
  const receiptPath = join(f.root, 'case.receipt.json');
  const emitted = f.call({ op: 'receipt', options: { ...f.options, attestationPath: later, caseId: 'C1' }, context: f.context, out: receiptPath });
  assert.equal(emitted.ok, true, emitted.error);
  assert.deepEqual(f.call({ op: 'readback', receipt: receiptPath }).value, []);
  const swapped = JSON.parse(readFileSync(receiptPath, 'utf8'));
  swapped.teamqa_provenance.case_id = 'C2';
  delete swapped.integrity; swapped.integrity = sha(canonical(swapped));
  writeFileSync(join(f.root, 'swapped.json'), JSON.stringify(swapped));
  assert.ok(f.call({ op: 'readback', receipt: join(f.root, 'swapped.json') }).value.some((e) => e.startsWith('TEAMQA_GUI_PROVENANCE_INVALID:TEAMQA_GUI_CASE_SCOPE_MISMATCH')));
});

test('case-scoped evidence must come from the Dragon sessions of that case\'s executor', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-case-sessions-')));
  const receipt = (file, sessionId) => json(join(root, file), { schema: 'qa-gui/state-receipt/v1', caseId: 'C1', dragon: { sessionId } });
  receipt('C1/loaded.json', 'dragon-s1'); receipt('C1/saved.json', 'dragon-s1'); receipt('C1/other.json', 'dragon-other');
  const board = (links, status = 'PASS') => ({ cases: [{ id: 'C1', status, stateReceipts: links }, { id: 'C2', status: 'TODO' }] });
  const ok = [{ state: 'loaded', file: 'C1/loaded.json' }, { state: 'saved', file: 'C1/saved.json' }];
  const issues = (data, caseId = 'C1', sessions = ['dragon-s1']) => caseEvidenceSessionIssues({ data, caseId, evidenceRoot: root, sessions });
  assert.deepEqual(issues(board(ok)), []);
  assert.deepEqual(issues(board([...ok, { state: 'other', file: 'C1/other.json' }])), ['TEAMQA_CASE_EVIDENCE_SESSION_FOREIGN:C1:other']);
  assert.deepEqual(issues(board([{ state: 'gone', file: 'C1/missing.json' }])), ['TEAMQA_CASE_EVIDENCE_UNREADABLE:C1:gone']);
  assert.deepEqual(issues(board([{ state: 'up', file: '../outside.json' }])), ['TEAMQA_CASE_EVIDENCE_UNREADABLE:C1:up']);
  assert.deepEqual(issues(board([])), ['TEAMQA_CASE_EVIDENCE_MISSING:C1']);
  assert.deepEqual(issues(board(ok), 'C2'), ['TEAMQA_CASE_NOT_EXECUTED:C2']);
  assert.deepEqual(issues(board(ok), 'C9'), ['TEAMQA_CASE_NOT_EXECUTED:C9']);
  assert.deepEqual(issues(board(ok), 'C1', []), ['TEAMQA_CASE_EXECUTOR_SESSIONS_MISSING:C1']);
});
