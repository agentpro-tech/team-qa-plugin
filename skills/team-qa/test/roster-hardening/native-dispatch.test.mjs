import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { approveRoster, dispatchRole, selectRoster } from '../../scripts/lib/roster.mjs';
import { prepareNativeRole, assertNativeAttestationBinding } from '../../scripts/lib/native-dispatch.mjs';
import { collectCatalog } from '../../scripts/lib/catalog.mjs';
import * as native from '../../scripts/lib/native-dispatch.mjs';
import { stableJson, sha256 } from '../../scripts/lib/core.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const fixture=join(root,'test/roster-dynamic');
const catalogPath=join(fixture,'catalog-openai-v1.json');
const promptPath=join(fixture,'request-default.json');
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
const hashFile=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function assertCode(fn,code){assert.throws(fn,error=>error?.code===code,`expected ${code}`);}

test('native prepare fails before writing any intent when the roster is unapproved',async()=>{
  const runDir=mkdtempSync(join(tmpdir(),'native-unapproved-'));
  const out=join(runDir,'requested-output.json');
  await assert.rejects(prepareNativeRole({runDir,role:'test_manager',prompt:promptPath,out}),error=>error?.code==='ROSTER_NOT_APPROVED');
  assert.equal(existsSync(out),false);
  assert.equal(existsSync(join(runDir,'native-dispatch')),false);
});

test('native prepare refuses an approved roster bound to the CLI harness',async()=>{
  const runDir=mkdtempSync(join(tmpdir(),'native-wrong-harness-'));
  const catalog=readJson(catalogPath),request=readJson(join(fixture,'request-default.json'));
  request.run_id=basename(runDir);
  const roster=selectRoster({catalog,request,catalogPath});
  const rosterFile=join(runDir,'roster.json');writeFileSync(rosterFile,`${JSON.stringify(roster,null,2)}\n`);
  const event={schema:'team-qa/roster-user-event/v1',id:'fixture-only-approval',actor:'user',text:'I approve this fixture roster for the fixture test.',run_id:roster.run_id,round:roster.round,roster_hash:hashFile(rosterFile),source:{}};
  await approveRoster({runDir,file:rosterFile,userEvent:event});

  const out=join(runDir,'requested-output.json');
  await assert.rejects(prepareNativeRole({runDir,role:'test_manager',prompt:promptPath,out}),error=>error?.code==='NATIVE_HARNESS_REQUIRED');
  assert.equal(existsSync(out),false);
  assert.equal(existsSync(join(runDir,'native-dispatch','test_manager.json')),false);
});

test('native catalog rejects an outside-session host source without treating it as runtime identity',()=>{
  assertCode(()=>collectCatalog({provider:'openai',harness:'codex-native',hostSourcePath:import.meta.url.startsWith('file:')?fileURLToPath(import.meta.url):''}),'NATIVE_HOST_UNTRUSTED');
});

test('approved fixture CLI dispatch remains available and always returns ungraded proof',async()=>{
  const runDir=mkdtempSync(join(tmpdir(),'native-legacy-fixture-dispatch-'));
  const catalog=readJson(catalogPath),request=readJson(join(fixture,'request-default.json'));
  request.run_id=basename(runDir);
  const roster=selectRoster({catalog,request,catalogPath});
  const rosterFile=join(runDir,'roster.json');writeFileSync(rosterFile,`${JSON.stringify(roster,null,2)}\n`);
  const event={schema:'team-qa/roster-user-event/v1',id:'fixture-only-approval',actor:'user',text:'I approve this fixture roster for the fixture test.',run_id:roster.run_id,round:roster.round,roster_hash:hashFile(rosterFile),source:{}};
  await approveRoster({runDir,file:rosterFile,userEvent:event});

  const out=join(runDir,'receipt.json');
  const receipt=await dispatchRole({runDir,role:'test_manager',prompt:promptPath,out});
  assert.equal(receipt.schema,'team-qa/role-attestation/v1');
  assert.equal(receipt.graded,false);
  assert.equal(receipt.source.kind,'fixture');
  assert.equal(receipt.session_id,null);
  assert.equal(receipt.agent_id,null);
});

