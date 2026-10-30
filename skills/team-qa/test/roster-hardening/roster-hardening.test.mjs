import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { approveRoster, extractHumanText, selectRoster } from '../../scripts/lib/roster.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const fixture=join(root,'test/roster-dynamic');
const catalogPath=join(fixture,'catalog-openai-v1.json');
const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
const hashFile=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function runtimeInputs(){
  const catalog=readJson(catalogPath);catalog.source={kind:'runtime',reference:'test runtime catalog fixture'};catalog.collected_at=new Date().toISOString();
  const request=readJson(join(fixture,'request-default.json'));
  return {catalog,request};
}
function assertCode(fn,code){assert.throws(fn,error=>error?.code===code,`expected ${code}`);}
function validUserEvent(text='I approve this fixture run.'){
  return {id:'event-test',actor:'user',text,source:{path:catalogPath,sha256:'a'.repeat(64),line:1}};
}

test('runtime catalog older than fifteen minutes is rejected',()=>{
  const {catalog,request}=runtimeInputs();
  catalog.collected_at=new Date(Date.now()-15*60*1000-1).toISOString();
  assertCode(()=>selectRoster({catalog,request,catalogPath}),'CATALOG_STALE');
});

test('delayed runtime approval preserves human and drift gates without expiring the proposal',async()=>{
  const {catalog,request}=runtimeInputs();
  for(const model of catalog.models)model.quality_evidence={fit_review:'source-reviewed'};
  const roster=selectRoster({catalog,request,catalogPath});
  roster.catalog_collected_at=new Date(Date.now()-60*60*1000).toISOString();
  const runDir=mkdtempSync(join(tmpdir(),'roster-delayed-approval-'));
  const file=join(runDir,'roster.json');writeFileSync(file,`${JSON.stringify(roster,null,2)}\n`);
  const rejected={schema:'team-qa/roster-user-event/v1',...validUserEvent('Reject this roster.'),run_id:roster.run_id,round:roster.round,roster_hash:hashFile(file)};
  await assert.rejects(approveRoster({runDir,file,userEvent:rejected}),error=>error?.code==='USER_APPROVAL_REQUIRED');
  const forged={...rejected,text:'Approve this exact roster.'};
  await assert.rejects(approveRoster({runDir,file,userEvent:forged}),error=>error?.code==='HUMAN_EVENT_SOURCE_UNTRUSTED');
  roster.roles[0].context[0].sha256='0'.repeat(64);writeFileSync(file,`${JSON.stringify(roster,null,2)}\n`);
  await assert.rejects(approveRoster({runDir,file,userEvent:forged}),error=>error?.code==='ROSTER_CONTEXT_DRIFT');
});

test('pending or unknown upgrade metadata cannot pass runtime model selection',()=>{
  const {catalog,request}=runtimeInputs();
  const manager=catalog.models.find(model=>model.id===request.manager.model);
  manager.quality_evidence={fit_review:'pending'};
  assertCode(()=>selectRoster({catalog,request,catalogPath}),'ROLE_MODEL_UNAVAILABLE');

  const fresh=runtimeInputs();
  fresh.catalog.models.push({id:'gpt-new-upgrade',provider:'openai',harness:'codex',efforts:['medium'],tools:['fs.read'],roles:['test_manager'],tier:'general',status:'unknown',quality_evidence:{fit_review:'source-reviewed',selection_priority:1}});
  fresh.request.manager.model='gpt-new-upgrade';
  assertCode(()=>selectRoster({...fresh,catalogPath}),'ROLE_MODEL_UNAVAILABLE');
});

test('runtime catalog from a different Codex client cannot qualify reviewed models',()=>{
  const {catalog,request}=runtimeInputs();
  for(const model of catalog.models){model.status='available';model.quality_evidence={fit_review:'source-reviewed',harness_compatibility:'cache-client-version-mismatch-unverified'};}
  assertCode(()=>selectRoster({catalog,request,catalogPath}),'ROLE_MODEL_UNAVAILABLE');
});

test('runtime role override and mixed-provider events require host-authentic source provenance',()=>{
  const overrideCase=runtimeInputs();
  overrideCase.request.overrides=[{role:'analyst',model:'gpt-6.1-sol',user_event:validUserEvent('Use this model for analyst.')}];
  assertCode(()=>selectRoster({...overrideCase,catalogPath}),'HUMAN_EVENT_SOURCE_UNTRUSTED');

  const mixedCase=runtimeInputs();
  mixedCase.request.allow_mixed_provider={user_event:validUserEvent('Allow mixed provider for this run.')};
  assertCode(()=>selectRoster({...mixedCase,catalogPath}),'HUMAN_EVENT_SOURCE_UNTRUSTED');

  const missingSource=runtimeInputs();
  missingSource.request.overrides=[{role:'analyst',model:'gpt-6.1-sol',user_event:{id:'event-missing',actor:'user',text:'Choose this model.'}}];
  assertCode(()=>selectRoster({...missingSource,catalogPath}),'HUMAN_EVENT_SOURCE_FIELDS');
});

test('full approval text rejects “OK? No, reject” and extracts wrapped user reply answers',async()=>{
  const catalog=readJson(catalogPath),request=readJson(join(fixture,'request-default.json'));
  const roster=selectRoster({catalog,request,catalogPath});
  const runDir=mkdtempSync(join(tmpdir(),'roster-hardening-approval-'));
  const rosterFile=join(runDir,'roster.json');writeFileSync(rosterFile,`${JSON.stringify(roster,null,2)}\n`);
  const rejected={schema:'team-qa/roster-user-event/v1',...validUserEvent('OK? No, reject'),run_id:roster.run_id,round:roster.round,roster_hash:hashFile(rosterFile)};
  await assert.rejects(approveRoster({runDir,file:rosterFile,userEvent:rejected}),error=>error?.code==='USER_APPROVAL_REQUIRED');

  const reply={content:[{type:'text',text:'<send_user_message_question_reply>\n[{"id":"approval","answer":"Approve the roster for this exact run."},{"id":"scope","answer":"Preview only."}]\n</send_user_message_question_reply>'}]};
  assert.equal(extractHumanText(reply),'Approve the roster for this exact run.\nPreview only.');
});
