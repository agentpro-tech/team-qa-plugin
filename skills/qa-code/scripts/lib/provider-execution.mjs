import {readFileSync,readdirSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import { createHash } from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {scanOriginalSource} from './original-source.mjs';

function hashLine(line) {return createHash('sha256').update(line).digest('hex');}

export function parseCodexRuntimeMetadata(text,{sessionId,path}) {
  let session=null;let context=null;
  const lines=String(text).split('\n');
  for(let i=0;i<lines.length;i++) {
    let event;try{event=JSON.parse(lines[i]);}catch{continue;}
    if(event.type==='session_meta')session={event,line:i+1,hash:hashLine(lines[i])};
    if(event.type==='turn_context')context={event,line:i+1,hash:hashLine(lines[i])};
  }
  const p=context?.event?.payload;
  const reasoning=p?.effort || p?.reasoning_effort || p?.collaboration_mode?.settings?.reasoning_effort;
  if(session?.event?.payload?.id!==sessionId || !p?.model || !reasoning || !p?.turn_id)return null;
  return {kind:'codex-rollout',path,session_id:sessionId,session_meta_line:session.line,session_meta_sha256:session.hash,turn_context_line:context.line,turn_context_sha256:context.hash,model:p.model,reasoning,turn_id:p.turn_id};
}

function scanCodexRuntimeMetadata(path,sessionId) {
 let session=null,context=null;
 scanOriginalSource(path,(line,index)=>{
  if(!line.includes('session_meta')&&!line.includes('turn_context'))return;
  let event;try{event=JSON.parse(line);}catch{return;}
  if(event.type==='session_meta')session={event,line:index,hash:hashLine(line)};
  if(event.type==='turn_context')context={event,line:index,hash:hashLine(line)};
 });
 const p=context?.event?.payload;
 const reasoning=p?.effort||p?.reasoning_effort||p?.collaboration_mode?.settings?.reasoning_effort;
 if(session?.event?.payload?.id!==sessionId||!p?.model||!reasoning||!p?.turn_id)return null;
 return {kind:'codex-rollout',path,session_id:sessionId,session_meta_line:session.line,session_meta_sha256:session.hash,turn_context_line:context.line,turn_context_sha256:context.hash,model:p.model,reasoning,turn_id:p.turn_id};
}

export function verifyCodexMetadataSource(source,{sessionId}) {
  let root;try{root=realpathSync(join(homedir(),'.codex','sessions'));}catch{throw new Error('CODEX_METADATA_SOURCE_ROOT_MISSING');}
  let path;try{path=realpathSync(source.path);}catch{throw new Error('CODEX_METADATA_SOURCE_MISSING');}
  if(!path.startsWith(root+sep)||source.kind!=='codex-rollout')throw new Error('CODEX_METADATA_SOURCE_UNTRUSTED');
  let sessionLine,contextLine;
  scanOriginalSource(path,(line,index)=>{if(index===source.session_meta_line)sessionLine=line;if(index===source.turn_context_line)contextLine=line;});
  if(!sessionLine||!contextLine||hashLine(sessionLine)!==source.session_meta_sha256||hashLine(contextLine)!==source.turn_context_sha256)throw new Error('CODEX_METADATA_SOURCE_HASH_MISMATCH');
  const session=JSON.parse(sessionLine),context=JSON.parse(contextLine);
  if(session.type!=='session_meta'||session.payload?.id!==sessionId||source.session_id!==sessionId||context.type!=='turn_context')throw new Error('CODEX_METADATA_SOURCE_SESSION_MISMATCH');
  const p=context.payload;
  const reasoning=p?.effort || p?.reasoning_effort || p?.collaboration_mode?.settings?.reasoning_effort;
  if(!p?.model||!reasoning||!p?.turn_id)throw new Error('CODEX_METADATA_SOURCE_CONFIG_MISSING');
  if(p.model!==source.model||reasoning!==source.reasoning||p.turn_id!==source.turn_id)throw new Error('CODEX_METADATA_SOURCE_OBSERVED_MISMATCH');
  return {model:p.model,reasoning,turn_id:p.turn_id,path};
}

export function readCodexRuntimeMetadata({sessionId}) {
  if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(sessionId || ''))return null;
  const root=join(homedir(),'.codex','sessions');
  try {
    const dirs=(path,pattern)=>readdirSync(path).filter(name=>pattern.test(name)).sort().slice(-2).reverse();
    let scanned=0;
    for(const year of dirs(root,/^\d{4}$/))for(const month of dirs(join(root,year),/^\d{2}$/))for(const day of dirs(join(root,year,month),/^\d{2}$/)) {
      const dir=join(root,year,month,day);
      for(const name of readdirSync(dir).slice(0,2048)) {
        if(++scanned>8192)return null;
        if(!name.endsWith('.jsonl')||!name.includes(sessionId))continue;
        const path=realpathSync(join(dir,name));
        const source=scanCodexRuntimeMetadata(path,sessionId);
        if(source){verifyCodexMetadataSource(source,{sessionId});return source;}
      }
    }
  }catch{return null;}
  return null;
}

