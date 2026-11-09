import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dispatchArgs, dispatchMaxBuffer, dragonOutputRoot } from '../../scripts/lib/roster.mjs';
import { canonicalDeployedTarget, deployedTargetBindingSha256 } from '../../scripts/lib/deployed-target.mjs';
import { assertToolPreflight, passiveHtmlParts, readCurrentDeployedIdentityObservation } from '../../scripts/lib/tool-preflight.mjs';
import { claudeRef, passiveTriple, scanClaudeTranscript } from '../../scripts/lib/claude-refs.mjs';
import { embedRosterTarget } from '../../scripts/lib/web-identity.mjs';
import { readContract } from '../../scripts/lib/release-truth.mjs';

// Deployed-build (web) lane tooling on a Claude Code root (eval compat 3, part B1). Every transcript below is a synthetic
// Claude Code 2.1.311-shaped fixture under a fake HOME, never evidence of a live QA run.
const REPO = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const SCROLL = process.env.TEAMQA_SCROLL_ROOT || join(homedir(), 'Dev', 'scroll');
const SCROLL_OK = existsSync(join(SCROLL, 'lib', 'effects.js'));
const NODE_OK = /^v(?:24|26)\./.test(process.version);
const NEEDS_SCROLL = !SCROLL_OK && 'SCROLL runtime unavailable (set TEAMQA_SCROLL_ROOT)';
const NEEDS_PREFLIGHT = NEEDS_SCROLL || (!NODE_OK && 'assertToolPreflight accepts Node 24/26 only');
// The Git lane pins the release-truth contract; a checkout carrying macOS AppleDouble (._*) copies cannot read it.
const CONTRACT_OK = (() => { try { readContract(); return true; } catch { return false; } })();
const NEEDS_GIT_CONTRACT = NEEDS_PREFLIGHT || (!CONTRACT_OK && 'contracts/release-truth-contract/v2 is unreadable in this checkout');
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-deployed-home-')));
process.env.HOME = HOME;
// Transcripts are written under HOME/.claude; a CLAUDE_CONFIG_DIR of the machine running the tests would point elsewhere.
delete process.env.CLAUDE_CONFIG_DIR;
for (const key of Object.keys(process.env)) if (key.startsWith('TEAMQA_TARGET_') || key === 'CLAUDE_CODE_SESSION_ID') delete process.env[key];

const PREVIEW = 'http://127.0.0.1:5401/intro', BACKEND = 'http://127.0.0.1:5411', BUILD = 'index-CJjkO35e';
const SCOUT = { sessionId: 'scout-session', nonce: 'scout-nonce', browserInstanceId: 'browser-1' }, SCOUT_TAB = 7;
const QA = { sessionId: 'qa-session-1', nonce: 'qa-nonce-1', browserInstanceId: 'browser-1' }, QA_TAB = 8;
const STATUS = { ok: true, ready: true, versionMatch: true, bridgeVersion: '1.6.9', extension: { version: '1.6.9' } };
const STATUS_COMMAND = 'curl --fail --silent http://127.0.0.1:9233/status';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1Z0AAAAASUVORK5CYII=', 'base64');
const WEB_ROLES = ['test_manager', 'analyst', 'designer', 'executor_gui', 'coverage_gate'];
const sha = value => createHash('sha256').update(value).digest('hex');
const html = () => '<html lang="en"><head><meta charset="UTF-8"><title>Sample Shop</title><script type="module" crossorigin src="/assets/index-CJjkO35e.js"></script>'
  + '<link rel="stylesheet" crossorigin href="/assets/index-COs_Fa8L.css"></head><body><div id="root"><main>About Sample Shop</main></div></body></html>';
function envelope(value) {
  const contentHash = 'sha256:' + sha(JSON.stringify(['string', value])), ref = 'observation:' + contentHash.slice(7);
  return { value, evidence: { v: 1, kind: 'dom', ts: Date.now(), correlationId: null, contentHash, ref },
    telemetry: { durMs: 12, bytesOut: Buffer.byteLength(value) + 64, terminalReason: 'complete', retryable: false, evidenceRef: ref } };
}

// Dragon 1.6.9 compact identity reads (apps/dragon-browser/qa-identity.cjs): getPageIdentity and getNetwork {summary:true}.
function identityRead(value, extra = {}) {
  const contentHash = 'sha256:' + sha(JSON.stringify(['identity', value])), ref = 'observation:' + contentHash.slice(7);
  return { v: 1, html_sha256: sha(value), html_length: value.length, html_bytes: Buffer.byteLength(value),
    complete: /^<html\b/i.test(value.trim()) && /<\/html>\s*$/i.test(value) && !value.includes('<!-- truncated -->'), truncated: false,
    ...passiveHtmlParts(value), omitted: 0, evidence: { v: 1, kind: 'dom', ts: Date.now(), correlationId: null, contentHash, ref },
    telemetry: { durMs: 9, bytesOut: 512, terminalReason: 'complete', retryable: false, evidenceRef: ref }, ...extra };
}
function networkSummary(requests, extra = {}) {
  const rows = new Map();
  for (const v of requests) {
    let origin = 'invalid'; try { origin = new URL(v.url).origin; } catch { /* counted as invalid */ }
    const row = rows.get(origin) ?? { origin, ok: 0, failed: 0, other: 0, last_ok_t: null };
    if (!v.failed && !v.errorText && Number.isFinite(v.t) && Number.isInteger(v.status) && v.status >= 200 && v.status < 400) { row.ok++; row.last_ok_t = Math.max(row.last_ok_t ?? -Infinity, v.t); }
    else if (v.failed || v.errorText || v.status >= 400) row.failed++; else row.other++;
    rows.set(origin, row);
  }
  const cursor = requests.at(-1)?.t ?? 0, contentHash = 'sha256:' + sha(JSON.stringify(requests)), ref = 'observation:' + contentHash.slice(7);
  return { summary: true, count: requests.length, cursor, truncated: false, omitted: 0,
    origins: [...rows.values()].sort((a, b) => a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0),
    evidence: { v: 1, kind: 'network', ts: Date.now(), correlationId: null, contentHash, ref, meta: { cursor, truncated: false, omitted: 0 } },
    telemetry: { durMs: 4, bytesOut: 256, terminalReason: 'complete', retryable: false, evidenceRef: ref }, ...extra };
}

