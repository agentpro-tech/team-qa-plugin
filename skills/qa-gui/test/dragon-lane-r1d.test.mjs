// Upgrade R1d, part 1: QA GUI accepts the Dragon eval lane build with R1a (1.6.9-qa.f108af9), its new RPCs and MCP
// tools, records receipt.env.conditions in its state receipts, and a case whose env.reset is not verified cannot PASS.
// Shapes follow the Dragon R1a contract (docs/r1a-environment-and-sensors.md); synthetic transcripts and boards only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nativeGuiPolicyErrors, validateNativeGuiRequest, validateNativeGuiTrajectory } from '../scripts/lib/native-gui-trajectory.mjs';
import { inspectClaudeStreamDragonRoute } from '../scripts/lib/claude-stream-route.mjs';
import {
  DRAGON_R1A_TOOLS, conditionsAtDefault, conditionsForced, conditionsRecordErrors, envResetVerdict, laneBuild, realSpeed,
} from '../scripts/lib/dragon-env.mjs';
import { checkGuiReleaseTruthV2 } from '../scripts/lib/qa-gui-v2.mjs';
import { asReleaseTruthV2, conditions, r1dBoard, resetResult, sha } from './support/r1d-board.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GATE = join(ROOT, 'scripts/qa-gate.mjs');
const LANE = '1.6.9-qa.f108af9';
const hash = 'b'.repeat(64), name = 'mcp__dragon_browser__dragon_rpc';

function fixture({ version = LANE, extVersion = '1.6.9', capabilities = [] } = {}) {
  const dragon = { version, sessionId: 'fixture-session', nonce: 'fixture-nonce', browserInstanceId: 'fixture-browser', tabId: 17 };
  const policy = { schema: 'qa-gui/native-policy/v1', allowed_tools: [{ namespace: '', name }], dragon,
    target: { url: 'http://localhost:9000', commit: 'a'.repeat(40) },
    capabilities: ['screenshot', 'captureTab', 'trustedClick', 'do', ...capabilities], max_calls: 40,
    helpers: [], commands: [], reads: ['return {count: document.querySelectorAll("button").length};'], behavioral: false };
  const params = { sessionId: dragon.sessionId, nonce: dragon.nonce, browserInstanceId: dragon.browserInstanceId, tabId: dragon.tabId };
  let line = 10;
  const stamp = (c) => Object.assign(c, { call_timestamp: '2026-11-04T12:00:00Z', output_timestamp: '2026-11-04T12:00:01Z', call_line: line++, output_line: line++, call_sha256: hash, output_sha256: hash });
  const call = (method, result, extra = {}) => stamp({ tool: name, namespace: '', name, type: 'function_call',
    input: { method, params: { ...params, ...extra } }, output: { ok: true, result } });
  const tool = (toolName, args, result) => stamp({ tool: toolName, namespace: '', name: toolName, type: 'function_call', input: { ...params, ...args }, output: { ok: true, result } });
  const receipt = (method = 'trustedClick', over = {}) => ({ actionId: `act-${line}`, ts: Date.parse('2026-11-04T12:00:00Z'), session: params,
    action: { method, step: {} }, input: { kind: 'pointer', trusted: true }, firewall: { verdict: 'allow' }, postcondition: { pass: true },
    env: { build: { extVersion }, ...over } });
  const envReceipt = (method, record) => ({ ...receipt(method, { conditions: record }), input: { kind: 'env', trusted: true } });
  const shot = call('screenshot', { privacyMasked: true, maskedRects: [], savedTo: '/fixture/shot.png' });
  return { calls: [shot], policy, call, tool, receipt, envReceipt, params };
}
const run = (f) => validateNativeGuiTrajectory(f);
const forced = conditions({ network: { offline: true, latencyMs: 0, downloadKbps: null, uploadKbps: null, urlPattern: null }, verified: true, setAt: 1, expiresAt: 2 });
const R1A = ['env.set', 'env.get', 'env.release', 'env.reset', 'sensors.start', 'sensors.read', 'sensors.stop', 'frames.start', 'frames.mark', 'frames.stop', 'paintSnapshot'];

