import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertNativeAttestationBinding} from '../../scripts/lib/native-dispatch.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const OLD = '0.100.0', NEW = '0.200.0';
const encode = rows => rows.map(JSON.stringify).join('\n') + '\n';
function fixture() {
  // Original host shapes under an isolated fake HOME, never live host evidence.
  const home = mkdtempSync(join(tmpdir(), 'teamqa-native-epoch-fixture-'));
  const sessions = join(home, '.codex/sessions/2026/10/07'); mkdirSync(sessions, {recursive: true});
  const parent = join(sessions, 'rollout-parent.jsonl'), child = join(sessions, 'rollout-child.jsonl');
  const rows = [
    {type: 'session_meta', payload: {id: 'fixture-parent', cli_version: OLD}},
    {type: 'turn_context', payload: {turn_id: 'earlier-turn', model: 'fixture-model', effort: 'medium'}},
    {type: 'response_item', payload: {type: 'message', role: 'assistant', channel: 'commentary', content: [{type: 'output_text', text: 'Fixture prepare'}]}},
    {type: 'turn_context', payload: {turn_id: 'creation-turn', model: 'fixture-model', effort: 'medium'}},
    {type: 'response_item', payload: {type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'fixture-spawn', arguments: '{}'}},
    {type: 'turn_context', payload: {turn_id: 'later-turn', model: 'fixture-model', effort: 'medium'}},
  ];
  writeFileSync(parent, encode(rows));
  writeFileSync(child, encode([{type: 'session_meta', payload: {id: 'fixture-child', cli_version: NEW,
    source: {subagent: {thread_spawn: {parent_thread_id: 'fixture-parent', agent_path: '/root/fixture_qa'}}}}}]));
  return {home, parent, child, rows, parentSource: {path: parent, line: 5, sha256: hash(JSON.stringify(rows[4]))}};
}
function runHost(f, mode = 'positive') {
  const code = `
    import {nativeHostSource,nativeCreationEpoch} from ${JSON.stringify(join(ROOT, 'scripts/lib/native-host.mjs'))};
    import {readFileSync,writeFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    const [parent,child,refJson,mode]=process.argv.slice(1),ref=JSON.parse(refJson);
    const host=nativeHostSource(parent);
    if(mode==='wrong-parent')ref.path=child;
    if(mode==='wrong-hash')ref.sha256='0'.repeat(64);
    if(mode==='missing-context'){
      const rows=readFileSync(parent,'utf8').trimEnd().split('\\n').map(JSON.parse).filter(x=>x.type!=='turn_context');
      writeFileSync(parent,rows.map(JSON.stringify).join('\\n')+'\\n');
      ref.line=rows.length;ref.sha256=createHash('sha256').update(JSON.stringify(rows.at(-1))).digest('hex');
    }
    if(mode==='untrusted-child'){
      const outside=process.env.HOME+'/outside-child.jsonl';writeFileSync(outside,readFileSync(child));
      try{nativeCreationEpoch({childSourcePath:outside,parentSource:ref,host});process.stdout.write(JSON.stringify({accepted:true}));}
      catch(e){process.stdout.write(JSON.stringify({code:e.code}));}process.exit(0);
    }
    try{process.stdout.write(JSON.stringify({epoch:nativeCreationEpoch({childSourcePath:child,parentSource:ref,host})}));}
    catch(e){process.stdout.write(JSON.stringify({code:e.code}));}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.parent, f.child, JSON.stringify(f.parentSource), mode],
    {env: {...process.env, HOME: f.home}, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
test('native creation epoch uses child version and nearest parent turn before spawn', () => {
  const f = fixture(), result = runHost(f);
  assert.deepEqual(result.epoch, {child_version: NEW, parent_origin_version: OLD,
    parent_turn_source: {line: 4, sha256: hash(JSON.stringify(f.rows[3])), turn_id: 'creation-turn'}});
  assert.notEqual(result.epoch.child_version, result.epoch.parent_origin_version);
});
test('epoch rejects wrong parent path/hash, missing turn and untrusted child source', () => {
  for (const [mode, code] of [['wrong-parent', 'NATIVE_PARENT_SOURCE_MISMATCH'], ['wrong-hash', 'NATIVE_PARENT_SOURCE_HASH_MISMATCH'],
    ['missing-context', 'NATIVE_RUNTIME_EPOCH_MISSING'], ['untrusted-child', 'NATIVE_HOST_UNTRUSTED']]) {
    assert.equal(runHost(fixture(), mode).code, code, mode);
  }
});
function binding() {
  const intent = {run_id: 'fixture-run', round: 1, roster_hash: 'a'.repeat(64), role: 'analyst', spawn: {model: 'fixture-model', reasoning_effort: 'medium'}};
  const seat = {role: 'analyst', provider: 'openai', harness: 'codex-native', harness_version: OLD, model: 'fixture-model', effort: 'medium',
    native_host: {version: OLD}, context: [{path: 'fixture-context.md', sha256: 'b'.repeat(64)}]};
  const a = {...intent, agent_id: 'codex-native:fixture-child', session_id: 'fixture-child', context: seat.context,
    runtime: {provider: 'openai', harness: 'codex-native', version: NEW, origin_version: OLD, model: seat.model, effort: seat.effort,
      sent: {model: seat.model, effort: seat.effort}, observed: {model: seat.model, effort: seat.effort, session_id: 'fixture-child'}},
    source: {kind: 'codex-native', metadata_source: {native: {child_version: NEW, parent_origin_version: OLD,
      parent_turn_source: {line: 4, sha256: 'c'.repeat(64), turn_id: 'creation-turn'}}}}};
  return {a, intent, seat};
}
test('attestation binds differing child and parent creation versions with explicit epoch proof', () => {
  const {a, intent, seat} = binding(); assert.doesNotThrow(() => assertNativeAttestationBinding(a, {intent, seat}));
});
test('attestation rejects tampered child version, parent origin and missing epoch', () => {
  for (const mutate of [
    a => {a.runtime.version = '0.300.0';}, a => {a.source.metadata_source.native.child_version = '0.300.0';},
    a => {a.runtime.origin_version = '0.300.0';}, a => {a.source.metadata_source.native.parent_origin_version = '0.300.0';},
    a => {delete a.source.metadata_source.native;},
    a => {a.runtime.version = OLD; delete a.runtime.origin_version;},
  ]) {
    const {a, intent, seat} = binding(); mutate(a); assert.throws(() => assertNativeAttestationBinding(a, {intent, seat}), undefined, String(mutate));
  }
});
test('legacy same-version native attestation remains bound', () => {
  const {a, intent, seat} = binding(); a.runtime.version = OLD; delete a.runtime.origin_version; delete a.source.metadata_source;
  assert.doesNotThrow(() => assertNativeAttestationBinding(a, {intent, seat}));
});
