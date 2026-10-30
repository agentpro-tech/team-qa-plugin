import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readComposition, prepareComposition, componentRows, buildCompositionReport, verifyCompositionReport, writeCompositionReport, projectedPlan } from '../scripts/lib/target-composition.mjs';
import { sha256File, stableJson } from '../scripts/lib/core.mjs';
import { loadPlan, loadTracked } from '../scripts/lib/validators.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'teamqa-composition-'));
 const raw=JSON.parse(readFileSync(join(root,'test/fixtures/source-traceability/tracked-v2.valid.json')));
 raw.cases=raw.cases.slice(0,3);raw.cases.forEach((c,i)=>{c.data.app=['HRM','Supply','Both'][i];});
 const plan={run_id:'original',app:'Both',plan_version:6,lanes:[{id:'lane-high',scope:['REQ-HIGH','REQ-LOW'],parallel_ok:false,vi_sao:''},{id:'lane-low',scope:['REQ-HIGH','REQ-LOW'],parallel_ok:false,vi_sao:''}],tiers:{'REQ-HIGH':'FULL','REQ-LOW':'SMOKE'},exit_criteria:{p0_max:0,p1_max:0,p1_waivers:[],coverage_high_pct:100,coverage_low_pct:70}};
 for(const [name,bytes] of [['plan.md',`TEAMQA_PLAN_START\n${JSON.stringify(plan)}\nTEAMQA_PLAN_END`],['tracked.json',JSON.stringify(raw)],['original-approval.json',JSON.stringify({fixture:'historical-only, never approval for child'})]])writeFileSync(join(dir,name),bytes);
 const pin=name=>({path:name,sha256:sha256File(join(dir,name))});
 const request={schema:'team-qa/target-composition/v1',parent:{plan:pin('plan.md'),tracked:pin('tracked.json'),signed_approval:pin('original-approval.json')},targets:['hrm','supply'].map((id,i)=>({id,app_values:[i?'Supply':'HRM','Both'],run_id:id+'-child',run_uuid:`12345678-1234-4123-8123-${String(i+1).padStart(12,'0')}`,task_base:'a'.repeat(40),exact_final_sha:(i?'c':'b').repeat(40),requirements_hash:'d'.repeat(64),target:{project_id:id,preview_url:`https://${id}.example.test`,version:id+'-build'}})),case_targets:raw.cases.map((c,i)=>({case_id:c.id,target_ids:i===2?['hrm','supply']:[i?'supply':'hrm']}))};
 const file=join(dir,'composition.json');writeFileSync(file,JSON.stringify(request));return {dir,file,request,raw};
}
const change=(f,fn)=>{fn(f.request);writeFileSync(f.file,JSON.stringify(f.request));};
function childRows(f,input){
 const children={};
 for(const t of input.request.targets){
  const run=join(f.dir,'runs',t.run_id);importFsMkdir(run,{recursive:true});
  children[t.id]={run_dir:run,run_uuid:t.run_uuid,records:input.projections[t.id].cases.map(c=>({case_id:c.id,lane:c.lane,verdict:'pass',evidence:[],source:'script',run_id:t.run_id,ts:'2026-10-01T00:00:00Z'}))};
 }
 return children;
}
function proofFor(input,children,id,mutate=()=>{}){
 const entry=input.request.case_targets.find(e=>e.target_ids.length>1),child=children[id],record=child.records.find(r=>r.case_id===entry.case_id);
 const flow=join(child.run_dir,'flow-'+Math.random().toString(16).slice(2)+'.json');
 writeFileSync(flow,JSON.stringify({fixture:true,case_id:entry.case_id,observed:'Full cross-app fixture oracle; no product acceptance'}));
 const proof={schema:'team-qa/composition-execution/v1',composition_sha256:input.request_sha256,case_id:entry.case_id,target_id:id,run_uuid:child.run_uuid,
  targets:structuredClone(entry.target_ids.map(targetId=>{const t=input.request.targets.find(t=>t.id===targetId);return {id:t.id,run_uuid:t.run_uuid,target:t.target,exact_final_sha:t.exact_final_sha};})),
  flow_evidence:[{path:flow,sha256:sha256File(flow)}]};
 mutate(proof);
 const draft=join(child.run_dir,'proof-draft-'+Math.random().toString(16).slice(2)+'.json');writeFileSync(draft,stableJson(proof));
 const path=join(child.run_dir,`composition-execution-${sha256File(draft)}.json`);writeFileSync(path,readFileSync(draft));
 record.evidence=[path,flow];return {proof,path,flow,record};
}
// Only the official child-verifier process is stubbed. These v2 fixtures are not authentic approvals.
function indexedChildren(f,input,children){
 const index={schema:'team-qa/composition-children/v1',composition_sha256:input.request_sha256,children:[]};
 for(const t of input.request.targets){
  const dir=children[t.id].run_dir;
  writeFileSync(join(dir,'test-plan.md'),projectedPlan(input,t));writeFileSync(join(dir,'tracked-plan.json'),stableJson(input.projections[t.id]));
  writeFileSync(join(dir,'roster.json'),stableJson({target:t.target}));writeFileSync(join(dir,'board.jsonl'),children[t.id].records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const receipt=join(dir,'receipt.json');writeFileSync(receipt,stableJson({schema:'team-qa/receipt/v2',release_verdict:'GO',...Object.fromEntries(['run_uuid','task_base','exact_final_sha','requirements_hash'].map(k=>[k,t[k]])),artifacts:{plan:{sha256:sha256File(join(dir,'test-plan.md'))},tracked_plan:{sha256:sha256File(join(dir,'tracked-plan.json'))}}}));
  index.children.push({target_id:t.id,receipt:{path:receipt,sha256:sha256File(receipt)}});
 }
 const path=join(f.dir,'children.json');writeFileSync(path,stableJson(index));return path;
}
test('projection retains original cases/order/steps/source edges and separate target bindings; writes no approval',async()=>{
 const f=fixture(),before=sha256File(join(f.dir,'tracked.json')),out=join(f.dir,'projection');
 const result=await prepareComposition(f.file,out);assert.equal(result.parent_case_total,3);assert.equal(result.current_run_graded,false);assert.equal(result.approval_required,true);
 const input=readComposition(f.file);
 for(const t of f.request.targets){const p=loadTracked(join(out,t.id,'tracked-plan.json'),{lock:{governed:false}}),plan=loadPlan(join(out,t.id,'test-plan.md'));assert.deepEqual(p.errors,[]);assert.deepEqual(plan.errors,[]);assert.deepEqual(plan.value.exit_criteria,input.plan.exit_criteria);assert.deepEqual(p.value.cases,input.projections[t.id].cases);assert.equal(existsSync(join(out,t.id,'control')),false);}
 assert.equal(sha256File(join(f.dir,'tracked.json')),before);assert.equal(result.targets[0].exact_final_sha,'b'.repeat(40));assert.equal(result.targets[1].exact_final_sha,'c'.repeat(40));
 await assert.rejects(()=>prepareComposition(f.file,out),/COMPOSITION_OUTPUT_EXISTS/);
});
test('cross-target case requires every component; one pass never covers both; failure dominates',()=>{
 const f=fixture(),i=readComposition(f.file);const id=f.raw.cases[2].id;
 const a=childRows(f,i);delete a.supply;proofFor(i,a,'hrm');
 assert.equal(componentRows(i,a).find(r=>r.case_id===id).verdict,'ungraded');
 a.supply=childRows(f,i).supply;a.supply.records.find(r=>r.case_id===id).verdict='fail';assert.equal(componentRows(i,a).find(r=>r.case_id===id).verdict,'fail');
 a.supply.records.find(r=>r.case_id===id).verdict='pass';proofFor(i,a,'supply');const rows=componentRows(i,a);assert.equal(rows.length,3);assert.equal(rows.find(r=>r.case_id===id).verdict,'pass');
});
test('cross-app PASS requires pinned execution of the exact dependency builds in every child',()=>{
 const f=fixture(),i=readComposition(f.file),children=childRows(f,i),id=f.raw.cases[2].id;
 assert.equal(componentRows(i,children).find(r=>r.case_id===id).verdict,'ungraded');
 proofFor(i,children,'hrm');proofFor(i,children,'supply');
 assert.equal(componentRows(i,children).find(r=>r.case_id===id).verdict,'pass');
 for(const mutate of [p=>p.targets[1].exact_final_sha='e'.repeat(40),p=>p.targets[0].target.version='old-hrm-build',p=>p.run_uuid='wrong-run',p=>p.case_id='wrong-case',p=>p.composition_sha256='e'.repeat(64),p=>p.waiver=true,p=>p.flow_evidence=[]]){
  proofFor(i,children,'hrm',mutate);const row=componentRows(i,children).find(r=>r.case_id===id);
  assert.equal(row.verdict,'ungraded');assert.equal(row.components[0].dependency.status,'ungraded');
 }
 const p=proofFor(i,children,'hrm');writeFileSync(p.path,'changed proof bytes');assert.equal(componentRows(i,children).find(r=>r.case_id===id).verdict,'ungraded');
 const next=proofFor(i,children,'hrm');writeFileSync(next.flow,'changed execution bytes');assert.equal(componentRows(i,children).find(r=>r.case_id===id).verdict,'ungraded');
 const last=proofFor(i,children,'hrm');last.record.evidence=[last.path];assert.equal(componentRows(i,children).find(r=>r.case_id===id).verdict,'ungraded');
});
test('build and verify reconcile both child gate results, dependency pins and parent counts at the adapter boundary',async()=>{
 const f=fixture(),i=readComposition(f.file),children=childRows(f,i);proofFor(i,children,'hrm');proofFor(i,children,'supply');
 const index=indexedChildren(f,i,children),calls=[];let racePath=null;
 const stub=mock.method(childProcess,'spawnSync',(binary,args,options)=>{calls.push({binary,args,options});if(racePath)writeFileSync(racePath,'concurrent output retained');return {status:0,stdout:'fixture child adapter accepted',stderr:''};});syncBuiltinESMExports();
 try{
  const out=join(f.dir,'parent-report.json'),report=await writeCompositionReport(f.file,index,out);
  assert.equal(report.release_verdict,'GO');assert.deepEqual(report.counts,{pass:3,fail:0,ungraded:0});assert.equal(calls.length,2);
  for(const [n,t] of i.request.targets.entries()){assert.equal(calls[n].binary,process.execPath);assert.deepEqual(calls[n].args.slice(1,3),['receipt','verify']);assert.equal(calls[n].options.env.TEAMQA_TARGET_VERSION,t.target.version);}
  assert.deepEqual(verifyCompositionReport(out),report);assert.equal(calls.length,4);
  racePath=join(f.dir,'racing-report.json');await assert.rejects(()=>writeCompositionReport(f.file,index,racePath),/COMPOSITION_OUTPUT_EXISTS/);assert.equal(readFileSync(racePath,'utf8'),'concurrent output retained');racePath=null;
  const proof=children.hrm.records.find(r=>r.case_id===f.raw.cases[2].id).evidence[0];writeFileSync(proof,'dependency proof changed');
  const changed=buildCompositionReport(f.file,index);assert.equal(changed.release_verdict,'NO-GO');assert.equal(changed.counts.ungraded,1);
  assert.throws(()=>verifyCompositionReport(out),/COMPOSITION_REPORT_DRIFT/);
 }finally{stub.mock.restore();syncBuiltinESMExports();}
});
test('build output refuses pinned inputs, existing reports and dangling symlinks without changing bytes',async()=>{
 const f=fixture(),children=join(f.dir,'children.json');writeFileSync(children,'retained child index');
 const existing=join(f.dir,'old-report.json');writeFileSync(existing,'retained report');const dangling=join(f.dir,'dangling-report.json');symlinkSync(join(f.dir,'missing.json'),dangling);
 for(const path of [f.file,join(f.dir,'plan.md'),join(f.dir,'tracked.json'),join(f.dir,'original-approval.json'),children,existing,dangling]){
  const before=existsSync(path)?readFileSync(path):null;
  await assert.rejects(()=>writeCompositionReport(f.file,children,path),/COMPOSITION_OUTPUT_EXISTS/);
  if(before)assert.deepEqual(readFileSync(path),before);
  const r=spawnSync(process.execPath,[join(root,'scripts/teamqa.mjs'),'composition','build','--file',f.file,'--children',children,'--out',path],{encoding:'utf8'});assert.equal(r.status,2);assert.match(r.stderr,/COMPOSITION_OUTPUT_EXISTS/);
 }
});
for(const [name,fn,code] of [
 ['missing case',r=>r.case_targets.pop(),'COMPOSITION_DENOMINATOR'],
 ['reordered case',r=>r.case_targets.reverse(),'COMPOSITION_CASE_ORDER'],
 ['cross-app target omitted',r=>r.case_targets[2].target_ids.pop(),'COMPOSITION_EXPLICIT_APP_MAPPING'],
 ['unknown field',r=>r.waiver=true,'COMPOSITION_FIELDS'],
 ['duplicate run UUID',r=>r.targets[1].run_uuid=r.targets[0].run_uuid,'COMPOSITION_TARGET_ID'],
 ['joined source SHA',r=>r.targets[0].exact_final_sha='joined-source','COMPOSITION_TARGET_BINDING'],
 ['bad parent bytes',r=>r.parent.tracked.sha256='0'.repeat(64),'COMPOSITION_PIN_DRIFT'],
])test(`rejects ${name}`,()=>{const f=fixture();change(f,fn);assert.throws(()=>readComposition(f.file),new RegExp(code));});
test('receipt index cannot turn a re-sealed legacy or forged v2 artifact into formal acceptance',()=>{
 for(const schema of ['team-qa/receipt/v1','team-qa/receipt/v2']){
  const f=fixture(),i=readComposition(f.file),path=join(f.dir,'fake.json');writeFileSync(path,JSON.stringify({schema,release_verdict:'GO'}));
  const children=join(f.dir,'children.json');writeFileSync(children,JSON.stringify({schema:'team-qa/composition-children/v1',composition_sha256:i.request_sha256,children:f.request.targets.map(t=>({target_id:t.id,receipt:{path,sha256:sha256File(path)}}))}));
  assert.throws(()=>buildCompositionReport(f.file,children),/COMPOSITION_(CURRENT_RECEIPT_REQUIRED|CHILD_RUN_PATH)/);
 }
});
test('CLI routes validate and prepares a draft without invoking child models',()=>{
 const f=fixture();const p=spawnSync(process.execPath,[join(root,'scripts/teamqa.mjs'),'composition','validate','--file',f.file],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/cases=3/);
 const text=projectedPlan(readComposition(f.file),f.request.targets[0]);assert.match(text,/requires its own current roster and plan approval/);
});
test('apparently complete fake v2 reaches unchanged official gate and is rejected for missing current approval',()=>{
 const f=fixture(),i=readComposition(f.file),t=f.request.targets[0];
 const rd=join(f.dir,'runs',t.run_id);importFsMkdir(rd,{recursive:true});
 writeFileSync(join(rd,'test-plan.md'),projectedPlan(i,t));writeFileSync(join(rd,'tracked-plan.json'),stableJson(i.projections[t.id]));writeFileSync(join(rd,'roster.json'),JSON.stringify({target:t.target}));
 const path=join(rd,'receipt.json');writeFileSync(path,JSON.stringify({schema:'team-qa/receipt/v2',...Object.fromEntries(['run_uuid','task_base','exact_final_sha','requirements_hash'].map(k=>[k,t[k]])),artifacts:{plan:{sha256:sha256File(join(rd,'test-plan.md'))},tracked_plan:{sha256:sha256File(join(rd,'tracked-plan.json'))}},release_verdict:'GO'}));
 const children=join(f.dir,'children.json');writeFileSync(children,JSON.stringify({schema:'team-qa/composition-children/v1',composition_sha256:i.request_sha256,children:f.request.targets.map(t=>({target_id:t.id,receipt:{path,sha256:sha256File(path)}}))}));
 assert.throws(()=>buildCompositionReport(f.file,children),/COMPOSITION_CHILD_GATE/);
});
import { mkdirSync as importFsMkdir } from 'node:fs';

test('required fixture EXIT cleanup archives evidence and preserves success/failure; unrelated paths stay untouched',()=>{
 const script=readFileSync(join(root,'fixtures/run_fixtures.sh'),'utf8');
 const trap=script.split('\n').find(line=>line.startsWith('trap '));
 assert.ok(trap);assert.doesNotMatch(trap,/\brm\b/);
 for(const exitCode of [0,7]){
  const dir=mkdtempSync(join(tmpdir(),'teamqa-cleanup-proof-'));
  const run=mkdtempSync(join(dir,'teamqa-fixtures.'));
  writeFileSync(join(run,'retained.json'),'original fixture evidence');
  const result=spawnSync('/bin/bash',['-c',`set -euo pipefail\n${trap}\nexit ${exitCode}`],{env:{...process.env,TMPDIR:dir,RUN_DIR:run},encoding:'utf8'});
  assert.equal(result.status,exitCode,result.stderr);
  const archived=join(dir,'teamqa-fixtures-archive',run.slice(run.lastIndexOf('/')+1));
  assert.equal(existsSync(run),false);assert.equal(readFileSync(join(archived,'retained.json'),'utf8'),'original fixture evidence');
  assert.match(result.stdout,/FIXTURE_ARCHIVE=/);
 }
 const dir=mkdtempSync(join(tmpdir(),'teamqa-cleanup-guard-'));
 const unrelated=join(dir,'unrelated');importFsMkdir(unrelated);writeFileSync(join(unrelated,'retained.txt'),'untouched');
 const result=spawnSync('/bin/bash',['-c',`set -euo pipefail\n${trap}\nexit 0`],{env:{...process.env,TMPDIR:dir,RUN_DIR:unrelated},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(join(unrelated,'retained.txt'),'utf8'),'untouched');
 assert.equal(existsSync(join(dir,'teamqa-fixtures-archive')),false);
});
