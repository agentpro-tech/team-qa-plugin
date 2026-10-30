import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../scripts/lib/core.mjs';
import { readContract } from '../../scripts/lib/release-truth.mjs';
import { nativeServiceStatusCode, assertToolPreflight } from '../../scripts/lib/tool-preflight.mjs';
const blocked=(fn,code)=>assert.throws(fn,e=>e.exitCode===3&&e.code===code);
function retime(ref,ageMs) {
  const at=new Date(Date.now()-ageMs).toISOString();
  const lines=readFileSync(ref.path,'utf8').trimEnd().split('\n').map(line=>JSON.stringify({...JSON.parse(line),timestamp:at}));
  writeFileSync(ref.path,lines.join('\n')+'\n');
  ref.call_sha256=sha256(lines[ref.call_line-1]);ref.result_sha256=sha256(lines[ref.result_line-1]);
}
function changeResult(ref,change) {
  const lines=readFileSync(ref.path,'utf8').trimEnd().split('\n'),event=JSON.parse(lines[ref.result_line-1]);
  const envelope=JSON.parse(event.payload.output),output=JSON.parse(envelope.content[0].text);
  change(output);envelope.content[0].text=JSON.stringify(output);event.payload.output=JSON.stringify(envelope);
  lines[ref.result_line-1]=JSON.stringify(event);ref.result_sha256=sha256(lines[ref.result_line-1]);
  writeFileSync(ref.path,lines.join('\n')+'\n');
}
function setup() {
  const runDir=mkdtempSync(join(tmpdir(),'teamqa-native-fresh-'));
  mkdirSync(join(runDir,'tools'));
  const servicePath=join(runDir,'tools/macos-service.mjs');writeFileSync(servicePath,'// mock status helper; never executed\n');
  const native={node_path:'/fixture/node',service:{path:servicePath,sha256:sha256(readFileSync(servicePath))}};
  const imagePath=join(runDir,'image.png');
  const pixels=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1Z0AAAAASUVORK5CYII=','base64');writeFileSync(imagePath,pixels);
  const roster={run_id:'fixture',round:1,roster_hash:'a'.repeat(64),target:{project_id:'fixture',preview_url:'http://localhost:3000',version:'a'.repeat(40)},roles:[{role:'executor_gui'}],catalog_source:{kind:'fixture'}};
  const p={schema:'team-qa/tool-preflight/v1',run_id:roster.run_id,round:roster.round,roster_hash:roster.roster_hash,target:roster.target,runtime:{node_version:process.version,contract_sha256:readContract().contract_sha256},target_access:{kind:'dragon'},gui:null};
  let sequence=0;
  function evidence(name,input,output) {
    const n=sequence++,at=new Date(Date.now()-5000+n*100).toISOString();
    const marker='TEAMQA_PREFLIGHT run=fixture round=1 roster='+roster.roster_hash;
    const lines=[
      JSON.stringify({type:'response_item',timestamp:at,payload:{type:'message',role:'assistant',channel:'commentary',content:marker}}),
      JSON.stringify({type:'response_item',timestamp:at,payload:{type:'function_call',call_id:'c'+n,name,arguments:JSON.stringify(input)}}),
      JSON.stringify({type:'response_item',timestamp:at,payload:{type:'function_call_output',call_id:'c'+n,output:JSON.stringify({content:[{type:'text',text:JSON.stringify(output)}]})}})
    ];
    const path=join(runDir,'original-'+n+'.jsonl');writeFileSync(path,lines.join('\n')+'\n');
    return {path,call_line:2,result_line:3,call_sha256:sha256(lines[1]),result_sha256:sha256(lines[2])};
  }
  function status(pid=1234) {
    const service={loaded:true,loadedFromPlist:true,pid,current:'releases/1.6.9',status:{ok:true,ready:true,versionMatch:true,bridgeVersion:'1.6.9',bridgeBuild:'fixture-build',extension:{version:'1.6.9'}}};
    return {...evidence('mcp__node_repl__js',{code:nativeServiceStatusCode(native),title:'Dragon service status',timeout_ms:12000},{schema:'team-qa/native-service-status-result/v1',exit_code:0,signal:null,exceeded:false,stderr:'',output:JSON.stringify(service)}),native};
  }
  const session={sessionId:'s',nonce:'n',browserInstanceId:'b',forbidSyntheticDOM:false};
  function dragon(method,params,result) {
    return evidence('mcp__Dragon_Browser__dragon_rpc',{method,params},{ok:true,result});
  }
  const gui={status:status(),session:dragon('session.create',session,{...session,policy:{requireTrusted:true,forbidSyntheticDOM:false}}),open:dragon('openTab',{...session,url:roster.target.preview_url,active:false},{tabId:42}),read:dragon('do',{...session,tabId:42,steps:[{read:'({url:location.href,dom:document.body.innerHTML})',as:'target'}]},{reads:{target:{url:roster.target.preview_url,dom:'<main>Fixture target content</main>'}}}),screenshot:dragon('screenshot',{...session,tabId:42,toFile:imagePath},{savedTo:imagePath,privacyMasked:true,maskedRects:[]}),image:{path:imagePath,sha256:sha256(pixels)},fresh_status:status(),fresh_session:dragon('session.list',{}, {sessions:[{sessionId:'s',alive:true,browserInstanceId:'b',expired:false,circuitOpen:false,forbidSyntheticDOM:false,policy:{requireTrusted:true,forbidSyntheticDOM:false}}]})};
  p.target_access.gui=gui;p.gui=gui;
  const run=(fresh=true)=>{writeFileSync(join(runDir,'preflight.json'),JSON.stringify(p));return assertToolPreflight({runDir,roster,stage:'execute',role:'executor_gui',requirements:{code:false,gui:true,recording:false},requireFresh:fresh});};
  const legacyStatus=()=>evidence('exec_command',{cmd:'curl --fail --silent http://127.0.0.1:9233/status'},{exit_code:0,output:JSON.stringify({ok:true,ready:true,versionMatch:true,bridgeVersion:'1.6.9',extension:{version:'1.6.9'}})});
  return {run,p,gui,status,legacyStatus,roster,runDir};
}
test('native freshness uses later original status and session refs without live bridge probes',()=>{
  const f=setup();const r=f.run();assert.equal(r.verified,true);assert.equal(r.lanes.gui,'verified');
});
test('long-lived session provenance remains valid with fresh dispatch observations',()=>{
  const f=setup();
  for(const ref of [f.gui.status,f.gui.session,f.gui.open])retime(ref,600000);
  assert.equal(f.run().lanes.gui,'verified');
});
test('long-lived sessions still require fresh read, screenshot, native status and session list',()=>{
  for(const key of ['read','screenshot','fresh_status','fresh_session']) {
    const f=setup();for(const ref of [f.gui.status,f.gui.session,f.gui.open])retime(ref,600000);
    retime(f.gui[key],600000);blocked(()=>f.run(),'PREFLIGHT_STALE');
  }
  const reused=setup();reused.gui.fresh_status=reused.gui.status;
  blocked(()=>reused.run(),'PREFLIGHT_DRAGON_FRESH_SOURCE_REQUIRED');
});
test('old creation provenance still enforces original hashes, session and target bindings',()=>{
  for(const key of ['status','session','open']) {
    const f=setup();retime(f.gui[key],600000);
    const lines=readFileSync(f.gui[key].path,'utf8').trimEnd().split('\n');lines[f.gui[key].result_line-1]+=' ';
    writeFileSync(f.gui[key].path,lines.join('\n')+'\n');blocked(()=>f.run(),'PREFLIGHT_SOURCE_DRIFT');
  }
  const session=setup();retime(session.gui.session,600000);
  changeResult(session.gui.session,output=>{output.result.nonce='other-nonce';});
  blocked(()=>session.run(),'PREFLIGHT_GUI_SESSION_DRIFT');
  const tab=setup();retime(tab.gui.open,600000);
  changeResult(tab.gui.open,output=>{output.result.tabId=99;});
  blocked(()=>tab.run(),'PREFLIGHT_GUI_TAB_DRIFT');
  const target=setup();retime(target.gui.open,600000);target.roster.target.preview_url='http://localhost:4000';
  blocked(()=>target.run(),'PREFLIGHT_TARGET_ACCESS');
});
test('fresh status and session readback retain service version, browser and policy bindings',()=>{
  for(const [mutate,code] of [
    [output=>{const service=JSON.parse(output.output);service.status.bridgeBuild='other-build';output.output=JSON.stringify(service);},'PREFLIGHT_DRAGON_LIVE_DRIFT'],
    [output=>{const service=JSON.parse(output.output);service.status.bridgeVersion='1.6.10';service.status.extension.version='1.6.10';output.output=JSON.stringify(service);},'PREFLIGHT_DRAGON_LIVE_DRIFT'],
  ]) {const f=setup();changeResult(f.gui.fresh_status,mutate);blocked(()=>f.run(),code);}
  for(const [mutate,code] of [
    [s=>{s.browserInstanceId='other-browser';},'PREFLIGHT_DRAGON_SESSION_STALE'],
    [s=>{s.expired=true;},'PREFLIGHT_DRAGON_SESSION_STALE'],
    [s=>{s.policy.requireTrusted=false;},'PREFLIGHT_DRAGON_POLICY_DRIFT'],
  ]) {const f=setup();changeResult(f.gui.fresh_session,output=>mutate(output.result.sessions[0]));blocked(()=>f.run(),code);}
});
test('native freshness rejects missing, drifted, or stale refs',()=>{
  const missing=setup();delete missing.gui.fresh_status;blocked(()=>missing.run(),'PREFLIGHT_DRAGON_FRESH_SOURCE_REQUIRED');
  const drift=setup();drift.gui.fresh_status=drift.status(5678);blocked(()=>drift.run(),'PREFLIGHT_DRAGON_LIVE_DRIFT');
  const absent=setup();delete absent.gui.fresh_session;blocked(()=>absent.run(),'PREFLIGHT_DRAGON_FRESH_SOURCE_REQUIRED');
});

test('legacy recorded curl status remains accepted without launching curl',()=>{const f=setup();f.gui.status=f.legacyStatus();assert.equal(f.run(false).lanes.gui,'verified');});
