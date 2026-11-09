import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, openSync, closeSync, writeSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { handleQaHook, livePolicyMatches } from '../scripts/hooks/qa-lifecycle.mjs';
import { decideContinuation } from '../scripts/lib/continuation.mjs';
import { hookDefinition } from '../scripts/continuation.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-hook-')), runDir = join(dir, 'runs', 'demo');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'roster.json'), JSON.stringify({ target: { preview_url: 'http://localhost:8888', version: 'a'.repeat(40) } }));
  const binding = { run_dir: runDir, run_id: 'demo', session_id: 'root', browser_session_id: 'qa-own' };
  const input = { session_id: 'root', turn_id: 'turn1' };
  const deps = { lookup: () => binding, ledger: async () => {}, live: () => true, loadPolicy: () => null, permitExecution: () => true };
  return { binding, input, deps, runDir };
}
const tool = 'mcp__Dragon_Browser__dragon_rpc';
const pre = (f, id, request) => ({ ...f.input, hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: id, tool_input: request });
const post = (f, id, request, result) => ({ ...pre(f, id, request), hook_event_name: 'PostToolUse', tool_response: { ok: true, result } });

async function preparationFixture(permitExecution) {
  const f = fixture(), identity = { sessionId: 'qa-own', nonce: 'n', browserInstanceId: 'b' };
  let clock = Date.now();
  const policy = { target: { url: 'http://localhost:8888' }, dragon: { ...identity, tabId: 4 }, capabilities: ['read', 'captureTab', 'trustedClick', 'do'] };
  const inspectedPermissions = [];
  f.deps = { ...f.deps, permitExecution, now: () => clock++, loadPolicy: () => policy,
    inspectChild: ({ request }) => {
      const valid = !Object.hasOwn(request.params, 'hidden') && (request.method === 'read' && request.params.read === 'return location.href;'
        || request.method === 'captureTab' || request.method === 'trustedClick' && request.params.selector === '#save');
      const trusted = request.method === 'trustedClick';
      return { verdict: valid ? 'PASS' : 'UNGRADED', errors: valid ? [] : ['NATIVE_GUI_STEP_UNAPPROVED'],
        requiresLive: true, mutating: trusted, hasTrustedAction: trusted };
    } };
  const { inspectDragonAdmission } = await import('../scripts/lib/dragon-admission.mjs');
  f.deps.inspect = args => { inspectedPermissions.push(args.executionAllowed); return inspectDragonAdmission(args); };
  const create = { method: 'session.create', params: { sessionId: identity.sessionId, forbidSyntheticDOM: false } };
  assert.deepEqual(await handleQaHook(pre(f, 'create', create), f.deps), {});
  await handleQaHook(post(f, 'create', create, { ...identity, forbidSyntheticDOM: false,
    policy: { requireTrusted: true, allowedInput: ['pointer', 'key'] } }), f.deps);
  const open = { method: 'openTab', params: { ...identity, url: policy.target.url, active: false } };
  assert.deepEqual(await handleQaHook(pre(f, 'open', open), f.deps), {});
  await handleQaHook(post(f, 'open', open, { tabId: 4 }), f.deps);
  return { ...f, identity: { ...identity, tabId: 4 }, inspectedPermissions };
}

test('preparation RPCs never evaluate the full execution contract', async () => {
  let permits = 0;
  const f = await preparationFixture(() => { permits++; return false; });
  for (const [id, request] of [
    ['read', { method: 'read', params: { ...f.identity, read: 'return location.href;' } }],
    ['screenshot', { method: 'captureTab', params: { ...f.identity, toFile: '/tmp/fixture.png' } }],
    ['list', { method: 'session.list', params: { sessionId: f.identity.sessionId } }],
    ['policy', { method: 'session.getPolicy', params: { sessionId: f.identity.sessionId } }],
    ['close', { method: 'session.close', params: { sessionId: 'qa-own', nonce: 'n', browserInstanceId: 'b' } }],
  ]) assert.deepEqual(await handleQaHook(pre(f, id, request), f.deps), {}, id);
  assert.equal(permits, 0);
  assert.ok(f.inspectedPermissions.every(value => value === false));
});