// Claude Code `-p` stream-json carries the model but not the reasoning effort. The worker's
// original transcript (~/.claude/projects/<project>/<session-id>.jsonl) records both on every
// assistant turn; it is the only accepted source for the observed Claude configuration.
const CLAUDE_SESSION=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function claudeProjectsRoot(){try{return realpathSync(join(homedir(),'.claude','projects'));}catch{return null;}}
function scanClaudeRuntimeMetadata(path,sessionId){
 const models=new Set(),efforts=new Set(),versions=new Set();let first=null,foreign=false;
 scanOriginalSource(path,(line,index)=>{
  if(!line.includes('"assistant"'))return;
  let e;try{e=JSON.parse(line);}catch{return;}
  if(e.type!=='assistant'||e.isSidechain===true||e.message?.role!=='assistant')return;
  if(e.sessionId!==sessionId){foreign=true;return;}
  const model=e.message?.model;if(!model||model==='<synthetic>')return;
  models.add(model);efforts.add(typeof e.effort==='string'&&e.effort?e.effort:null);if(e.version)versions.add(e.version);
  if(!first)first={line:index,hash:hashLine(line)};
 });
 if(foreign||!first||models.size!==1||efforts.size!==1||efforts.has(null)||versions.size>1)return null;
 return {kind:'claude-transcript',path,session_id:sessionId,observed_line:first.line,observed_sha256:first.hash,model:[...models][0],reasoning:[...efforts][0],version:[...versions][0]||null};
}
function claudeTranscriptMatches(root,sessionId){
  const matches=[];
  for(const project of readdirSync(root).slice(0,4096)){try{matches.push(realpathSync(join(root,project,`${sessionId}.jsonl`)));}catch{continue;}}
  return matches;
}
export function verifyClaudeMetadataSource(source,{sessionId}) {
  if(!CLAUDE_SESSION.test(sessionId||''))throw new Error('CLAUDE_METADATA_SOURCE_SESSION_MISMATCH');
  const root=claudeProjectsRoot();if(!root)throw new Error('CLAUDE_METADATA_SOURCE_ROOT_MISSING');
  let path;try{path=realpathSync(source.path);}catch{throw new Error('CLAUDE_METADATA_SOURCE_MISSING');}
  if(source.kind!=='claude-transcript'||!path.startsWith(root+sep)||resolve(path,'..','..')!==root||!path.endsWith(`${sep}${sessionId}.jsonl`))throw new Error('CLAUDE_METADATA_SOURCE_UNTRUSTED');
  if(source.session_id!==sessionId)throw new Error('CLAUDE_METADATA_SOURCE_SESSION_MISMATCH');
  // Session IDs can repeat across project folders; exactly one original transcript may attest.
  const matches=claudeTranscriptMatches(root,sessionId);
  if(matches.length!==1||matches[0]!==path)throw new Error('CLAUDE_METADATA_SOURCE_AMBIGUOUS');
  const actual=scanClaudeRuntimeMetadata(path,sessionId);
  if(!actual)throw new Error('CLAUDE_METADATA_SOURCE_CONFIG_MISSING');
  if(actual.observed_line!==source.observed_line||actual.observed_sha256!==source.observed_sha256)throw new Error('CLAUDE_METADATA_SOURCE_HASH_MISMATCH');
  if(actual.model!==source.model||actual.reasoning!==source.reasoning||actual.version!==source.version)throw new Error('CLAUDE_METADATA_SOURCE_OBSERVED_MISMATCH');
  return {model:actual.model,reasoning:actual.reasoning,path};
}
export function readClaudeRuntimeMetadata({sessionId}) {
  if(!CLAUDE_SESSION.test(sessionId||''))return null;
  const root=claudeProjectsRoot();if(!root)return null;
  try {
    const matches=claudeTranscriptMatches(root,sessionId);
    if(matches.length!==1)return null;
    const source=scanClaudeRuntimeMetadata(matches[0],sessionId);
    if(source){verifyClaudeMetadataSource(source,{sessionId});return source;}
  }catch{return null;}
  return null;
}

