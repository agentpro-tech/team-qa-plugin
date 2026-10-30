import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseCodexNativeRecords} from '../scripts/lib/provider-execution.mjs';

// Shape fixtures only: never create original rollouts or claim host provenance.
const hash=x=>createHash('sha256').update(x).digest('hex');
const packet='{"role":"TM","files":["SKILL.md","interfaces.md"],"prompt":"locked"}\n';
const facts='{"customer":"fixture"}\n';
const encrypted='gAAAA'+ 'A'.repeat(120)+'==';
const expected={parent_session_id:'parent',task_name:'TM',agent_path:'/root/TM',model:'fixture-model',reasoning_effort:'high',message:'TEAMQA context packet pointer',context_marker:'TEAMQA',intent_sha256:'a'.repeat(64),prepare_line:3,facts_path:'/locked/facts.json',facts_sha256:hash(facts),context_packet_path:'/locked/context.json',context_packet_sha256:hash(packet)};
const row=(type,payload)=>({type,payload});
function tool(id,path,output) {
 return [row('response_item',{type:'custom_tool_call',name:'exec',namespace:'functions',call_id:id,input:`text(await tools.exec_command(${JSON.stringify({cmd:`cat '${path}'`,login:false})}));`}),row('response_item',{type:'custom_tool_call_output',call_id:id,output:JSON.stringify({exit_code:0,output})})];
}
function fixture({message=encrypted}={}) {
 const parent=[row('session_meta',{id:'parent'}),row('response_item',{type:'custom_tool_call',name:'exec',namespace:'functions',call_id:'prep'}),row('response_item',{type:'custom_tool_call_output',call_id:'prep',output:JSON.stringify({exit_code:0,output:'TEAMQA_NATIVE_PREPARED sha256='+expected.intent_sha256})}),row('response_item',{type:'function_call',namespace:'collaboration',name:'spawn_agent',call_id:'spawn',arguments:JSON.stringify({task_name:'TM',model:expected.model,reasoning_effort:'high',fork_turns:'none',message})}),row('response_item',{type:'function_call_output',call_id:'spawn',output:'{"task_name":"/root/TM"}'})];
 const child=[row('session_meta',{id:'child',source:{subagent:{thread_spawn:{parent_thread_id:'parent',agent_path:'/root/TM'}}}}),row('event_msg',{type:'task_started',turn_id:'t'}),row('turn_context',{turn_id:'t',model:expected.model,effort:'high'}),row('response_item',{type:'agent_message',author:'/root',recipient:'/root/TM',content:[{type:'input_text',text:'Message Type: NEW_TASK\nTask name: /root/TM\nSender: /root\nPayload:\n'},{type:'encrypted_content',encrypted_content:'opaque'}]}),...tool('packet',expected.context_packet_path,packet),...tool('facts',expected.facts_path,facts),row('response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'{"verdict":"PASS"}'}]}),row('event_msg',{type:'task_complete',turn_id:'t'})];
 return {parent,child};
}
const parse=(f,locked=expected)=>parseCodexNativeRecords({parentRecords:f.parent,childRecords:f.child,parentLine:4,expected:locked});
test('packet shape allows encrypted or exact pointer spawn only after first exact packet read',()=>{
 for(const message of [encrypted,expected.message]) {
  const result=parse(fixture({message}));assert.deepEqual(result.errors,[]);assert.equal(result.provenance_verified,false);
  assert.equal(result.tool_log[0].purpose,'context-packet');assert.equal(result.tool_log[0].output_sha256,expected.context_packet_sha256);
  assert.match(result.context_evidence,/packet bytes observed/);assert.doesNotMatch(result.context_evidence,/parent-spawn-confirmed/);
 }
});
test('legacy encrypted full-message remains red and evidence cannot falsely confirm parent',()=>{
 const locked={...expected};delete locked.context_packet_path;delete locked.context_packet_sha256;
 const f=fixture();f.child.splice(4,2);
 const result=parse(f,locked);assert.ok(result.errors.includes('NATIVE_SPAWN_ARGUMENT_MISMATCH'));
 assert.doesNotMatch(result.context_evidence || '',/parent-spawn-confirmed/);
 const wrong=fixture({message:'TEAMQA wrong pointer'});assert.ok(parse(wrong).errors.includes('NATIVE_SPAWN_ARGUMENT_MISMATCH'));
 assert.doesNotMatch(parse(wrong).context_evidence || '',/parent-spawn-confirmed/);
});
test('packet mode requires complete safe distinct path/hash and separate facts hash',()=>{
 for(const extra of [{context_packet_path:undefined},{context_packet_sha256:undefined},{context_packet_sha256:'bad'},{context_packet_path:expected.facts_path},{context_packet_path:'relative'},{context_packet_path:'/locked/../context.json'},{context_packet_path:"/locked/context'$(x).json"},{facts_sha256:undefined}])assert.ok(parse(fixture(),{...expected,...extra}).errors.includes('NATIVE_CONTEXT_PACKET_CONFIG_INVALID'),JSON.stringify(extra));
});
test('packet output wrong path/hash/missing and reordered tool reads stay ungraded',()=>{
 const missing=fixture();missing.child.splice(4,2);assert.ok(parse(missing).errors.includes('NATIVE_CONTEXT_PACKET_FIRST_READ_REQUIRED'));
 const wrong=fixture();wrong.child[5].payload.output=JSON.stringify({exit_code:0,output:'wrong'});assert.ok(parse(wrong).errors.includes('NATIVE_CONTEXT_PACKET_OUTPUT_MISMATCH'));
 const path=fixture();path.child[4].payload.input='text(await tools.exec_command({"cmd":"cat \'/locked/other.json\'","login":false}));';assert.ok(parse(path).errors.includes('NATIVE_TOOL_UNSUPPORTED'));
 const order=fixture();order.child.splice(4,4,...order.child.slice(6,8),...order.child.slice(4,6));assert.ok(parse(order).errors.includes('NATIVE_CONTEXT_PACKET_FIRST_READ_REQUIRED'));
 const pending=fixture();pending.child.splice(5,1);assert.ok(parse(pending).errors.includes('NATIVE_CONTEXT_PACKET_BEFORE_FACTS_REQUIRED'));
 const failure=fixture();failure.child[5].payload.output=JSON.stringify({exit_code:1,output:packet});assert.ok(parse(failure).errors.includes('TOOL_FAILED'));
 const factsWrong=fixture();factsWrong.child[7].payload.output=JSON.stringify({exit_code:0,output:'other facts'});assert.ok(parse(factsWrong).errors.includes('NATIVE_FACTS_OUTPUT_MISMATCH'));
 const noFacts=fixture();noFacts.child.splice(6,2);assert.ok(parse(noFacts).errors.includes('NATIVE_FACTS_READ_MISSING'));
});
test('packet read never allows extra calls, followups, or encrypted non-message config',()=>{
 const noLogin=fixture();noLogin.child[4].payload.input='text(await tools.exec_command({"cmd":"cat \'/locked/context.json\'"}));';assert.ok(parse(noLogin).errors.includes('NATIVE_TOOL_UNSUPPORTED'));
 const followup=fixture();followup.child.push(structuredClone(followup.child[3]));assert.ok(parse(followup).errors.includes('NATIVE_SESSION_REUSED'));
 for(const patch of [{model:encrypted},{extra:'field'},{message:'gAAAA invalid'}]) {
  const f=fixture();f.parent[3].payload.arguments=JSON.stringify({...JSON.parse(f.parent[3].payload.arguments),...patch});assert.ok(parse(f).errors.includes('NATIVE_SPAWN_ARGUMENT_MISMATCH'));
 }
 const repeated=fixture();repeated.child.splice(6,0,...tool('packet2',expected.context_packet_path,packet));assert.ok(parse(repeated).errors.includes('NATIVE_CONTEXT_PACKET_FIRST_READ_REQUIRED'));
});
test('only packet first read permits exact bounded output pragma',()=>{
 const f=fixture();f.child[4].payload.input='// @exec: {"max_output_tokens": 20000}\n'+f.child[4].payload.input;assert.deepEqual(parse(f).errors,[]);
 for(const header of ['// @exec: {"max_output_tokens": 20001}\n','// @exec: {"max_output_tokens":20000}\n','// @exec: {"max_output_tokens": 20000, "yield_time_ms": 1000}\n','// @exec: {"max_output_tokens": 20000}\nconsole.log("extra");\n']) {
  const g=fixture();g.child[4].payload.input=header+g.child[4].payload.input;assert.ok(parse(g).errors.includes('NATIVE_TOOL_UNSUPPORTED'));
 }
 const facts=fixture();facts.child[6].payload.input='// @exec: {"max_output_tokens": 20000}\n'+facts.child[6].payload.input;assert.ok(parse(facts).errors.includes('NATIVE_TOOL_UNSUPPORTED'));
 const mismatch=fixture();mismatch.child[3].payload.content=[{type:'input_text',text:'wrong plaintext'}];assert.ok(parse(mismatch).errors.includes('NATIVE_CONTEXT_MISMATCH'));assert.doesNotMatch(parse(mismatch).context_evidence || '',/exact parent pointer matched|parent-spawn-confirmed|packet bytes observed/);
});
