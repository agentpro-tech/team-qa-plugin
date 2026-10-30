import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {parseCodexNativeExecution,validateProviderExecution} from './provider-execution.mjs';
import {verifyTeamQaReviewProof} from './teamqa-review-proof.mjs';
import {buildPrompt,gate0IsUsable} from './qa-harness.mjs';
import {spawnSync} from 'node:child_process';
import {scanOriginalSource} from './original-source.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const fileHash=p=>hash(readFileSync(p));
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const requireValue=(v,error)=>{if(!v)throw new Error(error);};
function repoSnapshot(repo){return Object.fromEntries([['status',['status','--porcelain=v1','--untracked-files=all']],['worktree',['diff','--no-ext-diff']],['index',['diff','--cached','--no-ext-diff']]].map(([key,args])=>{const result=spawnSync('git',['-C',repo,...args],{encoding:'utf8'});requireValue(result.status===0,'NATIVE_REPO_SNAPSHOT_FAILED');return [key,hash(result.stdout)];}));}
function exact(value,keys){requireValue(value&&same(Object.keys(value).sort(),keys.sort()),'NATIVE_INTENT_FIELDS');}
function writeNew(path,value){requireValue(!existsSync(path),'NATIVE_OUTPUT_EXISTS');mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,value,{flag:'wx'});}
function paths(proof){const dir=join(realpathSync(proof.run_dir),'native-dispatch');return {intent:join(dir,'executor_code.json'),packet:join(dir,'executor_code.context.md'),facts:join(dir,'executor_code.facts.md')};}
function binding(proof){return `TEAMQA_RUN_BINDING run=${proof.run_id} round=${proof.round} role=executor_code roster=${proof.roster_hash}`;}
function context(proof){return proof.context.map(item=>{const path=realpathSync(join(proof.runtime_root,item.path));const rel=relative(proof.runtime_root,path);requireValue(!rel.startsWith('..')&&!isAbsolute(rel)&&fileHash(path)===item.sha256,'NATIVE_CONTEXT_DRIFT');return readFileSync(path,'utf8');}).join('\n\n');}
function body(facts){return `Read the complete QA evidence and judge rules with exactly this tool call:\ntext(await tools.exec_command(${JSON.stringify({cmd:`cat '${facts}'`,login:false,max_output_tokens:16000})}));\nFollow that QA Code judge contract. Return exactly one verdict JSON object in the final response. No other tools, helpers, writes or follow-up turns are permitted.`;}
function pointer(i){return `${binding(i)}\nRead this locked context packet before following the task inside it. Its SHA256 is ${i.context_packet_sha256}.\nYour first tool call must be exactly:\n// @exec: {"max_output_tokens": 20000}\ntext(await tools.exec_command(${JSON.stringify({cmd:`cat '${i.context_packet_path}'`,login:false,max_output_tokens:16000})}));\nFollow the role, skill and scoped task in that packet; read the separate facts as instructed there. Do not call other tools or write files. End with the requested final response.`;}
function assertSeat(proof){const seat=proof.resolved_seat;requireValue(seat?.harness==='codex-native'&&seat.provider==='openai'&&seat.native_host?.session_id&&seat.caps.max_turns===1,'NATIVE_SEAT_REQUIRED');return seat;}
export function prepareNativeQa({options,proof,repo,commits,gate0,prompt}){
 const seat=assertSeat(proof),p=paths(proof);requireValue(resolve(options.nativePrepare)===p.intent,'NATIVE_INTENT_PATH');
 requireValue(options.mode==='static','NATIVE_STATIC_ONLY');
 const contents=body(p.facts),packet=binding(proof)+'\n'+context(proof)+'\n\n'+contents;
 const i={schema:'team-qa/native-dispatch/v2',run_id:proof.run_id,round:proof.round,roster_hash:proof.roster_hash,role:'executor_code',parent_session_id:seat.native_host.session_id,created_at:new Date().toISOString(),prompt_sha256:hash(contents),spawn:{task_name:`teamqa_${proof.run_id.replaceAll('-','_')}_r${proof.round}_executor_code`,model:seat.model,reasoning_effort:seat.effort,fork_turns:'none',message:''},facts_path:p.facts,facts_sha256:hash(prompt),context_packet_path:p.packet,context_packet_sha256:hash(packet),native_qa:{schema:'qa-code/native-intent/v1',repo,base:commits.base,head:commits.head,mode:'static',gate0_path:realpathSync(options.gate0),gate0_sha256:fileHash(options.gate0),review_proof_path:realpathSync(options.teamqaProof),review_proof_sha256:fileHash(options.teamqaProof),qa_prompt_sha256:hash(prompt),repo_snapshot:repoSnapshot(repo)}};
 requireValue(/^[a-z0-9_]+$/.test(i.spawn.task_name)&&!/[\0\n\r'`$]/.test(p.packet+p.facts),'NATIVE_PATH_OR_TASK_INVALID');i.spawn.message=pointer(i);
 for(const path of Object.values(p))requireValue(!existsSync(path),'NATIVE_OUTPUT_EXISTS');
 writeNew(p.facts,prompt);writeNew(p.packet,packet);writeNew(p.intent,JSON.stringify(i,null,2)+'\n');return i;
}
export function verifyNativeQaIntent({intentPath,proofPath,runtimePath,}){
 const i=json(intentPath),q=i.native_qa;
 exact(i,['schema','run_id','round','roster_hash','role','parent_session_id','created_at','prompt_sha256','spawn','facts_path','facts_sha256','context_packet_path','context_packet_sha256','native_qa']);
 exact(q,['schema','repo','base','head','mode','gate0_path','gate0_sha256','review_proof_path','review_proof_sha256','qa_prompt_sha256','repo_snapshot']);
 exact(i.spawn,['task_name','model','reasoning_effort','fork_turns','message']);requireValue(i.schema==='team-qa/native-dispatch/v2'&&i.role==='executor_code'&&q?.schema==='qa-code/native-intent/v1'&&q.mode==='static','NATIVE_QA_SCHEMA');
 requireValue(realpathSync(proofPath)===q.review_proof_path&&fileHash(proofPath)===q.review_proof_sha256,'NATIVE_REVIEW_PROOF_DRIFT');
 const proof=verifyTeamQaReviewProof({proofPath,runtimePath,repo:q.repo,base:q.base,head:q.head,provider:'openai',model:i.spawn.model,reasoning:i.spawn.reasoning_effort,stage:'sealed'});
 const seat=assertSeat(proof),p=paths(proof),gate=json(q.gate0_path);
 requireValue(fileHash(q.gate0_path)===q.gate0_sha256&&gate.repo===q.repo&&gate.base===q.base&&gate.commit===q.head&&gate0IsUsable(gate),'NATIVE_GATE0_DRIFT');
 requireValue(spawnSync('git',['-C',q.repo,'rev-parse','HEAD'],{encoding:'utf8'}).stdout?.trim()===q.head,'NATIVE_REPO_HEAD_DRIFT');
 const prompt=binding(proof)+'\n'+context(proof)+'\n\n'+buildPrompt(q.repo,'static',gate,{base:q.base,head:q.head});
 const contents=body(p.facts),packet=binding(proof)+'\n'+context(proof)+'\n\n'+contents;
 requireValue(same(q.repo_snapshot,repoSnapshot(q.repo)),'NATIVE_REPO_TAMPERING');
 requireValue(resolve(intentPath)===p.intent&&i.facts_path===p.facts&&i.context_packet_path===p.packet,'NATIVE_INTENT_PATH');
 requireValue(i.run_id===proof.run_id&&i.round===proof.round&&i.roster_hash===proof.roster_hash&&i.parent_session_id===seat.native_host.session_id,'NATIVE_INTENT_BINDING');
 requireValue(i.spawn.model===seat.model&&i.spawn.reasoning_effort===seat.effort&&i.spawn.fork_turns==='none'&&i.spawn.task_name===`teamqa_${proof.run_id.replaceAll('-','_')}_r${proof.round}_executor_code`&&i.spawn.message===pointer(i),'NATIVE_SPAWN_DRIFT');
 requireValue(i.prompt_sha256===hash(contents)&&i.context_packet_sha256===hash(packet)&&fileHash(p.packet)===hash(packet)&&q.qa_prompt_sha256===hash(prompt)&&i.facts_sha256===hash(prompt)&&fileHash(p.facts)===hash(prompt),'NATIVE_QA_PROMPT_DRIFT');
 return {intent:i,proof,seat};
}
export function verifyNativeQaSource({evidencePath,proofPath,runtimePath,}){
 const e=json(evidencePath);requireValue(e.schema==='team-qa/native-evidence/v1'&&same(Object.keys(e).sort(),['schema','intent_path','intent_sha256','prepare_source','parent_source','child_source_path'].sort())&&fileHash(e.intent_path)===e.intent_sha256,'NATIVE_EVIDENCE_DRIFT');
 const checked=verifyNativeQaIntent({intentPath:e.intent_path,proofPath,runtimePath}),{intent:i,seat}=checked;
 let childVersion,turnSource;
 scanOriginalSource(e.child_source_path,line=>{if(childVersion||!line.includes('session_meta'))return;const row=JSON.parse(line);if(row.type==='session_meta')childVersion=row.payload?.cli_version;});
 scanOriginalSource(e.parent_source.path,(line,index)=>{if(index>=e.parent_source.line||!line.includes('turn_context'))return;const row=JSON.parse(line);if(row.type==='turn_context')turnSource={line:index,sha256:hash(line),turn_id:row.payload?.turn_id};});
 requireValue(typeof childVersion==='string'&&childVersion.length>0&&turnSource,'NATIVE_RUNTIME_EPOCH_MISSING');
 const parsed=parseCodexNativeExecution({childSourcePath:e.child_source_path,parentSource:e.parent_source,expected:{intent_sha256:e.intent_sha256,prepare_source:e.prepare_source,parent_session_id:i.parent_session_id,task_name:i.spawn.task_name,agent_path:seat.native_host.agent_path+'/'+i.spawn.task_name,context_marker:binding(i),model:seat.model,reasoning_effort:seat.effort,message:i.spawn.message,facts_path:i.facts_path,facts_sha256:i.facts_sha256,context_packet_path:i.context_packet_path,context_packet_sha256:i.context_packet_sha256,harness_version:seat.harness_version,child_version:childVersion,parent_origin_version:seat.native_host.origin_version||seat.native_host.version,parent_turn_source:turnSource,created_at:i.created_at,caps:seat.caps}});
 const errors=validateProviderExecution(parsed,{provider:'openai',model:seat.model,reasoning:seat.effort,mode:'static'});requireValue(parsed.provenance_verified&&!errors.length,'NATIVE_RUNTIME_UNATTESTED:'+errors.join(';'));
 requireValue(parsed.session_id!==checked.proof.coder.session_id&&`codex-native:${parsed.session_id}`!==checked.proof.coder.agent_id,'NATIVE_REVIEWER_NOT_INDEPENDENT');return {...checked,parsed,evidence:e};
}
export function loadNativeQaExecution({options,proof,repo,commits,gate0,prompt}){
 const evidencePath=realpathSync(options.nativeExecution),{parsed,intent:i,seat}=verifyNativeQaSource({evidencePath,proofPath:options.teamqaProof,runtimePath:options.teamqaRuntime});
 requireValue(i.native_qa.repo===repo&&i.native_qa.base===commits.base&&i.native_qa.head===commits.head&&i.native_qa.gate0_sha256===fileHash(options.gate0),'NATIVE_QA_TARGET_DRIFT');
 const stderrPath=options.receipt+'.native.stderr';writeNew(stderrPath,'');
 const attestation={schema:'team-qa/role-attestation/v1',run_id:proof.run_id,round:proof.round,roster_hash:proof.roster_hash,context:proof.context,role:'executor_code',agent_id:`codex-native:${parsed.session_id}`,session_id:parsed.session_id,runtime:{provider:'openai',model:seat.model,effort:seat.effort,harness:'codex-native',version:parsed.metadata_source.native.child_version,origin_version:seat.native_host.origin_version||seat.native_host.version,sent:{model:seat.model,effort:seat.effort},observed:{model:parsed.observed.model,effort:parsed.observed.reasoning,session_id:parsed.session_id}},source:{kind:'codex-native',path:evidencePath,sha256:fileHash(evidencePath),stderr_path:stderrPath,stderr_sha256:hash(''),metadata_source:parsed.metadata_source},graded:true};
 const execution={schema:'qa-code/provider-execution/v1',provider:'openai',harness:'codex-native',sent:{model:seat.model,reasoning:seat.effort},observed:parsed.observed,session_id:parsed.session_id,metadata_source:parsed.metadata_source,source:{path:evidencePath,sha256:fileHash(evidencePath)},stderr_source:{path:stderrPath,sha256:hash('')},errors:[],attestation,native_review:{proof_path:realpathSync(options.teamqaProof),runtime_path:proof.runtime_root}};
 writeNew(options.receipt+'.role-attestation.json',JSON.stringify(attestation,null,2)+'\n');return {parsed,execution,attestation};
}