function nativeEmpty() {
  return {provider:'openai',harness:'codex-native',session_id:null,observed:{model:null,reasoning:null},tool_log:[],verdictText:null,errors:[],metadata_source:null,provenance_verified:false,context_evidence:null};
}
function nativeText(content) {
  if(!Array.isArray(content)||content.some(x=>!['input_text','output_text'].includes(x.type)))return null;
  return content.map(x=>x.text || '').join('');
}
function nativeOutput(value,{strictExec=false}={}) {
  if(strictExec&&(!Array.isArray(value)||value.length!==2||!/^Script completed\nWall time [0-9]+(?:\.[0-9]+)? seconds\nOutput:\n$/.test(value[0]?.text||'')))return null;
  if(typeof value==='string'){try{return JSON.parse(value);}catch{return null;}}
  if(!Array.isArray(value)||!value.length||value.some(x=>!['input_text','output_text','text'].includes(x.type)||typeof x.text!=='string'))return null;
  let payload;
  if(value.length===1)payload=value[0].text;
  else if(value.length===2&&/^Script completed\nWall time [0-9]+(?:\.[0-9]+)? seconds\nOutput:\n$/.test(value[0].text))payload=value[1].text;
  else return null;
  try{return JSON.parse(payload);}catch{return null;}
}
function nativeLineHashMatches(lines,line,sha256) {
  return Number.isInteger(line)&&line>0&&/^[a-f0-9]{64}$/.test(sha256 || '')&&hashLine(lines[line-1] || '')===sha256;
}
function nativePacketMode(expected) {
  const enabled=Object.hasOwn(expected,'context_packet_path')||Object.hasOwn(expected,'context_packet_sha256');
  const safe=path=>typeof path==='string'&&path.startsWith('/')&&resolve(path)===path&&!/[\0\n\r'`$]/.test(path);
  const valid=!enabled||safe(expected.context_packet_path)&&safe(expected.facts_path)&&expected.context_packet_path!==expected.facts_path&&/^[a-f0-9]{64}$/.test(expected.context_packet_sha256 || '')&&/^[a-f0-9]{64}$/.test(expected.facts_sha256 || '');
  return {enabled,valid};
}

// Pure shape inspection is deliberately unverified. Only the original-file wrapper
// below can certify provenance; fixture records never become official evidence.
export function parseCodexNativeRecords({childRecords,parentRecords,parentLines=null,childLines=null,parentLine,expected,strictCustomExec=false}) {
  const result=nativeEmpty(),errors=result.errors;
  const rows=Array.isArray(childRecords)?childRecords:[],parents=Array.isArray(parentRecords)?parentRecords:[];
  expected=expected || {};
  const packetMode=nativePacketMode(expected);
  const gui=expected.trajectory_mode==='qa-gui',guiPolicy=expected.gui_policy;result.gui_calls=[];
  if(expected.trajectory_mode&&!['readonly','qa-gui'].includes(expected.trajectory_mode))errors.push('NATIVE_TRAJECTORY_MODE_UNSUPPORTED');
  if(gui&&(!packetMode.enabled||!Array.isArray(guiPolicy?.allowed_tools)||!Array.isArray(guiPolicy?.commands)||!Number.isInteger(guiPolicy?.max_calls)||guiPolicy.max_calls<1))errors.push('NATIVE_GUI_POLICY_REQUIRED');
  if(!packetMode.valid)errors.push('NATIVE_CONTEXT_PACKET_CONFIG_INVALID');
  const required=['parent_session_id','task_name','agent_path','model','reasoning_effort','message','context_marker'];
  if(required.some(key=>typeof expected[key]!=='string'||!expected[key])||!expected.message?.includes(expected.context_marker || '\0'))errors.push('NATIVE_LOCKED_EXPECTATION_REQUIRED');
  const meta=rows.filter(x=>x?.type==='session_meta');
  result.session_id=meta.length===1?meta[0].payload?.id:null;
  if(!result.session_id)errors.push('AMBIGUOUS_OR_MISSING_SESSION');
  if(expected.child_session_id&&result.session_id!==expected.child_session_id)errors.push('NATIVE_CHILD_SESSION_MISMATCH');
  if(result.session_id===expected.parent_session_id)errors.push('NATIVE_CHILD_SESSION_REUSED_PARENT');
  const origin=meta[0]?.payload?.source?.subagent?.thread_spawn;
  if(origin?.parent_thread_id!==expected.parent_session_id)errors.push('NATIVE_PARENT_MISMATCH');
  if(origin?.agent_path!==expected.agent_path||meta[0]?.payload?.agent_path&&meta[0].payload.agent_path!==expected.agent_path)errors.push('NATIVE_CHILD_ORIGIN_MISMATCH');
  const lockedCreationVersion=expected.child_version||expected.harness_version;
  if(lockedCreationVersion&&meta[0]?.payload?.cli_version!==lockedCreationVersion)errors.push('NATIVE_HARNESS_VERSION_MISMATCH');
  if(expected.child_version) {
    const turn=expected.parent_turn_source;
    if(expected.harness_version&&expected.harness_version!==expected.parent_origin_version)errors.push('NATIVE_PARENT_ORIGIN_LOCK_MISMATCH');
    if(!expected.parent_origin_version||!turn?.turn_id||!Number.isInteger(turn.line)||!/^[a-f0-9]{64}$/.test(turn.sha256||''))errors.push('NATIVE_PARENT_EPOCH_REQUIRED');
    if(parents.find(x=>x?.type==='session_meta')?.payload?.cli_version!==expected.parent_origin_version)errors.push('NATIVE_PARENT_ORIGIN_VERSION_MISMATCH');
    const latest=parents.slice(0,parentLine-1).findLastIndex(x=>x?.type==='turn_context');
    if(latest!==turn?.line-1||parents[latest]?.payload?.turn_id!==turn?.turn_id)errors.push('NATIVE_PARENT_TURN_MISMATCH');
    if(parentLines&&!nativeLineHashMatches(parentLines,turn?.line,turn?.sha256))errors.push('NATIVE_PARENT_TURN_HASH_MISMATCH');
  }
  const pmeta=parents.find(x=>x?.type==='session_meta');
  if(pmeta?.payload?.id!==expected.parent_session_id)errors.push('NATIVE_PARENT_MISMATCH');
  const spawn=parents[parentLine-1];const sp=spawn?.payload;
  if(spawn?.type!=='response_item'||sp?.type!=='function_call'||sp.namespace!=='collaboration'||sp.name!=='spawn_agent'||!sp.call_id||parents.filter(x=>x.type==='response_item'&&x.payload?.type==='function_call'&&x.payload.call_id===sp?.call_id).length!==1)errors.push('NATIVE_SPAWN_CALL_REQUIRED');
  if(!/^[a-f0-9]{64}$/.test(expected.intent_sha256 || ''))errors.push('NATIVE_INTENT_HASH_REQUIRED');
  const prepareLine=expected.prepare_line,prepare=parents[prepareLine-1],prep=prepare?.payload;
  if(!Number.isInteger(prepareLine)||prepareLine<1||prepareLine>=parentLine)errors.push('NATIVE_PREPARE_BEFORE_SPAWN_REQUIRED');
  if(prepare?.type!=='response_item'||prep?.type!=='custom_tool_call_output'||!prep.call_id)errors.push('NATIVE_PREPARE_OUTPUT_INVALID');
  const prepareCalls=parents.flatMap((row,index)=>row.type==='response_item'&&row.payload?.type==='custom_tool_call'&&row.payload.call_id===prep?.call_id?[{index,payload:row.payload}]:[]);
  if(prepareCalls.length!==1||prepareCalls[0].index>=prepareLine-1||prepareCalls[0].payload.name!=='exec'||prepareCalls[0].payload.namespace&&!['functions'].includes(prepareCalls[0].payload.namespace))errors.push('NATIVE_PREPARE_CALL_REQUIRED');
  if(parents.filter(row=>row.type==='response_item'&&row.payload?.type==='custom_tool_call_output'&&row.payload.call_id===prep?.call_id).length!==1)errors.push('NATIVE_PREPARE_OUTPUT_AMBIGUOUS');
  const prepared=nativeOutput(prep?.output,{strictExec:strictCustomExec});
  if(prepared?.exit_code!==0||prepared?.session_id||typeof prepared?.output!=='string')errors.push('NATIVE_PREPARE_OUTPUT_INVALID');
  if(!prepared?.output?.split(/\r?\n/).includes(`TEAMQA_NATIVE_PREPARED sha256=${expected.intent_sha256}`))errors.push('NATIVE_PREPARE_MARKER_MISMATCH');
  if(parentLines&&expected.prepare_source&&!nativeLineHashMatches(parentLines,prepareLine,expected.prepare_source.sha256))errors.push('NATIVE_PREPARE_SOURCE_HASH_MISMATCH');
  if(expected.created_at) {
    const created=Date.parse(expected.created_at),called=Date.parse(spawn?.timestamp),childCreated=Date.parse(meta[0]?.timestamp);
    if(!Number.isFinite(created)||!Number.isFinite(called)||!Number.isFinite(childCreated)||called<created||childCreated<called)errors.push('NATIVE_SPAWN_BEFORE_INTENT_OR_TIME_MISSING');
  }
  let argumentsValue;try{argumentsValue=JSON.parse(sp.arguments);}catch{errors.push('NATIVE_SPAWN_ARGUMENT_MISMATCH');}
  const keys=['task_name','model','reasoning_effort','fork_turns','message'];
  const encryptedSpawn=packetMode.enabled&&packetMode.valid&&/^gAAAA[A-Za-z0-9_-]{75,}={0,2}$/.test(argumentsValue?.message || '');
  const spawnArgumentsMatch=Boolean(argumentsValue&&Object.keys(argumentsValue).sort().join()===keys.sort().join()&&keys.every(key=>key==='message'?argumentsValue[key]===expected.message||encryptedSpawn:argumentsValue[key]=== (key==='fork_turns'?'none':expected[key])));
  if(!spawnArgumentsMatch)errors.push('NATIVE_SPAWN_ARGUMENT_MISMATCH');
  const outputs=parents.slice(parentLine).filter(x=>x?.type==='response_item'&&x.payload?.type==='function_call_output'&&x.payload.call_id===sp?.call_id);
  const response=outputs.length===1?nativeOutput(outputs[0].payload.output):null;
  if(outputs.length!==1||!response)errors.push('NATIVE_SPAWN_RESULT_MISSING');
  else if(response.task_name!==expected.agent_path||response.agent_id&&![expected.agent_path,result.session_id].includes(response.agent_id)||response.session_id&&response.session_id!==result.session_id)errors.push('NATIVE_SPAWN_RESULT_MISMATCH');
  const contexts=rows.filter(x=>x?.type==='turn_context').map(x=>x.payload);
  const models=new Set(contexts.map(x=>x?.model).filter(Boolean)),efforts=new Set(contexts.map(x=>x?.effort || x?.reasoning_effort).filter(Boolean));
  result.observed={model:models.size===1?[...models][0]:null,reasoning:efforts.size===1?[...efforts][0]:null};
  if(!contexts.length||contexts.some(x=>!x.model))errors.push('NATIVE_MODEL_MISSING');
  if(!contexts.length||contexts.some(x=>!(x.effort || x.reasoning_effort)))errors.push('NATIVE_REASONING_MISSING');
  if(result.observed.model!==expected.model)errors.push('NATIVE_MODEL_MISMATCH');
  if(result.observed.reasoning!==expected.reasoning_effort)errors.push('NATIVE_REASONING_MISMATCH');
  const starts=rows.filter(x=>x?.type==='event_msg'&&x.payload?.type==='task_started');
  const turns=new Set(contexts.map(x=>x.turn_id).filter(Boolean));
  const inputs=rows.filter(x=>x?.type==='response_item'&&x.payload?.type==='agent_message');
  if(starts.length!==1||turns.size!==1||starts[0]?.payload?.turn_id!==[...turns][0]||inputs.length>1)errors.push('NATIVE_SESSION_REUSED');
  const input=inputs[0]?.payload || rows.find(x=>x?.type==='response_item'&&x.payload?.type==='message'&&x.payload.role==='user')?.payload;
  const actualMessage=nativeText(input?.content);
  const parentAgent=expected.agent_path?.slice(0,expected.agent_path.lastIndexOf('/'));
  const envelope=`Message Type: NEW_TASK\nTask name: ${expected.agent_path}\nSender: ${parentAgent}\nPayload:\n`;
  if(actualMessage!==null) {
    if(actualMessage!==expected.message&&actualMessage!==envelope+expected.message)errors.push('NATIVE_CONTEXT_MISMATCH');
    result.context_evidence=spawnArgumentsMatch?'parent-spawn-confirmed; child plaintext task matched; no comprehension claim':'parent spawn not confirmed; child plaintext comparison only; no comprehension claim';
  } else if(input?.content?.some(x=>x.type==='encrypted_content')) {
    if(nativeText(input.content.filter(x=>x.type!=='encrypted_content'))!==envelope)errors.push('NATIVE_CONTEXT_MISMATCH');
    result.context_evidence=spawnArgumentsMatch?'parent-spawn-confirmed; child task encrypted/unobservable; no read or comprehension claim':'parent spawn not confirmed; child task encrypted/unobservable; no read or comprehension claim';
  } else errors.push('NATIVE_CONTEXT_MISSING');
  if(input?.type==='agent_message'&&(input.author!==parentAgent||input.recipient!==expected.agent_path))errors.push('NATIVE_CONTEXT_MISMATCH');
  const pending=new Map();let finalLine=-1,completeLine=-1,finals=0,toolCount=0,packetRead=false;
  for(const [index,row] of rows.entries()) {
    const p=row?.payload || {};
    if(row?.type==='event_msg'&&/failed|aborted|interrupted|error/.test(p.type || ''))errors.push('PROVIDER_EXECUTION_FAILED');
    if(row?.type==='event_msg'&&p.type==='task_complete') {
      if(p.turn_id!==[...turns][0]||completeLine!==-1)errors.push('NATIVE_TERMINAL_MISMATCH');
      if(p.error||p.status&&!['completed','success'].includes(p.status))errors.push('PROVIDER_EXECUTION_FAILED');
      completeLine=index;
    }
    if(row?.type!=='response_item')continue;
    if(p.type==='message'&&p.role==='assistant'&&['final_answer','final'].includes(p.phase || p.channel)) {if(packetMode.enabled&&!packetRead)errors.push('NATIVE_CONTEXT_PACKET_BEFORE_FINAL_REQUIRED');result.verdictText=nativeText(p.content);finalLine=index;finals++;}
    if(['function_call','custom_tool_call'].includes(p.type)) {
      if(!p.call_id||pending.has(p.call_id))errors.push('DUPLICATE_TOOL_ID');
      const rpcLiteral=gui&&p.type==='custom_tool_call'&&p.name==='exec'&&(!p.namespace||p.namespace==='functions')?( /^text\(await tools\.([A-Za-z0-9_]+)\((\{[^]*\})\)\);\s*$/.exec(p.input||'') || /^const r=await tools\.([A-Za-z0-9_]+)\((\{[^]*\})\);text\(r\);\s*$/.exec(p.input||'')):null;
      const rpcPolicy=rpcLiteral&&guiPolicy?.allowed_tools?.find(x=>(String(x.name||'').startsWith('mcp__')?x.name:`${x.namespace}__${x.name}`)===rpcLiteral[1]&&/^mcp__.*dragon.*__dragon_rpc$/i.test(rpcLiteral[1]));
      const directGui=Boolean(rpcPolicy)||gui&&p.type==='function_call'&&guiPolicy?.allowed_tools?.some(x=>x.namespace===p.namespace&&x.name===p.name)&&/^mcp__.*dragon.*__dragon_rpc$/i.test((p.name||'').startsWith('mcp__')?p.name:`${p.namespace}__${p.name}`);
      if(p.namespace==='collaboration'||/spawn_agent|send_message|followup_task|Agent|Task/i.test(p.name || '')||/mcp__/i.test(p.name || '')&&!directGui)errors.push('UNAPPROVED_TOOL_OR_HELPER');
      if(completeLine!==-1||finalLine!==-1)errors.push('NATIVE_TERMINAL_MISMATCH');
      let command=null;
      const packetPragma='// @exec: {"max_output_tokens": 20000}\n';
      const hasPacketPragma=String(p.input || '').startsWith(packetPragma);
      const toolInput=hasPacketPragma?p.input.slice(packetPragma.length):p.input;
      const literal=p.type==='custom_tool_call'&&p.name==='exec'&&(!p.namespace||p.namespace==='functions')?/^text\(await tools\.exec_command\((\{[^]*\})\)\);\s*$/.exec(toolInput || ''):null;
      if(literal) {try{const args=JSON.parse(literal[1]);const allowed=['cmd','workdir','max_output_tokens','yield_time_ms','login'];if(args&&typeof args==='object'&&!Array.isArray(args)&&typeof args.cmd==='string'&&Object.keys(args).every(x=>allowed.includes(x))&&args.login===false&&(!Object.hasOwn(args,'workdir')||typeof args.workdir==='string'&&args.workdir.startsWith('/'))&&['max_output_tokens','yield_time_ms'].every(key=>!Object.hasOwn(args,key)||Number.isInteger(args[key])&&args[key]>0&&(!expected.caps?.[key]||args[key]<=expected.caps[key])))command=args.cmd;}catch{}}
      const facts=expected.facts_path;
      const packetCommand=packetMode.enabled&&packetMode.valid&&command===`cat '${expected.context_packet_path}'`;
      const helperGui=gui&&!hasPacketPragma&&command&&guiPolicy?.commands?.find(x=>x.command===command&&guiPolicy.helpers?.some(h=>h.path===x.helper?.path&&h.sha256===x.helper.sha256));
      if(directGui||helperGui) {
        if(!packetRead||!result.tool_log.some(x=>x.path===expected.facts_path&&x.status==='completed'))errors.push('NATIVE_GUI_AFTER_LOCKED_READS_REQUIRED');
        let input;try{input=rpcPolicy?JSON.parse(rpcLiteral[2]):directGui?JSON.parse(p.arguments):JSON.parse(literal[1]);}catch{errors.push('NATIVE_GUI_INPUT_INVALID');}
        pending.set(p.call_id,{tool:helperGui?'exec_command':rpcPolicy?rpcPolicy.name:p.name,namespace:rpcPolicy?rpcPolicy.namespace:p.namespace||'',kind:'gui',input,command:command||null,helper:helperGui?.helper||null,call_timestamp:row.timestamp||null,call_line:index+1,call_sha256:hashLine(childLines?.[index]||JSON.stringify(row))});
        toolCount++;continue;
      }
      if(hasPacketPragma&&!packetCommand)errors.push('NATIVE_TOOL_UNSUPPORTED');
      if(!command||typeof facts!=='string'||!facts.startsWith('/')||/[\0\n\r'`$]/.test(facts)||!packetCommand&&command!==`cat '${facts}'`)errors.push('NATIVE_TOOL_UNSUPPORTED');
      if(packetMode.enabled&&(toolCount===0&&!packetCommand||toolCount>0&&packetCommand))errors.push('NATIVE_CONTEXT_PACKET_FIRST_READ_REQUIRED');
      if(packetMode.enabled&&!packetCommand&&!packetRead)errors.push('NATIVE_CONTEXT_PACKET_BEFORE_FACTS_REQUIRED');
      const purpose=packetCommand?'context-packet':'facts';
      pending.set(p.call_id,{tool:'exec_command',kind:'read',command:command || '',path:packetCommand?expected.context_packet_path:facts || '',status:'pending',...(packetMode.enabled?{purpose}:{}),call_line:index+1});toolCount++;
    }
    if(['function_call_output','custom_tool_call_output'].includes(p.type)) {
      const call=pending.get(p.call_id);if(!call){errors.push('UNPAIRED_TOOL_RESULT');continue;}
      const output=nativeOutput(p.output,{strictExec:strictCustomExec&&p.type==='custom_tool_call_output'});
      if(call.kind==='gui'){
        if(!output||output.isError===true||output.ok===false||output.error||output.exit_code!==undefined&&output.exit_code!==0)errors.push('TOOL_FAILED');
        const item={...call,output,output_timestamp:row.timestamp||null,output_line:index+1,output_sha256:hashLine(childLines?.[index]||JSON.stringify(row)),status:output&&!output.isError&&!output.error&&output.ok!==false?'completed':'failed'};
        result.gui_calls.push(item);result.tool_log.push(item);pending.delete(p.call_id);continue;
      }
      call.status=output?.exit_code===0&&!output.session_id&&typeof output.output==='string'?'completed':'failed';
      if(call.status!=='completed')errors.push('TOOL_FAILED');
      call.output_line=index+1;
      if(typeof output?.output==='string') {call.output_sha256=hashLine(output.output);call.output_bytes=Buffer.byteLength(output.output);if(call.purpose==='context-packet') {if(call.output_sha256!==expected.context_packet_sha256)errors.push('NATIVE_CONTEXT_PACKET_OUTPUT_MISMATCH');else if(call.status==='completed'&&result.tool_log.length===0&&toolCount===1)packetRead=true;}else if(expected.facts_sha256&&call.output_sha256!==expected.facts_sha256)errors.push('NATIVE_FACTS_OUTPUT_MISMATCH');}
      result.tool_log.push(call);pending.delete(p.call_id);
    }
  }
  if(gui&&result.gui_calls.length>(guiPolicy?.max_calls??0))errors.push('NATIVE_GUI_CALL_CAP_EXCEEDED');
  if(pending.size)errors.push('MISSING_TOOL_RESULT');
  if(packetMode.enabled&&!packetRead)errors.push('NATIVE_CONTEXT_PACKET_FIRST_READ_REQUIRED');
  const contextDispatchMatches=spawnArgumentsMatch&&!errors.some(error=>['NATIVE_CONTEXT_MISMATCH','NATIVE_CONTEXT_MISSING','NATIVE_SPAWN_RESULT_MISSING','NATIVE_SPAWN_RESULT_MISMATCH','NATIVE_PARENT_MISMATCH','NATIVE_CHILD_ORIGIN_MISMATCH'].includes(error));
  if(packetMode.enabled)result.context_evidence=packetRead&&contextDispatchMatches?`${encryptedSpawn?'spawn/task text encrypted/unobservable':'exact parent pointer matched; child task text may be encrypted/unobservable'}; packet bytes observed in actual first read; no comprehension claim`:'packet provenance unconfirmed; spawn/task text may be encrypted/unobservable; no comprehension claim';
  else if(!contextDispatchMatches)result.context_evidence='context dispatch unconfirmed; no child read or comprehension claim';
  if(expected.facts_path&&!result.tool_log.some(x=>x.kind==='read'&&x.status==='completed'&&x.path===expected.facts_path))errors.push('NATIVE_FACTS_READ_MISSING');
  if(finalLine<0||!result.verdictText)errors.push('VERDICT_MISSING');
  if(finals!==1)errors.push('NATIVE_FINAL_AMBIGUOUS');
  if(completeLine<0)errors.push('MISSING_TERMINAL');
  else if(finalLine>=completeLine)errors.push('NATIVE_TERMINAL_MISMATCH');
  if(expected.caps?.timeout_ms!==undefined) {
    const started=Date.parse(starts[0]?.timestamp),completed=Date.parse(rows[completeLine]?.timestamp);
    if(!Number.isInteger(expected.caps.timeout_ms)||expected.caps.timeout_ms<=0||!Number.isFinite(started)||!Number.isFinite(completed)||completed<started)errors.push('NATIVE_ELAPSED_TIME_UNOBSERVABLE');
    else if(completed-started>expected.caps.timeout_ms)errors.push('NATIVE_OBSERVED_TIMEOUT_EXCEEDED');
    else result.observed_elapsed_ms=completed-started;
  }
  if(expected.caps?.max_turns!==undefined&&expected.caps.max_turns!==1)errors.push('NATIVE_SINGLE_TURN_CAP_REQUIRED');
  result.errors=[...new Set(errors)];return result;
}

function readNativeOriginal(path,{parentSource=null,prepareSource=null}={}) {
  const rootPath=join(homedir(),'.codex','sessions');
  let root;try{root=realpathSync(rootPath);}catch(error){if(error.code!=='ENOENT')throw error;root=rootPath;}
  const actual=realpathSync(path);
  if(!actual.startsWith(root+sep)||!actual.endsWith('.jsonl'))throw new Error('NATIVE_SOURCE_UNTRUSTED');
  let callIds=null,firstHash=null;
  if(parentSource){
   callIds=new Set();
   firstHash=scanOriginalSource(actual,(line,index)=>{
    if(index!==parentSource.line&&index!==prepareSource?.line)return;
    let row;try{row=JSON.parse(line);}catch{throw new Error('NATIVE_SOURCE_MALFORMED');}
    if(row.payload?.call_id)callIds.add(row.payload.call_id);
   }).sha256;
  }
  const records=[],lines=[],logical=createHash('sha256');let retained=0;
  const scanned=scanOriginalSource(actual,(line,index)=>{
   if(index>1)logical.update('\n');logical.update(line);
   let row;try{row=JSON.parse(line);}catch{throw new Error('NATIVE_SOURCE_MALFORMED');}
   const relevant=!parentSource||row.type==='session_meta'||row.type==='turn_context'||
    index===parentSource.line||index===prepareSource?.line||
    row.type==='response_item'&&callIds.has(row.payload?.call_id);
   retained+=relevant?Buffer.byteLength(line):0;
   if(retained>32*1024*1024)throw new Error('NATIVE_RELEVANT_RECORDS_TOO_LARGE');
   records.push(relevant?row:{type:'ignored'});
   lines.push(relevant?line:undefined);
  });
  if(firstHash&&firstHash!==scanned.sha256)throw new Error('ORIGINAL_SOURCE_CHANGED');
  return {path:actual,lines,records,logical_sha256:logical.digest('hex')};
}

function nativePrefixHash(path,count) {
 const digest=createHash('sha256');let seen=0;
 scanOriginalSource(path,(line,index)=>{if(index>count)return;if(seen++)digest.update('\n');digest.update(line);});
 return seen===count?digest.digest('hex'):null;
}

export function parseCodexNativeExecution({childSourcePath,parentSource,expected}) {
  const empty=nativeEmpty();
  try {
    if(!expected?.created_at||!expected?.harness_version||!Number.isInteger(expected?.caps?.timeout_ms)||expected.caps.timeout_ms<=0||expected.caps.max_turns!==1)throw new Error('NATIVE_LOCKED_CAPS_AND_INTENT_REQUIRED');
    if(!/^[a-f0-9]{64}$/.test(expected.intent_sha256 || '')||!expected.prepare_source?.path||!Number.isInteger(expected.prepare_source.line)||expected.prepare_source.line<1||!/^[a-f0-9]{64}$/.test(expected.prepare_source.sha256 || ''))throw new Error('NATIVE_PREPARE_SOURCE_REQUIRED');
    const packetMode=nativePacketMode(expected);if(!packetMode.valid)throw new Error('NATIVE_CONTEXT_PACKET_CONFIG_INVALID');
    const child=readNativeOriginal(childSourcePath),parent=readNativeOriginal(parentSource?.path,{parentSource,prepareSource:expected.prepare_source});
    if(expected.trajectory_mode==='qa-gui')for(const helper of expected.gui_policy?.helpers||[]) {if(realpathSync(helper.path)!==helper.path||hashLine(readFileSync(helper.path))!==helper.sha256)throw new Error('NATIVE_GUI_HELPER_DRIFT');}
    if(expected.child_version&&!nativeLineHashMatches(parent.lines,expected.parent_turn_source?.line,expected.parent_turn_source?.sha256))throw new Error('NATIVE_PARENT_TURN_HASH_MISMATCH');
    if(!nativeLineHashMatches(parent.lines,parentSource.line,parentSource.sha256))throw new Error('NATIVE_PARENT_SOURCE_HASH_MISMATCH');
    if(realpathSync(expected.prepare_source.path)!==parent.path)throw new Error('NATIVE_PREPARE_SOURCE_PARENT_MISMATCH');
    if(!nativeLineHashMatches(parent.lines,expected.prepare_source.line,expected.prepare_source.sha256))throw new Error('NATIVE_PREPARE_SOURCE_HASH_MISMATCH');
    const parsed=parseCodexNativeRecords({childRecords:child.records,parentRecords:parent.records,parentLines:parent.lines,childLines:child.lines,parentLine:parentSource.line,strictCustomExec:true,expected:{...expected,prepare_line:expected.prepare_source.line}});
    const metadata=scanCodexRuntimeMetadata(child.path,parsed.session_id);
    if(!metadata)parsed.errors.push('NATIVE_METADATA_MISSING');
    else {verifyCodexMetadataSource(metadata,{sessionId:parsed.session_id});parsed.metadata_source={...metadata,native:{parent_source:{...parentSource,path:parent.path},prepare_source:{...expected.prepare_source,path:parent.path},intent_sha256:expected.intent_sha256,...(expected.child_version?{child_version:expected.child_version,parent_origin_version:expected.parent_origin_version,parent_turn_source:expected.parent_turn_source}:{}),...(packetMode.enabled?{context_packet:{path:expected.context_packet_path,sha256:expected.context_packet_sha256,reads:parsed.tool_log.filter(call=>call.purpose==='context-packet').map(call=>({call_line:call.call_line,call_sha256:hashLine(child.lines[call.call_line-1]),output_line:call.output_line,output_sha256:hashLine(child.lines[call.output_line-1]),stdout_sha256:call.output_sha256}))}}:{}),parent_response:parent.records.flatMap((row,index)=>row.type==='response_item'&&row.payload?.type==='function_call_output'&&row.payload.call_id===parent.records[parentSource.line-1]?.payload?.call_id?[{line:index+1,sha256:hashLine(parent.lines[index])}]:[]),child_prefix_lines:child.lines.length,child_prefix_sha256:child.logical_sha256,context_evidence:parsed.context_evidence}};}
    parsed.errors=[...new Set(parsed.errors)];parsed.provenance_verified=parsed.errors.length===0;
    parsed.stream_sha256=child.logical_sha256;parsed.stderr_sha256=hashLine('');
    return parsed;
  }catch(error){empty.errors=['NATIVE_SOURCE:'+error.message];return empty;}
}

const testCommand = /\b(node\s+--test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|pytest|cargo\s+test|go\s+test)\b/;
const forbiddenTool = /^(Agent|Task|Edit|Write|NotebookEdit|mcp__)/i;

export function providerCommand({provider,model,reasoning,repo,mode,sessionId,caps=null}) {
  if (!model || !reasoning) throw new Error('EXPLICIT_MODEL_AND_REASONING_REQUIRED');
  if (provider === 'openai') return { command:'codex', args:[
    'exec','--ignore-user-config','--disable','multi_agent','-m',model,
    '-c',`model_reasoning_effort=${JSON.stringify(reasoning)}`,
    '-c','approval_policy="never"','--sandbox','read-only','--json','-C',repo,'-',
  ] };
  if (provider === 'anthropic') return { command:'claude', args:[
    '-p',...(caps?['--max-turns',String(caps.max_turns)]:[]),'--safe-mode','--setting-sources','','--model',model,'--effort',reasoning,
    '--output-format','stream-json','--verbose','--session-id',sessionId,
    '--permission-mode','dontAsk','--settings',JSON.stringify({sandbox:{enabled:true,autoAllowBashIfSandboxed:false,allowUnsandboxedCommands:false,filesystem:{denyWrite:[repo]},network:{allowLocalBinding:false,allowedDomains:[]}}}),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
    '--tools',mode === 'static' ? '' : 'Read,Glob,Grep,Bash',
    '--allowedTools','Read,Glob,Grep,Bash(node --test *),Bash(npm test *),Bash(pnpm test *),Bash(pytest *),Bash(cargo test *),Bash(go test *)',
    '--disallowedTools','Agent,Task,Edit,Write,NotebookEdit,WebSearch,WebFetch',
  ] };
  throw new Error(`UNSUPPORTED_PROVIDER:${provider}`);
}

function kind(command,tool) {
  if (testCommand.test(command || '')) return 'test';
  if (/read|glob|grep/i.test(tool)) return 'read';
  return command ? 'command' : 'other';
}

// Only provider-origin events are parsed here. Verdict text cannot supply provenance.
export function parseProviderExecution({provider,stdout,stderr,metadataSource=null,allowedMcpServers=[]}) {
  const allowedServers=new Set(Array.isArray(allowedMcpServers)?allowedMcpServers:[]);
  const errors=[]; const events=[]; const sessions=new Set(); const models=new Set();const efforts=new Set();
  for (const line of String(stdout || '').split(/\r?\n/).filter(x=>x.trim())) {
    try { events.push(JSON.parse(line)); } catch { errors.push('MALFORMED_PROVIDER_STREAM'); }
  }
  const tool_log=[];const pending=new Map();let verdictText=null;let terminal=false;
  if (provider==='openai') {
    const model=/^\s*model:\s*(\S+)\s*$/m.exec(stderr || ''); if(model)models.add(model[1]);
    const effort=/^\s*reasoning effort:\s*(\S+)\s*$/m.exec(stderr || '');if(effort)efforts.add(effort[1]);
    for(const e of events) {
      if(e.type==='thread.started' && e.thread_id)sessions.add(e.thread_id);
      if(e.type==='turn.completed')terminal=true;
      if(e.type==='turn.failed'||e.type==='error')errors.push('PROVIDER_EXECUTION_FAILED');
      if(e.type==='item.completed') {
        const item=e.item || {};
        if(item.type==='agent_message')verdictText=item.text;
        if(item.type==='command_execution') {
          if(item.exit_code!==0||item.status!=='completed')errors.push('TOOL_FAILED');
          tool_log.push({tool:'command_execution',kind:kind(item.command,'command_execution'),command:item.command || '',status:item.exit_code===0?'completed':'failed'});
        }
        if(item.type==='mcp_tool_call') {
          if(!allowedServers.has(item.server) || forbiddenTool.test(item.tool || ''))errors.push('UNAPPROVED_TOOL_OR_HELPER');
          const failed=item.status!=='completed'||Boolean(item.error)||item.result?.isError===true;
          if(failed)errors.push('TOOL_FAILED');
          tool_log.push({tool:item.tool || 'unknown',server:item.server || 'unknown',kind:'other',status:failed?'failed':'completed'});
        }
        if(/collab|agent_tool|file_change/.test(item.type || ''))errors.push('UNAPPROVED_TOOL_OR_HELPER');
      }
    }
  } else if(provider==='anthropic') {
    for(const e of events) {
      if(e.type==='system' && e.subtype==='init') {
        if(e.session_id)sessions.add(e.session_id);if(e.model)models.add(e.model);
        if(e.effort || e.reasoning_effort)efforts.add(e.effort || e.reasoning_effort);
      }
      if(e.type==='assistant') {
        if(e.message?.model)models.add(e.message.model);
        for(const part of e.message?.content || [])if(part.type==='tool_use') {
          if(String(part.name || '').startsWith('mcp__')) {
            const server=[...allowedServers].find(value=>String(part.name).startsWith(`mcp__${value}__`));
            const tool=server?String(part.name).slice(`mcp__${server}__`.length):null;
            if(!server || forbiddenTool.test(tool || ''))errors.push('UNAPPROVED_TOOL_OR_HELPER');
            if(server)part.approvedServer=server;
          } else if(forbiddenTool.test(part.name || ''))errors.push('UNAPPROVED_TOOL_OR_HELPER');
          if(pending.has(part.id))errors.push('DUPLICATE_TOOL_ID');
          pending.set(part.id,part);
        }
      }
      if(e.type==='user')for(const part of e.message?.content || [])if(part.type==='tool_result') {
        const call=pending.get(part.tool_use_id);
        if(!call){errors.push('UNPAIRED_TOOL_RESULT');continue;}
        if(part.is_error)errors.push('TOOL_FAILED');
        tool_log.push({tool:call.name,...(call.approvedServer?{server:call.approvedServer}:{}),kind:kind(call.input?.command,call.name),...(call.input?.command?{command:call.input.command}:{}),...(call.input?.file_path?{path:call.input.file_path}:{}),status:part.is_error?'failed':'completed'});
        pending.delete(part.tool_use_id);
      }
      if(e.type==='result') {
        if(e.session_id)sessions.add(e.session_id);if(e.subtype!=='success'||e.is_error)errors.push('PROVIDER_EXECUTION_FAILED');
        terminal=e.subtype==='success' && !e.is_error;verdictText=e.result;
      }
    }
  } else errors.push('UNSUPPORTED_PROVIDER');
  let metadata_source=null;
  if(provider==='openai' && sessions.size===1) {
    const sessionId=[...sessions][0];
    const source=metadataSource || readCodexRuntimeMetadata({sessionId});
    if(source) {
      try {
        const observed=verifyCodexMetadataSource(source,{sessionId});
        models.add(observed.model);efforts.add(observed.reasoning);
        metadata_source={...source,path:observed.path};
      }catch(error){errors.push('CODEX_METADATA_SOURCE:'+error.message);}
    }
  }
  if(provider==='anthropic' && sessions.size===1) {
    const sessionId=[...sessions][0];
    const source=metadataSource || readClaudeRuntimeMetadata({sessionId});
    if(source) {
      try {
        const observed=verifyClaudeMetadataSource(source,{sessionId});
        models.add(observed.model);efforts.add(observed.reasoning);
        metadata_source={...source,path:observed.path};
      }catch(error){errors.push('CLAUDE_METADATA_SOURCE:'+error.message);}
    }
  }
  if(pending.size)errors.push('MISSING_TOOL_RESULT');
  if(sessions.size!==1)errors.push('AMBIGUOUS_OR_MISSING_SESSION');
  if(models.size!==1)errors.push('AMBIGUOUS_OR_MISSING_MODEL');
  if(efforts.size!==1)errors.push('AMBIGUOUS_OR_MISSING_REASONING');
  if(!terminal)errors.push('MISSING_TERMINAL');
  return {provider,metadata_source,session_id:sessions.size===1?[...sessions][0]:null,observed:{model:models.size===1?[...models][0]:null,reasoning:efforts.size===1?[...efforts][0]:null},tool_log,verdictText,errors,stream_sha256:createHash('sha256').update(stdout || '').digest('hex'),stderr_sha256:createHash('sha256').update(stderr || '').digest('hex')};
}

export function validateProviderExecution(execution,locked) {
  const errors=[...(execution?.errors || [])];
  if(execution?.provider!==locked.provider)errors.push('PROVIDER_MISMATCH');
  if(execution?.observed?.model!==locked.model)errors.push('MODEL_MISMATCH');
  if(execution?.observed?.reasoning!==locked.reasoning)errors.push('REASONING_MISMATCH');
  if(!execution?.session_id)errors.push('SESSION_MISSING');
  if(!execution?.verdictText)errors.push('VERDICT_MISSING');
  if(locked.mode==='tools' && !execution?.tool_log?.some(item=>item.kind==='test' && item.status==='completed'))errors.push('TEST_EXECUTION_MISSING');
  return [...new Set(errors)];
}

export function verifyProviderExecutionEvidence(execution, {mode}={}) {
  const errors=[];
  if(execution?.harness==='codex-native') {
    try {
      if(hashLine(readFileSync(execution.source.path))!==execution.source.sha256||hashLine(readFileSync(execution.stderr_source.path))!==execution.stderr_source.sha256)throw new Error('NATIVE_PROVIDER_SOURCE_DRIFT');
      if(!execution.native_review?.proof_path||!execution.native_review?.runtime_path)throw new Error('NATIVE_REVIEW_PROOF_REQUIRED');
      const check=spawnSync(process.execPath,[fileURLToPath(new URL('../native-verify.mjs',import.meta.url)),'--evidence',execution.source.path,'--proof',execution.native_review.proof_path,'--teamqa-runtime',execution.native_review.runtime_path],{encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024});
      if(check.status!==0)throw new Error('NATIVE_REVIEW_REJECTED:'+check.stderr?.trim());
      const {parsed,authorized}=JSON.parse(check.stdout);if(authorized!==true)throw new Error('NATIVE_REVIEW_REJECTED');
      errors.push(...validateProviderExecution(parsed,{provider:execution.provider,...execution.sent,mode}));
      if(parsed.session_id!==execution.session_id||JSON.stringify(parsed.observed)!==JSON.stringify(execution.observed))errors.push('PROVIDER_OBSERVED_MISMATCH');
      const saved=execution.metadata_source,current=parsed.metadata_source,old=saved?.native;
      const normalized=m=>({...m,native:{...m.native,child_prefix_lines:null,child_prefix_sha256:null}});
      if(!Number.isInteger(old?.child_prefix_lines)||old.child_prefix_lines<1||old.child_prefix_lines>current?.native?.child_prefix_lines||JSON.stringify(normalized(saved))!==JSON.stringify(normalized(current))||nativePrefixHash(current.path,old.child_prefix_lines)!==old.child_prefix_sha256)errors.push('NATIVE_PROVIDER_METADATA_DRIFT');
      if(execution.errors?.length)errors.push('PROVIDER_EXECUTION_ERRORS');
      return {errors:[...new Set(errors)],parsed};
    }catch(error){return {errors:['NATIVE_PROVIDER:'+error.message],parsed:null};}
  }
  try {
    const stdout=readFileSync(execution.source.path,'utf8');
    const stderr=readFileSync(execution.stderr_source.path,'utf8');
    const parsed=parseProviderExecution({provider:execution.provider,stdout,stderr,metadataSource:execution.metadata_source});
    if(parsed.stream_sha256!==execution.source.sha256||parsed.stderr_sha256!==execution.stderr_source.sha256)errors.push('PROVIDER_SOURCE_HASH_MISMATCH');
    errors.push(...validateProviderExecution(parsed,{provider:execution.provider,...execution.sent,mode}));
    if(parsed.session_id!==execution.session_id||JSON.stringify(parsed.observed)!==JSON.stringify(execution.observed))errors.push('PROVIDER_OBSERVED_MISMATCH');
    if(parsed.metadata_source && !execution.metadata_source)errors.push('CODEX_METADATA_SOURCE_REQUIRED');
    if(execution.errors?.length)errors.push('PROVIDER_EXECUTION_ERRORS');
    if(execution.command && execution.command!==(execution.provider==='openai'?'codex':'claude'))errors.push('PROVIDER_COMMAND_MISMATCH');
    return {errors:[...new Set(errors)],parsed};
  } catch(error) {return {errors:['PROVIDER_SOURCE_UNREADABLE:'+error.message],parsed:null};}
}