test('lane build 1.6.9-qa.<sha> is accepted beside every plain release; other pre-releases still fail closed', () => {
  assert.deepEqual(laneBuild('1.6.9-qa.f108af9'), { version: '1.6.9-qa.f108af9', base: '1.6.9', lane: 'qa', sha: 'f108af9' });
  assert.deepEqual(laneBuild('1.6.9-qa.991cf5d').base, '1.6.9');
  for (const bad of ['1.6.9-beta', '1.6.9-qa.', '1.6.9-qa.xyz1234', '1.6.9-qa.ABCDEF1', '1.6.9-qa.abc', '1.6.9']) assert.equal(laneBuild(bad), null, bad);
  for (const version of [LANE, '1.6.9-qa.991cf5d', '1.6.4', '1.6.9', '1.7.0']) {
    const f = fixture({ version });
    assert.deepEqual(nativeGuiPolicyErrors(f.policy), [], version);
  }
  for (const version of ['1.6.3-qa.f108af9', '2.0.0-qa.f108af9', '1.6.6-beta', '1.6.9-qa', '1.6.9-qa.f108af9.1']) {
    assert.ok(nativeGuiPolicyErrors(fixture({ version }).policy).includes('NATIVE_GUI_POLICY_REQUIRED'), version);
  }
  // The extension manifest cannot carry the suffix: a lane pin binds receipts of its base release (or the full name).
  for (const extVersion of ['1.6.9', LANE]) {
    const f = fixture({ extVersion });
    f.calls.push(f.call('trustedClick', { receipt: f.receipt() }, { selector: '#ok', fast: false }));
    assert.equal(run(f).verdict, 'PASS', `${extVersion}: ${run(f).errors}`);
  }
  for (const extVersion of ['1.6.8', '1.6.10', '1.6.9-qa.991cf5d']) {
    const f = fixture({ extVersion });
    f.calls.push(f.call('trustedClick', { receipt: f.receipt() }, { selector: '#ok', fast: false }));
    assert.ok(run(f).errors.includes('NATIVE_GUI_TRUSTED_RECEIPT_REQUIRED'), extVersion);
  }
});

