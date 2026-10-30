import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeGuiPolicyErrors, validateNativeGuiRequest, validateNativeGuiTrajectory } from '../scripts/lib/native-gui-trajectory.mjs';

const hash = 'b'.repeat(64), name = 'mcp__dragon_browser__dragon_rpc';
function fixture(behavioral = false) {
  const dragon = { version: '1.6.4', sessionId: 'fixture-session', nonce: 'fixture-nonce', browserInstanceId: 'fixture-browser', tabId: 17 };
  const policy = { schema: 'qa-gui/native-policy/v1', allowed_tools: [{ namespace: '', name }], dragon,
    target: { url: 'http://localhost:9000', commit: 'a'.repeat(40) }, capabilities: ['screenshot', 'trustedClick', 'do', 'startRecording', 'stopRecording', 'assembleRecording'], max_calls: 20,
    helpers: [], commands: [], reads: ['return {count: document.querySelectorAll("button").length};'], behavioral };
  const params = { sessionId: dragon.sessionId, nonce: dragon.nonce, browserInstanceId: dragon.browserInstanceId, tabId: dragon.tabId };
  let line = 10;
  const call = (method, result, extra = {}) => ({ tool: name, namespace: '', name, type: 'function_call',
    input: { method, params: { ...params, ...extra } }, output: { ok: true, result }, call_timestamp: '2026-10-07T12:00:00Z', output_timestamp: '2026-10-07T12:00:01Z', call_line: line++, output_line: line++, call_sha256: hash, output_sha256: hash });
  const receipt = (method = 'trustedClick') => ({ actionId: 'fixture-action', ts: Date.parse('2026-10-07T12:00:00Z'), session: params, action: { method, step: {} }, input: { trusted: true }, firewall: { verdict: 'allow' }, postcondition: { pass: true }, env: { build: { extVersion: '1.6.4' } } });
  const shot = call('screenshot', { privacyMasked: true, maskedRects: [], savedTo: '/fixture/shot.png' });
  const calls = behavioral ? [call('startRecording', { id: 'fixture-recording', tabId: dragon.tabId, start: {privacyMasked: true} }), call('trustedClick', { receipt: receipt() }, { selector: '#submit', fast: false }), shot,
    call('stopRecording', { id: 'fixture-recording', frameCount: 5, events: 2, privacy: { masked: true, maskFailures: 0, cleanup: { ok: true } }, delivery: { persistedFrames: 5, extensionFrames: 5, ingestErrors: 0, captureErrors: 0, pushErrors: 0 } }, { id: 'fixture-recording' }),
    call('assembleRecording', { id: 'fixture-recording', video: '/fixture/recording.mp4' }, { id: 'fixture-recording' })] : [shot];
  // Synthetic shapes only: these fixtures never assert host or product acceptance.
  calls.sort((a, b) => a.call_line - b.call_line);
  if (behavioral) { const index = calls.indexOf(shot); calls.splice(index, 1); calls.splice(2, 0, shot); calls.forEach((c, i) => { c.call_line = 10 + i * 2; c.output_line = c.call_line + 1; }); }
  return { calls, policy, call, receipt };
}
const run = f => validateNativeGuiTrajectory(f);
test('static fixture validates privacy-attested image trajectory only', () => {
  const r = run(fixture()); assert.equal(r.verdict, 'PASS'); assert.deepEqual(r.summary, { calls: 1, actions: 0, captures: 1, recordings: 0 });
});
test('behavioral fixture requires start/action/image/stop/assemble', () => {
  const r = run(fixture(true)); assert.equal(r.verdict, 'PASS', r.errors.join(',')); assert.equal(r.summary.recordings, 1);
});
test('do binds each trusted receipt to the corresponding settled action', () => {
  const f = fixture(); const step = { clickSelector: '#submit', fast: false };
  f.calls.push(f.call('do', { completed: true, results: [{ receipt: f.receipt('do') }], receipts: [f.receipt('do')] }, { steps: [step] }));
  assert.equal(run(f).verdict, 'PASS'); f.calls[1].output.result.results[0].receipt.input.trusted = false;
  assert.ok(run(f).errors.includes('NATIVE_GUI_TRUSTED_RECEIPT_REQUIRED'));
});
test('negative mutations fail closed on source/session/tool/caps/privacy/input/recording', () => {
  const mutations = [
    f => { f.calls[0].call_sha256 = null; }, f => { f.calls[0].input.params.nonce = 'stale'; },
    f => { f.calls[0].name = 'mcp__other__run'; }, f => { f.policy.capabilities.push('executeJs'); },
    f => { f.policy.target.commit = 'unresolved'; }, f => { f.policy.max_calls = 1; },
    f => { f.calls[1].input.params.fast = true; }, f => { f.calls[1].output.result.receipt.input.trusted = false; },
    f => { f.calls[1].output.result.receipt.env.build.extVersion = '1.6.3'; },
    f => { f.calls[2].output.result.privacyMasked = false; }, f => { f.calls[3].output.result.delivery.pushErrors = 1; },
    f => { f.calls[3].output.result.privacy.maskFailures = 1; }, f => { f.calls.pop(); },
    f => { f.calls[1].output.result.receipt.ts = 0; }, f => { f.calls[1].call_timestamp = null; }, f => { f.policy.unrecognized = true; }, f => { f.calls[2].output.result.ok = false; },
  ];
  for (const mutate of mutations) { const f = fixture(true); mutate(f); assert.equal(run(f).verdict, 'UNGRADED', String(mutate)); }
});
test('measurement permits only exact locked read bytes and populated output', () => {
  const f = fixture(); f.calls.push(f.call('do', { completed: true, results: [{ step: 'read' }], reads: { measured: { count: 2 } } }, { steps: [{ read: f.policy.reads[0], as: 'measured' }] }));
  assert.equal(run(f).verdict, 'PASS'); f.calls[1].input.params.steps[0].read = 'document.querySelector("button").click()';
  assert.ok(run(f).errors.includes('NATIVE_GUI_MEASUREMENT_REQUIRED'));
});
test('unknown helper shell and missing helper hash cannot pass', () => {
  const f = fixture(); f.calls.push({ ...f.call('screenshot', {}), tool: 'exec_command', command: 'curl http://example.invalid', input: { cmd: 'curl http://example.invalid', login: false }, output: { exit_code: 0, output: '{}' } });
  assert.ok(run(f).errors.includes('NATIVE_GUI_HELPER_UNAPPROVED'));
  f.policy.helpers.push({ path: '/fixture/scripts/qa_do.mjs', sha256: 'unknown' });
  assert.ok(run(f).errors.includes('NATIVE_GUI_HELPER_PIN_REQUIRED'));
});
test('malformed shapes and non-sequential source pairs return UNGRADED without throwing', () => {
  for (const calls of [null, [null], [false], [{}]]) assert.equal(validateNativeGuiTrajectory({ policy: fixture().policy, calls }).verdict, 'UNGRADED');
  for (const policy of [null, [], {}, {schema: 'unknown'}]) assert.ok(nativeGuiPolicyErrors(policy).length);
  const f = fixture(true); f.calls.reverse(); assert.ok(run(f).errors.includes('NATIVE_GUI_SOURCE_PAIR_REQUIRED'));
});
test('shared parser call shape and direct namespaced MCP tool remain supported', () => {
  const f = fixture(); delete f.calls[0].name; f.calls[0].namespace = 'mcp__Dragon_Browser'; f.calls[0].tool = 'dragon_rpc';
  f.policy.allowed_tools = [{namespace: 'mcp__Dragon_Browser', name: 'dragon_rpc'}];
  assert.equal(run(f).verdict, 'PASS');
});
test('helper command must invoke actual pinned helper with exact literal request', () => {
  const f = fixture(), helper = {path: '/fixture/scripts/qa_do.mjs', sha256: hash}, request = f.calls[0].input;
  const command = `node '${helper.path}' --method 'screenshot' --params '${JSON.stringify(request.params)}' --timeout 15000`;
  f.policy.helpers = [helper]; f.policy.commands = [{command, helper, request}];
  f.calls[0] = {...f.calls[0], tool: 'exec_command', command, input: {cmd: command, login: false}, output: {exit_code: 0, output: JSON.stringify(f.calls[0].output)}};
  assert.equal(run(f).verdict, 'PASS');
  f.policy.commands[0].command = `curl http://example.invalid # ${helper.path}`;
  assert.ok(nativeGuiPolicyErrors(f.policy).includes('NATIVE_GUI_HELPER_COMMAND_REQUIRED'));
});
test('actual MCP wrapper accepts one text JSON and rejects failed or ambiguous wrappers', () => {
  const f = fixture(), raw = f.calls[0].output;
  f.calls[0].output = {content: [{type: 'text', text: JSON.stringify(raw)}], isError: false};
  assert.equal(run(f).verdict, 'PASS');
  for (const output of [{content: [{type: 'text', text: JSON.stringify(raw)}], isError: true},
    {content: [{type: 'text', text: JSON.stringify(raw)}, {type: 'text', text: '{}'}]},
    {content: [{type: 'image', data: 'unknown'}]}, {content: [{type: 'text', text: '{}{}'}]},
    {content: [{type: 'text', text: JSON.stringify(raw)}], structuredContent: {ok: true, result: {}}}]) {
    f.calls[0].output = output; assert.equal(run(f).verdict, 'UNGRADED');
  }
});
test('supported Dragon versions are a range and receipt version remains bound', () => {
  for (const version of ['1.6.4', '1.6.6', '1.6.9', '1.7.0', '1.12.3']) {
    const f = fixture(); f.policy.dragon.version = version;
    f.calls[0].output.result.receipt = undefined;
    assert.deepEqual(nativeGuiPolicyErrors(f.policy), []);
    const action = f.call('trustedClick', { receipt: { ...f.receipt(), env: { build: { extVersion: version } } } }, { selector: '#ok', fast: false });
    f.calls.push(action);
    assert.equal(run(f).verdict, 'PASS');
  }
  for (const version of ['1.6.3', '1.5.9', '2.0.0', '1.6.6-beta', '1.6', '', null, 166]) {
    const f = fixture(); f.policy.dragon.version = version;
    assert.ok(nativeGuiPolicyErrors(f.policy).includes('NATIVE_GUI_POLICY_REQUIRED'), String(version));
  }
  const f = fixture(); f.policy.dragon.version = '1.6.9';
  f.calls[0].output.result.receipt = undefined;
  f.calls.push(f.call('trustedClick', { receipt: { ...f.receipt(), env: { build: { extVersion: '1.6.6' } } } }, { selector: '#ok', fast: false }));
  assert.notEqual(run(f).verdict, 'PASS', 'a receipt from another extension release than the policy names is not graded');
});
test('deployed-build policy binds an opaque target hash without a product Git SHA', () => {
  const f = fixture();
  f.policy.schema = 'qa-gui/native-policy/v2';
  f.policy.target = { url: 'https://preview.example/cart', kind: 'deployed-build', target_binding_sha256: 'c'.repeat(64) };
  assert.deepEqual(nativeGuiPolicyErrors(f.policy), []);
  const malformed = structuredClone(f.policy); malformed.target.target_binding_sha256 = 'd'.repeat(40);
  assert.ok(nativeGuiPolicyErrors(malformed).includes('NATIVE_GUI_POLICY_REQUIRED'));
  const fakeSha = structuredClone(f.policy); fakeSha.target.commit = 'a'.repeat(40);
  assert.ok(nativeGuiPolicyErrors(fakeSha).includes('NATIVE_GUI_TARGET_UNKNOWN'));
  const wrongKind = structuredClone(f.policy); wrongKind.target.kind = 'git';
  assert.ok(nativeGuiPolicyErrors(wrongKind).includes('NATIVE_GUI_POLICY_REQUIRED'));
});
test('Storage read policy allows literal-key getItem and rejects writes or dynamic access', () => {
  const f = fixture();
  for (const read of [
    'return localStorage.getItem("cart")',
    "return sessionStorage . getItem ( 'checkout-state' )",
    'return {count: document.querySelectorAll("button").length}',
  ]) {
    f.policy.reads = [read]; assert.deepEqual(nativeGuiPolicyErrors(f.policy), [], read);
  }
  for (const read of [
    'localStorage.setItem("cart", "x")',
    'localStorage.removeItem("cart")',
    'localStorage.clear()',
    'localStorage["getItem"]("cart")',
    'fixture.localStorage.getItem("cart")',
    'localStorage.getItem("cart");',
    'localStorage.getItem("cart"); alert(1)',
    'localStorage.getItem.call(localStorage, "cart")',
    'localStorage["get" + "Item"]("cart")',
    'window["local" + "Storage"].setItem("cart", "x")',
    'localStorage.constructor.getItem("cart")',
    'Storage.prototype.getItem.call(localStorage, "cart")',
    'Object.defineProperty(localStorage, "cart", { get() { return "x"; } })',
    'localStorage.getItem(key)',
    'sessionStorage.getItem("x"); localStorage.setItem("y", "z")',
  ]) {
    f.policy.reads = [read]; assert.ok(nativeGuiPolicyErrors(f.policy).includes('NATIVE_GUI_READ_POLICY_REQUIRED'), read);
  }
});