let counter = 0;
class Transcript {
  constructor(workspace, sid, start = Date.now() - 30 * 60000) {
    Object.assign(this, { workspace, sid, t: start });
    const dir = join(HOME, '.claude', 'projects', workspace.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${sid}.jsonl`);
    writeFileSync(this.path, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: sid, timestamp: new Date(start).toISOString() }) + '\n');
    this.human('Run Team QA for Sample Shop (local build)');
  }
  tick(ms = 1000) { this.t += ms; return this.t; }
  base(extra) { return { parentUuid: null, isSidechain: false, userType: 'external', cwd: this.workspace, sessionId: this.sid, version: '2.1.311', gitBranch: '', timestamp: new Date(this.t).toISOString(), ...extra }; }
  push(entry) { appendFileSync(this.path, JSON.stringify(entry) + '\n'); return entry; }
  human(text) { this.tick(); return this.push(this.base({ type: 'user', uuid: `u-${++counter}`, promptId: 'prompt-1', origin: { kind: 'human' }, message: { role: 'user', content: text } })); }
  say(text) { this.tick(); return this.push(this.base({ type: 'assistant', uuid: `a-${++counter}`, message: { model: 'claude-opus-5-5', id: `msg_${counter}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }] } })); }
  call(name, input, extra = {}) {
    const id = `toolu_${++counter}`; this.tick();
    this.push(this.base({ type: 'assistant', uuid: `c-${id}`, message: { model: 'claude-opus-5-5', id: `msg_${counter}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }] }, ...extra }));
    return id;
  }
  rpc(method, params, result, { raw, text, preview, sidechain = false, isError = false } = {}) {
    const id = this.call('mcp__Dragon_Browser__dragon_rpc', { method, params }, sidechain ? { isSidechain: true } : {});
    const body = text ?? JSON.stringify(raw ?? { ok: true, result });
    // preview: Claude Code 2.1.311 moved a large result to a side file; the message keeps only the preview while
    // toolUseResult keeps the original blocks.
    const block = { tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: preview ?? body }] };
    if (isError) block.is_error = true;
    this.tick(200);
    this.push(this.base({ type: 'user', uuid: `r-${id}`, sourceToolAssistantUUID: `c-${id}`, isSidechain: sidechain, message: { role: 'user', content: [block] }, toolUseResult: [{ type: 'text', text: body }] }));
    return this.t;
  }
  bash(command, stdout) {
    const id = this.call('Bash', { command, description: 'Team QA step' }); this.tick(200);
    this.push(this.base({ type: 'user', uuid: `r-${id}`, sourceToolAssistantUUID: `c-${id}`, message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: stdout, is_error: false }] },
      toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false } }));
  }
}

// The root's Dragon calls, shaped like Dragon 1.6.x dragon_rpc results.
function openSession(tx, session = QA, tab = QA_TAB) {
  tx.rpc('session.create', { sessionId: session.sessionId, forbidSyntheticDOM: false }, { ...session, forbidSyntheticDOM: false, policy: { requireTrusted: true, forbidSyntheticDOM: false } });
  tx.rpc('openTab', { ...session, url: PREVIEW, active: false }, { tabId: tab });
}
function scout(tx, { compact = false } = {}) {
  openSession(tx, SCOUT, SCOUT_TAB);
  if (compact) tx.rpc('getPageIdentity', { ...SCOUT, tabId: SCOUT_TAB }, identityRead(html()));
  else tx.rpc('getPageHtml', { ...SCOUT, tabId: SCOUT_TAB, maxLength: 1048576 }, envelope(html()));
  tx.rpc('getTabInfo', { ...SCOUT, tabId: SCOUT_TAB }, { tabId: SCOUT_TAB, url: PREVIEW, title: 'Sample Shop' });
}
function passive(tx, o = {}) {
  const session = o.session ?? SCOUT, tabId = o.tab ?? SCOUT_TAB;
  let pageAt = tx.t;
  for (const method of o.order ?? [o.compact ? 'getPageIdentity' : 'getPageHtml', 'getNetwork', 'getTabInfo']) {
    if (method === 'getPageHtml') pageAt = tx.rpc('getPageHtml', { ...session, tabId, maxLength: 1048576 }, envelope(o.html ?? html()), o.page ?? {});
    if (method === 'getPageIdentity') pageAt = tx.rpc('getPageIdentity', { ...session, tabId }, o.identity ?? identityRead(o.html ?? html()), o.page ?? {});
    if (method === 'getNetwork') {
      const t = pageAt - (o.requestAge ?? 2000);
      const requests = o.requests ? o.requests(t) : [{ t, method: 'GET', url: `${BACKEND}/rest/v1/workspace_members?select=*`, status: 200, type: 'fetch' }];
      if (o.compact) tx.rpc('getNetwork', { ...session, tabId, summary: true }, o.network ?? networkSummary(requests), o.net ?? {});
      else tx.rpc('getNetwork', { ...session, tabId, maxBytes: 200000 }, o.network ?? { count: requests.length, requests, cursor: t, truncated: false, omitted: 0 }, o.net ?? {});
    }
    if (method === 'getTabInfo') { if (o.gap) tx.tick(o.gap); tx.rpc('getTabInfo', { ...session, tabId }, { tabId, url: PREVIEW, title: 'Sample Shop' }, o.tabCall ?? {}); }
  }
}
function screenshot(tx, name, result = {}) {
  const path = join(HOME, '.dragon-browser', 'screenshots', `${name}.png`);
  mkdirSync(join(HOME, '.dragon-browser', 'screenshots'), { recursive: true });
  writeFileSync(path, PNG);
  tx.rpc('screenshot', { ...QA, tabId: QA_TAB }, { savedTo: path, privacyMasked: true, maskedRects: [], ...result });
  return path;
}
function preflightBlock(tx, marker, { shot = 'shot-basic', session = true, compact = false } = {}) {
  tx.say(marker);
  if (session) { tx.bash(STATUS_COMMAND, JSON.stringify(STATUS)); openSession(tx); }
  passive(tx, { session: QA, tab: QA_TAB, compact });
  return shot ? screenshot(tx, shot) : null;
}

function workspace() { return realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-deployed-ws-'))); }
function cli(ws, script, args, env = {}) {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', script), ...args], { cwd: ws, encoding: 'utf8', env: { PATH: process.env.PATH, HOME, TEAMQA_SCROLL_ROOT: SCROLL, ...env } });
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { /* not a JSON command */ }
  return { status: r.status, out, stdout: r.stdout, stderr: r.stderr };
}
const teamqa = (ws, args, env) => cli(ws, 'teamqa.mjs', args, env);
const DRAFT_ARGS = run => ['web', 'identity', 'draft', '--run', run, '--project-id', 'sample-shop-local', '--environment', 'Local', '--preview-url', PREVIEW, '--backend-origin', BACKEND];
function rejected(result, code) {
  assert.notEqual(result.status, 0, `expected ${code}\n${result.stdout}${result.stderr}`);
  assert.equal(result.out?.ok, false, result.stdout + result.stderr);
  assert.equal(result.out.code, code, result.stdout + result.stderr);
}

// A run whose identity is drafted from the scout read; `prove` binds the marked triple.
function lane(runId = 'hub-web-001', { compact = false } = {}) {
  const ws = workspace(), tx = new Transcript(ws, '5d9c1e7a-0b3f-4c2d-9e8f-a1b2c3d4e5f6');
  scout(tx, { compact });
  const draft = teamqa(ws, DRAFT_ARGS(runId));
  assert.equal(draft.status, 0, draft.stdout + draft.stderr);
  return { ws, tx, runId, draft: draft.out, runDir: join(ws, 'runs', runId) };
}
function provenLane(runId) {
  const l = lane(runId);
  l.tx.say(l.draft.marker); passive(l.tx);
  const proved = teamqa(l.ws, ['web', 'identity', 'prove', '--run', runId]);
  assert.equal(proved.status, 0, proved.stdout + proved.stderr);
  return { ...l, proved: proved.out, target: JSON.parse(readFileSync(join(l.runDir, 'identity', 'target.json'), 'utf8')) };
}

// Runtime-mode preflight needs the installed child packages, the Dragon runtime pins and, for dispatch freshness,
// the live bridge status and session list. All are fixtures under the fake HOME.
let children = false;
function installChildren() {
  if (children) return;
  const git = (cwd, ...args) => { const r = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  for (const skill of ['qa-code', 'qa-gui']) {
    const root = join(HOME, '.agents', 'skills', skill), repo = join(HOME, 'Dev', skill), url = `https://github.com/agentpro-tech/${skill}.git`;
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), `# ${skill} fixture\n`);
    copyFileSync(join(REPO, 'scripts/package-tool.mjs'), join(root, 'scripts/package-tool.mjs'));
    writeFileSync(join(root, 'package-files.json'), JSON.stringify({ schema: 'agentpro/skill-package-files/v1', skill, version: '9.9.9', include: ['SKILL.md', 'scripts'] }, null, 2) + '\n');
    if (skill === 'qa-code') writeFileSync(join(root, 'scripts/lib/provider-execution.mjs'), 'export const fixture = true;\n');
    else {
      writeFileSync(join(root, 'scripts/lib/native-gui-trajectory.mjs'), 'export const fixture = true;\n');
      writeFileSync(join(root, 'scripts/qa_do.mjs'), `if (process.argv[process.argv.indexOf('--method') + 1] !== 'session.list') process.exit(2);\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ ok: true, result: { sessions: [{ ...QA, alive: true, expired: false, circuitOpen: false }] } }))});\n`);
    }
    assert.equal(spawnSync(process.execPath, [join(REPO, 'scripts/package-tool.mjs'), 'manifest', '--root', root]).status, 0);
    mkdirSync(repo, { recursive: true }); git(repo, 'init', '-q');
    copyFileSync(join(root, 'package-manifest.json'), join(repo, 'package-manifest.json'));
    git(repo, 'add', 'package-manifest.json'); git(repo, 'commit', '-q', '-m', 'fixture'); git(repo, 'remote', 'add', 'origin', url);
    const commit = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'SOURCE.json'), JSON.stringify({ schema: 'agentpro/skill-source/v1', skill, version: '9.9.9', repo: url, commit, tree: '', manifest_sha256: sha(readFileSync(join(root, 'package-manifest.json'))) }, null, 2) + '\n');
    writeFileSync(join(root, 'release-truth.json'), JSON.stringify({ head: commit, repo_url: url, repo }) + '\n');
  }
  const runtime = join(HOME, '.dragon-browser', 'runtime', 'current');
  mkdirSync(runtime, { recursive: true });
  for (const [name, body] of [['server.js', '// fixture\n'], ['mcp-server.mjs', '// fixture\n'], ['package.json', '{"version":"1.6.9"}\n']]) writeFileSync(join(runtime, name), body);
  children = true;
}
async function statusServer() {
  const child = spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(${JSON.stringify(JSON.stringify(STATUS))});}).on('error',e=>{console.log('ERROR '+e.code);process.exit(1);}).listen(9233,'127.0.0.1',()=>console.log('LISTENING'));`], { stdio: ['ignore', 'pipe', 'ignore'] });
  const line = await new Promise(resolve => { child.stdout.on('data', data => resolve(String(data))); child.on('exit', () => resolve('EXIT')); });
  if (!line.includes('LISTENING')) { child.kill(); return null; }
  return child;
}
function writeRoster(ws, runId, target) {
  const roster = { schema: 'team-qa/roster/v1', run_id: runId, round: 1, scope: 'Sample Shop web', target, provider: 'anthropic', catalog_sha256: '0'.repeat(64),
    policy_sha256: '0'.repeat(64), catalog_source: { kind: 'runtime', reference: 'deployed-lane fixture' }, catalog_collected_at: new Date().toISOString(),
    mixed_provider_request: null, roles: WEB_ROLES.map(role => ({ role })), selection_notes: [] };
  const file = join(ws, 'runs', runId, 'roster.candidate.json');
  writeFileSync(file, JSON.stringify(roster, null, 2) + '\n');
  const hash = sha(readFileSync(file));
  return { file, hash, roster: { ...roster, roster_hash: hash }, marker: `TEAMQA_PREFLIGHT run=${runId} round=1 roster=${hash}` };
}
function approve(l, candidate) {
  copyFileSync(candidate.file, join(l.runDir, 'roster.json'));
  mkdirSync(join(l.runDir, 'control', 'approvals'), { recursive: true });
  writeFileSync(join(l.runDir, 'control', 'approvals', 'roster.json'), JSON.stringify({ event: { source: { path: l.tx.path, line: 2 } } }));
}
function writePlan(l, recording = false, code = false) {
  const plan = { run_id: l.runId, app: 'Sample Shop', plan_version: 1, lanes: [{ id: 'gui', scope: ['REQ-1'], parallel_ok: false, vi_sao: '' }], tiers: { 'REQ-1': 'FULL' },
    exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 80 }, preflight: { code, gui: true, recording } };
  writeFileSync(join(l.runDir, 'test-plan.md'), `# Test plan\n\nTEAMQA_PLAN_START\n${JSON.stringify(plan, null, 2)}\nTEAMQA_PLAN_END\n`);
}
const build = (l, args, env) => teamqa(l.ws, ['preflight', 'build', '--run', l.runId, ...args], env);