test('the R1a RPCs and the R1e methods are capabilities with exact parameters; nothing else is', () => {
  const f = fixture({ capabilities: [...R1A, 'setViewport', 'waitForState', 'reloadTab', 'waitForNetworkIdle', 'getNetwork'] });
  assert.deepEqual(nativeGuiPolicyErrors(f.policy), []);
  const locked = { policy: { requireTrusted: true, forbidSyntheticDOM: false, allowedInput: ['pointer', 'key'] } };
  const request = (method, extra) => validateNativeGuiRequest({ request: { method, params: { ...f.params, ...extra } }, policy: f.policy, lockedPolicy: locked });
  const ok = [
    ['env.set', { network: 'slow-3g', cpu: 4, timezone: 'Asia/Ho_Chi_Minh', locale: 'vi-VN', media: { colorScheme: 'dark' }, requests: [{ urlPattern: '*/api/*', action: 'hold' }], role: 'test', caseId: 'TC-01', ttlMs: 60000 }, 'environment'],
    ['env.get', { readback: true, cpu: false }, 'read'], ['env.release', { ruleId: 'r1' }, 'environment'], ['env.reset', {}, 'environment'],
    ['sensors.start', { kinds: ['mutation', 'layout-shift'], watch: 'button', maxTargets: 300, stream: 'auto' }, 'environment'],
    ['sensors.read', { since: 0, max: 500, kinds: ['focus'] }, 'read'], ['sensors.stop', {}, 'environment'],
    ['frames.start', { maxWidth: 480, quality: 50, everyNthFrame: 1, maxMs: 3600, maxFrames: 600 }, 'environment'],
    ['frames.mark', { label: 'action' }, 'environment'], ['frames.stop', { keep: [{ from: 1, to: 2 }], edges: true, maxKeep: 24 }, 'environment'],
    ['paintSnapshot', { selector: '#save', nth: 0, all: false }, 'read'],
    ['setViewport', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, 'environment'],
    ['waitForState', { state: 'complete', timeoutMs: 8000 }, 'read'], ['reloadTab', {}, 'navigation'],
    ['waitForNetworkIdle', { idleMs: 100, timeoutMs: 100 }, 'read'], ['getNetwork', { types: ['XHR', 'Fetch'], since: 3, maxBytes: 200000 }, 'read'],
    ['captureTab', { evidence: true, maxWidth: 960 }, 'capture'], ['screenshot', { toFile: 'a.jpg', evidence: true }, 'capture'],
  ];
  for (const [method, extra, actionClass] of ok) {
    const r = request(method, extra);
    assert.deepEqual(r.errors, [], `${method}: ${r.errors}`);
    assert.equal(r.actionClass, actionClass, method);
  }
  assert.ok(request('env.set', { injectState: true }).errors.includes('NATIVE_GUI_PARAMS_UNKNOWN'));
  assert.ok(request('frames.stop', { keep: 'all', bytes: true }).errors.includes('NATIVE_GUI_PARAMS_UNKNOWN'));
  assert.ok(request('executeJs', { code: '1' }).errors.includes('NATIVE_GUI_CAPABILITY_UNAPPROVED'));
  // A capability the policy does not name is refused even when it is a real R1a RPC.
  const narrow = fixture();
  assert.ok(validateNativeGuiRequest({ request: { method: 'env.set', params: { ...narrow.params } }, policy: narrow.policy, lockedPolicy: locked }).errors.includes('NATIVE_GUI_CAPABILITY_UNAPPROVED'));
});

test('do steps: key, goto (target origin only), scroll {delta}, clickXY, clickSelector, read and wait are accepted; pressKey stays', () => {
  const f = fixture();
  const steps = [{ goto: 'http://localhost:9000/orders' }, { clickSelector: '#open', fast: false }, { clickXY: [10, 20], fast: false },
    { key: 'Escape' }, { pressKey: 'Tab' }, { scroll: { delta: 400 } }, { wait: 250 }, { read: f.policy.reads[0], as: 'n' }];
  const results = steps.map((step) => {
    const key = Object.keys(step)[0];
    if (key === 'wait') return { step: 'wait', ok: true };
    if (key === 'read') return { step: 'read', as: 'n', value: { count: 2 } };
    return { step: key, ok: true, receipt: { ...f.receipt('do'), input: { kind: key === 'goto' ? 'nav' : key === 'key' || key === 'pressKey' ? 'key' : 'pointer', trusted: true } } };
  });
  f.calls.push(f.call('do', { completed: true, results, reads: { n: { count: 2 } } }, { steps }));
  const r = run(f);
  assert.equal(r.verdict, 'PASS', r.errors.join(','));
  assert.equal(r.summary.actions, 5, 'goto is navigation, not user input');
  const away = fixture();
  away.calls.push(away.call('do', { completed: true, results: [{ step: 'goto', ok: true, receipt: away.receipt('do') }] }, { steps: [{ goto: 'https://elsewhere.example/' }] }));
  assert.ok(run(away).errors.includes('NATIVE_GUI_STEP_UNAPPROVED'));
  const unbound = fixture();
  unbound.calls.push(unbound.call('do', { completed: true, results: [{ step: 'key', ok: true }] }, { steps: [{ key: 'Enter' }] }));
  assert.ok(run(unbound).errors.includes('NATIVE_GUI_TRUSTED_RECEIPT_REQUIRED'), 'a key step needs its trusted receipt');
});