test('native request inspection classifies read, capture, trusted input, and recording', () => {
  const f = fixture();
  f.policy.capabilities.push('captureTab', 'perceive');
  const lockedPolicy = { allowedInput: ['pointer', 'key'], requireTrusted: true, forbidSyntheticDOM: false, locked: true };
  const common = { sessionId: f.policy.dragon.sessionId, nonce: f.policy.dragon.nonce, browserInstanceId: f.policy.dragon.browserInstanceId, tabId: f.policy.dragon.tabId, runId: 'run', caseId: 'case', stateId: 'state', buildId: 'build' };
  const check = (method, extra = {}) => validateNativeGuiRequest({ request: { method, params: { ...common, ...extra } }, policy: f.policy, lockedPolicy });
  const read = check('do', { steps: [{ read: f.policy.reads[0], as: 'measured' }] });
  assert.equal(read.verdict, 'PASS', read.errors.join(','));
  assert.deepEqual({ requiresLive: read.requiresLive, mutating: read.mutating, hasTrustedAction: read.hasTrustedAction, actionClass: read.actionClass }, { requiresLive: true, mutating: false, hasTrustedAction: false, actionClass: 'read' });
  const click = check('trustedClick', { selector: '#submit', fast: false });
  assert.equal(click.verdict, 'PASS', click.errors.join(','));
  assert.equal(click.mutating, true);
  assert.equal(click.hasTrustedAction, true);
  assert.equal(click.actionClass, 'trusted-input');
  const capture = check('captureTab', { toFile: 'capture.png', format: 'png', quality: 'high' });
  assert.equal(capture.verdict, 'PASS', capture.errors.join(','));
  assert.equal(capture.mutating, false);
  assert.equal(capture.actionClass, 'capture');
  const recording = check('startRecording', { quality: 'high' });
  assert.equal(recording.verdict, 'PASS', recording.errors.join(','));
  assert.equal(recording.mutating, true);
  assert.equal(recording.actionClass, 'recording');
  assert.equal(check('startRecording', { fps: 15, quality: 80 }).verdict, 'PASS');
  assert.equal(check('assembleRecording', { id: 'rec-1', fps: 15 }).verdict, 'PASS');
  const perception = check('perceive', { max: 5 });
  assert.equal(perception.verdict, 'PASS', perception.errors.join(','));
  assert.equal(perception.mutating, false);
  const waited = check('do', { steps: [{ waitFor: { selector: '#ready', timeoutMs: 1200 } }] });
  assert.equal(waited.verdict, 'PASS', waited.errors.join(','));
});