test('GUI executor seats on the Claude host load the locked Dragon route; other argv stay unchanged', () => {
  const seat = harness => ({ harness, model: 'm', reasoning_control: harness === 'claude' ? { args: ['--effort', 'medium'] } : { args: ['-c', 'model_reasoning_effort="medium"'] }, caps: { max_turns: 20 }, mcp_config: { path: '/locked/dragon.json' } });
  const route = { data: { mcpServers: { Dragon_Browser: { command: '/usr/bin/node', args: ['/dragon/mcp-server.mjs'] } } }, names: ['Dragon_Browser'] };
  assert.deepEqual(dispatchArgs({ seat: seat('claude'), role: 'executor_gui', route, attempt: 'a1' }), ['-p', '--disable-slash-commands', '--model', 'm', '--effort', 'medium',
    '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--max-turns', '20', '--setting-sources', '', '--strict-mcp-config',
    '--mcp-config', '/locked/dragon.json', '--tools', 'Read,Glob,Grep,Bash', '--allowedTools', 'mcp__Dragon_Browser',
    '--add-dir', dragonOutputRoot(), '--disallowedTools', 'Agent,Task,Edit,Write,NotebookEdit,WebSearch,WebFetch', '--session-id', 'a1']);
  // The executor reads its own Dragon captures: the bridge's output root, DRAGON_OUT_DIR or ~/.dragon/out.
  assert.equal(dragonOutputRoot({}), join(homedir(), '.dragon', 'out'));
  assert.equal(dragonOutputRoot({ DRAGON_OUT_DIR: '/tmp/dragon-out' }), '/tmp/dragon-out');
  // Its stream-json carries every image it Reads: 256 MB of output for this seat, 16 MB for every other one.
  assert.equal(dispatchMaxBuffer({ seat: seat('claude'), route }), 256 * 1024 * 1024);
  assert.equal(dispatchMaxBuffer({ seat: seat('claude'), route: null }), 16 * 1024 * 1024);
  assert.equal(dispatchMaxBuffer({ seat: seat('codex'), route }), 16 * 1024 * 1024);
  assert.deepEqual(dispatchArgs({ seat: seat('claude'), role: 'analyst', route: null, attempt: 'a2' }), ['-p', '--safe-mode', '--model', 'm', '--effort', 'medium',
    '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--max-turns', '20', '--setting-sources', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read,Glob,Grep', '--disallowedTools', 'Agent,Task,Edit,Write,NotebookEdit,WebSearch,WebFetch', '--session-id', 'a2']);
  // A fixture roster gives the GUI seat no route: it keeps the isolated argv.
  assert.equal(dispatchArgs({ seat: seat('claude'), role: 'executor_gui', route: null, attempt: 'a3' })[1], '--safe-mode');
  const codex = dispatchArgs({ seat: seat('codex'), role: 'executor_gui', route, attempt: 'a4' });
  assert.deepEqual(codex.slice(0, 6), ['exec', '--skip-git-repo-check', '--ignore-user-config', '--json', '--sandbox', 'workspace-write']);
  assert.ok(!codex.some(arg => ['--disable-slash-commands', '--allowedTools', '--permission-mode'].includes(arg)));
  assert.deepEqual(codex.slice(-6), ['-c', 'mcp_servers.Dragon_Browser.command="/usr/bin/node"', '-c', 'mcp_servers.Dragon_Browser.args=["/dragon/mcp-server.mjs"]', '-c', 'approval_policy="never"']);
});

test('identity draft and prove bind a Vite page through the root transcript and the lane verifiers', { skip: NEEDS_SCROLL }, () => {
  const l = lane();
  const draft = JSON.parse(readFileSync(join(l.runDir, 'identity', 'target.draft.json'), 'utf8'));
  assert.deepEqual(Object.keys(draft), ['project_id', 'preview_url', 'version', 'kind', 'environment', 'backend_origin', 'frontend_build', 'asset_manifest_sha256', 'target_binding_sha256']);
  assert.deepEqual(draft.frontend_build, { kind: 'vite', id: BUILD });
  assert.equal(draft.version, BUILD); assert.equal(draft.preview_url, PREVIEW); assert.equal(draft.backend_origin, BACKEND);
  assert.equal(draft.asset_manifest_sha256, sha(JSON.stringify({ kind: 'vite-html-assets/v1', entry: 'http://127.0.0.1:5401/assets/index-CJjkO35e.js' })));
  assert.equal(draft.target_binding_sha256, deployedTargetBindingSha256(draft));
  assert.equal(l.draft.marker, `TEAMQA_IDENTITY_PREFLIGHT run=${l.runId} round=1 target=${draft.target_binding_sha256}`);
  assert.equal(l.draft.transcript, l.tx.path);
  assert.match(l.draft.next.join('\n'), /getPageIdentity .*→ getNetwork .*summary:true.*→ getTabInfo/);
  l.tx.say(l.draft.marker); passive(l.tx);
  const proved = teamqa(l.ws, ['web', 'identity', 'prove', '--run', l.runId]);
  assert.equal(proved.status, 0, proved.stdout + proved.stderr);
  const proofBytes = readFileSync(join(l.runDir, 'identity', 'proof.json'));
  const target = JSON.parse(readFileSync(join(l.runDir, 'identity', 'target.json'), 'utf8'));
  assert.equal(JSON.stringify(target), JSON.stringify(canonicalDeployedTarget(target)), 'target.json keeps the canonical key order');
  assert.deepEqual(target.identity_proof, { path: 'identity/proof.json', sha256: sha(proofBytes) });
  assert.equal(proved.out.proof.sha256, sha(proofBytes));
  assert.equal(proved.out.target_binding_sha256, draft.target_binding_sha256);
  const proof = JSON.parse(proofBytes);
  assert.deepEqual(Object.keys(proof), ['schema', 'target_binding_sha256', 'identity', 'sources']);
  const [source] = proof.sources;
  assert.deepEqual(Object.keys(source), ['path', 'call_line', 'result_line', 'call_sha256', 'result_sha256', 'host', 'tab_source', 'network_source']);
  const lines = readFileSync(l.tx.path, 'utf8').split('\n');
  for (const ref of [source, source.tab_source, source.network_source]) {
    assert.equal(ref.path, l.tx.path); assert.equal(sha(lines[ref.call_line - 1]), ref.call_sha256); assert.equal(sha(lines[ref.result_line - 1]), ref.result_sha256);
    assert.equal(ref.host.session_id, l.tx.sid); assert.equal(ref.host.agent_path, '/root');
  }
  assert.ok(!existsSync(join(l.runDir, 'identity', 'staging', `proof-${sha(proofBytes)}.json`)));
});

test('identity artifacts are byte stable, never overwritten and refused under a TEAMQA_TARGET lock', { skip: NEEDS_SCROLL }, () => {
  const l = provenLane('hub-web-002');
  const files = ['target.draft.json', 'proof.json', 'target.json'].map(name => [name, readFileSync(join(l.runDir, 'identity', name))]);
  assert.equal(teamqa(l.ws, DRAFT_ARGS(l.runId)).status, 0, 'same draft bytes are an idempotent success');
  assert.equal(teamqa(l.ws, ['web', 'identity', 'prove', '--run', l.runId]).status, 0, 'same proof bytes are an idempotent success');
  rejected(teamqa(l.ws, [...DRAFT_ARGS(l.runId).slice(0, 5), '--project-id', 'other-project', ...DRAFT_ARGS(l.runId).slice(7)]), 'WEB_IDENTITY_DRAFT_EXISTS');
  l.tx.say(l.draft.marker); passive(l.tx);
  rejected(teamqa(l.ws, ['web', 'identity', 'prove', '--run', l.runId]), 'WEB_IDENTITY_PROOF_EXISTS');
  for (const [name, bytes] of files) assert.deepEqual(readFileSync(join(l.runDir, 'identity', name)), bytes, `${name} unchanged`);
  for (const key of ['TEAMQA_TARGET_PROJECT_ID', 'TEAMQA_TARGET_PREVIEW_URL', 'TEAMQA_TARGET_VERSION']) {
    rejected(teamqa(l.ws, DRAFT_ARGS('hub-web-other'), { [key]: 'x' }), 'WEB_TARGET_ENV_SET');
    rejected(teamqa(l.ws, ['web', 'identity', 'prove', '--run', l.runId], { [key]: 'x' }), 'WEB_TARGET_ENV_SET');
  }
  rejected(teamqa(l.ws, [...DRAFT_ARGS('hub-web-003').slice(0, 11), '--backend-origin', `${BACKEND}/rest/v1`]), 'WEB_IDENTITY_BACKEND_ORIGIN');
  rejected(teamqa(l.ws, [...DRAFT_ARGS('hub-web-003').slice(0, 7), '--environment', 'Production', ...DRAFT_ARGS('hub-web-003').slice(9)]), 'WEB_IDENTITY_ENVIRONMENT');
});

test('prove reads a persisted getPageHtml result from the original blocks the transcript line keeps', { skip: NEEDS_SCROLL }, () => {
  const l = lane('hub-web-persisted');
  l.tx.say(l.draft.marker);
  passive(l.tx, { page: { preview: '<persisted-output>\nOutput too large (72KB). Full output saved to: /x/tool-results/page.txt\n\nPreview (first 2KB):\n{"ok":true' } });
  const result = teamqa(l.ws, ['web', 'identity', 'prove', '--run', l.runId]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const proof = JSON.parse(readFileSync(join(l.runDir, 'identity', 'proof.json'), 'utf8'));
  assert.equal(proof.target_binding_sha256, l.draft.target_binding_sha256);
});

test('prove rejects sidechain, error, truncated and persisted results, wrong order, stale triples and a missing backend request', { skip: NEEDS_SCROLL }, () => {
  const cases = [
    ['sidechain tab read', { tabCall: { sidechain: true } }, 'CLAUDE_REF_SIDECHAIN'],
    ['tool error', { net: { isError: true, text: 'Error: tab is gone' } }, 'CLAUDE_REF_ERROR'],
    ['RPC failure', { net: { raw: { ok: false, error: { code: 'TAB_GONE' } } } }, 'CLAUDE_REF_RPC_ERROR'],
    ['persisted output', { page: { text: '<persisted-output>\nOutput too large (301.2KB). Full output saved to: /x/tool-results/abc.txt\n\nPreview (first 2KB):\n{"ok":true' } }, 'CLAUDE_REF_PERSISTED_OUTPUT'],
    ['truncated output', { page: { text: JSON.stringify({ ok: true, result: envelope(html()) }).slice(0, 300) } }, 'CLAUDE_REF_TRUNCATED'],
    ['wrong order', { order: ['getPageHtml', 'getTabInfo', 'getNetwork'] }, 'WEB_IDENTITY_SEQUENCE'],
    ['triple longer than 300 s', { gap: 301000 }, 'PREFLIGHT_WEB_PASSIVE_ORDER'],
    ['backend request older than 300 s', { requestAge: 301000 }, 'PREFLIGHT_WEB_BACKEND_OBSERVATION'],
    ['no backend request', { network: { count: 0, requests: [], cursor: 0, truncated: false, omitted: 0 } }, 'PREFLIGHT_WEB_BACKEND_OBSERVATION'],
  ];
  for (const [name, options, code] of cases) {
    const l = lane(`hub-web-reject-${cases.findIndex(c => c[0] === name)}`);
    l.tx.say(l.draft.marker); passive(l.tx, options);
    const result = teamqa(l.ws, ['web', 'identity', 'prove', '--run', l.runId]);
    rejected(result, code);
    assert.ok(!existsSync(join(l.runDir, 'identity', 'proof.json')) && !existsSync(join(l.runDir, 'identity', 'target.json')), `${name}: nothing final written`);
  }
  // A Bash echo of the marker is tool output, not chat: it never binds calls.
  const echo = lane('hub-web-echo');
  echo.tx.bash(`echo '${echo.draft.marker}'`, echo.draft.marker); passive(echo.tx);
  rejected(teamqa(echo.ws, ['web', 'identity', 'prove', '--run', echo.runId]), 'CLAUDE_REFS_TRANSCRIPT_NOT_FOUND');
  rejected(teamqa(echo.ws, ['web', 'identity', 'prove', '--run', echo.runId, '--transcript', echo.tx.path]), 'CLAUDE_REFS_MARKER_NOT_FOUND');
  // Calls before the latest marker belong to an earlier attempt.
  const again = lane('hub-web-again');
  again.tx.say(again.draft.marker); passive(again.tx); again.tx.say(again.draft.marker);
  rejected(teamqa(again.ws, ['web', 'identity', 'prove', '--run', again.runId]), 'WEB_IDENTITY_SEQUENCE');
});

test('compact identity reads (getPageIdentity, getNetwork summary) prove the same target as the whole HTML and request list', { skip: NEEDS_SCROLL }, () => {
  const full = provenLane('hub-web-full');
  const l = lane('hub-web-compact', { compact: true });
  assert.equal(l.draft.target_binding_sha256, full.draft.target_binding_sha256, 'the scout getPageIdentity drafts the same identity');
  l.tx.say(l.draft.marker); passive(l.tx, { compact: true });
  const proved = teamqa(l.ws, ['web', 'identity', 'prove', '--run', l.runId]);
  assert.equal(proved.status, 0, proved.stdout + proved.stderr);
  const target = JSON.parse(readFileSync(join(l.runDir, 'identity', 'target.json'), 'utf8'));
  for (const key of ['target_binding_sha256', 'asset_manifest_sha256', 'frontend_build', 'version', 'preview_url', 'backend_origin']) assert.deepEqual(target[key], full.target[key], key);
  assert.deepEqual(Object.keys(proved.out.refs), ['getPageIdentity', 'getNetwork', 'getTabInfo']);
  const scan = scanClaudeTranscript(l.tx.path, { marker: l.draft.marker });
  assert.equal(passiveTriple(scan.records).page.method, 'getPageIdentity');
  // Mixed pairs are the same reads: a compact page read with a full request list, and the reverse.
  for (const [name, o] of [['identity + list', { order: ['getPageIdentity', 'getNetwork', 'getTabInfo'] }], ['html + summary', { compact: true, order: ['getPageHtml', 'getNetwork', 'getTabInfo'] }]]) {
    const m = lane(`hub-web-mixed-${name.length}`);
    m.tx.say(m.draft.marker); passive(m.tx, o);
    const r = teamqa(m.ws, ['web', 'identity', 'prove', '--run', m.runId]);
    assert.equal(r.status, 0, name + '\n' + r.stdout + r.stderr);
  }
});

test('compact identity reads fail with the codes of the whole reads', { skip: NEEDS_SCROLL }, () => {
  const twoEntries = html().replace('</head>', '<script type="module" src="/assets/admin-QwErTy12.js"></script></head>');
  const unclosed = html().replace('</html>', '');
  const elsewhere = t => [{ t, method: 'GET', url: 'http://127.0.0.1:9999/rest/v1/x', status: 200, type: 'fetch' }];
  const failed = t => [{ t, method: 'GET', url: `${BACKEND}/rest/v1/x`, status: 500, type: 'fetch' }];
  const cases = [
    // [name, compact options, same-input full options or null, code]
    ['incomplete page read', { identity: identityRead(unclosed) }, { html: unclosed }, 'PREFLIGHT_WEB_PASSIVE_HTML'],
    ['cut page read', { identity: identityRead(html(), { truncated: true }) }, { html: html() + '\n<!-- truncated -->' }, 'PREFLIGHT_WEB_PASSIVE_HTML'],
    ['a part left out', { identity: identityRead(html(), { omitted: 1 }) }, null, 'PREFLIGHT_WEB_PASSIVE_HTML'],
    ['two Vite entries', { html: twoEntries }, { html: twoEntries }, 'PREFLIGHT_WEB_PASSIVE_VITE_ENTRY'],
    ['no backend request', { requests: elsewhere }, { requests: elsewhere }, 'PREFLIGHT_WEB_BACKEND_OBSERVATION'],
    ['only a failed backend request', { requests: failed }, { requests: failed }, 'PREFLIGHT_WEB_BACKEND_OBSERVATION'],
    ['backend request older than 300 s', { requestAge: 301000 }, { requestAge: 301000 }, 'PREFLIGHT_WEB_BACKEND_OBSERVATION'],
    ['cut network window', { network: { ...networkSummary([{ t: Date.now(), url: `${BACKEND}/x`, status: 200 }]), truncated: true } }, null, 'PREFLIGHT_WEB_PASSIVE_NETWORK'],
    ['counts that do not add up', { network: { ...networkSummary([{ t: Date.now(), url: `${BACKEND}/x`, status: 200 }]), count: 2 } }, null, 'PREFLIGHT_WEB_PASSIVE_NETWORK'],
    ['unknown identity field', { identity: identityRead(html(), { value: html() }) }, null, 'PREFLIGHT_FIELDS'],
    ['wrong order', { order: ['getPageIdentity', 'getTabInfo', 'getNetwork'] }, { order: ['getPageHtml', 'getTabInfo', 'getNetwork'] }, 'WEB_IDENTITY_SEQUENCE'],
  ];
  cases.forEach(([name, compact, full, code], i) => {
    for (const [kind, o] of [['compact', { compact: true, ...compact }], ['full', full]]) {
      if (!o) continue;
      const l = lane(`hub-web-compact-reject-${i}-${kind}`);
      l.tx.say(l.draft.marker); passive(l.tx, o);
      const result = teamqa(l.ws, ['web', 'identity', 'prove', '--run', l.runId]);
      assert.notEqual(result.status, 0, `${name} (${kind}) must be refused`);
      assert.equal(result.out?.code, code, `${name} (${kind})\n${result.stdout}${result.stderr}`);
      assert.ok(!existsSync(join(l.runDir, 'identity', 'proof.json')), `${name} (${kind}): nothing final written`);
    }
  });
});

test('roster select embeds the proven target verbatim', { skip: NEEDS_SCROLL }, () => {
  const l = provenLane('hub-web-roster');
  const request = JSON.parse(readFileSync(join(REPO, 'test/roster-dynamic/request-default.json'), 'utf8'));
  delete request.target; request.run_id = l.runId;
  writeFileSync(join(l.ws, 'request.json'), JSON.stringify(request));
  const out = join(l.runDir, 'roster.candidate.json');
  const selected = cli(l.ws, 'roster.mjs', ['select', '--catalog', join(REPO, 'test/roster-dynamic/catalog-openai-v1.json'), '--request', join(l.ws, 'request.json'), '--target', join(l.runDir, 'identity', 'target.json'), '--out', out]);
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  const roster = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(JSON.stringify(roster.target), JSON.stringify(l.target));
  assert.deepEqual(roster.roles.map(r => r.role), WEB_ROLES);
  assert.throws(() => embedRosterTarget({ target: { ...l.target, project_id: 'other' } }, join(l.runDir, 'identity', 'target.json')), e => e.code === 'ROSTER_TARGET_CONFLICT');
  const reordered = join(l.ws, 'reordered.json'), { kind, ...rest } = l.target;
  writeFileSync(reordered, JSON.stringify({ kind, ...rest }));
  assert.throws(() => embedRosterTarget({}, reordered), e => e.code === 'ROSTER_TARGET_NOT_CANONICAL');
});

test('preflight build writes basic, plan and execute --current files that pass assertToolPreflight', { skip: NEEDS_PREFLIGHT }, async t => {
  installChildren();
  const l = provenLane('hub-web-preflight');
  const candidate = writeRoster(l.ws, l.runId, l.target);
  preflightBlock(l.tx, candidate.marker);
  const basic = build(l, ['--stage', 'basic', '--roster', candidate.file]);
  assert.equal(basic.status, 0, basic.stdout + basic.stderr);
  assert.equal(basic.out.verdict.verified, true);
  const p = JSON.parse(readFileSync(join(l.runDir, 'preflight.json'), 'utf8'));
  assert.deepEqual(Object.keys(p), ['schema', 'run_id', 'round', 'roster_hash', 'target', 'runtime', 'target_access', 'current_identity']);
  assert.equal(JSON.stringify(p.target), JSON.stringify(l.target));
  assert.deepEqual(p.runtime.children.map(c => c.skill), ['qa-code', 'qa-gui']);
  assert.equal(p.runtime.dragon_files.length, 3);
  assert.deepEqual(Object.keys(p.target_access.gui), ['status', 'session', 'open', 'read']);
  assert.equal(p.target_access.gui.read.network_source, undefined);
  assert.equal(assertToolPreflight({ runDir: l.runDir, roster: candidate.roster, stage: 'basic' }).verified, true);
  assert.equal(build(l, ['--stage', 'basic', '--roster', candidate.file]).status, 0, 'rebuilding the same block is idempotent');
  approve(l, candidate);
  writePlan(l);
  const plan = build(l, ['--stage', 'plan']);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  const planned = JSON.parse(readFileSync(join(l.runDir, 'preflight.json'), 'utf8'));
  assert.deepEqual(Object.keys(planned.gui), ['status', 'session', 'open', 'read', 'screenshot', 'image']);
  assert.equal(planned.gui.image.sha256, sha(PNG));
  assert.equal(assertToolPreflight({ runDir: l.runDir, roster: candidate.roster, stage: 'plan', requirements: { code: false, gui: true, recording: false } }).lanes.gui, 'verified');
  assert.ok(existsSync(join(l.runDir, 'archive', `preflight-${sha(JSON.stringify(p, null, 2) + '\n')}.json`)), 'the replaced preflight is archived');
  // Dispatch freshness: a later marked sample on the same session and tab, within 5 minutes.
  const server = await statusServer();
  if (!server) return t.skip('127.0.0.1:9233 is in use; the live bridge probe cannot be stubbed');
  t.after(() => server.kill());
  l.tx.t = Date.now() - 20000;
  preflightBlock(l.tx, candidate.marker, { session: false, shot: 'shot-current' });
  const current = build(l, ['--stage', 'execute', '--current']);
  assert.equal(current.status, 0, current.stdout + current.stderr);
  assert.equal(current.out.require_fresh, true);
  assert.ok(Date.parse(current.out.fresh_until) > Date.now() && Date.parse(current.out.fresh_until) <= Date.now() + 300000, 'dispatch deadline within the 5-minute window');
  assert.match(current.out.next, /roster\.mjs dispatch .*--role executor_gui/);
  const fresh = JSON.parse(readFileSync(join(l.runDir, 'preflight.json'), 'utf8'));
  for (const key of ['status', 'session', 'open']) assert.deepEqual(fresh.target_access.gui[key], planned.target_access.gui[key], `${key} keeps its creation provenance`);
  assert.notDeepEqual(fresh.current_identity, planned.current_identity);
  assert.deepEqual(fresh.gui.read, fresh.target_access.gui.read);
  assert.match(fresh.gui.image.path, /shot-current\.png$/);
  assert.equal(assertToolPreflight({ runDir: l.runDir, roster: { ...candidate.roster }, stage: 'execute', role: 'executor_gui', requirements: { code: false, gui: true, recording: false }, requireFresh: true }).verified, true);
});

test('preflight build basic and plan accept the compact identity reads', { skip: NEEDS_PREFLIGHT }, () => {
  installChildren();
  const l = provenLane('hub-web-preflight-compact');
  const candidate = writeRoster(l.ws, l.runId, l.target);
  preflightBlock(l.tx, candidate.marker, { compact: true });
  const basic = build(l, ['--stage', 'basic', '--roster', candidate.file]);
  assert.equal(basic.status, 0, basic.stdout + basic.stderr);
  const p = JSON.parse(readFileSync(join(l.runDir, 'preflight.json'), 'utf8'));
  const lines = readFileSync(l.tx.path, 'utf8').split('\n');
  assert.equal(JSON.parse(lines[p.current_identity.call_line - 1]).message.content[0].input.method, 'getPageIdentity');
  assert.equal(JSON.parse(lines[p.current_identity.network_source.call_line - 1]).message.content[0].input.params.summary, true);
  assert.equal(readCurrentDeployedIdentityObservation(p.current_identity, { roster: candidate.roster, runDir: l.runDir, requireFresh: false }).frontend_build.id, BUILD);
  approve(l, candidate);
  writePlan(l);
  const plan = build(l, ['--stage', 'plan']);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.equal(assertToolPreflight({ runDir: l.runDir, roster: candidate.roster, stage: 'plan', requirements: { code: false, gui: true, recording: false } }).lanes.gui, 'verified');
});

test('preflight build refuses stale dispatch samples, other root sessions, unverified files and a TEAMQA_TARGET lock', { skip: NEEDS_PREFLIGHT }, () => {
  installChildren();
  const l = provenLane('hub-web-preflight-neg');
  const candidate = writeRoster(l.ws, l.runId, l.target);
  rejected(build(l, ['--stage', 'basic', '--roster', candidate.file], { TEAMQA_TARGET_VERSION: BUILD }), 'WEB_TARGET_ENV_SET');
  preflightBlock(l.tx, candidate.marker);
  assert.equal(build(l, ['--stage', 'basic', '--roster', candidate.file]).status, 0);
  approve(l, candidate); writePlan(l);
  const before = readFileSync(join(l.runDir, 'preflight.json'));
  // Stale: the newest marked sample is older than five minutes at dispatch.
  rejected(build(l, ['--stage', 'execute', '--current']), 'PREFLIGHT_STALE');
  assert.deepEqual(readFileSync(join(l.runDir, 'preflight.json')), before);
  // Unverified: a screenshot without privacy masking leaves the GUI lane BLOCKED; preflight.json stays as it was.
  l.tx.t = Date.now() - 60000;
  preflightBlock(l.tx, candidate.marker, { shot: null }); screenshot(l.tx, 'shot-unmasked', { privacyMasked: false });
  const blocked = build(l, ['--stage', 'plan']);
  rejected(blocked, 'PREFLIGHT_BUILD_NOT_VERIFIED');
  assert.match(blocked.out.detail, /PREFLIGHT_GUI_CONTENT/);
  assert.deepEqual(readFileSync(join(l.runDir, 'preflight.json')), before);
  // Another root session after approval: refused before collection, and rejected by the verifier itself.
  const other = new Transcript(l.ws, '9e8d7c6b-5a49-4382-a716-151413121110', Date.now() - 60000);
  other.say(candidate.marker); passive(other, { session: QA, tab: QA_TAB }); screenshot(other, 'shot-other');
  rejected(build(l, ['--stage', 'execute', '--current', '--transcript', other.path]), 'CLAUDE_REFS_HOST_NOT_ORCHESTRATOR');
  rejected(build(l, ['--stage', 'execute', '--current'], { CLAUDE_CODE_SESSION_ID: other.sid }), 'CLAUDE_REFS_HOST_NOT_ORCHESTRATOR');
  rejected(teamqa(l.ws, ['web', 'identity', 'prove', '--run', l.runId, '--transcript', other.path]), 'CLAUDE_REFS_HOST_NOT_ORCHESTRATOR');
  const scan = scanClaudeTranscript(other.path, { marker: candidate.marker }), triple = passiveTriple(scan.records, { session: QA, tabId: QA_TAB });
  const ref = { ...claudeRef(other.path, triple.page), tab_source: claudeRef(other.path, triple.tab), network_source: claudeRef(other.path, triple.network) };
  assert.throws(() => readCurrentDeployedIdentityObservation(ref, { roster: candidate.roster, runDir: l.runDir, requireFresh: false }), e => e.code === 'PREFLIGHT_HOST_NOT_ORCHESTRATOR');
  // A re-selected roster has a new hash; the old marked blocks no longer bind.
  writeFileSync(candidate.file, readFileSync(candidate.file, 'utf8').replace('"Sample Shop web"', '"Sample Shop web v2"'));
  rejected(build(l, ['--stage', 'basic', '--roster', candidate.file]), 'CLAUDE_REFS_MARKER_NOT_FOUND');
});

test('preflight build collects the Git lane GUI chain and both QA Code gate0 tiers', { skip: NEEDS_GIT_CONTRACT }, () => {
  const ws = workspace(), runId = 'git-gui-001', runDir = join(ws, 'runs', runId), tx = new Transcript(ws, '0f1e2d3c-4b5a-4968-8776-655443322110', Date.now() - 120000);
  mkdirSync(runDir, { recursive: true });
  const repo = join(ws, 'app');
  mkdirSync(join(repo, 'test'), { recursive: true }); writeFileSync(join(repo, 'README.md'), '# app\n'); writeFileSync(join(repo, 'test', 'app.test.mjs'), '// fixture\n');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@local', ...args], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'app');
  // Fixture QA Code root: its gate0 receipts below are synthetic and its integrity/outcome readers accept them.
  const codeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-fixture-qa-code-')));
  mkdirSync(join(codeRoot, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(codeRoot, 'scripts', 'gate0.sh'), '#!/bin/sh\n');
  writeFileSync(join(codeRoot, 'scripts', 'lib', 'release-receipt.mjs'), 'export const verifyObjectIntegrity = () => true;\n');
  writeFileSync(join(codeRoot, 'scripts', 'lib', 'test-runners.mjs'), "export const testExecutionOutcome = () => 'pass';\n");
  const target = { project_id: 'app', preview_url: PREVIEW, version: git('rev-parse', 'HEAD') };
  const roster = { schema: 'team-qa/roster/v1', run_id: runId, round: 1, scope: 'git', target, provider: 'anthropic', catalog_source: { kind: 'fixture', reference: 'git-lane fixture' }, roles: [{ role: 'executor_code' }, { role: 'executor_gui' }] };
  writeFileSync(join(runDir, 'roster.json'), JSON.stringify(roster, null, 2) + '\n');
  const hash = sha(readFileSync(join(runDir, 'roster.json')));
  writePlan({ runDir, runId }, false, true);
  tx.say(`TEAMQA_PREFLIGHT run=${runId} round=1 roster=${hash}`);
  tx.bash(STATUS_COMMAND, JSON.stringify(STATUS)); openSession(tx);
  tx.rpc('do', { ...QA, tabId: QA_TAB, steps: [{ read: '({url:location.href,dom:document.body.innerHTML})', as: 'target' }] }, { reads: { target: { url: PREVIEW, dom: '<main>About Sample Shop</main>' } } });
  screenshot(tx, 'shot-git');
  const command = `bash '${join(codeRoot, 'scripts', 'gate0.sh')}' --repo '${repo}' --base HEAD`;
  const checkers = [{ path: process.execPath, version: process.version }];
  tx.bash(command, JSON.stringify({ schema: 'qa-code/gate0/v1', status: 'pass', repo, runtime: { node: { version: process.version }, checkers } }));
  const report = JSON.stringify({ type: 'test:pass', data: { file: join(repo, 'test', 'app.test.mjs'), name: 'fixture', nesting: 0 } }) + '\n', reportPath = join(runDir, 'execution.jsonl');
  writeFileSync(reportPath, report);
  tx.bash(command, JSON.stringify({ schema: 'qa-code/gate0/v1', status: 'pass', repo, runtime: { node: { version: process.version }, checkers }, native_test_runners: { records: { coverage: { exit_status: 0, records: [{ runner: 'node', files: ['test/app.test.mjs'], status: 0,
    receipt: { path: process.execPath, sha256: sha(readFileSync(process.execPath)), version: process.version }, execution_report: { path: reportPath, sha256: sha(report), files: [{ file: realpathSync(join(repo, 'test', 'app.test.mjs')), passed: 1, skipped: 0, failed: 0 }] } }] } } } }));
  const env = { TEAMQA_TARGET_VERSION: target.version, TEAMQA_PREFLIGHT_TEST_QA_CODE_ROOT: codeRoot };
  const basic = teamqa(ws, ['preflight', 'build', '--run', runId, '--stage', 'basic', '--repo-root', repo, '--source-path', 'README.md'], env);
  assert.equal(basic.status, 0, basic.stdout + basic.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'preflight.json'), 'utf8')).target_access, { kind: 'git', repo_root: realpathSync(repo), source_path: 'README.md', source_sha256: sha('# app\n') });
  const plan = teamqa(ws, ['preflight', 'build', '--run', runId, '--stage', 'plan', '--repo-root', repo, '--source-path', 'README.md'], env);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.deepEqual(plan.out.verdict.lanes, { runtime: 'verified', target: 'verified', code: 'verified', gui: 'verified', recording: 'N/A' });
  const p = JSON.parse(readFileSync(join(runDir, 'preflight.json'), 'utf8'));
  assert.equal(p.current_identity, undefined);
  assert.deepEqual(p.qa_code.map(c => [c.tier, c.command, c.runtime, c.tools]), ['scanner', 'runner'].map(tier => [tier, command, codeRoot, [{ path: process.execPath, sha256: sha(readFileSync(process.execPath)) }]]));
});