test('captureTab {evidence:true}: a masked JPEG file or data URL is accepted; an unmasked one is not', () => {
  const f = fixture();
  f.calls.push(f.call('captureTab', { privacyMasked: true, maskedRects: [], dataUrl: 'data:image/jpeg;base64,AAAA', scaled: { fromWidth: 2560, fromHeight: 1600, width: 1280, height: 800 } }, { evidence: true }));
  f.calls.push(f.call('screenshot', { privacyMasked: true, maskedRects: [], savedTo: '/fixture/evidence.jpg' }, { toFile: 'evidence.jpg', evidence: true }));
  const r = run(f);
  assert.equal(r.verdict, 'PASS', r.errors.join(','));
  assert.equal(r.summary.captures, 2, 'the data URL is not a file and is not counted');
  const bad = fixture();
  bad.calls.push(bad.call('captureTab', { privacyMasked: false, maskedRects: [], dataUrl: 'data:image/jpeg;base64,AAAA' }, { evidence: true }));
  assert.ok(run(bad).errors.includes('NATIVE_GUI_CAPTURE_PRIVACY_REQUIRED'));
});

function envTrajectory({ reset = resetResult(), withReset = true, setResult } = {}) {
  const f = fixture({ capabilities: R1A });
  f.calls.push(f.call('env.set', setResult ?? { ok: true, applied: ['network'], conditions: forced, readback: {}, receipt: f.envReceipt('env.set', forced) }, { network: 'offline', caseId: 'TC-01' }));
  f.calls.push(f.call('trustedClick', { receipt: f.receipt('trustedClick', { conditions: forced }) }, { selector: '#load', fast: false }));
  if (withReset) f.calls.push(f.call('env.reset', { ...reset, receipt: f.envReceipt('env.reset', reset.conditions) }));
  return f;
}

test('trajectory: env.set, an action under the forced condition, a verified env.reset is PASS; a missing or unverified reset is UNGRADED', () => {
  const good = run(envTrajectory());
  assert.equal(good.verdict, 'PASS', good.errors.join(','));
  assert.deepEqual(good.summary.env, { sets: 1, resets: 1, unsupported: 0, resetVerified: true });
  assert.deepEqual(run(envTrajectory({ withReset: false })).errors, ['NATIVE_GUI_ENV_RESET_REQUIRED']);
  const unverified = resetResult({ ok: false, code: 'ENV_RESET_UNVERIFIED', atDefault: false, mismatches: [{ dim: 'network', field: 'onLine', expected: true, actual: false }], conditions: { ...forced, verified: false } });
  const r = run(envTrajectory({ reset: unverified }));
  assert.equal(r.verdict, 'UNGRADED');
  assert.ok(r.errors.includes('NATIVE_GUI_ENV_RESET_UNVERIFIED'), r.errors.join(','));
  assert.ok(r.errors.includes('NATIVE_GUI_ENV_RESET_REQUIRED'));
  // A trajectory that never touches the environment needs no reset (the baseline build has no env.* RPCs).
  const plain = fixture({ version: '1.6.4', extVersion: '1.6.4' });
  plain.calls.push(plain.call('trustedClick', { receipt: plain.receipt() }, { selector: '#ok', fast: false }));
  assert.deepEqual(run(plain).summary, { calls: 2, actions: 1, captures: 1, recordings: 0 });
});

test('trajectory: ENV_UNSUPPORTED is "not applied"; malformed conditions and an evidence-role tab cannot grade', () => {
  const unsupported = envTrajectory({ setResult: { ok: false, code: 'ENV_UNSUPPORTED', error: 'animation: no Animation domain on Lane A', conditions: conditions() } });
  unsupported.calls.splice(2, 1);
  unsupported.calls.push(unsupported.call('trustedClick', { receipt: unsupported.receipt() }, { selector: '#load', fast: false }));
  const r = run(unsupported);
  assert.equal(r.verdict, 'PASS', r.errors.join(','));
  assert.equal(r.summary.env.unsupported, 1);
  const broken = envTrajectory();
  broken.calls[2].output.result.receipt.env.conditions = { ...forced, cpu: { rate: 4, extra: 1 } };
  assert.ok(run(broken).errors.includes('NATIVE_GUI_ENV_CONDITIONS_INVALID'));
  const evidence = envTrajectory();
  evidence.calls[2].output.result.receipt.env.conditions = { ...forced, role: 'evidence' };
  assert.ok(run(evidence).errors.includes('NATIVE_GUI_EVIDENCE_TAB_VERDICT'));
  const failed = envTrajectory({ setResult: { ok: false, code: 'ENV_READBACK_MISMATCH', mismatches: [], conditions: conditions() } });
  assert.ok(run(failed).errors.includes('NATIVE_GUI_OPERATION_FAILED'));
});

