import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(root, 'test/roster-dynamic');
const cli = join(root, 'scripts/roster.mjs');
const tempRoot = mkdtempSync(join(tmpdir(), 'team-qa-roster-acceptance-'));
const callsLog = join(tempRoot, 'model-calls.jsonl');

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(args, { env = {}, cwd = root } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, TEAMQA_TEST_CALL_LOG: callsLog, ...env },
  });
}

function assertPass(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function assertRejected(result, label) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded\n${result.stdout}`);
  assert.doesNotMatch(result.stderr, /Cannot find module[\s\S]*scripts\/roster\.mjs/, `${label} failed because CLI is absent, not because the contract rejected the input`);
}

function select({ catalog = 'catalog-openai-v1.json', request = 'request-default.json', dir = tempRoot, name = 'roster.json' } = {}) {
  const output = join(dir, name);
  const result = run(['select', '--catalog', join(fixtureDir, catalog), '--request', join(fixtureDir, request), '--out', output]);
  return { result, output, roster: existsSync(output) ? readJson(output) : null };
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function userApproval(rosterPath, extra = {}) {
  const roster = readJson(rosterPath);
  return {
    schema: 'team-qa/roster-user-event/v1',
    id: 'approval-event-001',
    actor: 'user',
    text: 'I approve this exact roster for the fixture run.',
    run_id: roster.run_id,
    round: roster.round,
    roster_hash: hashFile(rosterPath),
    ...extra,
  };
}

function approve(runDir, rosterPath, event) {
  const eventPath = writeJson(join(runDir, 'user-event.json'), event);
  return run(['approve', '--run-dir', runDir, '--file', rosterPath, '--user-event', eventPath]);
}

function check(runDir, role) {
  const args = ['check', '--run-dir', runDir];
  if (role) args.push('--role', role);
  return run(args);
}

function dispatch(runDir, role = 'test_manager') {
  const prompt = writeFileSync(join(runDir, 'prompt.txt'), `Fixture-only prompt for ${role}.`);
  void prompt;
  return run(['dispatch', '--run-dir', runDir, '--role', role, '--prompt', join(runDir, 'prompt.txt'), '--out', join(runDir, `receipt-${role}.json`)]);
}

function callCount() {
  if (!existsSync(callsLog)) return 0;
  return readFileSync(callsLog, 'utf8').trim().split('\n').filter(Boolean).length;
}

function assertRoster(roster) {
  assert.equal(roster?.schema, 'team-qa/roster/v1');
  assert.ok(/^[a-f0-9]{64}$/.test(roster.catalog_sha256), 'roster pins catalog SHA-256');
  assert.ok(/^[a-f0-9]{64}$/.test(roster.policy_sha256), 'roster pins selection policy SHA-256');
  assert.equal(roster.roles.length, 6, 'roster contains the five model roles and deterministic coverage gate');
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS' });
  } catch (error) {
    results.push({ name, status: 'FAIL', error: error.stack || String(error) });
  }
}

test('selection follows changed catalog and harness capability on each run', () => {
  const dir1 = join(tempRoot, 'dynamic-v1');
  const dir2 = join(tempRoot, 'dynamic-v2');
  mkdirSync(dir1, { recursive: true });
  mkdirSync(dir2, { recursive: true });
  const first = select({ catalog: 'catalog-openai-v1.json', dir: dir1 });
  const req2 = readJson(join(fixtureDir, 'request-default.json'));
  req2.run_id = 'roster-acceptance-v2';
  req2.manager.model = 'gpt-6.2-sol';
  const requestPath = writeJson(join(dir2, 'request.json'), req2);
  const rosterPath = join(dir2, 'roster.json');
  const secondResult = run(['select', '--catalog', join(fixtureDir, 'catalog-openai-v2.json'), '--request', requestPath, '--out', rosterPath]);
  assertPass(first.result, 'select against catalog v1');
  assertPass(secondResult, 'select against catalog v2');
  const firstRoster = first.roster;
  const secondRoster = readJson(rosterPath);
  assertRoster(firstRoster);
  assertRoster(secondRoster);
  assert.ok(firstRoster.roles.filter(r => r.role !== 'coverage_gate').every(r => r.model === 'gpt-6.1-sol' || r.model === 'gpt-6-luna'));
  assert.ok(secondRoster.roles.filter(r => r.role !== 'coverage_gate').every(r => r.model === 'gpt-6.2-sol' || r.model === 'gpt-6-luna'));
  assert.notEqual(firstRoster.catalog_sha256, secondRoster.catalog_sha256);
});

test('defaults to one supported provider and never selects Astra without a scoped user event', () => {
  const dir = join(tempRoot, 'default-provider');
  mkdirSync(dir, { recursive: true });
  const selected = select({ dir });
  assertPass(selected.result, 'default selection');
  assertRoster(selected.roster);
  const modelRoles = selected.roster.roles.filter(r => r.role !== 'coverage_gate');
  assert.deepEqual([...new Set(modelRoles.map(r => r.provider))], ['openai']);
  assert.ok(modelRoles.every(r => !/astra/i.test(`${r.model} ${r.fallback ?? ''}`)));
  assert.equal(selected.roster.roles.find(r => r.role === 'coverage_gate').model, null);
  assert.equal(selected.roster.roles.find(r => r.role === 'coverage_gate').provider, null);
});

test('an explicit Astra request is retained only for its named role and carries user provenance', () => {
  const dir = join(tempRoot, 'astra-scoped');
  mkdirSync(dir, { recursive: true });
  const selected = select({ request: 'request-astra-explicit.json', dir });
  assertPass(selected.result, 'explicit Astra selection');
  assertRoster(selected.roster);
  const code = selected.roster.roles.find(r => r.role === 'executor_code');
  assert.equal(code.model, 'astra-v1');
  assert.equal(code.user_request?.id, 'user-event-astra-001');
  assert.equal(code.user_request?.actor, 'user');
  assert.ok(selected.roster.roles.filter(r => r.role !== 'executor_code' && r.role !== 'coverage_gate').every(r => r.model !== 'astra-v1'));
});

test('unsupported model, effort, role or harness version is rejected instead of downgraded', () => {
  const dir = join(tempRoot, 'incompatible');
  mkdirSync(dir, { recursive: true });
  const request = readJson(join(fixtureDir, 'request-default.json'));
  request.run_id = 'roster-incompatible-effort';
  request.overrides = [{ role: 'analyst', model: 'gpt-6-luna', effort: 'max', user_event: { id: 'event-effort', actor: 'user', text: 'Use max effort for analyst.' } }];
  const requestPath = writeJson(join(dir, 'request.json'), request);
  const badEffort = run(['select', '--catalog', join(fixtureDir, 'catalog-openai-v1.json'), '--request', requestPath, '--out', join(dir, 'bad-effort.json')]);
  assertRejected(badEffort, 'unsupported effort');
  const catalog = readJson(join(fixtureDir, 'catalog-openai-v1.json'));
  catalog.harnesses.find(h => h.id === 'claude').version = '2.1.100';
  const oldCatalog = writeJson(join(dir, 'old-harness.json'), catalog);
  const oldModelRequest = readJson(join(fixtureDir, 'request-default.json'));
  oldModelRequest.run_id = 'roster-old-harness';
  oldModelRequest.provider = 'anthropic';
  oldModelRequest.manager = { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium', harness: 'claude' };
  const oldReq = writeJson(join(dir, 'old-request.json'), oldModelRequest);
  assertRejected(run(['select', '--catalog', oldCatalog, '--request', oldReq, '--out', join(dir, 'old-model.json')]), 'unsupported harness version');
});

test('unknown fields fail closed in catalog, request and user approval event', () => {
  const dir = join(tempRoot, 'unknown-fields');
  mkdirSync(dir, { recursive: true });
  const catalog = readJson(join(fixtureDir, 'catalog-openai-v1.json'));
  catalog.unreviewed_bypass = true;
  const catalogPath = writeJson(join(dir, 'catalog.json'), catalog);
  const reqPath = join(fixtureDir, 'request-default.json');
  assertRejected(run(['select', '--catalog', catalogPath, '--request', reqPath, '--out', join(dir, 'catalog-output.json')]), 'unknown catalog field');
  const request = readJson(reqPath);
  request.unreviewed_bypass = true;
  const requestPath = writeJson(join(dir, 'request.json'), request);
  assertRejected(run(['select', '--catalog', join(fixtureDir, 'catalog-openai-v1.json'), '--request', requestPath, '--out', join(dir, 'request-output.json')]), 'unknown request field');
  const selected = select({ dir, name: 'accepted-roster.json' });
  assertPass(selected.result, 'prepare approval fixture');
  const event = userApproval(selected.output, { skip_roster_gate: true });
  assertRejected(approve(dir, selected.output, event), 'unknown approval event field');
});

test('provider mixing requires an explicit user event that names the mixed run', () => {
  const dir = join(tempRoot, 'mixed-provider');
  mkdirSync(dir, { recursive: true });
  const request = readJson(join(fixtureDir, 'request-default.json'));
  request.run_id = 'roster-mixed-provider';
  request.overrides = [{ role: 'executor_code', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', user_event: { id: 'event-mixed-role', actor: 'user', text: 'Use Anthropic for executor_code.' } }];
  const requestPath = writeJson(join(dir, 'request.json'), request);
  assertRejected(run(['select', '--catalog', join(fixtureDir, 'catalog-openai-v1.json'), '--request', requestPath, '--out', join(dir, 'without-mixed-approval.json')]), 'mixed providers without run-level authorization');
  request.allow_mixed_provider = { user_event: { id: 'event-mixed-run', actor: 'user', text: 'For this run, allow both OpenAI and Anthropic providers.' } };
  const allowedPath = writeJson(join(dir, 'mixed-approved-request.json'), request);
  const accepted = run(['select', '--catalog', join(fixtureDir, 'catalog-openai-v1.json'), '--request', allowedPath, '--out', join(dir, 'with-mixed-approval.json')]);
  assertPass(accepted, 'mixed providers with explicit run-level authorization');
  const roster = readJson(join(dir, 'with-mixed-approval.json'));
  assert.deepEqual([...new Set(roster.roles.filter(r => r.role !== 'coverage_gate').map(r => r.provider))].sort(), ['anthropic', 'openai']);
});

test('dispatch makes zero stub calls before user approval, and approval is bound to exact roster hash/run/round', () => {
  const dir = join(tempRoot, 'approval-gate');
  mkdirSync(dir, { recursive: true });
  const selected = select({ dir });
  assertPass(selected.result, 'select roster');
  const before = callCount();
  assertRejected(dispatch(dir), 'dispatch before approval');
  assert.equal(callCount(), before, 'blocked preapproval dispatch made zero stub model calls');

  const wrongRound = userApproval(selected.output, { round: 2 });
  assertRejected(approve(dir, selected.output, wrongRound), 'approve wrong round');
  const wrongRun = userApproval(selected.output, { run_id: 'different-run' });
  assertRejected(approve(dir, selected.output, wrongRun), 'approve wrong run');
  const event = userApproval(selected.output);
  assertPass(approve(dir, selected.output, event), 'approve exact roster with user event');
  assertPass(check(dir), 'read back exact approval');
  assertPass(dispatch(dir), 'approved fixture dispatch');
  assert.equal(callCount(), before + 1, 'one fixture invocation follows approval');
  const receipt = readJson(join(dir, 'receipt-test_manager.json'));
  assert.equal(receipt.graded, false, 'fixture harness output cannot claim a graded model result');
  assert.equal(receipt.agent_id, null, 'fixture receipt does not claim a verified runtime agent identity');
  assert.equal(receipt.session_id, null, 'fixture receipt does not claim a verified runtime session identity');
  assert.equal(receipt.runtime.observed.model, null, 'fixture receipt does not claim observed provider model metadata');
  assert.equal(receipt.runtime.observed.effort, null, 'fixture receipt does not claim observed effort metadata');
});

test('check and dispatch reject roster or approval tampering after approval', () => {
  const dir = join(tempRoot, 'tamper-after-approval');
  mkdirSync(dir, { recursive: true });
  const selected = select({ dir });
  assertPass(selected.result, 'select roster');
  assertPass(approve(dir, selected.output, userApproval(selected.output)), 'approve exact roster');
  const before = callCount();
  const roster = readJson(selected.output);
  roster.target.preview_url = 'http://127.0.0.1:9999';
  roster.roles.find(r => r.role === 'analyst').model = 'unlocked-model';
  writeJson(selected.output, roster);
  assertRejected(check(dir), 'check tampered target/config');
  assertRejected(dispatch(dir), 'dispatch tampered target/config');
  assert.equal(callCount(), before, 'tampered roster blocked before model call');
});

test('dispatch binds a role to its exact configured effort; no hidden fallback/helper or invalid-role call', () => {
  const dir = join(tempRoot, 'runtime-contract');
  mkdirSync(dir, { recursive: true });
  const selected = select({ dir });
  assertPass(selected.result, 'select roster');
  assertRoster(selected.roster);
  const modelRoles = selected.roster.roles.filter(r => r.role !== 'coverage_gate');
  assert.equal(new Set(modelRoles.map(r => r.role)).size, 5);
  assert.ok(modelRoles.every(r => r.fallback === null), 'fallbacks are explicit null');
  assert.ok(modelRoles.every(r => r.reasoning_control && Object.keys(r.reasoning_control.args || {}).length > 0), 'actual adapter arguments are recorded');
  assert.ok(modelRoles.every(r => r.context?.length > 0), 'role context has content hashes');
  assert.ok(modelRoles.every(r => r.permission_profile), 'each role has a bound permission profile');
  assert.ok(!JSON.stringify(selected.roster).match(/helper|summarizer|grader/i), 'no undeclared helper model is hidden in the roster');
  assertPass(approve(dir, selected.output, userApproval(selected.output)), 'approve roster');
  const analystSeat = selected.roster.roles.find(r => r.role === 'analyst');
  assert.deepEqual(analystSeat.reasoning_control.args, ['-c', `model_reasoning_effort=${JSON.stringify(analystSeat.effort)}`], 'roster effort has an actual Codex configuration mapping');
  const before = callCount();
  assertPass(dispatch(dir, 'analyst'), 'fixture analyst dispatch');
  assert.equal(callCount(), before + 1);
  const stubCall = JSON.parse(readFileSync(callsLog, 'utf8').trim().split('\n').at(-1));
  const args = stubCall.argv.join(' ');
  assert.match(args, /gpt-6-luna/, 'runner passes the locked model to harness');
  assert.ok(stubCall.argv.includes(`model_reasoning_effort=${JSON.stringify(analystSeat.effort)}`), 'runner passes the exact configured effort to harness');
  const afterValidRole = callCount();
  assertRejected(dispatch(dir, 'coverage_gate'), 'LLM dispatch for deterministic coverage gate');
  assertRejected(dispatch(dir, 'unknown_role'), 'dispatch for unknown role');
  assert.equal(callCount(), afterValidRole, 'invalid or deterministic role dispatch makes zero stub model calls');
});

for (const result of results) {
  if (result.status === 'PASS') process.stdout.write(`PASS ${result.name}\n`);
  else process.stderr.write(`FAIL ${result.name}\n${result.error}\n`);
}
process.stdout.write(`${results.filter(x => x.status === 'PASS').length}/${results.length} acceptance cases passed\n`);
if (results.some(x => x.status === 'FAIL')) process.exitCode = 1;
