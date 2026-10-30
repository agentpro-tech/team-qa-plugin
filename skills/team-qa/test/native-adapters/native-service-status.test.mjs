import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../scripts/lib/core.mjs';
import { nativeServiceStatusCode, readNativeServiceStatusEvidence } from '../../scripts/lib/tool-preflight.mjs';

function fixture(statusPatch={}, outputPatch={}, codePatch=null, ageMs=5000) {
  const runDir=mkdtempSync(join(tmpdir(),'teamqa-native-status-'));
  const folder=join(runDir,'tools'); mkdirSync(folder);
  const servicePath=join(folder,'macos-service.mjs');
  writeFileSync(servicePath,'// fixture: never executed\n');
  const service={path:servicePath,sha256:sha256(readFileSync(servicePath))};
  const native={node_path:'/fixture/node',service};
  const roster={run_id:'fixture',round:1,roster_hash:'a'.repeat(64),catalog_source:{kind:'fixture'}};
  const at=new Date(Date.now()-ageMs).toISOString();
  const status={loaded:true,loadedFromPlist:true,pid:1234,current:'releases/1.6.9',status:{ok:true,ready:true,bridgeVersion:'1.6.9',bridgeBuild:'fixture-build',versionMatch:true,extension:{version:'1.6.9'}},...statusPatch};
  const output={schema:'team-qa/native-service-status-result/v1',exit_code:0,signal:null,exceeded:false,stderr:'',output:JSON.stringify(status),...outputPatch};
  const code=codePatch ?? nativeServiceStatusCode(native);
  const marker='TEAMQA_PREFLIGHT run=fixture round=1 roster='+roster.roster_hash;
  const lines=[
    JSON.stringify({type:'response_item',timestamp:at,payload:{type:'message',role:'assistant',channel:'commentary',content:marker}}),
    JSON.stringify({type:'response_item',timestamp:at,payload:{type:'function_call',call_id:'status-call',name:'mcp__node_repl__js',arguments:JSON.stringify({code,title:'Dragon service status',timeout_ms:12000})}}),
    JSON.stringify({type:'response_item',timestamp:at,payload:{type:'function_call_output',call_id:'status-call',output:JSON.stringify({content:[{type:'text',text:JSON.stringify(output)}]})}})
  ];
  const path=join(runDir,'original.jsonl');writeFileSync(path,lines.join('\n')+'\n');
  const ref={path,call_line:2,result_line:3,call_sha256:sha256(lines[1]),result_sha256:sha256(lines[2]),native};
  return {ref,roster,runDir};
}
const read=f=>readNativeServiceStatusEvidence(f.ref,{roster:f.roster,runDir:f.runDir,requireFresh:true});
const blocked=(f,code)=>assert.throws(()=>read(f),e=>e.code===code);
test('original native status pair proves pinned service readiness without invoking bridge',()=>{
  const f=fixture();const result=read(f);assert.equal(result.native,true);assert.equal(result.service.pid,1234);assert.equal(result.version.ready,true);
  assert.match(nativeServiceStatusCode(f.ref.native),/nativeChild.spawn/);
  assert.doesNotMatch(nativeServiceStatusCode(f.ref.native),/curl|exec_command|execFileSync/);
});
test('native status rejects unloaded, missing PID, not-ready, version mismatch and transport errors',()=>{
  blocked(fixture({loaded:false}),'PREFLIGHT_DRAGON_SERVICE_NOT_LOADED');
  blocked(fixture({pid:null}),'PREFLIGHT_DRAGON_SERVICE_NOT_LOADED');
  blocked(fixture({status:{ok:true,ready:false,versionMatch:true,bridgeVersion:'1.6.9',bridgeBuild:'b',extension:{version:'1.6.9'}}}),'PREFLIGHT_DRAGON_NOT_READY');
  blocked(fixture({status:{ok:true,ready:true,versionMatch:true,bridgeBuild:'b',extension:{version:'1.6.9'}}}),'PREFLIGHT_DRAGON_VERSION');
  blocked(fixture({}, {stderr:'error'}),'PREFLIGHT_DRAGON_STATUS');
  blocked(fixture({}, {exit_code:1}),'PREFLIGHT_DRAGON_STATUS');
  const ambiguous=fixture();ambiguous.ref.helper={};blocked(ambiguous,'PREFLIGHT_DRAGON_STATUS_METADATA');
});
test('native status rejects code, service hash and stale original source',()=>{
  blocked(fixture({}, {}, 'nodeRepl.write("{}")'),'PREFLIGHT_DRAGON_STATUS_CALL');
  const f=fixture();f.ref.native.service.sha256='0'.repeat(64);blocked(f,'PREFLIGHT_DRAGON_SERVICE_PIN');
  blocked(fixture({}, {}, null,3600000),'PREFLIGHT_STALE');
});

// Public v1 (T1): requirements.json sets a minimum and a next-major bound for the bridge and the extension; the two
// may differ (the Chrome Web Store updates the extension on its own), and an older or unsupported one says what to do.
const status=(bridgeVersion,extension)=>fixture({status:{ok:true,ready:true,versionMatch:bridgeVersion===extension?.version,bridgeVersion,bridgeBuild:'b',extension}});
test('Dragon versions are checked against requirements.json, not against each other',()=>{
  assert.equal(read(status('1.6.10',{version:'1.6.9'})).version.bridgeVersion,'1.6.10');
  assert.equal(read(status('1.6.9',{version:'1.7.2'})).version.extension.version,'1.7.2');
  assert.equal(read(status('1.6.9-qa.991cf5d',{version:'1.6.9'})).version.ready,true);
  blocked(status('1.6.8',{version:'1.6.9'}),'PREFLIGHT_DRAGON_RUNTIME_OLD');
  blocked(status('2.0.0',{version:'1.6.9'}),'PREFLIGHT_DRAGON_RUNTIME_UNSUPPORTED');
  blocked(status('1.6.9',{version:'1.6.6'}),'PREFLIGHT_DRAGON_EXTENSION_OLD');
  blocked(status('1.6.9',{version:'2.1.0'}),'PREFLIGHT_DRAGON_EXTENSION_UNSUPPORTED');
  blocked(status('1.6.9',undefined),'PREFLIGHT_DRAGON_EXTENSION_MISSING');
  blocked(status('1.6.9',{version:'1.6.9',installType:'development'}),'PREFLIGHT_DRAGON_EXTENSION_NOT_STORE');
  blocked(status('1.6.9',{version:'1.6.9',id:'ecidbgopafpecddiefiihnpdljacaiko'}),'PREFLIGHT_DRAGON_EXTENSION_NOT_STORE');
  assert.equal(read(status('1.6.9',{version:'1.6.9',id:'dmgoldioklileddehbjpbfacojckfkjo',installType:'normal'})).version.ready,true);
});
test('an older Dragon is refused with the fix to run',()=>{
  assert.throws(()=>read(status('1.6.9',{version:'1.6.6'})),e=>e.code==='PREFLIGHT_DRAGON_EXTENSION_OLD'&&/older than 1\.6\.9/.test(e.message)&&/update_extension/.test(e.message)&&/teamqa doctor/.test(e.message));
});
