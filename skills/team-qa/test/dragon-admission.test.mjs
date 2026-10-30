import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectDragonAdmission } from '../scripts/lib/dragon-admission.mjs';

const sourcePath = fileURLToPath(new URL('../scripts/lib/dragon-admission.mjs', import.meta.url));
const targetUrl = 'https://fixture.example.test/cart';
const planned = { sessionId: 'run-session-1', runId: 'run-1', owner: 'codex-parent', targetUrl, created: false };
const created = { ...planned, nonce: 'nonce-1', browserInstanceId: 'browser-1', created: true };
const opened = { ...created, tabId: 42 };
const readExpression = 'return {url: location.href};';
const policy = {
  schema: 'qa-gui/native-policy/v1',
  target: { url: targetUrl },
  dragon: { sessionId: created.sessionId, nonce: created.nonce, browserInstanceId: created.browserInstanceId, tabId: opened.tabId },
  capabilities: ['do', 'trustedClick', 'read', 'captureTab', 'startRecording', 'stopRecording', 'assembleRecording'],
  reads: [readExpression],
  requireTrusted: true,
  forbidSyntheticDOM: false,
};
const childInspector = ({ request }) => {
  const action = ['trustedClick', 'trustedType', 'pressKey', 'trustedHover', 'trustedScroll', 'dragDrop', 'clear', 'chord'].includes(request.method)
    || request.method === 'do' && request.params.steps.some(step => Object.keys(step).some(key => ['click', 'clickSelector', 'clickXY', 'type', 'fill', 'pressKey', 'hover', 'scroll', 'drag', 'clear', 'chord'].includes(key)));
  const badRead = request.method === 'read' && !policy.reads.includes(request.params.read)
    || request.method === 'do' && request.params.steps.some(step => Object.hasOwn(step, 'read') && !policy.reads.includes(step.read));
  const unknownStep = request.method === 'do' && request.params.steps.some(step => Object.keys(step).some(key => !['read', 'as', 'wait', 'waitFor', 'assert', 'expectNet', 'click', 'clickSelector', 'clickXY', 'type', 'fill', 'pressKey', 'hover', 'scroll', 'drag', 'clear', 'chord'].includes(key)));
  const unknownRequestField = Object.keys(request.params).some(key => ['hidden', 'code', 'url'].includes(key));
  const unknownMethod = !['read', 'do', 'trustedClick', 'captureTab', 'startRecording', 'stopRecording', 'assembleRecording'].includes(request.method);
  const mixed = badRead || unknownStep || unknownRequestField || unknownMethod;
  const mutating = action || ['startRecording', 'stopRecording', 'assembleRecording'].includes(request.method);
  return { verdict: mixed ? 'UNGRADED' : 'PASS', errors: mixed ? ['NATIVE_GUI_STEP_UNAPPROVED'] : [], requiresLive: true, mutating, hasTrustedAction: action };
};
const rpc = (method, params) => ({ method, params });

test('run-owned session can be created only with the required non-synthetic policy', () => {
  assert.deepEqual(inspectDragonAdmission({
    request: rpc('session.create', { sessionId: planned.sessionId, forbidSyntheticDOM: false }),
    session: planned,
    targetUrl,
  }), { allowed: true, code: 'DRAGON_CREATE_SCOPED', requiresLive: false, mutating: true });
  assert.equal(inspectDragonAdmission({
    request: rpc('session.create', { sessionId: planned.sessionId, forbidSyntheticDOM: true }), session: planned, targetUrl,
  }).code, 'DRAGON_SYNTHETIC_DOM_POLICY');
  assert.equal(inspectDragonAdmission({
    request: rpc('session.create', { sessionId: planned.sessionId, forbidSyntheticDOM: false, policy: { requireTrusted: false } }), session: planned, targetUrl,
  }).code, 'DRAGON_REQUEST_PARAMS_UNKNOWN');
  assert.equal(inspectDragonAdmission({
    request: rpc('session.create', { sessionId: planned.sessionId, forbidSyntheticDOM: false }), session: created, targetUrl,
  }).code, 'DRAGON_SESSION_ALREADY_CREATED');
});