test('native proof binds its original intent and seat before source inspection',()=>{
  const intent={run_id:'fixture-native',round:1,roster_hash:'fixture-hash',role:'analyst',spawn:{model:'gpt-6-luna',reasoning_effort:'high'}};
  const seat={role:'analyst',provider:'openai',model:'gpt-6-luna',effort:'high',harness:'codex-native',harness_version:'0.159.2',context:[{path:'fixture-context',sha256:'fixture-hash'}]};
  const a={...intent,agent_id:'codex-native:fixture-session',session_id:'fixture-session',runtime:{provider:'openai',model:seat.model,effort:seat.effort,harness:seat.harness,version:seat.harness_version,sent:{model:seat.model,effort:seat.effort},observed:{model:seat.model,effort:seat.effort,session_id:'fixture-session'}},context:seat.context,source:{kind:'codex-native'}};
  delete a.spawn;
  assert.doesNotThrow(()=>assertNativeAttestationBinding(a,{intent,seat}));
  for(const role of ['designer','executor_code','executor_gui'])assertCode(()=>assertNativeAttestationBinding({...a,role},{intent,seat:{...seat,role}}),'NATIVE_ATTESTATION_BINDING');
  for(const key of ['run_id','round','roster_hash'])assertCode(()=>assertNativeAttestationBinding({...a,[key]:'changed'},{intent,seat}),'NATIVE_ATTESTATION_BINDING');
  for(const key of ['provider','model','effort','harness','version'])assertCode(()=>assertNativeAttestationBinding({...a,runtime:{...a.runtime,[key]:'changed'}},{intent,seat}),'NATIVE_ATTESTATION_HARNESS');
  assertCode(()=>assertNativeAttestationBinding(a,{intent,seat:{...seat,harness:'codex'}}),'NATIVE_ATTESTATION_HARNESS');
  assertCode(()=>assertNativeAttestationBinding({...a,context:[]},{intent,seat}),'NATIVE_ATTESTATION_CONTEXT');
  assertCode(()=>assertNativeAttestationBinding({...a,agent_id:'forged'},{intent,seat}),'NATIVE_ATTESTATION_RUNTIME');
  assertCode(()=>assertNativeAttestationBinding({...a,runtime:{...a.runtime,observed:{...a.runtime.observed,session_id:'other'}}},{intent,seat}),'NATIVE_ATTESTATION_RUNTIME');
});

test('native retry attestation binds its immutable attempt identity and previous intent/attestation hashes',()=>{
  const previous='a'.repeat(64),previousIntent='c'.repeat(64),intent={run_id:'fixture-native',round:1,roster_hash:'fixture-hash',role:'analyst',dispatch_attempt_id:'attempt_0002',dispatch_attempt_seq:2,dispatch_previous_sha256:previous,dispatch_previous_intent_sha256:previousIntent,spawn:{model:'gpt-6-luna',reasoning_effort:'high'}};
  const seat={role:'analyst',provider:'openai',model:'gpt-6-luna',effort:'high',harness:'codex-native',harness_version:'0.159.2',context:[{path:'fixture-context',sha256:'fixture-hash'}]};
  const chain=sha256(`${previous}\n${previousIntent}\nattempt_0002\n${sha256(stableJson(intent))}`);
  const a={schema:'team-qa/role-attestation/v2',...intent,agent_id:'codex-native:child',session_id:'child',runtime:{provider:'openai',model:seat.model,effort:seat.effort,harness:seat.harness,version:seat.harness_version,sent:{model:seat.model,effort:seat.effort},observed:{model:seat.model,effort:seat.effort,session_id:'child'}},context:seat.context,source:{kind:'codex-native'},dispatch_chain_sha256:chain};
  assert.doesNotThrow(()=>assertNativeAttestationBinding(a,{intent,seat}));
  assertCode(()=>assertNativeAttestationBinding({...a,dispatch_attempt_id:'other'},{intent,seat}),'NATIVE_ATTESTATION_ATTEMPT_BINDING');
  assertCode(()=>assertNativeAttestationBinding({...a,dispatch_attempt_seq:3},{intent,seat}),'NATIVE_ATTESTATION_ATTEMPT_BINDING');
  assertCode(()=>assertNativeAttestationBinding({...a,dispatch_chain_sha256:'b'.repeat(64)},{intent,seat}),'NATIVE_ATTESTATION_ATTEMPT_BINDING');
});

test('native packet binds actual bytes to the approved context and original prompt',()=>{
  const runDir=mkdtempSync(join(tmpdir(),'native-context-packet-'));
  mkdirSync(join(runDir,'native-dispatch'));
  const path=join(runDir,'native-dispatch','analyst.context.md');
  const context='Approved role\n\nApproved skill\n',body='Read scoped facts; no product verdict.\n';
  const binding='TEAMQA_RUN_BINDING run=fixture round=1 role=analyst roster=locked';
  const bytes=binding+'\n'+context+'\n\n'+body;
  const digest=s=>createHash('sha256').update(s).digest('hex');
  const intent={run_id:'fixture',round:1,role:'analyst',roster_hash:'locked',context_packet_path:path,context_packet_sha256:digest(bytes),prompt_sha256:digest(body)};
  writeFileSync(path,bytes);
  assert.equal(typeof native.assertNativePacketBinding,'function');
  assert.doesNotThrow(()=>native.assertNativePacketBinding(intent,{runDir,context}));
  writeFileSync(path,bytes.replace('Approved role','Different role'));
  assertCode(()=>native.assertNativePacketBinding(intent,{runDir,context}),'NATIVE_PACKET_DRIFT');
  const forged={...intent,context_packet_sha256:hashFile(path)};
  assertCode(()=>native.assertNativePacketBinding(forged,{runDir,context}),'NATIVE_CONTEXT_DRIFT');
  writeFileSync(path,bytes+'Unapproved instructions');
  assertCode(()=>native.assertNativePacketBinding({...intent,context_packet_sha256:hashFile(path)},{runDir,context}),'NATIVE_CONTEXT_DRIFT');
  writeFileSync(path,bytes);
  assertCode(()=>native.assertNativePacketBinding({...intent,context_packet_sha256:'bad'},{runDir,context}),'NATIVE_PACKET_DRIFT');
  assertCode(()=>native.assertNativePacketBinding({...intent,context_packet_path:join(runDir,'different.context.md')},{runDir,context}),'NATIVE_PACKET_PATH');
});