test('trajectory: the R1a MCP tools (envSet ... paintSnapshot) are thin RPC proxies the policy may pin', () => {
  assert.deepEqual(Object.values(DRAGON_R1A_TOOLS).sort(), [...R1A].sort());
  const f = fixture({ capabilities: R1A });
  for (const toolName of ['envSet', 'envReset', 'framesStart']) f.policy.allowed_tools.push({ namespace: '', name: `mcp__dragon_browser__${toolName}` });
  f.policy.allowed_tools.push({ namespace: 'mcp__dragon_browser', name: 'sensorsRead' });
  assert.deepEqual(nativeGuiPolicyErrors(f.policy), []);
  f.calls.push(f.tool('mcp__dragon_browser__envSet', { network: 'offline', caseId: 'TC-01' }, { ok: true, applied: ['network'], conditions: forced, receipt: f.envReceipt('env.set', forced) }));
  f.calls.push(f.tool('mcp__dragon_browser__framesStart', { maxWidth: 480 }, { ok: true, windowId: 'fw-1', conditions: forced, receipt: f.envReceipt('frames.start', forced) }));
  const read = f.tool('sensorsRead', { since: 0 }, { ok: true, events: [], cursor: 0 }); read.namespace = 'mcp__dragon_browser';
  f.calls.push(read);
  const reset = resetResult();
  f.calls.push(f.tool('mcp__dragon_browser__envReset', {}, { ...reset, receipt: f.envReceipt('env.reset', reset.conditions) }));
  const r = run(f);
  assert.equal(r.verdict, 'PASS', r.errors.join(','));
  assert.equal(r.summary.env.resetVerified, true);
  const other = fixture();
  other.policy.allowed_tools.push({ namespace: '', name: 'mcp__dragon_browser__executeJs' });
  assert.ok(nativeGuiPolicyErrors(other.policy).includes('NATIVE_GUI_TOOL_PIN_REQUIRED'));
});

test('Claude stream route: the R1a MCP tools are Dragon route tools, and their sessions count', () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'S', mcp_servers: [{ name: 'Dragon_Browser', status: 'connected' }], tools: ['mcp__Dragon_Browser__dragon_rpc', 'mcp__Dragon_Browser__envSet', 'mcp__Dragon_Browser__sensorsStart'] },
    { type: 'assistant', session_id: 'S', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__Dragon_Browser__envSet', input: { tabId: 1, sessionId: 'dragon-env', nonce: 'n', browserInstanceId: 'b', network: 'offline' } }] } },
    { type: 'user', session_id: 'S', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: JSON.stringify({ ok: true, result: { ok: true, conditions: forced } }) }] }] } },
    { type: 'assistant', session_id: 'S', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__Dragon_Browser__dragon_rpc', input: { method: 'do', params: { sessionId: 'dragon-do', tabId: 1, steps: [] } } }] } },
    { type: 'user', session_id: 'S', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: JSON.stringify({ ok: true, result: { completed: true, results: [] } }) }] }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'S' },
  ];
  const r = inspectClaudeStreamDragonRoute({ stream: lines.map((l) => JSON.stringify(l)).join('\n'), sessionId: 'S', server: 'Dragon_Browser' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.sessions, ['dragon-do', 'dragon-env']);
  assert.equal(r.summary.dragon_rpc_ok, 1, 'rule 6 still counts dragon_rpc calls only');
});