test('openTab is exact-target, background-only, and one-time for the created session', () => {
  const params = { sessionId: created.sessionId, nonce: created.nonce, browserInstanceId: created.browserInstanceId, url: targetUrl, active: false };
  assert.equal(inspectDragonAdmission({ request: rpc('openTab', params), session: created, targetUrl }).allowed, true);
  assert.equal(inspectDragonAdmission({ request: rpc('openTab', { ...params, url: 'https://other.example.test/' }), session: created, targetUrl }).allowed, false);
  assert.equal(inspectDragonAdmission({ request: rpc('openTab', { ...params, active: true }), session: created, targetUrl }).allowed, false);
  assert.equal(inspectDragonAdmission({ request: rpc('openTab', params), session: opened, targetUrl }).code, 'DRAGON_OPEN_TAB_STATE');
});

test('only registered identity and allowlisted read expressions pass during preparation', () => {
  const request = rpc('do', { sessionId: opened.sessionId, nonce: opened.nonce, browserInstanceId: opened.browserInstanceId, tabId: opened.tabId, steps: [{ read: readExpression, as: 'target' }] });
  const allowed = inspectDragonAdmission({ request, session: opened, targetUrl, executionAllowed: false, policy, childInspector });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.code, 'DRAGON_READ_ONLY_SCOPED');
  assert.equal(inspectDragonAdmission({ request: rpc('do', { ...request.params, nonce: 'stale-nonce' }), session: opened, targetUrl, policy, childInspector }).code, 'DRAGON_SESSION_IDENTITY_MISMATCH');
  assert.equal(inspectDragonAdmission({ request: rpc('do', { ...request.params, tabId: 7 }), session: opened, targetUrl, policy, childInspector }).code, 'DRAGON_SESSION_IDENTITY_MISMATCH');
  assert.equal(inspectDragonAdmission({ request: rpc('do', { ...request.params, steps: [{ read: 'return document.body.innerHTML;', as: 'target' }] }), session: opened, targetUrl, policy, childInspector }).code, 'DRAGON_NATIVE_POLICY_INVALID');
  assert.equal(inspectDragonAdmission({ request: rpc('do', { ...request.params, steps: [{ click: '#save' }, { read: 'return document.body.innerHTML;', as: 'target' }] }), session: opened, targetUrl, executionAllowed: true, policy, childInspector }).code, 'DRAGON_NATIVE_POLICY_INVALID');
  assert.equal(inspectDragonAdmission({ request, session: opened, targetUrl }).detail, 'DRAGON_POLICY_MISSING');
});

test('trusted actions need execution permission and child-validated native GUI policy', () => {
  const request = rpc('trustedClick', { sessionId: opened.sessionId, nonce: opened.nonce, browserInstanceId: opened.browserInstanceId, tabId: opened.tabId, selector: '#save' });
  assert.equal(inspectDragonAdmission({ request, session: opened, targetUrl, policy, childInspector }).code, 'DRAGON_EXECUTION_NOT_ALLOWED');
  const result = inspectDragonAdmission({ request, session: opened, targetUrl, executionAllowed: true, policy, childInspector });
  assert.equal(result.allowed, true);
  assert.equal(result.code, 'DRAGON_MUTATING_OPERATION_SCOPED');
  assert.equal(result.requiresLive, true);
  assert.equal(result.mutating, true);
  assert.equal(inspectDragonAdmission({ request, session: opened, targetUrl, executionAllowed: true, policy: { ...policy, target: { url: 'https://other.example.test/' } }, childInspector }).code, 'DRAGON_POLICY_SCOPE_MISMATCH');
  assert.equal(inspectDragonAdmission({ request, session: opened, targetUrl, executionAllowed: true, policy, childInspector: () => ({ verdict: 'UNGRADED', errors: ['NATIVE_GUI_POLICY_BAD'] }) }).detail, 'NATIVE_GUI_POLICY_BAD');
});