test('native request inspection rejects unsafe Storage reads, drift, and weakened policy', () => {
  const f = fixture();
  const lockedPolicy = { allowedInput: ['pointer', 'key'], requireTrusted: true, forbidSyntheticDOM: false };
  const common = { sessionId: f.policy.dragon.sessionId, nonce: f.policy.dragon.nonce, browserInstanceId: f.policy.dragon.browserInstanceId, tabId: f.policy.dragon.tabId, runId: 'run', caseId: 'case', stateId: 'state', buildId: 'build' };
  const request = { method: 'do', params: { ...common, steps: [{ read: f.policy.reads[0], as: 'measured' }] } };
  const invalidRead = structuredClone(request);
  invalidRead.params.steps[0].read = 'localStorage.getItem("cart"); alert(1)';
  assert.ok(validateNativeGuiRequest({ request: invalidRead, policy: f.policy, lockedPolicy }).errors.includes('NATIVE_GUI_READ_POLICY_REQUIRED'));
  for (const value of [null, 1, false]) {
    const malformedRead = structuredClone(request);
    malformedRead.params.steps[0].read = value;
    assert.ok(validateNativeGuiRequest({ request: malformedRead, policy: f.policy, lockedPolicy }).errors.includes('NATIVE_GUI_READ_POLICY_REQUIRED'));
  }
  const unsafeWait = structuredClone(request);
  unsafeWait.params.steps[0] = { waitFor: { selector: '#ready', then: [{ click: 'Delete' }] } };
  assert.ok(validateNativeGuiRequest({ request: unsafeWait, policy: f.policy, lockedPolicy }).errors.includes('NATIVE_GUI_STEP_UNAPPROVED'));
  const drift = structuredClone(request);
  drift.params.nonce = 'other';
  assert.ok(validateNativeGuiRequest({ request: drift, policy: f.policy, lockedPolicy }).errors.includes('NATIVE_GUI_SESSION_DRIFT'));
  assert.ok(validateNativeGuiRequest({ request, policy: f.policy, lockedPolicy: { ...lockedPolicy, forbidSyntheticDOM: true } }).errors.includes('NATIVE_GUI_LOCKED_POLICY_REQUIRED'));
  assert.ok(validateNativeGuiRequest({ request: { method: 'executeJs', params: { ...common, code: 'return 1' } }, policy: f.policy, lockedPolicy }).errors.includes('NATIVE_GUI_CAPABILITY_UNAPPROVED'));
});