test('conditions record: the closed Dragon shape, forced dimensions, real speed and a verified reset', () => {
  assert.deepEqual(conditionsRecordErrors(conditions()), []);
  assert.deepEqual(conditionsRecordErrors(forced), []);
  assert.ok(conditionsRecordErrors({ ...forced, extra: 1 }).length);
  assert.ok(conditionsRecordErrors({ ...forced, role: 'judge' }).length);
  assert.ok(conditionsRecordErrors({ ...forced, requests: [{ id: 'r', urlPattern: '*', action: 'inject', status: null, errorReason: null, matched: 0 }] }).length);
  assert.equal(conditionsForced(conditions()), false);
  assert.equal(conditionsForced(conditions({ probes: { sensors: true, frames: true } })), false, 'probes are not a forced state');
  assert.equal(conditionsForced(forced), true);
  assert.equal(conditionsAtDefault(resetResult().conditions), true);
  assert.equal(conditionsAtDefault(conditions({ probes: { sensors: true, frames: false } })), false);
  assert.equal(realSpeed(null), true);
  assert.equal(realSpeed(conditions({ cpu: { rate: 4 } })), false);
  assert.equal(realSpeed(conditions({ cpu: { rate: 1 } })), true);
  assert.equal(realSpeed(forced), true, 'a network condition does not slow the page clock');
  assert.deepEqual(envResetVerdict(resetResult()), { verified: true, code: null });
  assert.deepEqual(envResetVerdict({ ok: true, result: resetResult() }), { verified: true, code: null }, 'the dragon_rpc envelope is read too');
  assert.equal(envResetVerdict(resetResult({ ok: false, code: 'ENV_RESET_UNVERIFIED', atDefault: false })).code, 'ENV_RESET_UNVERIFIED');
  assert.equal(envResetVerdict(resetResult({ conditions: conditions({ cpu: { rate: 4 } }) })).verified, false);
  assert.equal(envResetVerdict(resetResult({ mismatches: [{ dim: 'cpu' }] })).verified, false);
  assert.equal(envResetVerdict(null).code, 'ENV_RESET_EVIDENCE_INVALID');
});

// ── the gate: state receipts record env.conditions; the case's env.reset must be verified ───────────────────────────
const gate = (file) => spawnSync(process.execPath, [GATE, file], { cwd: dirname(file), encoding: 'utf8' });
const RESET = 'evidence/TC-01-env-reset.json';
function envBoard({ env, reset = resetResult(), honest = false } = {}) {
  return r1dBoard({
    files: reset === undefined ? {} : { [RESET]: reset },
    receipt: (r) => { if (env !== undefined) r.env = env; },
    data: (d) => { if (honest) Object.assign(d.cases[0], { status: 'BLOCKED', functionVerdict: 'UNGRADED', uiVerdict: 'UNGRADED' }), d.release = { verdict: 'NO-GO', risks: ['env'] }; },
  });
}