test('policy changes, arbitrary JavaScript, unknown methods, and unrelated cleanup are denied', () => {
  const identity = { sessionId: opened.sessionId, nonce: opened.nonce, browserInstanceId: opened.browserInstanceId, tabId: opened.tabId };
  assert.equal(inspectDragonAdmission({ request: rpc('session.setPolicy', { ...identity, policy }), session: opened, targetUrl }).code, 'DRAGON_ACTIVE_POLICY_CHANGE_DENIED');
  assert.equal(inspectDragonAdmission({ request: rpc('executeJs', { ...identity, code: 'document.body.remove()' }), session: opened, targetUrl, policy, childInspector }).allowed, false);
  assert.equal(inspectDragonAdmission({ request: rpc('navigate', { ...identity, url: targetUrl }), session: opened, targetUrl, policy, childInspector }).allowed, false);
  assert.equal(inspectDragonAdmission({ request: rpc('session.getPolicy', { sessionId: opened.sessionId }), session: opened, targetUrl }).code, 'DRAGON_OWN_SESSION_READ');
  assert.equal(inspectDragonAdmission({ request: rpc('session.list', {}), session: opened, targetUrl }).code, 'DRAGON_SESSION_READ_NOT_OWNED');
});

test('close requires the receipt-backed identity and an active session', () => {
  const identity = { sessionId: opened.sessionId, nonce: opened.nonce, browserInstanceId: opened.browserInstanceId };
  assert.deepEqual(inspectDragonAdmission({ request: rpc('session.close', identity), session: opened, targetUrl }),
    { allowed: true, code: 'DRAGON_OWN_SESSION_CLOSE', requiresLive: true, mutating: true });
  for (const params of [
    { sessionId: identity.sessionId },
    { ...identity, sessionId: 'someone-else' },
    { ...identity, nonce: 'other-nonce' },
    { ...identity, browserInstanceId: 'other-browser' },
    { ...identity, hidden: true },
  ]) {
    assert.equal(inspectDragonAdmission({ request: rpc('session.close', params), session: opened, targetUrl }).code, 'DRAGON_CLOSE_NOT_RUN_OWNED');
  }
  assert.equal(inspectDragonAdmission({ request: rpc('session.close', identity), session: created, targetUrl }).code, 'DRAGON_OWN_SESSION_CLOSE');
  assert.equal(inspectDragonAdmission({ request: rpc('session.close', identity), session: planned, targetUrl }).code, 'DRAGON_CLOSE_NOT_RUN_OWNED');
  assert.equal(inspectDragonAdmission({ request: rpc('session.close', identity), session: { ...opened, created: false }, targetUrl }).code, 'DRAGON_SESSION_NOT_ACTIVE');
  assert.equal(inspectDragonAdmission({ request: rpc('session.close', identity), session: { ...opened, closed: true }, targetUrl }).code, 'DRAGON_SESSION_CLOSED');
});

test('closed sessions, stale targets, and hidden request fields fail closed', () => {
  const request = rpc('read', { sessionId: opened.sessionId, nonce: opened.nonce, browserInstanceId: opened.browserInstanceId, tabId: opened.tabId, read: readExpression, as: 'target' });
  assert.equal(inspectDragonAdmission({ request, session: { ...opened, closed: true }, targetUrl, policy, childInspector }).code, 'DRAGON_SESSION_CLOSED');
  assert.equal(inspectDragonAdmission({ request, session: opened, targetUrl: 'https://other.example.test/', policy, childInspector }).code, 'DRAGON_TARGET_SCOPE_MISMATCH');
  assert.equal(inspectDragonAdmission({ request: { ...request, hidden: true }, session: opened, targetUrl, policy, childInspector }).code, 'DRAGON_REQUEST_INVALID');
  assert.equal(inspectDragonAdmission({ request: rpc('read', { ...request.params, hidden: true }), session: opened, targetUrl, policy, childInspector }).allowed, false);
  assert.equal(inspectDragonAdmission({ request: rpc('do', { sessionId: opened.sessionId, nonce: opened.nonce, browserInstanceId: opened.browserInstanceId, tabId: opened.tabId, steps: [{ read: readExpression, as: 'target', hidden: true }] }), session: opened, targetUrl, policy, childInspector }).code, 'DRAGON_NATIVE_POLICY_INVALID');
});

