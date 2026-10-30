import { existsSync, readFileSync, realpathSync, mkdirSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertApprovedRoster, parseNativeRoleExecution, verifyProviderInterface } from './roster.mjs';
import { fail, readJson, rejectUnknownFields, sha256File, sha256, stableJson, writeConfirmed } from './core.mjs';
import { assertToolPreflight, readDragonToolEvidence } from './tool-preflight.mjs';
import { isDeployedTarget } from './deployed-target.mjs';
import { nativeCreationEpoch } from './native-host.mjs';
import { loadPlan, loadTracked } from './validators.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const requireValue=(v,code)=>{if(!v)fail(3,code,'','ungraded');};
function intentFile(runDir,role,seq=1){return seq===1?join(resolve(runDir),'native-dispatch',`${role}.json`):join(resolve(runDir),'native-dispatch',role,`attempt-${seq}`,'intent.json');}
const MAX_CASE_ATTEMPTS=3;
function signedCaseCount(runDir){
  const lock=readJson(join(runDir,'docs-lock.json')),ref=lock.artifacts?.tracked;
  requireValue(ref&&typeof ref.path==='string'&&sha256File(resolve(runDir,ref.path))===ref.sha256,'NATIVE_CASE_SCOPE_LOCK');
  const tracked=loadTracked(resolve(runDir,ref.path));requireValue(!tracked.errors.length&&tracked.value.cases.length>0,'NATIVE_CASE_SCOPE_INVALID');
  return tracked.value.cases.length;
}
function attemptSequence(runDir,role){
  const dir=join(resolve(runDir),'native-dispatch',role);let found=[];
  if(existsSync(dir)) found=readdirSync(dir).map(x=>/^attempt-(\d+)$/.exec(x)).filter(Boolean).map(x=>Number(x[1]));
  const seq=Math.max(1,...found)+1,limit=role==='executor_gui'?signedCaseCount(runDir)*MAX_CASE_ATTEMPTS:MAX_CASE_ATTEMPTS;
  requireValue(seq<=limit,'NATIVE_ATTEMPT_LIMIT');return seq;
}
function caseAttemptCount(runDir,role,caseId){
  let count=0;const primary=intentFile(runDir,role);if(existsSync(primary)){const intent=readJson(primary);if(intent.dispatch_case_id===undefined||intent.dispatch_case_id===caseId)count++;}
  const dir=join(runDir,'native-dispatch',role);
  if(existsSync(dir))for(const entry of readdirSync(dir)){const match=/^attempt-(\d+)$/.exec(entry);if(!match)continue;const path=join(dir,entry,'intent.json');if(!existsSync(path))continue;const intent=readJson(path);if(intent.dispatch_case_id===undefined||intent.dispatch_case_id===caseId)count++;}
  return count;
}
async function continuationForCase(runDir,caseId){
  requireValue(typeof caseId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(caseId),'NATIVE_CASE_ID_REQUIRED');
  const {readContinuation}=await import('./continuation.mjs'),decision=readContinuation({runDir});
  requireValue(decision.unresolved?.includes(caseId)&&!decision.blocked?.some(row=>row.caseId===caseId),'NATIVE_CASE_NOT_ACTIONABLE');
  requireValue(decision.disposition==='CONTINUE'&&decision.next?.kind==='execute','NATIVE_CASE_NOT_ACTIONABLE');
  const nextCase=decision.next?.caseId;
  requireValue(nextCase===caseId,'NATIVE_CASE_DISPATCH_ORDER',`expected ${nextCase||'no executable case'}`);
  const caseProgress=decision.progressByCase?.[caseId];
  requireValue(/^[a-f0-9]{64}$/.test(caseProgress||''),'NATIVE_CASE_PROGRESS_UNVERIFIED');
  return {...decision,caseProgress};
}
function attemptTerminal(runDir,intent){
  if(!intent.dispatch_attempt_seq){const bindingPath=join(runDir,'role-bindings',`${intent.role}.json`),closedPath=join(runDir,'native-dispatch',intent.role,'attempt-1','closed.json');return existsSync(bindingPath)&&validPreviousAttestation(bindingPath,runDir,intent,1)||existsSync(closedPath)&&verifyNativeAttemptClosure({runDir,intent});}
  const bindingPath=join(runDir,'role-bindings',intent.role,`attempt-${intent.dispatch_attempt_seq}.json`);
  const closedPath=join(runDir,'native-dispatch',intent.role,`attempt-${intent.dispatch_attempt_seq}`,'closed.json');
  return existsSync(bindingPath)&&validPreviousAttestation(bindingPath,runDir,intent,intent.dispatch_attempt_seq)||existsSync(closedPath)&&verifyNativeAttemptClosure({runDir,intent});
}
function validPreviousAttestation(path,runDir,intent,seq){try{const a=readJson(path);if(seq===1&&a.schema!=='team-qa/role-attestation/v1'||seq>1&&(a.schema!=='team-qa/role-attestation/v2'||a.dispatch_attempt_seq!==seq||a.dispatch_attempt_id!==intent.dispatch_attempt_id))return false;verifyNativeRoleSource(a,{runDir});return true;}catch{return false;}}
function terminalProofPath(runDir,role,seq){
  const bindingPath=seq===1?join(runDir,'role-bindings',`${role}.json`):join(runDir,'role-bindings',role,`attempt-${seq}.json`);
  if(existsSync(bindingPath))return bindingPath;
  const closedPath=join(runDir,'native-dispatch',role,`attempt-${seq}`,'closed.json');return closedPath;
}
function binding(i){return `TEAMQA_RUN_BINDING run=${i.run_id} round=${i.round} role=${i.role} roster=${i.roster_hash}${i.dispatch_attempt_id?` attempt=${i.dispatch_attempt_id} seq=${i.dispatch_attempt_seq}`:''}${i.dispatch_case_id?` case=${i.dispatch_case_id} progress=${i.dispatch_progress_sha256}`:''}`;}
function packetMessage(i){
  const firstRead=i.native_node_reads?`text(await tools.mcp__node_repl__js(${JSON.stringify({code:i.native_node_reads.packet,title:'Read locked Team QA context'})}));`:`// @exec: {"max_output_tokens": 20000}\ntext(await tools.exec_command(${JSON.stringify({cmd:`cat '${i.context_packet_path}'`,login:false,max_output_tokens:16000})}));`;
  const tools=i.native_gui?'After the two reads, only the Dragon operations and literal helper commands in the locked native GUI policy are permitted. No other tools or file writes.':'Do not call other tools or write files.';
  return `${binding(i)}\nRead this locked context packet before following the task inside it. Its SHA256 is ${i.context_packet_sha256}.\nYour first tool call must be exactly:\n${firstRead}\nFollow the role, skill and scoped task in that packet; read the separate facts as instructed there. ${tools}${i.native_node_reads?' Your second tool call must be exactly:\ntext(await tools.mcp__node_repl__js('+JSON.stringify({code:i.native_node_reads.facts,title:'Read scoped Team QA facts'})+'));':''} End with the requested final response.`;
}
function childCall(skill,moduleName,method,args){
  const child=verifyProviderInterface({skill}),path=join(child.root,'scripts/lib',moduleName);
  requireValue(existsSync(path),'NATIVE_CHILD_ADAPTER_MISSING');
  const code='const m=await import(process.argv[1]);let raw="";for await(const chunk of process.stdin)raw+=chunk;process.stdout.write(JSON.stringify(await m[process.argv[2]](JSON.parse(raw))));';
  const result=spawnSync(process.execPath,['--input-type=module','-e',code,path,method],{input:JSON.stringify(args),encoding:'utf8',maxBuffer:32*1024*1024,timeout:30000});
  requireValue(result.status===0&&!result.error,'NATIVE_CHILD_ADAPTER_REJECTED');
  return JSON.parse(result.stdout);
}
export function assertNativeGuiPolicy({runDir,roster,policyPath,policySha256}){
  requireValue(typeof policyPath==='string'&&existsSync(policyPath)&&sha256File(policyPath)===policySha256,'NATIVE_GUI_POLICY_DRIFT');
  const policy=readJson(policyPath),child=verifyProviderInterface({skill:'qa-gui'});
  requireValue(childCall('qa-gui','native-gui-trajectory.mjs','nativeGuiPolicyErrors',policy).length===0,'NATIVE_GUI_POLICY_INVALID');
  const current=readJson(join(runDir,'binding.json'));
  requireValue(policy.target.url===roster.target.preview_url&&(isDeployedTarget(roster.target)?policy.schema==='qa-gui/native-policy/v2'&&policy.target.kind==='deployed-build'&&policy.target.target_binding_sha256===roster.target.target_binding_sha256&&current.target_binding_sha256===roster.target.target_binding_sha256:policy.target.commit===roster.target.version&&policy.target.commit===current.exact_final_sha),'NATIVE_GUI_TARGET_MISMATCH');
  const plan=readJson(join(runDir,'docs-lock.json')).artifacts.plan;
  const loadedPlan=loadPlan(resolve(runDir,plan.path));requireValue(loadedPlan.errors.length===0,'NATIVE_GUI_PLAN_INVALID');
  const requirements=loadedPlan.value.preflight;
  requireValue(requirements?.gui===true&&policy.behavioral===requirements.recording&&(!isDeployedTarget(roster.target)||requirements.code===false),'NATIVE_GUI_SCOPE_MISMATCH');
  const preflight=readJson(join(runDir,'preflight.json'));
  const session=readDragonToolEvidence(preflight.gui.session,{runDir,roster},'session.create').result;
  const opened=readDragonToolEvidence(preflight.gui.open,{runDir,roster},'openTab').result;
  requireValue(['sessionId','nonce','browserInstanceId'].every(k=>policy.dragon[k]===session[k])&&policy.dragon.tabId===opened.tabId,'NATIVE_GUI_SESSION_DRIFT');
  for(const helper of policy.helpers)requireValue(realpathSync(helper.path)===realpathSync(join(child.root,'scripts/qa_do.mjs'))&&sha256File(helper.path)===helper.sha256,'NATIVE_GUI_HELPER_DRIFT');
  return policy;
}
export function assertNativeResponseCap(parsed,intent){
  if(intent.role==='executor_code')return;
  const cap=readJson(join(ROOT,'references/roster-policy.json')).native_response_max_words;
  requireValue(Number.isInteger(cap)&&cap>0&&intent.response_max_words===cap,'NATIVE_RESPONSE_CAP_BINDING');
  requireValue(typeof parsed.verdictText==='string'&&parsed.verdictText.trim().split(/\s+/u).length<=cap,'NATIVE_RESPONSE_CAP_EXCEEDED');
}
export function assertNativePacketBinding(i,{runDir,context}){
  const path=i.context_packet_path;
  const expectedPath=i.dispatch_attempt_seq?join(dirname(path),'context.md'):join(resolve(runDir),'native-dispatch',`${i.role}.context.md`);
  requireValue(path===expectedPath&&!/[\0\n\r'`$]/.test(path),'NATIVE_PACKET_PATH');
  requireValue(/^[a-f0-9]{64}$/.test(i.context_packet_sha256||'')&&existsSync(path)&&sha256File(path)===i.context_packet_sha256,'NATIVE_PACKET_DRIFT');
  const bytes=readFileSync(path,'utf8'),prefix=binding(i)+'\n'+context+'\n\n';
  requireValue(bytes.startsWith(prefix)&&sha256(bytes.slice(prefix.length))===i.prompt_sha256,'NATIVE_CONTEXT_DRIFT');
}
function checkIntent({runDir,intentPath}){
  const i=readJson(intentPath),r=assertApprovedRoster({runDir,role:i.role}),seat=r.roles.find(s=>s.role===i.role);
  const packet=['team-qa/native-dispatch/v2','team-qa/native-dispatch/v3'].includes(i.schema),multi=i.schema==='team-qa/native-dispatch/v3';
  rejectUnknownFields(i,['schema','run_id','round','roster_hash','role','parent_session_id','created_at','prompt_sha256','spawn','facts_path','facts_sha256',...(packet?['context_packet_path','context_packet_sha256','response_max_words','native_qa','native_gui','native_node_reads','dispatch_case_id','dispatch_progress_sha256']:[]),...(multi?['dispatch_attempt_id','dispatch_attempt_seq','dispatch_previous_sha256','dispatch_previous_intent_sha256']:[])],'NATIVE_INTENT_FIELDS');
  const expectedPath=intentFile(runDir,i.role,multi?i.dispatch_attempt_seq:1);
  requireValue(['team-qa/native-dispatch/v1','team-qa/native-dispatch/v2','team-qa/native-dispatch/v3'].includes(i.schema)&&i.run_id===r.run_id&&i.round===r.round&&i.roster_hash===r.roster_hash&&resolve(intentPath)===expectedPath,'NATIVE_INTENT_BINDING');
  if(i.role==='executor_gui'&&i.dispatch_case_id!==undefined){requireValue(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(i.dispatch_case_id)&&/^[a-f0-9]{64}$/.test(i.dispatch_progress_sha256||''),'NATIVE_CASE_ATTEMPT_BINDING');const trackedPath=resolve(runDir,readJson(join(runDir,'docs-lock.json')).artifacts.tracked.path),tracked=loadTracked(trackedPath);requireValue(!tracked.errors.length&&tracked.value.cases.some(c=>c.id===i.dispatch_case_id),'NATIVE_CASE_OUT_OF_SCOPE');}
  if(multi){const limit=i.role==='executor_gui'?signedCaseCount(runDir)*MAX_CASE_ATTEMPTS:MAX_CASE_ATTEMPTS;requireValue(Number.isInteger(i.dispatch_attempt_seq)&&i.dispatch_attempt_seq>=2&&i.dispatch_attempt_seq<=limit&&/^[A-Za-z0-9_-]{8,128}$/.test(i.dispatch_attempt_id||'')&&/^[a-f0-9]{64}$/.test(i.dispatch_previous_sha256||'')&&/^[a-f0-9]{64}$/.test(i.dispatch_previous_intent_sha256||''),'NATIVE_ATTEMPT_BINDING');if(i.role==='executor_gui')requireValue(i.dispatch_case_id&&i.dispatch_progress_sha256,'NATIVE_CASE_ATTEMPT_BINDING');const priorIntentPath=intentFile(runDir,i.role,i.dispatch_attempt_seq-1),priorIntent=readJson(priorIntentPath),priorProofPath=terminalProofPath(runDir,i.role,i.dispatch_attempt_seq-1);requireValue(attemptTerminal(runDir,priorIntent)&&sha256File(priorIntentPath)===i.dispatch_previous_intent_sha256&&sha256File(priorProofPath)===i.dispatch_previous_sha256,'NATIVE_PREVIOUS_ATTEMPT_OPEN');}
  requireValue(seat.harness==='codex-native'&&i.parent_session_id===seat.native_host.session_id,'NATIVE_INTENT_HARNESS');
  if(packet){const base=i.dispatch_attempt_seq?dirname(intentPath):join(resolve(runDir),'native-dispatch');const packetPath=join(base,i.dispatch_attempt_seq?'context.md':`${i.role}.context.md`);requireValue(resolve(i.context_packet_path)===packetPath,'NATIVE_PACKET_PATH');}
  if(i.role==='executor_code'){
    requireValue(packet&&i.native_qa&&!i.native_gui&&!Object.hasOwn(i,'response_max_words'),'NATIVE_CODE_USE_QA_CODE');
    childCall('qa-code','native-qa.mjs','verifyNativeQaIntent',{intentPath,proofPath:i.native_qa.review_proof_path,runtimePath:ROOT});
  }else{
    requireValue(!i.native_qa&&packet&&i.response_max_words===readJson(join(ROOT,'references/roster-policy.json')).native_response_max_words,'NATIVE_RESPONSE_CAP_BINDING');
    if(i.role==='executor_gui'){
      requireValue(i.native_gui&&typeof i.native_gui==='object','NATIVE_GUI_POLICY_REQUIRED');
      rejectUnknownFields(i.native_gui,['policy_path','policy_sha256'],'NATIVE_GUI_POLICY_FIELDS');
      assertNativeGuiPolicy({runDir,roster:r,policyPath:i.native_gui.policy_path,policySha256:i.native_gui.policy_sha256});
    }else requireValue(!i.native_gui,'NATIVE_GUI_ROLE_MISMATCH');
  }
  rejectUnknownFields(i.spawn,['task_name','model','reasoning_effort','fork_turns','message'],'NATIVE_SPAWN_FIELDS');
  requireValue(i.spawn.model===seat.model&&i.spawn.reasoning_effort===seat.effort&&i.spawn.fork_turns==='none','NATIVE_SPAWN_CONFIG');
  const context=seat.context.map(x=>readFileSync(join(ROOT,x.path),'utf8')).join('\n\n');
  if(i.native_node_reads){rejectUnknownFields(i.native_node_reads,['packet','facts'],'NATIVE_NODE_READ_FIELDS');requireValue(i.native_node_reads.packet===childCall('qa-code','provider-execution.mjs','nativeFileReadCode',{path:i.context_packet_path,sha256:i.context_packet_sha256})&&i.native_node_reads.facts===childCall('qa-code','provider-execution.mjs','nativeFileReadCode',{path:i.facts_path,sha256:i.facts_sha256}),'NATIVE_NODE_READ_DRIFT');}
  if(packet){assertNativePacketBinding(i,{runDir,context});requireValue(i.spawn.message===packetMessage(i),'NATIVE_CONTEXT_DRIFT');requireValue(i.facts_path&&i.facts_path!==i.context_packet_path,'NATIVE_FACTS_REQUIRED');}
  else {const prefix=binding(i)+'\n'+context+'\n\n';requireValue(i.spawn.message.startsWith(prefix)&&sha256(i.spawn.message.slice(prefix.length))===i.prompt_sha256,'NATIVE_CONTEXT_DRIFT');}
  requireValue(i.facts_path?sha256File(i.facts_path)===i.facts_sha256:i.facts_sha256===null,'NATIVE_FACTS_DRIFT');
  return {intent:i,roster:r,seat};
}
async function phaseGate(runDir,role,{preflightFresh=true}={}){
  if(['test_manager','analyst'].includes(role)){
    const roster=assertApprovedRoster({runDir,role});
    if(roster.catalog_source.kind==='runtime')assertToolPreflight({runDir,roster,stage:'basic'});
    return;
  }
  const contract=await import('./run-contract.mjs');contract.assertRunContract({runDir,action:role==='designer'?'design':'execute',role,preDispatch:true,preflightFresh});
}
export function nativePrepareNodeCode({helper,request,node_path}) {
  const allowed=['runDir','role','prompt','factsPath','taskName','guiPolicyPath','nativeNodeReads','dispatchAttemptId','dispatchAttemptSeq','caseId'];
  rejectUnknownFields(helper,['path','sha256'],'NATIVE_PREPARE_HELPER_FIELDS');
  requireValue(helper?.path===join(ROOT,'scripts/lib/native-dispatch.mjs')&&helper.sha256===sha256File(helper.path),'NATIVE_PREPARE_MODULE_DRIFT');
  requireValue(typeof node_path==='string'&&node_path.startsWith('/')&&!/[\0\n\r]/.test(node_path),'NATIVE_PREPARE_NODE_PATH');
  rejectUnknownFields(request,allowed,'NATIVE_PREPARE_REQUEST_FIELDS');
  requireValue(typeof request?.runDir==='string'&&typeof request.role==='string'&&typeof request.prompt==='string'&&typeof request.factsPath==='string','NATIVE_PREPARE_REQUEST');
  const role=String(request.role).replaceAll('-','_'),seq=request.dispatchAttemptId===undefined?1:(request.dispatchAttemptSeq??attemptSequence(request.runDir,role));
  const intentPath=intentFile(request.runDir,role,seq);
  const effectiveRequest=request.dispatchAttemptId===undefined?request:{...request,dispatchAttemptSeq:seq};
  const worker='import {readFileSync} from "node:fs";import {createHash} from "node:crypto";const m=await import(process.argv[1]);let raw="";for await(const chunk of process.stdin)raw+=chunk;await m.prepareNativeRole(JSON.parse(raw));const p=process.argv[2];process.stdout.write(JSON.stringify({schema:"team-qa/native-prepare-result/v1",intent_path:p,intent_sha256:createHash("sha256").update(readFileSync(p)).digest("hex")}));';
  return 'var nativeFs=await import("node:fs/promises");var nativeCrypto=await import("node:crypto");if(nativeCrypto.createHash("sha256").update(await nativeFs.readFile('+JSON.stringify(helper.path)+')).digest("hex")!=='+JSON.stringify(helper.sha256)+')throw new Error("NATIVE_PREPARE_MODULE_DRIFT");var nativeChild=await import("node:child_process");var nativePrepared=nativeChild.spawnSync('+JSON.stringify(node_path)+',["--input-type=module","-e",'+JSON.stringify(worker)+','+JSON.stringify(helper.path)+','+JSON.stringify(intentPath)+'],{input:'+JSON.stringify(JSON.stringify(effectiveRequest))+',encoding:"utf8",timeout:30000,maxBuffer:2097152});if(nativePrepared.error||nativePrepared.status!==0||nativePrepared.signal||nativePrepared.stderr)throw new Error("NATIVE_PREPARE_EXECUTION_FAILED");var nativePreparedOutput=JSON.parse(nativePrepared.stdout);if(nativePreparedOutput.schema!=="team-qa/native-prepare-result/v1"||nativePreparedOutput.intent_path!=='+JSON.stringify(intentPath)+'||nativePreparedOutput.intent_sha256!==nativeCrypto.createHash("sha256").update(await nativeFs.readFile('+JSON.stringify(intentPath)+')).digest("hex"))throw new Error("NATIVE_PREPARE_RESULT_DRIFT");nodeRepl.write(JSON.stringify(nativePreparedOutput));';
}
function assertNativePrepareRecipe(recipe,{runDir,intent}) {
  rejectUnknownFields(recipe,['helper','request','node_path'],'NATIVE_PREPARE_RECIPE_FIELDS');
  const request=recipe.request;
  requireValue(resolve(request.runDir)===runDir&&String(request.role).replaceAll('-','_')===intent.role&&resolve(request.factsPath)===intent.facts_path&&(request.taskName||intent.spawn.task_name)===intent.spawn.task_name&&Boolean(request.nativeNodeReads)===Boolean(intent.native_node_reads)&&(!intent.native_gui||resolve(request.guiPolicyPath||'')===intent.native_gui.policy_path)&&((request.dispatchAttemptId===undefined&&!intent.dispatch_attempt_id)||(request.dispatchAttemptId===intent.dispatch_attempt_id&&[undefined,intent.dispatch_attempt_seq].includes(request.dispatchAttemptSeq)))&&request.caseId===intent.dispatch_case_id,'NATIVE_PREPARE_RECIPE_BINDING');
  const code=nativePrepareNodeCode({...recipe,request:intent.dispatch_attempt_seq?{...request,dispatchAttemptSeq:intent.dispatch_attempt_seq}:request});
  return code;
}
export async function prepareNativeRole({runDir,role,prompt,out,factsPath,taskName,guiPolicyPath,nativeNodeReads=false,dispatchAttemptId,dispatchAttemptSeq,caseId}){
  runDir=resolve(runDir);role=String(role).replaceAll('-','_');
  const r=assertApprovedRoster({runDir,role}),seat=r.roles.find(s=>s.role===role);
  requireValue(seat.harness==='codex-native','NATIVE_HARNESS_REQUIRED');requireValue(role!=='executor_code','NATIVE_CODE_USE_QA_CODE');requireValue(r.run_id===basename(runDir),'RUN_ID_MISMATCH');requireValue(seat.caps.max_turns===1,'NATIVE_SINGLE_TURN_REQUIRED');await phaseGate(runDir,role);
  const caseDecision=role==='executor_gui'?await continuationForCase(runDir,caseId):null;
  const primary=intentFile(runDir,role);let seq=1,id=null,previous=null;
  let previousIntent=null;
  if(dispatchAttemptId!==undefined){requireValue(existsSync(primary),'NATIVE_FIRST_ATTEMPT_REQUIRED');seq=attemptSequence(runDir,role);requireValue(dispatchAttemptSeq===undefined||dispatchAttemptSeq===seq,'NATIVE_ATTEMPT_SEQUENCE_DRIFT');id=dispatchAttemptId||randomUUID();requireValue(/^[A-Za-z0-9_-]{8,128}$/.test(id),'NATIVE_ATTEMPT_ID');const prior=intentFile(runDir,role,seq-1);requireValue(existsSync(prior),'NATIVE_PREVIOUS_ATTEMPT_MISSING');const priorIntent=readJson(prior),priorProof=terminalProofPath(runDir,role,seq-1);requireValue(attemptTerminal(runDir,priorIntent),'NATIVE_PREVIOUS_ATTEMPT_OPEN');previous=sha256File(priorProof);previousIntent=sha256File(prior);if(role==='executor_gui')requireValue(caseAttemptCount(runDir,role,caseId)<MAX_CASE_ATTEMPTS,'NATIVE_CASE_ATTEMPT_LIMIT');}
  const path=intentFile(runDir,role,seq);requireValue(!existsSync(path),'NATIVE_INTENT_EXISTS');
  const attemptDir=seq>1?dirname(path):join(runDir,'native-dispatch');
  const packetPath=seq>1?join(attemptDir,'context.md'):join(runDir,'native-dispatch',`${role}.context.md`);requireValue(!existsSync(packetPath),'NATIVE_PACKET_EXISTS');requireValue(!/[\0\n\r'`$]/.test(packetPath),'NATIVE_PACKET_PATH');
  requireValue(typeof factsPath==='string'&&factsPath.length>0&&resolve(factsPath)!==packetPath&&!/[\0\n\r'`$]/.test(resolve(factsPath)),'NATIVE_FACTS_REQUIRED');
  const task=taskName||`teamqa_${r.run_id.replaceAll('-','_')}_r${r.round}_${role}${seq>1?`_a${seq}`:''}`;requireValue(/^[a-z0-9_]+$/.test(task),'NATIVE_TASK_NAME');
  if(seq>1){requireValue(task!==readJson(intentFile(runDir,role,seq-1)).spawn.task_name,'NATIVE_TASK_REUSED');for(let n=1;n<seq-1;n++){const priorPath=intentFile(runDir,role,n);if(existsSync(priorPath))requireValue(task!==readJson(priorPath).spawn.task_name,'NATIVE_TASK_REUSED');}}
  const cap=readJson(join(ROOT,'references/roster-policy.json')).native_response_max_words;
  const gui=role==='executor_gui'?{policy_path:resolve(guiPolicyPath||''),policy_sha256:guiPolicyPath?sha256File(guiPolicyPath):null}:null;
  if(gui)assertNativeGuiPolicy({runDir,roster:r,policyPath:gui.policy_path,policySha256:gui.policy_sha256});
  else requireValue(!guiPolicyPath,'NATIVE_GUI_ROLE_MISMATCH');
  const policyText=gui?`\n\nDragon RPC envelope uses method and nested params (for example {"method":"do","params":{...}} or {"method":"screenshot","params":{...}}). Put sessionId, nonce, browserInstanceId, tabId and operation fields inside params; do not use op or top-level session fields. Method must be one declared by the locked policy.\n\nLocked native GUI policy (${gui.policy_sha256}):\n${stableJson(readJson(gui.policy_path))}`:'';
  const factsRead=nativeNodeReads?`text(await tools.mcp__node_repl__js(${JSON.stringify({code:childCall('qa-code','provider-execution.mjs','nativeFileReadCode',{path:resolve(factsPath),sha256:sha256File(factsPath)}),title:'Read scoped Team QA facts'})}));`:`text(await tools.exec_command(${JSON.stringify({cmd:`cat '${resolve(factsPath)}'`,login:false,max_output_tokens:16000})}));`;
  const body=readFileSync(prompt,'utf8')+`\n\nYour second tool call must be exactly:\n${factsRead}`+policyText+`\nFinal response limit: ${cap} whitespace-separated words.`,context=seat.context.map(x=>readFileSync(join(ROOT,x.path),'utf8')).join('\n\n');
  const i={schema:seq>1?'team-qa/native-dispatch/v3':'team-qa/native-dispatch/v2',run_id:r.run_id,round:r.round,roster_hash:r.roster_hash,role,parent_session_id:seat.native_host.session_id,created_at:new Date().toISOString(),prompt_sha256:sha256(body),spawn:{task_name:task,model:seat.model,reasoning_effort:seat.effort,fork_turns:'none',message:''},facts_path:resolve(factsPath),facts_sha256:sha256File(factsPath),context_packet_path:packetPath,context_packet_sha256:null,...(role==='executor_gui'?{dispatch_case_id:caseId,dispatch_progress_sha256:caseDecision.caseProgress}:{}),...(seq>1?{dispatch_attempt_id:id,dispatch_attempt_seq:seq,dispatch_previous_sha256:previous,dispatch_previous_intent_sha256:previousIntent}:{})};
  i.response_max_words=cap;if(gui)i.native_gui=gui;
  const packet=binding(i)+'\n'+context+'\n\n'+body;i.context_packet_sha256=sha256(packet);
  if(nativeNodeReads)i.native_node_reads={packet:childCall('qa-code','provider-execution.mjs','nativeFileReadCode',{path:packetPath,sha256:i.context_packet_sha256}),facts:childCall('qa-code','provider-execution.mjs','nativeFileReadCode',{path:i.facts_path,sha256:i.facts_sha256})};
  requireValue(!nativeNodeReads||i.native_node_reads.packet&&i.native_node_reads.facts,'NATIVE_NODE_READ_INTERFACE_REQUIRED');
  i.spawn.message=packetMessage(i);
  if(seq>1){mkdirSync(dirname(attemptDir),{recursive:true});try{mkdirSync(attemptDir,{recursive:false});}catch(error){if(error.code==='EEXIST')fail(3,'NATIVE_ATTEMPT_ALREADY_PREPARING');throw error;}}
  await writeConfirmed(packetPath,packet,'teamqa.native.context');
  await writeConfirmed(path,stableJson(i),'teamqa.native.prepare');checkIntent({runDir,intentPath:path});
  if(out&&resolve(out)!==path){requireValue(!existsSync(out),'NATIVE_OUTPUT_EXISTS');await writeConfirmed(out,stableJson(i),'teamqa.native.export');}
  return i;
}
export function assertNativeAttestationBinding(a,{intent,seat}){
  requireValue(a.run_id===intent.run_id&&a.round===intent.round&&a.roster_hash===intent.roster_hash&&a.role===intent.role&&seat.role===intent.role,'NATIVE_ATTESTATION_BINDING');
  if(intent.dispatch_attempt_seq){const expected=sha256(`${intent.dispatch_previous_sha256}\n${intent.dispatch_previous_intent_sha256}\n${intent.dispatch_attempt_id}\n${sha256(stableJson(intent))}`);requireValue(a.schema==='team-qa/role-attestation/v2'&&a.dispatch_attempt_id===intent.dispatch_attempt_id&&a.dispatch_attempt_seq===intent.dispatch_attempt_seq&&a.dispatch_chain_sha256===expected,'NATIVE_ATTESTATION_ATTEMPT_BINDING');}
  else if(intent.dispatch_attempt_seq!==undefined)requireValue(a.schema==='team-qa/role-attestation/v1','NATIVE_ATTESTATION_ATTEMPT_BINDING');
  const r=a.runtime;
  const epoch=a.source?.metadata_source?.native;
  const version=r?.origin_version? r.origin_version===seat.harness_version&&epoch?.parent_origin_version===seat.harness_version&&epoch?.child_version===r.version : !epoch?.child_version&&r?.version===seat.harness_version;
  requireValue(a.source?.kind==='codex-native'&&seat.provider==='openai'&&seat.harness==='codex-native'&&r?.provider===seat.provider&&r.harness===seat.harness&&version&&r.model===seat.model&&r.effort===seat.effort,'NATIVE_ATTESTATION_HARNESS');
  requireValue(r.sent?.model===intent.spawn.model&&r.sent?.effort===intent.spawn.reasoning_effort&&r.observed?.model===seat.model&&r.observed?.effort===seat.effort&&r.observed?.session_id===a.session_id&&a.agent_id===`codex-native:${a.session_id}`,'NATIVE_ATTESTATION_RUNTIME');
  requireValue(stableJson(a.context)===stableJson(seat.context),'NATIVE_ATTESTATION_CONTEXT');
}
function parseRoleEvidence(e,{runDir,intent:i,seat,evidencePath,allowExecutionFailure=false}){
  if(i.role==='executor_code')return childCall('qa-code','native-qa.mjs','verifyNativeQaSource',{evidencePath,proofPath:i.native_qa.review_proof_path,runtimePath:ROOT}).parsed;
  const epoch=nativeCreationEpoch({childSourcePath:e.child_source_path,parentSource:e.parent_source,host:seat.native_host});
  const policy=i.native_gui?assertNativeGuiPolicy({runDir,roster:assertApprovedRoster({runDir}),policyPath:i.native_gui.policy_path,policySha256:i.native_gui.policy_sha256}):null;
  const nativePrepareCode=e.native_prepare?assertNativePrepareRecipe(e.native_prepare,{runDir,intent:i}):null;
  const parsed=parseNativeRoleExecution({childSourcePath:e.child_source_path,parentSource:e.parent_source,expected:{intent_sha256:e.intent_sha256,...(nativePrepareCode?{native_prepare_code:nativePrepareCode}:{}),prepare_source:e.prepare_source,parent_session_id:i.parent_session_id,task_name:i.spawn.task_name,agent_path:seat.native_host.agent_path+'/'+i.spawn.task_name,context_marker:binding(i),model:i.spawn.model,reasoning_effort:i.spawn.reasoning_effort,message:i.spawn.message,facts_path:i.facts_path,facts_sha256:i.facts_sha256,context_packet_path:i.context_packet_path,context_packet_sha256:i.context_packet_sha256,harness_version:seat.harness_version,...epoch,allowedMcpServers:[],created_at:i.created_at,caps:seat.caps,...(policy?{trajectory_mode:'qa-gui',gui_policy:policy}:{})}});
  if(!allowExecutionFailure&&(!parsed.provenance_verified||parsed.errors?.length))fail(3,'NATIVE_RUNTIME_UNATTESTED',(parsed.errors||[]).join(','),'ungraded');
  if(!allowExecutionFailure||parsed.verdictText)assertNativeResponseCap(parsed,i);
  if(policy){
    const verified=childCall('qa-gui','native-gui-trajectory.mjs','validateNativeGuiTrajectory',{calls:parsed.gui_calls,policy});
    if(!allowExecutionFailure)requireValue(verified.verdict==='PASS'&&!verified.errors.length,'NATIVE_GUI_TRAJECTORY_UNATTESTED');
    else if(verified.verdict!=='PASS'||verified.errors.length){parsed.errors=[...new Set([...parsed.errors,...verified.errors.map(code=>`NATIVE_GUI_TRAJECTORY:${code}`)])];parsed.provenance_verified=false;}
    if(parsed.metadata_source?.native){
      parsed.metadata_source.native.gui_policy={path:i.native_gui.policy_path,sha256:i.native_gui.policy_sha256};
      parsed.metadata_source.native.gui_verification={verdict:allowExecutionFailure?verified.verdict:'PASS',policy_sha256:i.native_gui.policy_sha256};
    }
  }
  return parsed;
}
function hostDeniedRequestProof(lines,rows,parsed,intent){
  if(!intent.native_gui||parsed.gui_calls?.length!==1)return null;
  const call=parsed.gui_calls[0],input=rows[call.call_line-1],output=rows[call.output_line-1],p=input?.payload,q=output?.payload;
  if(call.status!=='failed'||input?.type!=='response_item'||p?.type!=='custom_tool_call'||p.name!=='exec'||![undefined,'functions'].includes(p.namespace)||output?.type!=='response_item'||q?.type!=='custom_tool_call_output'||!p.call_id||p.call_id!==q.call_id||output.metadata?.client_authored!==false)return null;
  if(rows.filter(row=>row.payload?.call_id===p.call_id).length!==2)return null;
  const literal=/^text\(await tools\.mcp__Dragon_Browser__dragon_rpc\((\{[^]*\})\)\);$/.exec(p.input?.trim()||'');
  if(!literal)return null;
  let request;try{request=JSON.parse(literal[1]);}catch{return null;}
  const policy=readJson(intent.native_gui.policy_path);
  // Only this malformed envelope is covered; a real session mismatch remains a denial.
  if(stableJson(request)!==stableJson(call.input)||request.op!=='do'||Object.hasOwn(request,'method')||Object.hasOwn(request,'params')||!['sessionId','nonce','browserInstanceId','tabId'].every(key=>request[key]===policy.dragon[key]))return null;
  const parts=q.output;
  if(!Array.isArray(parts)||parts.length!==2||parts.some(part=>part.type!=='input_text')||!/^Script failed\nWall time [0-9.]+ seconds\nOutput:\n$/.test(parts[0].text)||parts[1].text!=='Script error:\nTool call blocked by PreToolUse hook: DRAGON_REQUEST_INVALID. Tool: mcp__Dragon_Browser__dragon_rpc')return null;
  return {call_id:p.call_id,request_line:call.call_line,request_sha256:sha256(lines[call.call_line-1]),output_line:call.output_line,output_sha256:sha256(lines[call.output_line-1])};
}
function failureTerminal(childSourcePath,parsed,intent,seat){
  const child=realpathSync(childSourcePath),sessions=realpathSync(join(homedir(),'.codex/sessions'));
  requireValue(child.startsWith(sessions+'/')&&child.endsWith('.jsonl'),'NATIVE_FAILURE_SOURCE_UNTRUSTED');
  const lines=readFileSync(child,'utf8').split('\n');if(lines.at(-1)==='')lines.pop();
  const rows=lines.map(line=>JSON.parse(line)),meta=rows.filter(row=>row.type==='session_meta');
  requireValue(meta.length===1&&meta[0].payload.id===parsed.session_id,'NATIVE_FAILURE_SESSION_BINDING');
  requireValue(meta[0].payload.source?.subagent?.thread_spawn?.parent_thread_id===seat.native_host.session_id&&meta[0].payload.source?.subagent?.thread_spawn?.agent_path===`${seat.native_host.agent_path}/${intent.spawn.task_name}`,'NATIVE_FAILURE_AGENT_BINDING');
  const last=rows.at(-1),p=last?.payload||{};
  const failedEvent=last?.type==='event_msg'&&(/failed|aborted|interrupted|error/.test(p.type||'')||p.type==='task_complete'&&(p.error||p.status&&!['completed','success'].includes(p.status)));
  const timedOut=last?.type==='event_msg'&&p.type==='task_complete'&&!p.error&&['completed','success',undefined].includes(p.status)&&parsed.errors.includes('NATIVE_OBSERVED_TIMEOUT_EXCEEDED')&&parsed.observed_elapsed_ms>0;
  const starts=rows.filter(row=>row.type==='event_msg'&&row.payload?.type==='task_started'),turns=rows.filter(row=>row.type==='turn_context').map(row=>row.payload?.turn_id);
  const messages=rows.filter(row=>row.type==='response_item'&&row.payload?.type==='agent_message');
  // Parent corrections may reject this execution, but cannot turn a reused child into a new attempt.
  const singleTurn=starts.length===1&&turns.length>0&&new Set(turns).size===1&&turns[0]&&starts[0].payload.turn_id===turns[0]&&p.turn_id===turns[0]
    &&messages.every(row=>row.payload.author===seat.native_host.agent_path&&row.payload.recipient===`${seat.native_host.agent_path}/${intent.spawn.task_name}`);
  const rejected=last?.type==='event_msg'&&p.type==='task_complete'&&!p.error&&['completed','success',undefined].includes(p.status)&&singleTurn;
  requireValue(failedEvent||timedOut||rejected,'NATIVE_FAILURE_TERMINAL_REQUIRED');
  const denied=rejected&&!failedEvent&&!timedOut?hostDeniedRequestProof(lines,rows,parsed,intent):null;
  return {path:child,sha256:sha256File(child),terminal_line:rows.length,terminal_sha256:sha256(lines.at(-1)),kind:timedOut?'timeout':failedEvent?'execution_failure':'rejected_execution',...(denied?{host_denied_request:denied}:{})};
}
function failureOnly(errors,terminal){
  if(terminal.kind==='rejected_execution'){
    if(terminal.host_denied_request){
      const deniedErrors=new Set(['TOOL_FAILED','NATIVE_GUI_TRAJECTORY:NATIVE_GUI_REQUEST_UNKNOWN','NATIVE_GUI_TRAJECTORY:NATIVE_GUI_CAPABILITY_UNAPPROVED','NATIVE_GUI_TRAJECTORY:NATIVE_GUI_SESSION_DRIFT','NATIVE_GUI_TRAJECTORY:NATIVE_GUI_OPERATION_FAILED','NATIVE_GUI_TRAJECTORY:NATIVE_GUI_STATIC_IMAGE_REQUIRED']);
      return errors.includes('TOOL_FAILED')&&errors.includes('NATIVE_GUI_TRAJECTORY:NATIVE_GUI_REQUEST_UNKNOWN')&&errors.every(error=>deniedErrors.has(error));
    }
    const allowed=new Set(['NATIVE_SESSION_REUSED','NATIVE_TOOL_UNSUPPORTED','TOOL_FAILED','NATIVE_FACTS_OUTPUT_MISMATCH','UNAPPROVED_TOOL_OR_HELPER','NATIVE_FACTS_READ_MISSING','NATIVE_GUI_TRAJECTORY:NATIVE_GUI_CALL_CAP']);
    return errors.length>0&&errors.every(error=>allowed.has(error));
  }
  const allowed=terminal.kind==='timeout'?new Set(['NATIVE_OBSERVED_TIMEOUT_EXCEEDED']):new Set(['PROVIDER_EXECUTION_FAILED','VERDICT_MISSING','NATIVE_FINAL_AMBIGUOUS','MISSING_TERMINAL']);
  return errors.length>0&&errors.every(error=>allowed.has(error))&&(terminal.kind==='timeout'?errors.includes('NATIVE_OBSERVED_TIMEOUT_EXCEEDED'):errors.includes('PROVIDER_EXECUTION_FAILED'));
}
export function verifyNativeAttemptClosure({runDir,intent}){
  const seq=intent.dispatch_attempt_seq||1,path=join(runDir,'native-dispatch',intent.role,`attempt-${seq}`,'closed.json');if(!existsSync(path))return false;
  try{
    const receipt=readJson(path);rejectUnknownFields(receipt,['schema','run_id','round','roster_hash','role','dispatch_attempt_id','dispatch_attempt_seq','intent_path','intent_sha256','prepare_source','parent_source','child_source_path','native_prepare','terminal','parser_errors'],'NATIVE_CLOSURE_FIELDS');
    requireValue(receipt.schema==='team-qa/native-attempt-closure/v1'&&receipt.run_id===intent.run_id&&receipt.round===intent.round&&receipt.roster_hash===intent.roster_hash&&receipt.role===intent.role&&receipt.dispatch_attempt_id===(intent.dispatch_attempt_id||null)&&receipt.dispatch_attempt_seq===seq,'NATIVE_CLOSURE_BINDING');
    requireValue(resolve(receipt.intent_path)===intentFile(runDir,intent.role,seq)&&sha256File(receipt.intent_path)===receipt.intent_sha256&&receipt.intent_sha256===sha256File(intentFile(runDir,intent.role,seq)),'NATIVE_CLOSURE_INTENT');
    const {intent:locked,seat}=checkIntent({runDir,intentPath:receipt.intent_path});
    const evidence={schema:'team-qa/native-evidence/v1',intent_path:receipt.intent_path,intent_sha256:receipt.intent_sha256,prepare_source:receipt.prepare_source,parent_source:receipt.parent_source,child_source_path:receipt.child_source_path,...(receipt.native_prepare?{native_prepare:receipt.native_prepare}:{})};
    const parsed=parseRoleEvidence(evidence,{runDir,intent:locked,seat,allowExecutionFailure:true});
    const terminal=failureTerminal(receipt.child_source_path,parsed,locked,seat);
    requireValue(stableJson(terminal)===stableJson(receipt.terminal)&&stableJson(parsed.errors)===stableJson(receipt.parser_errors)&&failureOnly(parsed.errors,terminal),'NATIVE_CLOSURE_EVIDENCE');
    return true;
  }catch{return false;}
}
export async function closeNativeAttempt({runDir,intentPath,prepareSource,parentSource,childSourcePath,nativePrepare}){
  runDir=resolve(runDir);const {intent,seat}=checkIntent({runDir,intentPath});const seq=intent.dispatch_attempt_seq||1;requireValue(resolve(intentPath)===intentFile(runDir,intent.role,seq),'NATIVE_CLOSURE_ATTEMPT_REQUIRED');
  const path=join(runDir,'native-dispatch',intent.role,`attempt-${seq}`,'closed.json');requireValue(!existsSync(path),'NATIVE_ATTEMPT_ALREADY_CLOSED');
  const evidence={schema:'team-qa/native-evidence/v1',intent_path:resolve(intentPath),intent_sha256:sha256File(intentPath),prepare_source:prepareSource,parent_source:parentSource,child_source_path:resolve(childSourcePath),...(nativePrepare?{native_prepare:nativePrepare}:{})};
  const parsed=parseRoleEvidence(evidence,{runDir,intent,seat,allowExecutionFailure:true});const terminal=failureTerminal(childSourcePath,parsed,intent,seat);
  requireValue(failureOnly(parsed.errors,terminal),'NATIVE_CLOSURE_EVIDENCE');
  const receipt={schema:'team-qa/native-attempt-closure/v1',run_id:intent.run_id,round:intent.round,roster_hash:intent.roster_hash,role:intent.role,dispatch_attempt_id:intent.dispatch_attempt_id||null,dispatch_attempt_seq:seq,intent_path:evidence.intent_path,intent_sha256:evidence.intent_sha256,prepare_source:prepareSource,parent_source:parentSource,child_source_path:evidence.child_source_path,...(nativePrepare?{native_prepare:nativePrepare}:{}),terminal,parser_errors:parsed.errors};
  await writeConfirmed(path,stableJson(receipt),'teamqa.native.attempt.close');requireValue(verifyNativeAttemptClosure({runDir,intent}),'NATIVE_CLOSURE_READBACK');return receipt;
}
export function verifyNativeRoleSource(a,{runDir}){
  const sourcePath=resolve(runDir,a.source.path);requireValue(sourcePath.startsWith(resolve(runDir)+'/')&&a.graded===true&&sha256File(sourcePath)===a.source.sha256,'NATIVE_SOURCE_HASH');
  const e=readJson(sourcePath);rejectUnknownFields(e,['schema','intent_path','intent_sha256','prepare_source','parent_source','child_source_path','native_prepare'],'NATIVE_EVIDENCE_FIELDS');
  requireValue(e.schema==='team-qa/native-evidence/v1'&&sha256File(e.intent_path)===e.intent_sha256,'NATIVE_INTENT_DRIFT');
  const {intent:i,seat}=checkIntent({runDir,intentPath:e.intent_path});
  assertNativeAttestationBinding(a,{intent:i,seat});
  const parsed=parseRoleEvidence(e,{runDir,intent:i,seat,evidencePath:sourcePath});
  requireValue(parsed.provenance_verified===true&&!parsed.errors?.length,'NATIVE_RUNTIME_UNATTESTED');requireValue(parsed.session_id===a.session_id&&parsed.observed.model===a.runtime.model&&parsed.observed.reasoning===a.runtime.effort,'NATIVE_RUNTIME_DRIFT');
  requireValue(a.runtime.version===parsed.metadata_source?.native?.child_version&&a.runtime.origin_version===parsed.metadata_source?.native?.parent_origin_version,'NATIVE_RUNTIME_VERSION_DRIFT');
  const saved=a.source.metadata_source,current=parsed.metadata_source;
  const oldNative=saved?.native,newNative=current?.native;
  requireValue(Number.isInteger(oldNative?.child_prefix_lines)&&oldNative.child_prefix_lines>0&&oldNative.child_prefix_lines<=newNative?.child_prefix_lines,'NATIVE_METADATA_DRIFT');
  const normalized=m=>({...m,native:{...m.native,child_prefix_lines:null,child_prefix_sha256:null}});
  requireValue(stableJson(normalized(saved))===stableJson(normalized(current))&&sha256(readFileSync(current.path,'utf8').split('\n').slice(0,oldNative.child_prefix_lines).join('\n'))===oldNative.child_prefix_sha256,'NATIVE_METADATA_DRIFT');
  return parsed;
}
export async function attestNativeRole({runDir,intentPath,prepareSource,parentSource,childSourcePath,out,nativePrepare}){
  runDir=resolve(runDir);const {intent:i,seat}=checkIntent({runDir,intentPath});requireValue(i.role!=='executor_code','NATIVE_CODE_USE_QA_CODE');await phaseGate(runDir,i.role,{preflightFresh:false});
  requireValue(typeof out==='string'&&out.length>0,'NATIVE_OUTPUT_REQUIRED');
  const bindingPath=i.dispatch_attempt_seq?join(runDir,'role-bindings',i.role,`attempt-${i.dispatch_attempt_seq}.json`):join(runDir,'role-bindings',`${i.role}.json`);
  const currentClosed=join(runDir,'native-dispatch',i.role,`attempt-${i.dispatch_attempt_seq||1}`,'closed.json');
  requireValue((i.dispatch_attempt_seq?attemptTerminal(runDir,readJson(intentFile(runDir,i.role,i.dispatch_attempt_seq-1))):!existsSync(bindingPath))&&!existsSync(bindingPath)&&!existsSync(currentClosed)&&(!i.dispatch_attempt_seq||resolve(out)===bindingPath)&&!existsSync(out),'NATIVE_ALREADY_BOUND');
  const e={schema:'team-qa/native-evidence/v1',intent_path:resolve(intentPath),intent_sha256:sha256File(intentPath),prepare_source:prepareSource,parent_source:parentSource,child_source_path:resolve(childSourcePath),...(nativePrepare?{native_prepare:nativePrepare}:{})};
  const parsed=parseRoleEvidence(e,{runDir,intent:i,seat});
  requireValue(parsed.provenance_verified===true&&!parsed.errors?.length,'NATIVE_RUNTIME_UNATTESTED');
  const evidenceDir=i.dispatch_attempt_seq?dirname(intentPath):join(runDir,'native-dispatch');
  const path=join(evidenceDir,i.dispatch_attempt_seq?'evidence.json':`${i.role}.evidence.json`),stderr=join(evidenceDir,i.dispatch_attempt_seq?'stderr.txt':`${i.role}.stderr.txt`);requireValue(!existsSync(path),'NATIVE_EVIDENCE_EXISTS');
  await writeConfirmed(path,stableJson(e),'teamqa.native.evidence');await writeConfirmed(stderr,'','teamqa.native.no-stderr');
  const a={schema:i.dispatch_attempt_seq?'team-qa/role-attestation/v2':'team-qa/role-attestation/v1',run_id:i.run_id,round:i.round,roster_hash:i.roster_hash,role:i.role,agent_id:`codex-native:${parsed.session_id}`,session_id:parsed.session_id,runtime:{provider:'openai',model:seat.model,effort:seat.effort,harness:'codex-native',version:parsed.metadata_source.native.child_version,origin_version:seat.native_host.version,sent:{model:i.spawn.model,effort:i.spawn.reasoning_effort},observed:{model:parsed.observed.model,effort:parsed.observed.reasoning,session_id:parsed.session_id}},context:seat.context,source:{kind:'codex-native',path,sha256:sha256File(path),stderr_path:stderr,stderr_sha256:sha256File(stderr),metadata_source:parsed.metadata_source},graded:true,...(i.dispatch_attempt_seq?{dispatch_attempt_id:i.dispatch_attempt_id,dispatch_attempt_seq:i.dispatch_attempt_seq,dispatch_chain_sha256:sha256(`${i.dispatch_previous_sha256}\n${i.dispatch_previous_intent_sha256}\n${i.dispatch_attempt_id}\n${sha256(stableJson(i))}`)}:{})};
  assertNativeAttestationBinding(a,{intent:i,seat});
  if(!i.dispatch_attempt_seq)await writeConfirmed(out,stableJson(a),'teamqa.native.attestation');const contract=await import('./run-contract.mjs');await contract.bindRoleAttestation({runDir,attestation:a});return a;
}
