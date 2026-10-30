import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fail, readJson, sha256File, stableJson, rejectUnknownFields, writeConfirmed } from './core.mjs';
import { loadPlan, loadTracked, loadBoard, trackedErrors } from './validators.mjs';
import { targetShapeErrors } from './target-lock.mjs';
import { sourceTraceabilityRows } from './source-traceability.mjs';
import { seal, integrityFor } from './release-truth.mjs';
import { latestAttemptByCase } from './attempt-sequence.mjs';

const CLI=fileURLToPath(new URL('../teamqa.mjs',import.meta.url));
const exact=(v,keys,code)=>{ if(!v || typeof v!=='object' || Array.isArray(v)) fail(2,code); rejectUnknownFields(v,keys,code); };
const need=(v,code,detail='')=>{if(!v)fail(2,code,detail);};
const same=(a,b)=>stableJson(a)===stableJson(b);
const token=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function pinned(item,base){
 exact(item,['path','sha256'],'COMPOSITION_PIN_FIELDS');
 need(typeof item.path==='string' && /^[a-f0-9]{64}$/.test(item.sha256||''),'COMPOSITION_PIN');
 const path=resolve(base,item.path); need(existsSync(path)&&sha256File(path)===item.sha256,'COMPOSITION_PIN_DRIFT',path); return path;
}
export function readComposition(file){
 const request=readJson(file),base=dirname(resolve(file));
 exact(request,['schema','parent','targets','case_targets'],'COMPOSITION_FIELDS');
 need(request.schema==='team-qa/target-composition/v1','COMPOSITION_SCHEMA');
 exact(request.parent,['plan','tracked','signed_approval'],'COMPOSITION_PARENT_FIELDS');
 const planPath=pinned(request.parent.plan,base),trackedPath=pinned(request.parent.tracked,base);
 pinned(request.parent.signed_approval,base); // Historical authority is preserved, never minted as current approval.
 const plan=loadPlan(planPath),tracked=loadTracked(trackedPath,{lock:{governed:false}});
 need(!plan.errors.length&&!tracked.errors.length,'COMPOSITION_PARENT_INVALID',[...plan.errors,...tracked.errors].join(';'));
 need(tracked.value.schemaVersion===2 && tracked.value.cases.length>0,'COMPOSITION_TRACKED_V2');
 need(tracked.value.cases.every(c=>Object.hasOwn(plan.value.tiers,c.req_id)&&plan.value.lanes.some(l=>l.id===c.lane&&l.scope.includes(c.req_id))),'COMPOSITION_PARENT_SCOPE');
 need(Array.isArray(request.targets)&&request.targets.length>=2,'COMPOSITION_TARGETS');
 const ids=new Set(),runs=new Set(),uuids=new Set();
 for(const t of request.targets){
  exact(t,['id','app_values','run_id','run_uuid','task_base','exact_final_sha','requirements_hash','target'],'COMPOSITION_TARGET_FIELDS');
  need(token.test(t.id||'')&&!ids.has(t.id)&&token.test(t.run_id||'')&&!runs.has(t.run_id)&&t.run_id!==plan.value.run_id&&uuid.test(t.run_uuid||'')&&!uuids.has(t.run_uuid),'COMPOSITION_TARGET_ID');
  ids.add(t.id);runs.add(t.run_id);uuids.add(t.run_uuid);
  need(Array.isArray(t.app_values)&&t.app_values.length&&new Set(t.app_values).size===t.app_values.length&&t.app_values.every(x=>typeof x==='string'&&x.trim()),'COMPOSITION_APP_VALUES');
  need(/^[a-f0-9]{40}$/.test(t.task_base||'')&&/^[a-f0-9]{40}$/.test(t.exact_final_sha||'')&&/^[a-f0-9]{64}$/.test(t.requirements_hash||''),'COMPOSITION_TARGET_BINDING');
  need(!targetShapeErrors(t.target,'COMPOSITION').length,'COMPOSITION_TARGET_SHAPE');
 }
 need(Array.isArray(request.case_targets)&&request.case_targets.length===tracked.value.cases.length,'COMPOSITION_DENOMINATOR');
 const projections={};
 for(const t of request.targets)projections[t.id]={schemaVersion:2,sourceItems:[],cases:[]};
 request.case_targets.forEach((entry,i)=>{
  exact(entry,['case_id','target_ids'],'COMPOSITION_CASE_FIELDS');const c=tracked.value.cases[i];
  need(entry.case_id===c.id,'COMPOSITION_CASE_ORDER',c.id);
  const declared=request.targets.filter(t=>t.app_values.includes(c.data.app)).map(t=>t.id);
  need(declared.length>0&&same(entry.target_ids,declared),'COMPOSITION_EXPLICIT_APP_MAPPING',c.id);
  for(const id of entry.target_ids)projections[id].cases.push(structuredClone(c));
 });
 for(const t of request.targets){
  const p=projections[t.id];need(p.cases.length>0,'COMPOSITION_EMPTY_TARGET',t.id);
  p.sourceItems=tracked.value.sourceItems.filter(s=>p.cases.some(c=>c.sourceRefs.includes(s.id)));
  // Existing tracked validator owns case/source semantics.
  need(new Set(p.cases.flatMap(c=>c.sourceRefs)).size===p.sourceItems.length,'COMPOSITION_SOURCE_LINK');
  need(!trackedErrors(p,{lock:{governed:false}}).length,'COMPOSITION_PROJECTION_INVALID');
 }
 return {request,plan:plan.value,tracked:tracked.value,projections,file:resolve(file),request_sha256:sha256File(file)};
}
export function projectedPlan(input,t){
 const reqs=new Set(input.projections[t.id].cases.map(c=>c.req_id));
 const plan={...structuredClone(input.plan),run_id:t.run_id,app:t.id,
  lanes:input.plan.lanes.map(l=>({...structuredClone(l),scope:l.scope.filter(id=>reqs.has(id))})).filter(l=>l.scope.length),
  tiers:Object.fromEntries(Object.entries(input.plan.tiers).filter(([id])=>reqs.has(id)))};
 return `# Target projection ${t.id}\n\nParent plan SHA256: ${input.request.parent.plan.sha256}\nParent tracked SHA256: ${input.request.parent.tracked.sha256}\nComposition SHA256: ${input.request_sha256}\nThis projection requires its own current roster and plan approval; no parent approval is copied.\n\nTEAMQA_PLAN_START\n${JSON.stringify(plan,null,2)}\nTEAMQA_PLAN_END\n`;
}
export async function prepareComposition(file,out){
 const input=readComposition(file);need(!existsSync(out),'COMPOSITION_OUTPUT_EXISTS');mkdirSync(out,{recursive:true});
 const artifacts=[];
 for(const t of input.request.targets){
  const dir=join(out,t.id);mkdirSync(dir);
  const paths=[['test-plan.md',projectedPlan(input,t)],['tracked-plan.json',stableJson(input.projections[t.id])]];
  for(const [name,bytes] of paths){const path=join(dir,name);await writeConfirmed(path,bytes,'teamqa.composition.project');artifacts.push({target_id:t.id,path:resolve(path),sha256:sha256File(path)});}
 }
 const result=seal({schema:'team-qa/target-projection/v1',composition:{path:input.file,sha256:input.request_sha256},parent_case_total:input.tracked.cases.length,parent_source_total:input.tracked.sourceItems.length,
  case_ids:input.tracked.cases.map(c=>c.id),source_ids:input.tracked.sourceItems.map(s=>s.id),targets:input.request.targets,artifacts,current_run_graded:false,approval_required:true});
 await writeConfirmed(join(out,'projection.json'),stableJson(result),'teamqa.composition.project');return result;
}
function dependencyEvidence(input,entry,id,child,record){
 if(entry.target_ids.length===1)return {status:'not-required'};
 const candidates=(record?.evidence??[]).filter(path=>/^composition-execution-[a-f0-9]{64}\.json$/.test(basename(path)));
 if(!child?.run_dir||candidates.length!==1)return {status:'ungraded',reason:'COMPOSITION_DEPENDENCY_MISSING'};
 try{
  const artifact=resolve(child.run_dir,candidates[0]);
  need(sha256File(artifact)===basename(artifact).slice(22,-5),'COMPOSITION_DEPENDENCY_HASH');
  const proof=readJson(artifact);
  exact(proof,['schema','composition_sha256','case_id','target_id','run_uuid','targets','flow_evidence'],'COMPOSITION_DEPENDENCY_FIELDS');
  need(proof.schema==='team-qa/composition-execution/v1'&&proof.composition_sha256===input.request_sha256&&proof.case_id===entry.case_id&&proof.target_id===id&&proof.run_uuid===child.run_uuid,'COMPOSITION_DEPENDENCY_BINDING');
  const targets=entry.target_ids.map(targetId=>{
   const t=input.request.targets.find(t=>t.id===targetId);
   return {id:t.id,run_uuid:t.run_uuid,target:t.target,exact_final_sha:t.exact_final_sha};
  });
  need(same(proof.targets,targets),'COMPOSITION_DEPENDENCY_TARGETS');
  need(Array.isArray(proof.flow_evidence)&&proof.flow_evidence.length>0,'COMPOSITION_DEPENDENCY_FLOW');
  for(const item of proof.flow_evidence){
   const path=pinned(item,child.run_dir);
   need(path!==artifact&&(record.evidence??[]).some(p=>resolve(child.run_dir,p)===path),'COMPOSITION_DEPENDENCY_FLOW');
  }
  return {status:'verified',artifact:candidates[0],sha256:sha256File(artifact)};
 }catch(error){return {status:'ungraded',reason:error.code??'COMPOSITION_DEPENDENCY_INVALID'};}
}
// Child gates authenticate the rows; the composition also binds cross-app execution evidence.
export function componentRows(input,children){
 const latest=new Map(Object.entries(children).map(([id,child])=>[id,latestAttemptByCase(child.records)]));
 return input.request.case_targets.map(entry=>{
  const planned=input.tracked.cases.find(c=>c.id===entry.case_id);
  const components=entry.target_ids.map(id=>{
   const child=children[id],r=latest.get(id)?.latestByCase.get(entry.case_id);
   const dependency=r?.verdict==='pass'?dependencyEvidence(input,entry,id,child,r):{status:'not-graded'};
   return {target_id:id,verdict:r?.verdict==='pass'&&dependency.status==='ungraded'?'ungraded':r?.verdict??'ungraded',child_verdict:r?.verdict??'ungraded',evidence:r?.evidence??[],dependency};
  });
  const verdict=components.some(c=>c.verdict==='fail')?'fail':components.every(c=>c.verdict==='pass')?'pass':'ungraded';
  return {case_id:entry.case_id,req_id:planned.req_id,lane:planned.lane,layer:planned.data.layer??null,priority:planned.priority,sourceRefs:planned.sourceRefs,verdict,components};
 });
}
function verifyChild(input,t,item,base){
 exact(item,['target_id','receipt'],'COMPOSITION_CHILD_FIELDS');need(item.target_id===t.id,'COMPOSITION_CHILD_ORDER');
 const receiptPath=pinned(item.receipt,base),runDir=dirname(receiptPath),receipt=readJson(receiptPath);
 need(receipt.schema==='team-qa/receipt/v2'&&!receipt.historical_diagnostic,'COMPOSITION_CURRENT_RECEIPT_REQUIRED');
 need(basename(runDir)===t.run_id&&basename(dirname(runDir))==='runs','COMPOSITION_CHILD_RUN_PATH');
 for(const key of ['run_uuid','task_base','exact_final_sha','requirements_hash'])need(receipt[key]===t[key],'COMPOSITION_CHILD_BINDING',key);
 need(same(readJson(join(runDir,'roster.json')).target,t.target),'COMPOSITION_CHILD_TARGET');
 need(sha256File(join(runDir,'test-plan.md'))===receipt.artifacts?.plan?.sha256,'COMPOSITION_CHILD_PLAN_PIN');
 need(sha256File(join(runDir,'tracked-plan.json'))===receipt.artifacts?.tracked_plan?.sha256,'COMPOSITION_CHILD_TRACKED_PIN');
 // Text comparison binds original exit criteria, unchanged steps and explicit mapping to actual SIGN.
 need(readFileSync(join(runDir,'test-plan.md'),'utf8')===projectedPlan(input,t),'COMPOSITION_CHILD_PLAN_DRIFT');
 const childTracked=loadTracked(join(runDir,'tracked-plan.json'),{lock:{governed:false}});
 need(!childTracked.errors.length&&same(childTracked.value,input.projections[t.id]),'COMPOSITION_CHILD_CASE_DRIFT');
 const env={...process.env,TEAMQA_TARGET_PROJECT_ID:t.target.project_id,TEAMQA_TARGET_PREVIEW_URL:t.target.preview_url,TEAMQA_TARGET_VERSION:t.target.version};
 const result=spawnSync(process.execPath,[CLI,'receipt','verify','--file',receiptPath],{cwd:dirname(dirname(runDir)),env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
 need(!result.error&&!result.signal&&result.status===0,'COMPOSITION_CHILD_GATE',(result.stderr||result.stdout||String(result.error)).slice(0,800));
 const board=loadBoard(join(runDir,'board.jsonl'));need(!board.errors.length,'COMPOSITION_CHILD_BOARD');
 return {receipt:item.receipt,records:board.records,run_dir:runDir,release_verdict:receipt.release_verdict,run_uuid:t.run_uuid,target:t.target,exact_final_sha:t.exact_final_sha};
}
export function assertNewCompositionOutput(out){
 try{lstatSync(out);}catch(error){if(error.code==='ENOENT')return;throw error;}
 fail(2,'COMPOSITION_OUTPUT_EXISTS',out);
}
export async function writeCompositionReport(file,childFile,out){
 assertNewCompositionOutput(out);
 const report=buildCompositionReport(file,childFile);
 try{await writeConfirmed(out,stableJson(report),'teamqa.composition.report',{exclusive:true});}
 catch(error){if(error.code==='EEXIST')fail(2,'COMPOSITION_OUTPUT_EXISTS',out);throw error;}
 return report;
}
export function buildCompositionReport(file,childFile){
 const input=readComposition(file),index=readJson(childFile),base=dirname(resolve(childFile));
 exact(index,['schema','composition_sha256','children'],'COMPOSITION_CHILD_INDEX_FIELDS');
 need(index.schema==='team-qa/composition-children/v1'&&index.composition_sha256===input.request_sha256,'COMPOSITION_CHILD_INDEX');
 need(Array.isArray(index.children)&&index.children.length===input.request.targets.length,'COMPOSITION_CHILD_DENOMINATOR');
 const children={};input.request.targets.forEach((t,i)=>{children[t.id]=verifyChild(input,t,index.children[i],base);});
 const rows=componentRows(input,children),counts=Object.fromEntries(['pass','fail','ungraded'].map(v=>[v,rows.filter(r=>r.verdict===v).length]));
 const allGo=Object.values(children).every(c=>c.release_verdict==='GO');
 const uncovered_sources=input.tracked.sourceItems.filter(s=>!input.tracked.cases.some(c=>c.sourceRefs.includes(s.id))).map(s=>s.id);
 const uncovered_requirements=Object.keys(input.plan.tiers).filter(id=>!input.tracked.cases.some(c=>c.req_id===id));
 return seal({schema:'team-qa/composition-report/v1',composition:{path:input.file,sha256:input.request_sha256},child_index:{path:resolve(childFile),sha256:sha256File(childFile)},parent_case_total:rows.length,parent_source_total:input.tracked.sourceItems.length,
  source_ids:input.tracked.sourceItems.map(s=>s.id),exit_criteria:input.plan.exit_criteria,counts,rows,
  counts_by_layer:Object.fromEntries([...new Set(rows.map(r=>r.layer??'unclassified'))].map(layer=>[layer,Object.fromEntries(['pass','fail','ungraded'].map(v=>[v,rows.filter(r=>(r.layer??'unclassified')===layer&&r.verdict===v).length]))])),
  source_edges:sourceTraceabilityRows(input.tracked,rows.map(r=>({case_id:r.case_id,verdict:r.verdict,evidence:r.components.map(c=>children[c.target_id].receipt.path)}))),
  targets:input.request.targets.map(t=>({id:t.id,run_uuid:t.run_uuid,target:t.target,task_base:t.task_base,exact_final_sha:t.exact_final_sha,receipt:children[t.id].receipt,release_verdict:children[t.id].release_verdict})),
  uncovered_sources,uncovered_requirements,release_verdict:allGo&&counts.pass===rows.length&&!uncovered_sources.length&&!uncovered_requirements.length?'GO':'NO-GO'});
}
export function verifyCompositionReport(reportPath){
 const report=readJson(reportPath);need(report.integrity===integrityFor(report),'COMPOSITION_REPORT_INTEGRITY');
 const file=pinned(report.composition,dirname(resolve(reportPath))),children=pinned(report.child_index,dirname(resolve(reportPath)));
 need(same(report,buildCompositionReport(file,children)),'COMPOSITION_REPORT_DRIFT');return report;
}