test('gate (default mode): env.conditions with a verified env.reset passes; without env the receipt is graded as before', () => {
  for (const env of [undefined, { conditions: forced, reset: { evidence_ref: RESET } }, { conditions: null, reset: { evidence_ref: RESET } }]) {
    const r = gate(envBoard({ env }).file);
    assert.equal(r.status, 0, `${JSON.stringify(env)}\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /QA gate: PASS/);
  }
});

test('gate (default mode): an unverified, missing or foreign reset, bad conditions or an evidence tab keep the case from PASS', () => {
  const unverified = resetResult({ ok: false, code: 'ENV_RESET_UNVERIFIED', atDefault: false, conditions: { ...forced, verified: false } });
  for (const [label, options, code] of [
    ['reset unverified', { env: { conditions: forced, reset: { evidence_ref: RESET } }, reset: unverified }, 'ENV_RESET_UNVERIFIED'],
    ['reset missing', { env: { conditions: forced } }, 'ENV_RESET_MISSING'],
    ['reset of another case', { env: { conditions: forced, reset: { evidence_ref: RESET } }, reset: resetResult({ endedCase: 'TC-99' }) }, 'ENV_RESET_CASE_MISMATCH'],
    ['reset not in the manifest', { env: { conditions: forced, reset: { evidence_ref: 'evidence/elsewhere.json' } } }, 'ENV_RESET_EVIDENCE_INVALID'],
    ['conditions malformed', { env: { conditions: { ...forced, cpu: 4 }, reset: { evidence_ref: RESET } } }, 'ENV_CONDITIONS_INVALID'],
    ['conditions unverified', { env: { conditions: { ...forced, verified: false }, reset: { evidence_ref: RESET } } }, 'ENV_CONDITIONS_UNVERIFIED'],
    ['conditions of another case', { env: { conditions: { ...forced, caseId: 'TC-02' }, reset: { evidence_ref: RESET } } }, 'ENV_CONDITIONS_CASE_MISMATCH'],
    ['evidence tab', { env: { conditions: { ...forced, role: 'evidence' }, reset: { evidence_ref: RESET } } }, 'ENV_EVIDENCE_TAB_VERDICT'],
    ['env without conditions', { env: { reset: { evidence_ref: RESET } } }, 'ENV_CONDITIONS_INVALID'],
  ]) {
    const claimed = gate(envBoard(options).file);
    assert.equal(claimed.status, 1, `${label}: ${claimed.stdout}${claimed.stderr}`);
    assert.match(claimed.stderr, new RegExp(`UNGRADED ${code}:TC-01`), label);
    assert.doesNotMatch(claimed.stdout, /QA gate: PASS/, label);
    const honest = gate(envBoard({ ...options, honest: true }).file);
    assert.equal(honest.status, 20, `${label} (honest): ${honest.stdout}${honest.stderr}`);
  }
});

test('release-truth v2: the same env checks; a failed reset turns the case\'s atomic rows UNGRADED', () => {
  const good = checkGuiReleaseTruthV2(asReleaseTruthV2(envBoard({ env: { conditions: forced, reset: { evidence_ref: RESET } } })));
  assert.deepEqual(good.issues.filter((i) => i.message.startsWith('ENV_')), []);
  assert.deepEqual(good.atomicCoverage.map((row) => row.result), ['PASS']);
  const unverified = resetResult({ ok: false, code: 'ENV_RESET_UNVERIFIED', atDefault: false, conditions: { ...forced, verified: false } });
  const bad = checkGuiReleaseTruthV2(asReleaseTruthV2(envBoard({ env: { conditions: forced, reset: { evidence_ref: RESET } }, reset: unverified })));
  assert.ok(bad.issues.some((i) => i.ungraded && i.message.startsWith('ENV_RESET_UNVERIFIED:TC-01')), JSON.stringify(bad.issues));
  assert.deepEqual(bad.atomicCoverage.map((row) => row.result), ['UNGRADED']);
  const missing = checkGuiReleaseTruthV2(asReleaseTruthV2(envBoard({ env: { conditions: forced } })));
  assert.ok(missing.issues.some((i) => i.ungraded && i.message.startsWith('ENV_RESET_MISSING:TC-01')));
  const plain = checkGuiReleaseTruthV2(asReleaseTruthV2(envBoard()));
  assert.deepEqual(plain.issues.filter((i) => i.message.startsWith('ENV_')), []);
});

test('R1c: the Gate-0 sweep reads with the U-rule calls are declared measurement reads; the R1c Dragon surface is accepted', () => {
  // The files are inlined as reads (SKILL.md "Calling Dragon"); this checkout's sources, whatever they hold after a merge.
  const ui = readFileSync(join(ROOT, 'scripts/ui-sanity.js'), 'utf8'), a11y = readFileSync(join(ROOT, 'scripts/a11y-gate0.js'), 'utf8');
  const f = fixture({ capabilities: ['env.get', 'sensors.read', 'paintSnapshot', 'env.set', 'env.release', 'env.reset', 'sensors.start', 'sensors.stop'] });
  f.policy.reads = [`${ui}; return __uiSanity('after-save', {ux:{}});`, `${a11y}; return __a11yB({minTarget:24, ux:{}});`,
    `${ui}; return __uxObserve({trigger:'#save'});`, `__uxObserve({trigger:'#save'})`, `__uiSanity('after-save',{ux:{}})`, `__a11yB({minTarget:24,ux:{}})`];
  for (const toolName of ['envSet', 'envGet', 'envRelease', 'envReset', 'sensorsStart', 'sensorsRead', 'sensorsStop', 'paintSnapshot']) f.policy.allowed_tools.push({ namespace: '', name: `mcp__dragon_browser__${toolName}` });
  assert.deepEqual(nativeGuiPolicyErrors(f.policy), []);
  f.calls.push(f.call('do', { completed: true, results: [{ step: 'read', as: 'u', value: { v: 'ui-sanity/2.0' } }], reads: { u: { v: 'ui-sanity/2.0' } } }, { steps: [{ read: f.policy.reads[0], as: 'u' }] }));
  assert.equal(run(f).verdict, 'PASS', run(f).errors.join(','));
});

test('do step {dialog:{accept}} (answer the next native dialog, read back as do.dialogHandled) is accepted with its receipt', () => {
  const f = fixture();
  const steps = [{ dialog: { accept: true } }, { clickSelector: '#delete', fast: false }];
  const results = [{ step: 'dialog', ok: true, receipt: { ...f.receipt('do'), input: { kind: 'key', trusted: true } } }, { step: 'clickSelector', ok: true, receipt: f.receipt('do') }];
  f.calls.push(f.call('do', { completed: true, results, dialogHandled: { type: 'confirm', message: 'Delete?', action: 'accept' } }, { steps }));
  const r = run(f);
  assert.equal(r.verdict, 'PASS', r.errors.join(','));
  for (const dialog of [{ accept: 'yes' }, { accept: true, script: 'x' }, 'accept']) {
    const bad = fixture();
    bad.calls.push(bad.call('do', { completed: true, results: [{ step: 'dialog', ok: true, receipt: bad.receipt('do') }] }, { steps: [{ dialog }] }));
    assert.ok(run(bad).errors.includes('NATIVE_GUI_STEP_UNAPPROVED'), JSON.stringify(dialog));
  }
});

test('dogfood 05/11 (CHILD_VERDICT_CONFLICT): a case whose UI FAILs while every function row PASSes gets a FAIL row of its own', () => {
  const uiFail = r1dBoard({
    receipt: (r) => { r.ui.uiSanity = { id: 'ui-sanity', verdict: 'FAIL', evidence: 'raw' }; r.ui.verdict = 'FAIL'; },
    data: (d) => { Object.assign(d.cases[0], { status: 'FAIL', uiVerdict: 'FAIL' }); d.cases[0].results[0].uiVerdict = 'FAIL'; d.release = { verdict: 'NO-GO', risks: ['ui'] }; },
  });
  const out = checkGuiReleaseTruthV2(asReleaseTruthV2(uiFail));
  assert.deepEqual(out.atomicCoverage.map((row) => [row.assertion_id.endsWith('#ui') ? 'ui' : 'function', row.result]), [['function', 'PASS'], ['ui', 'FAIL']]);
  const ui = out.atomicCoverage.at(-1);
  assert.deepEqual([ui.assertion_id, ui.case_id, ui.requirement_id, ui.evidence_type], ['TC-01#ui', 'TC-01', 'REQ-1', 'gui-screenshot']);
  // Team QA reads a case-scoped receipt's verdict from the case's rows: any FAIL row makes it FAIL.
  assert.ok(out.atomicCoverage.some((row) => row.case_id === 'TC-01' && row.result === 'FAIL'));
  // A clean case keeps exactly its function rows.
  assert.deepEqual(checkGuiReleaseTruthV2(asReleaseTruthV2(r1dBoard({}))).atomicCoverage.map((row) => row.assertion_id.endsWith('#ui')), [false]);
});