test('read, capture, and recording calls carry explicit live and mutation classifications', () => {
  const base = { sessionId: opened.sessionId, nonce: opened.nonce, browserInstanceId: opened.browserInstanceId, tabId: opened.tabId };
  const calls = [
    ['read', { ...base, read: readExpression, as: 'target' }, false],
    ['captureTab', { ...base, toFile: '/tmp/case.png' }, false],
    ['startRecording', { ...base, quality: 80 }, true],
    ['stopRecording', { ...base, id: 'recording-1' }, true],
    ['assembleRecording', { ...base, id: 'recording-1' }, true],
  ];
  for (const [method, params, mutating] of calls) {
    const result = inspectDragonAdmission({ request: rpc(method, params), session: opened, targetUrl, policy, childInspector });
    assert.equal(result.allowed, true, method);
    assert.equal(result.requiresLive, true, method);
    assert.equal(result.mutating, mutating, method);
  }
});

test('source mutation is killed by the PreToolUse admission assertion with a passing positive control', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamqa-dragon-admission-'));
  try {
    const original = readFileSync(sourcePath, 'utf8');
    const needle = 'params.forbidSyntheticDOM !== false';
    assert.equal(original.split(needle).length - 1, 1);
    const mutated = original.replace(needle, 'params.forbidSyntheticDOM !== true');
    const mutantPath = path.join(directory, 'dragon-admission-mutant.mjs');
    writeFileSync(mutantPath, mutated);
    const check = (modulePath) => `import assert from 'node:assert/strict';\nimport { inspectDragonAdmission } from ${JSON.stringify(pathToFileURL(modulePath).href)};\nconst base={sessionId:'s',runId:'r',owner:'o',created:false,targetUrl:'https://fixture.example.test/'};\nconst call=(forbidSyntheticDOM)=>inspectDragonAdmission({request:{method:'session.create',params:{sessionId:'s',forbidSyntheticDOM}},session:base,targetUrl:base.targetUrl});\nassert.equal(call(false).allowed,true);\nassert.equal(call(true).allowed,false);`;
    const positiveControl = spawnSync(process.execPath, ['--input-type=module', '-e', check(sourcePath)], { encoding: 'utf8' });
    assert.equal(positiveControl.status, 0, positiveControl.stderr);
    const mutation = spawnSync(process.execPath, ['--input-type=module', '-e', check(mutantPath)], { encoding: 'utf8' });
    assert.notEqual(mutation.status, 0, 'the source mutation must make the admission assertion fail');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('close identity assertion kills an admission bypass mutation', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'teamqa-dragon-close-'));
  try {
    const original = readFileSync(sourcePath, 'utf8');
    const needle = '!exactKeys(params, IDENTITY) || !validIdentity(params, session)';
    assert.equal(original.split(needle).length - 1, 1);
    const mutantPath = path.join(directory, 'dragon-close-mutant.mjs');
    writeFileSync(mutantPath, original.replace(needle, '!exactKeys(params, IDENTITY)'));
    const check = modulePath => `import assert from 'node:assert/strict';\nimport { inspectDragonAdmission } from ${JSON.stringify(pathToFileURL(modulePath).href)};\nconst session={sessionId:'s',nonce:'n',browserInstanceId:'b',runId:'r',owner:'o',targetUrl:'https://fixture.example.test/',created:true};\nconst call=nonce=>inspectDragonAdmission({request:{method:'session.close',params:{sessionId:'s',nonce,browserInstanceId:'b'}},session,targetUrl:session.targetUrl});\nassert.equal(call('n').allowed,true);\nassert.equal(call('stale').allowed,false);`;
    assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', check(sourcePath)], { encoding: 'utf8' }).status, 0);
    assert.notEqual(spawnSync(process.execPath, ['--input-type=module', '-e', check(mutantPath)], { encoding: 'utf8' }).status, 0);
  } finally {
    renameSync(directory, `${directory}-archive`);
  }
});