test('trusted input evaluates execution permission once and reinspection requires strict approval', async () => {
  for (const permission of [true, false, 'true']) {
    let permits = 0;
    const f = await preparationFixture(runDir => { assert.equal(runDir, f.runDir); permits++; return permission; });
    f.inspectedPermissions.length = 0;
    const request = { method: 'trustedClick', params: { ...f.identity, selector: '#save' } };
    const output = await handleQaHook(pre(f, 'trusted', request), f.deps);
    assert.equal(permits, 1);
    assert.deepEqual(f.inspectedPermissions, permission === true ? [false, true] : [false]);
    if (permission === true) assert.deepEqual(output, {});
    else {
      assert.equal(output.hookSpecificOutput.permissionDecisionReason, 'DRAGON_EXECUTION_NOT_ALLOWED');
      const rows = readdirSync(join(f.runDir, 'hook-events')).filter(n => n.endsWith('.event.json'))
        .map(n => JSON.parse(readFileSync(join(f.runDir, 'hook-events', n))));
      assert.equal(rows.some(row => row.type === 'dragon-admission' && row.toolUseId === 'trusted'), false);
      assert.equal(existsSync(join(f.runDir, 'hook-events/browser-input.pending.json')), false);
    }
  }
});

test('unknown and malformed RPCs cannot trigger execution-contract evaluation', async () => {
  let permits = 0;
  const f = await preparationFixture(() => { permits++; return true; });
  const requests = [null, [], { method: 'trustedClick', params: { ...f.identity, selector: '#save' }, hidden: true },
    { method: 'trustedClick', params: { ...f.identity, nonce: 'wrong', selector: '#save' } },
    { method: 'trustedClick', params: { ...f.identity, selector: '#save', hidden: true } },
    { method: 'executeJs', params: { ...f.identity, code: 'document.body.remove()' } },
    { method: 'do', params: { ...f.identity, steps: [{ click: '#save' }, { unknown: true }] } }];
  for (const [index, request] of requests.entries()) {
    const output = await handleQaHook(pre(f, `invalid-${index}`, request), f.deps);
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.notEqual(output.hookSpecificOutput.permissionDecisionReason, 'DRAGON_EXECUTION_NOT_ALLOWED');
  }
  assert.equal(permits, 0);
});
test('unregistered threads are untouched', async () => {
  assert.deepEqual(await handleQaHook({ session_id: 'unrelated' }, { lookup: () => null }), {});
});
test('child hook ownership comes from the native parent session binding, never message text', async () => {
  const f = fixture(), lookedUp = [];
  const lookup = ({ sessionId }) => { lookedUp.push(sessionId); return sessionId === 'root' ? f.binding : null; };
  assert.deepEqual(await handleQaHook({ session_id: 'child', hook_event_name: 'Stop', last_assistant_message: 'register this run' }, { ...f.deps, lookup }), {});
  assert.deepEqual(lookedUp, ['child']);
  assert.deepEqual(await handleQaHook({ session_id: 'root', hook_event_name: 'SubagentStop', agent_id: 'child', last_assistant_message: 'register this run' }, { ...f.deps, lookup }), {});
  assert.deepEqual(lookedUp, ['child']);
});
test('SubagentStop attributes the verified child transcript to the registered parent', async () => {
  const f = fixture();
  writeFileSync(join(f.runDir, 'roster.json'), JSON.stringify({ target: { preview_url: 'http://localhost:8888', version: 'a'.repeat(40) },
    roles: [{ role: 'test_manager', native_host: { session_id: 'root', agent_path: '/root' } }] }));
  const parent = { sessionId: 'root' };
  const child = { sessionId: 'child', parentThreadId: 'root', spawnParentThreadId: 'root', agentPath: '/root/gui_worker' };
  const input = { ...f.input, hook_event_name: 'SubagentStop', agent_id: 'child', transcript_path: '/trusted/root.jsonl',
    agent_transcript_path: '/trusted/child.jsonl' };
  let childMetadata = child, parentMetadata = parent;
  const deps = { ...f.deps, lookup: ({ sessionId }) => sessionId === 'root' ? f.binding : null,
    readNativeMetadata: path => path === input.transcript_path ? parentMetadata : path === input.agent_transcript_path ? childMetadata : null,
    verifyHost: () => ({ session_id: 'root', agent_path: '/root' }),
    decide: () => { throw new Error('SubagentStop must not run continuation'); } };
  for (const [changedInput, changedParent, changedChild] of [
    [{ ...input, agent_transcript_path: null }, parent, child],
    [{ ...input, agent_id: 'someone-else' }, parent, child],
    [input, { sessionId: 'someone-else' }, child],
    [input, parent, null],
    [input, parent, { ...child, parentThreadId: 'someone-else' }],
    [input, parent, { ...child, spawnParentThreadId: 'someone-else' }],
    [input, parent, { ...child, agentPath: '/root/gui_worker/nested' }],
  ]) {
    parentMetadata = changedParent; childMetadata = changedChild;
    assert.deepEqual(await handleQaHook(changedInput, deps), {});
  }
  assert.equal(existsSync(join(f.runDir, 'hook-events')), false);
  parentMetadata = parent; childMetadata = child;
  assert.deepEqual(await handleQaHook(input, deps), {});
  const log = readdirSync(join(f.runDir, 'hook-events')).map(n => JSON.parse(readFileSync(join(f.runDir, 'hook-events', n))));
  assert.equal(log.length, 1);
  assert.equal(log[0].type, 'worker-stop');
  assert.equal(log[0].agentId, 'child');
  assert.deepEqual(log[0].caller, { sessionId: 'child', kind: 'child', parentSessionId: 'root', agentPath: '/root/gui_worker' });
});
test('SubagentStop attribution regression fails when child transcript handling is skipped', () => {
  const directory = mkdtempSync(join(tmpdir(), 'teamqa-child-stop-'));
  try {
    const hookUrl = new URL('../scripts/hooks/qa-lifecycle.mjs', import.meta.url);
    const original = readFileSync(hookUrl, 'utf8');
    const needle = "if (input.hook_event_name === 'SubagentStop') {";
    assert.equal(original.split(needle).length - 1, 1);
    const mutant = original.replace(needle, 'if (false) {')
      .replace(/from '(\.\.\/lib\/[^']+)'/g, (_, relative) => `from '${new URL(relative, hookUrl).href}'`);
    const mutantUrl = pathToFileURL(join(directory, 'qa-lifecycle-mutant.mjs'));
    writeFileSync(mutantUrl, mutant);
    const check = moduleUrl => `import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleQaHook } from ${JSON.stringify(moduleUrl)};
const runDir=process.argv[1]; mkdirSync(runDir,{recursive:true});
writeFileSync(join(runDir,'roster.json'),JSON.stringify({roles:[{role:'test_manager',native_host:{session_id:'root',agent_path:'/root'}}]}));
await handleQaHook({hook_event_name:'SubagentStop',session_id:'root',agent_id:'child',turn_id:'turn1',transcript_path:'/trusted/root.jsonl',agent_transcript_path:'/trusted/child.jsonl'},
  {lookup:()=>({run_dir:runDir,run_id:'fixture',session_id:'root'}),readNativeMetadata:path=>path==='/trusted/root.jsonl'?{sessionId:'root'}:{sessionId:'child',parentThreadId:'root',spawnParentThreadId:'root',agentPath:'/root/worker'},verifyHost:()=>({session_id:'root',agent_path:'/root'})});
const rows=readdirSync(join(runDir,'hook-events')).filter(n=>n.endsWith('.event.json')).map(n=>JSON.parse(readFileSync(join(runDir,'hook-events',n))));
assert.equal(rows.length,1); assert.equal(rows[0].caller.kind,'child'); assert.equal(rows[0].caller.sessionId,'child');`;
    const run = (moduleUrl, suffix) => spawnSync(process.execPath, ['--input-type=module', '-e', check(moduleUrl), join(directory, suffix)], { encoding: 'utf8' });
    const control = run(hookUrl.href, 'control');
    assert.equal(control.status, 0, control.stderr);
    const changed = run(mutantUrl.href, 'mutant');
    assert.notEqual(changed.status, 0, 'parent-only ownership must fail the child attribution check');
  } finally {
    renameSync(directory, `${directory}-archive`);
  }
});
test('direct native child resolves the registered root for RPCs but its Stop only records child identity', async () => {
  const f = fixture(), rosterPath = join(f.runDir, 'roster.json');
  writeFileSync(rosterPath, JSON.stringify({ target: { preview_url: 'http://localhost:8888', version: 'a'.repeat(40) },
    roles: [{ role: 'test_manager', native_host: { session_id: 'root', agent_path: '/root' } }] }));
  const metadata = { sessionId: 'child', parentThreadId: 'root', spawnParentThreadId: 'root', agentPath: '/root/gui_worker' };
  const lookedUp = [];
  const deps = { ...f.deps, lookup: ({ sessionId }) => { lookedUp.push(sessionId); return sessionId === 'root' ? f.binding : null; },
    readNativeMetadata: path => { assert.equal(path, '/trusted/child.jsonl'); return metadata; },
    verifyHost: host => { assert.equal(host.session_id, 'root'); return { session_id: 'root', agent_path: '/root' }; },
    decide: () => { throw new Error('child Stop must not run continuation'); } };
  assert.deepEqual(await handleQaHook({ ...f.input, session_id: 'child', transcript_path: '/trusted/child.jsonl', hook_event_name: 'Stop', turn_id: 'child-turn' }, deps), {});
  assert.deepEqual(lookedUp, ['child', 'root']);
  let admission;
  const request = { method: 'session.create', params: { sessionId: 'qa-own', forbidSyntheticDOM: false } };
  await handleQaHook({ ...f.input, session_id: 'root', transcript_path: '/trusted/child.jsonl', hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: 'child-call', tool_input: request },
    { ...deps, inspect: args => { admission = args; return { allowed: true, requiresLive: false, mutating: false }; } });
  assert.equal(admission.session.owner, 'root');
  await handleQaHook({ ...f.input, session_id: 'root', transcript_path: '/trusted/child.jsonl', hook_event_name: 'PostToolUse', tool_name: tool,
    tool_use_id: 'child-call', tool_input: request, tool_response: { ok: true, result: { sessionId: 'qa-own', nonce: 'n', browserInstanceId: 'b',
      forbidSyntheticDOM: false, policy: { requireTrusted: true, allowedInput: ['pointer', 'key'] } } } }, deps);
  const log = readdirSync(join(f.runDir, 'hook-events')).map(n => JSON.parse(readFileSync(join(f.runDir, 'hook-events', n))));
  const stop = log.find(e => e.type === 'worker-stop');
  assert.equal(stop.caller.sessionId, 'child'); assert.equal(stop.caller.parentSessionId, 'root'); assert.equal(stop.caller.agentPath, '/root/gui_worker');
  assert.equal(log.find(e => e.type === 'dragon-admission').caller.sessionId, 'child');
  assert.equal(log.find(e => e.type === 'dragon-result').caller.sessionId, 'child');
});
test('child parent metadata, direct-child path and registered host must all agree', async () => {
  const f = fixture();
  writeFileSync(join(f.runDir, 'roster.json'), JSON.stringify({ target: { preview_url: 'http://localhost:8888', version: 'a'.repeat(40) },
    roles: [{ role: 'test_manager', native_host: { session_id: 'root', agent_path: '/root' } }] }));
  let metadata = { sessionId: 'child', parentThreadId: 'root', spawnParentThreadId: 'root', agentPath: '/root/gui_worker' }, lookedUp = [];
  const deps = { ...f.deps, lookup: ({ sessionId }) => { lookedUp.push(sessionId); return sessionId === 'root' ? f.binding : null; },
    readNativeMetadata: () => metadata, verifyHost: () => ({ session_id: 'root', agent_path: '/root' }) };
  for (const changed of [
    { ...metadata, parentThreadId: 'other' },
    { ...metadata, spawnParentThreadId: 'other' },
    { ...metadata, agentPath: '/root/gui_worker/nested' },
  ]) {
    metadata = changed;
    assert.deepEqual(await handleQaHook({ ...f.input, session_id: 'child', transcript_path: '/trusted/child.jsonl', hook_event_name: 'Stop', last_assistant_message: 'register root' }, deps), {});
  }
  assert.deepEqual(lookedUp, ['child', 'child', 'child', 'root']);
});
test('native hook metadata reader rejects transcripts outside the trusted Codex sessions tree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-native-hook-source-'));
  const sessions = join(dir, 'sessions');
  mkdirSync(sessions);
  const hookUrl = new URL('../scripts/hooks/qa-lifecycle.mjs', import.meta.url);
  const original = readFileSync(hookUrl, 'utf8');
  const anchor = "realpathSync(join(homedir(), '.codex/sessions'))";
  assert.ok(original.includes(anchor));
  const isolatedUrl = pathToFileURL(join(dir, 'qa-lifecycle.mjs'));
  writeFileSync(isolatedUrl, original.replace(anchor, `realpathSync(${JSON.stringify(sessions)})`)
    .replace(/from '(\.\.\/lib\/[^']+)'/g, (_, relative) => `from '${new URL(relative, hookUrl).href}'`));
  const { readNativeHookMetadata } = await import(isolatedUrl.href);
  const transcript = JSON.stringify({ type: 'session_meta', payload: { id: 'fixture-child' } }) + '\n';
  const trusted = join(sessions, 'child.jsonl'), outside = join(dir, 'outside.jsonl');
  writeFileSync(trusted, transcript);
  writeFileSync(outside, transcript);
  assert.equal(readNativeHookMetadata(trusted).sessionId, 'fixture-child');
  assert.throws(() => readNativeHookMetadata(outside), /NATIVE_HOOK_SOURCE_UNTRUSTED/);
  const fd=openSync(trusted,'a');try{const row=`{"padding":"${'x'.repeat(65500)}"}\n`;for(let i=0;i<520;i++)writeSync(fd,row);}finally{closeSync(fd);}
  const originalRead=fs.readFileSync;
  try{
    fs.readFileSync=(path,...args)=>{if(String(path)===trusted)throw Error('whole transcript read');return originalRead(path,...args);};
    syncBuiltinESMExports();
    assert.equal(readNativeHookMetadata(trusted).sessionId,'fixture-child');
  }finally{fs.readFileSync=originalRead;syncBuiltinESMExports();}
});
test('live policy readback binds the effective policy and rejects expiry or policy drift', () => {
  const session = { sessionId: 'qa-own', nonce: 'n', browserInstanceId: 'b', tabId: 4, forbidSyntheticDOM: false,
    policy: { requireTrusted: true, forbidSyntheticDOM: false, allowedInput: ['pointer', 'key'], expiry: null, setAt: 1, locked: false } };
  const actual = { ok: true, result: { expired: false,
    policy: { requireTrusted: true, forbidSyntheticDOM: false, allowedInput: ['pointer', 'key'], expiry: null, setAt: 1, locked: true } } };
  assert.equal(livePolicyMatches(actual, session), true);
  for (const mutate of [x => { x.result.expired = true; }, x => { x.result.policy.forbidSyntheticDOM = true; },
    x => { x.result.policy.requireTrusted = false; }, x => { x.result.policy.setAt = 2; }, x => { x.ok = false; },
    x => { x.result.ok = false; },
    x => { x.result = { ...x.result, ok: false }; }]) {
    const changed = structuredClone(actual); mutate(changed);
    assert.equal(livePolicyMatches(changed, session), false);
  }
});
test('candidate definition pins isolated provider paths without activating hooks', () => {
  const definition = hookDefinition({ registryDir: '/tmp/qa registry', qaGuiRoot: '/tmp/isolated gui', allowLocalCandidate: true });
  assert.deepEqual(Object.keys(definition.hooks), ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Interrupt']);
  assert.match(definition.hooks.Stop[0].hooks[0].command, /TEAMQA_QA_GUI_ROOT='\/tmp\/isolated gui'/);
  assert.match(definition.hooks.Stop[0].hooks[0].command, /TEAMQA_ALLOW_LOCAL_CANDIDATE=yes/);
  assert.equal(definition.hooks.Interrupt[0].hooks[0].timeout, 3);
});
test('bad create is denied before invocation; valid response binds next request', async () => {
  const f = fixture(), request = { method: 'session.create', params: { sessionId: 'qa-own', forbidSyntheticDOM: false } };
  const bad = structuredClone(request); bad.params.forbidSyntheticDOM = true;
  const denied = await handleQaHook(pre(f, 'bad', bad), f.deps);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await handleQaHook(pre(f, 'create', request), f.deps), {});
  assert.equal((await handleQaHook(pre(f, 'create', request), f.deps)).hookSpecificOutput.permissionDecision, 'deny');
  await handleQaHook(post(f, 'create', request, { sessionId: 'qa-own', nonce: 'n', browserInstanceId: 'b', forbidSyntheticDOM: false, policy: { requireTrusted: true, allowedInput: ['pointer', 'key'] } }), f.deps);
  const open = { method: 'openTab', params: { sessionId: 'qa-own', nonce: 'n', browserInstanceId: 'b', url: 'http://localhost:8888', active: false } };
  assert.deepEqual(await handleQaHook(pre(f, 'open', open), f.deps), {});
  const collision = await handleQaHook(pre(f, 'open-again', open), f.deps);
  assert.equal(collision.hookSpecificOutput.permissionDecisionReason, 'DRAGON_INPUT_IN_FLIGHT');
});
test('receipt-backed close passes the live gate and a confirmed close ends the session', async () => {
  const f = fixture();
  const create = { method: 'session.create', params: { sessionId: 'qa-own', forbidSyntheticDOM: false } };
  await handleQaHook(pre(f, 'create', create), f.deps);
  await handleQaHook(post(f, 'create', create, { sessionId: 'qa-own', nonce: 'n', browserInstanceId: 'b', forbidSyntheticDOM: false,
    policy: { requireTrusted: true, allowedInput: ['pointer', 'key'] } }), f.deps);
  const close = { method: 'session.close', params: { sessionId: 'qa-own', nonce: 'n', browserInstanceId: 'b' } };
  let liveChecked = false;
  assert.deepEqual(await handleQaHook(pre(f, 'close', close), { ...f.deps, live: () => { liveChecked = true; return true; } }), {});
  assert.equal(liveChecked, true);
  await handleQaHook(post(f, 'close', close, { ok: true }), f.deps);
  assert.equal((await handleQaHook(pre(f, 'close-again', close), f.deps)).hookSpecificOutput.permissionDecisionReason, 'DRAGON_SESSION_CLOSED');
});
test('stale session rejects operation and failed nested response cannot prove creation', async () => {
  const f = fixture(), request = { method: 'session.create', params: { sessionId: 'qa-own', forbidSyntheticDOM: false } };
  await handleQaHook(pre(f, 'create', request), f.deps);
  await handleQaHook(post(f, 'create', request, { ok: false, error: 'timeout' }), f.deps);
  const logs = readdirSync(join(f.runDir, 'hook-events')).filter(n => n.endsWith('.event.json')).map(n => JSON.parse(readFileSync(join(f.runDir, 'hook-events', n))));
  assert.equal(logs.find(e => e.type === 'dragon-result').confirmed, false);
  const result = await handleQaHook(pre(f, 'other', { method: 'read', params: {} }), { ...f.deps, inspect: () => ({ allowed: true, requiresLive: true, mutating: false }), live: () => false });
  assert.equal(result.hookSpecificOutput.permissionDecisionReason, 'DRAGON_SESSION_STALE');
});
test('Stop continues root on actual outstanding work; active Stop does not bypass', async () => {
  const f = fixture(); let completed = false;
  const deps = { ...f.deps, decide: () => ({ ...decideContinuation({ cases: [{ id: 'C1' }], records: completed ? [{ case_id: 'C1', verdict: 'pass' }] : [], complete: completed }), runId: 'demo', progress: completed ? 'done' : 'none' }) };
  const stop = { ...f.input, hook_event_name: 'Stop', last_assistant_message: 'Done', stop_hook_active: true };
  assert.equal((await handleQaHook(stop, deps)).decision, 'block');
  completed = true;
  assert.deepEqual(await handleQaHook({ ...stop, turn_id: 'turn2' }, deps), {});
});
test('no-progress cap survives changed turn IDs and board chatter; independent case continues', async () => {
  const f = fixture();
  const deps = { ...f.deps, decide: ({ exhausted = [] }) => ({ ...decideContinuation({ cases: [{ id: 'C1' }, { id: 'C2' }], exhausted }), runId: 'demo', progress: 'unchanged' }) };
  for (let n = 1; n <= 3; n++) assert.match((await handleQaHook({ ...f.input, turn_id: `t${n}`, hook_event_name: 'Stop', last_assistant_message: `board ${n}/453`, stop_hook_active: true }, deps)).reason, /C1/);
  assert.match((await handleQaHook({ ...f.input, turn_id: 't4', hook_event_name: 'Stop', stop_hook_active: true }, deps)).reason, /C2/);
});
test('Interrupt wins; worker stop never launches another worker turn', async () => {
  const f = fixture(), deps = { ...f.deps, decide: () => { throw new Error('must not run'); } };
  await handleQaHook({ ...f.input, hook_event_name: 'Interrupt' }, deps);
  assert.deepEqual(await handleQaHook({ ...f.input, hook_event_name: 'Stop' }, deps), {});
  assert.deepEqual(await handleQaHook({ ...f.input, hook_event_name: 'SubagentStop', agent_id: 'worker' }, deps), {});
});
test('new progress on another case cannot renew the exhausted branch budget', async () => {
  const f = fixture(); let progress = 'before';
  const deps = { ...f.deps, decide: ({ exhausted = [] }) => ({ ...decideContinuation({ cases: [{ id: 'C1' }, { id: 'C2' }], exhausted }), runId: 'demo', progress, progressByCase: { C1: 'same', C2: progress } }) };
  for (let n = 1; n <= 3; n++) await handleQaHook({ ...f.input, turn_id: `t${n}`, hook_event_name: 'Stop' }, deps);
  progress = 'new verified case';
  const result = await handleQaHook({ ...f.input, turn_id: 't4', hook_event_name: 'Stop' }, deps);
  assert.match(result.reason, /"caseId": "C2"/);
});
test('pending worker waits use elapsed roster budget rather than three Stop events', async () => {
  const f = fixture(); let time = Date.now();
  const deps = { ...f.deps, now: () => time, decide: ({ exhausted = [] }) => ({ ...decideContinuation({ cases: [{ id: 'C1', work: { state: 'running', workerSessionId: 'worker' } }], exhausted }), runId: 'demo', progress: 'unchanged' }) };
  for (let n = 1; n <= 4; n++) {
    const result = await handleQaHook({ ...f.input, turn_id: `t${n}`, hook_event_name: 'Stop' }, deps);
    assert.match(result.reason, /WORKER_PENDING/); time += 1000;
  }
  time += 120000;
  // The last message starts with the WAIT marker; the legacy marker earlier versions told the agent to write (written
  // as escapes) is accepted too.
  const result = await handleQaHook({ ...f.input, turn_id: 't5', hook_event_name: 'Stop', last_assistant_message: 'NOT COMPLETE: all remaining work is blocked' }, deps);
  assert.equal(result.decision, undefined); assert.match(result.systemMessage, /QA NOT COMPLETE: ALL_REMAINING_WORK_BLOCKED/);
  const legacy = await handleQaHook({ ...f.input, turn_id: 't6', hook_event_name: 'Stop', last_assistant_message: 'CH\u01afA HO\u00c0N TH\u00c0NH' }, deps);
  assert.equal(legacy.decision, undefined); assert.match(legacy.systemMessage, /ALL_REMAINING_WORK_BLOCKED/);
});
// M3: hooks of parallel tool calls read the run's hook events while another hook writes one. A torn event file was
// JSON_INVALID, which refused a valid call.
test('a parallel hook never reads a half-written event file', async () => {
  const { splitWrites } = await import('./support/split-writes.mjs');
  const f = fixture(), dir = join(f.runDir, 'hook-events');
  mkdirSync(dir, { recursive: true });
  const parallel = [];
  const read = { method: 'session.list', params: { sessionId: 'qa-own' } };
  const deps = { ...f.deps, inspect: () => ({ allowed: true, requiresLive: false, mutating: false }) };
  let started = 0;
  const restore = splitWrites(dir, () => { if (started < 3) { const id = `parallel-${started++}`; parallel.push(handleQaHook(pre(f, id, read), deps).catch(error => ({ error: error.code || error.message }))); } });
  let first;
  try { first = await handleQaHook(pre(f, 'first', read), deps); }
  finally { restore(); }
  assert.deepEqual(first, {});
  const results = await Promise.all(parallel);
  assert.ok(results.length > 0, 'a parallel hook ran during the write');
  for (const result of results) assert.deepEqual(result, {}, JSON.stringify(result));
});
// N9: Claude Code sends last_assistant_message on every Stop, so the one-correction guard has to hold for it too, and a
// WAIT report that starts with the marker in markdown emphasis is a WAIT report.
test('a WAIT report in markdown emphasis passes, and a report that misses the marker is blocked at most once per code', async () => {
  const f = fixture();
  const deps = { ...f.deps, decide: () => ({ disposition: 'WAIT', code: 'GUI_BLOCKED', runId: 'demo', next: null }) };
  const stop = (turn, message, active = false) => handleQaHook({ ...f.input, turn_id: turn, hook_event_name: 'Stop', last_assistant_message: message, stop_hook_active: active }, deps);
  for (const [turn, message] of [['b1', '**NOT COMPLETE**: the GUI lane is blocked'], ['b2', '## NOT COMPLETE\nblocked'], ['b3', '_NOT COMPLETE_ - blocked'], ['b4', '> **NOT COMPLETE:** blocked']]) {
    const output = await stop(turn, message);
    assert.equal(output.decision, undefined, message);
    assert.match(output.systemMessage, /QA NOT COMPLETE: GUI_BLOCKED/);
  }
  const lead = 'Here is where the run stands.\n\nNOT COMPLETE: the GUI lane is blocked';
  assert.equal((await stop('l1', lead)).decision, 'block');
  const repeat = await stop('l1', lead, true);
  assert.equal(repeat.decision, undefined);
  assert.match(repeat.systemMessage, /GUI_BLOCKED/);
  assert.equal((await stop('l1', 'Still blocked, as reported above.', true)).decision, undefined);
  // Another blocked code gets its own single correction.
  const other = { ...deps, decide: () => ({ disposition: 'WAIT', code: 'BOARD_BLOCKED', runId: 'demo', next: null }) };
  assert.equal((await handleQaHook({ ...f.input, turn_id: 'l2', hook_event_name: 'Stop', last_assistant_message: 'Done.', stop_hook_active: true }, other)).decision, 'block');
  assert.equal((await handleQaHook({ ...f.input, turn_id: 'l2', hook_event_name: 'Stop', last_assistant_message: 'Done!', stop_hook_active: true }, other)).decision, undefined);
});
// M7: a Dragon input that never got its PostToolUse (the user pressed No, or the turn was interrupted) used to block every
// later Dragon input of the run with DRAGON_INPUT_IN_FLIGHT.
test('an input left in flight stops blocking after a Stop or Interrupt of its turn, or after the bounded time', async () => {
  const f = fixture(); let clock = Date.parse('2026-11-04T08:00:00Z');
  const deps = { ...f.deps, now: () => clock, inspect: () => ({ allowed: true, requiresLive: false, mutating: true }),
    decide: () => ({ disposition: 'COMPLETE', code: 'RUN_COMPLETE_VERIFIED', runId: 'demo', next: null, progress: 'p' }) };
  const click = { method: 'trustedClick', params: { selector: '#save' } };
  const reason = output => output.hookSpecificOutput?.permissionDecisionReason;
  const dir = join(f.runDir, 'hook-events');
  const abandoned = () => readdirSync(dir).filter(n => n.endsWith('.input-abandoned.json')).map(n => JSON.parse(readFileSync(join(dir, n))));
  assert.deepEqual(await handleQaHook(pre(f, 'c1', click), deps), {});
  clock += 1000;
  assert.equal(reason(await handleQaHook(pre(f, 'c2', click), deps)), 'DRAGON_INPUT_IN_FLIGHT', 'a real in-flight input still blocks');
  // c1 never gets a PostToolUse; its turn ends.
  clock += 1000;
  await handleQaHook({ ...f.input, hook_event_name: 'Stop', last_assistant_message: 'Paused for the user.' }, deps);
  clock += 1000;
  assert.deepEqual(await handleQaHook(pre(f, 'c3', click), deps), {});
  assert.deepEqual(abandoned().map(row => row.toolUseId), ['c1']);
  const admission = readdirSync(dir).filter(n => n.endsWith('.event.json')).map(n => JSON.parse(readFileSync(join(dir, n)))).find(e => e.type === 'dragon-admission' && e.toolUseId === 'c3');
  assert.equal(admission.supersedes.toolUseId, 'c1');
  assert.equal(admission.supersedes.reason, 'STOP_AFTER_INPUT');
  // c3 is in flight; a Stop of another turn does not release it, the bounded time does.
  clock += 1000;
  await handleQaHook({ ...f.input, turn_id: 'other-turn', hook_event_name: 'Stop', last_assistant_message: 'x' }, deps);
  assert.equal(reason(await handleQaHook(pre(f, 'c4', click), deps)), 'DRAGON_INPUT_IN_FLIGHT');
  clock += 10 * 60 * 1000;
  assert.deepEqual(await handleQaHook(pre(f, 'c5', click), deps), {});
  assert.deepEqual(abandoned().map(row => row.toolUseId).sort(), ['c1', 'c3']);
  // An Interrupt of the turn releases c5.
  clock += 1000;
  await handleQaHook({ ...f.input, hook_event_name: 'Interrupt' }, deps);
  clock += 1000;
  assert.deepEqual(await handleQaHook(pre(f, 'c6', click), deps), {});
  // A completed input is not abandoned.
  await handleQaHook(post(f, 'c6', click, { ok: true }), deps);
  assert.deepEqual(await handleQaHook(pre(f, 'c7', click), deps), {});
  assert.deepEqual(abandoned().map(row => row.toolUseId).sort(), ['c1', 'c3', 'c5']);
});
// M10: a hook staged with Node's Homebrew Cellar path stopped silently after `brew upgrade` removed that version.
test('a staged hook names Node by the Homebrew path that survives an upgrade', async () => {
  const { chmodSync, realpathSync, symlinkSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const brew = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-brew-')));
  const node = (formula, version) => { const path = join(brew, 'Cellar', formula, version, 'bin', 'node'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ''); chmodSync(path, 0o755); return path; };
  const command = nodePath => hookDefinition({ registryDir: '/tmp/qa-registry', nodePath, qaGuiRoot: undefined, allowLocalCandidate: false }).hooks.Stop[0].hooks[0].command;
  mkdirSync(join(brew, 'opt'), { recursive: true });
  const current = node('node', '22.11.0');
  symlinkSync(join('..', 'Cellar', 'node', '22.11.0'), join(brew, 'opt', 'node'));
  assert.ok(command(current).startsWith(`'${join(brew, 'opt', 'node', 'bin', 'node')}' `), command(current));
  const pinned = node('node@20', '20.18.1');
  symlinkSync(join('..', 'Cellar', 'node@20', '20.18.1'), join(brew, 'opt', 'node@20'));
  assert.ok(command(pinned).startsWith(`'${join(brew, 'opt', 'node@20', 'bin', 'node')}' `), command(pinned));
  // No opt link: the prefix's bin link; neither: the path stays as given.
  const orphan = node('node@18', '18.20.4');
  assert.ok(command(orphan).startsWith(`'${orphan}' `));
  mkdirSync(join(brew, 'bin'), { recursive: true }); symlinkSync(orphan, join(brew, 'bin', 'node'));
  assert.ok(command(orphan).startsWith(`'${join(brew, 'bin', 'node')}' `));
  assert.ok(command('/usr/bin/node').startsWith("'/usr/bin/node' "));
  assert.throws(() => command('node'), /HOOK_ABSOLUTE_PATH_REQUIRED/);
});
