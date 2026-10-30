import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../scripts/lib/core.mjs';
import * as preflight from '../../scripts/lib/tool-preflight.mjs';
import { assertDeployedIdentityProof, deployedTargetBindingSha256, WEB_CONTRACT_SHA256 } from '../../scripts/lib/deployed-target.mjs';

const failCode = (fn, code) => assert.throws(fn, e => e.code === code);
const pageUrl = 'https://fixture.example/cart';
const backendUrl = 'https://api.fixture.example';
const build = 'fixture-build';
const assets = ['https://fixture.example/_next/static/fixture-build/_buildManifest.js', 'https://fixture.example/_next/static/chunks/main.js'].sort();
const assetManifest = { kind:'nextjs-html-assets/v1', build_id:build, urls:assets };
const html = '<html><head><script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({buildId:build}) + '</script><script src="/_next/static/chunks/main.js"></script><script src="/_next/static/fixture-build/_buildManifest.js"></script></head><body>Fixture only</body></html>';
const session = { sessionId:'fixture-session', nonce:'fixture-nonce', browserInstanceId:'fixture-browser' };

function setup() {
  const runDir = mkdtempSync(join(tmpdir(), 'teamqa-passive-identity-'));
  const now = Date.now() - 10000;
  let sequence = 0;
  const target = {project_id:'fixture-web', preview_url:pageUrl, version:build, kind:'deployed-build',
    environment:'Test', backend_origin:backendUrl, frontend_build:{kind:'nextjs',id:build},
    asset_manifest_sha256:sha256(JSON.stringify(assetManifest)), identity_proof:{path:'proof.json',sha256:'0'.repeat(64)}};
  target.target_binding_sha256 = deployedTargetBindingSha256(target);
  const roster = {run_id:'fixture-original-run',round:1,roster_hash:'a'.repeat(64),target,
    roles:[{role:'executor_gui'}],catalog_source:{kind:'fixture'}};
  const marker = 'TEAMQA_IDENTITY_PREFLIGHT run='+roster.run_id+' round=1 target='+target.target_binding_sha256;
  function evidence(method, params, result, binding=marker, options={}) {
    const n=sequence++, at=new Date(now+n*100+Number(options.timeShift||0)).toISOString();
    const lines=[
      JSON.stringify({type:'response_item',timestamp:at,payload:{type:'message',role:'assistant',channel:'commentary',content:binding}}),
      JSON.stringify({type:'response_item',timestamp:at,payload:{type:'function_call',call_id:'fixture-'+n,name:'mcp__Dragon_Browser__dragon_rpc',arguments:JSON.stringify({method,params})}}),
      JSON.stringify({type:'response_item',timestamp:at,payload:{type:'function_call_output',call_id:'fixture-'+n,output:JSON.stringify({content:[{type:'text',text:JSON.stringify({ok:true,result})}]})}})
    ];
    const path=join(runDir,'original-'+n+'.jsonl');writeFileSync(path,lines.join('\n')+'\n');
    return {path,call_line:2,result_line:3,call_sha256:sha256(lines[1]),result_sha256:sha256(lines[2]),host:{fixture:true}};
  }
  function passive(binding=marker, overrides={}) {
    const params={...session,tabId:42,maxLength:200000,...overrides.params};
    const source=evidence('getPageHtml',params,overrides.html??html,binding,overrides);
    source.network_source=evidence('getNetwork',{...session,tabId:42,maxBytes:200000},
      overrides.network??{count:1,requests:[{t:now,method:'GET',url:backendUrl+'/fixture',status:200,type:'xmlhttprequest'}],cursor:now,truncated:false,omitted:0},binding,overrides);
    source.tab_source=evidence('getTabInfo',{...session,tabId:42,...overrides.tabParams},
      overrides.tab??{tabId:42,url:pageUrl,title:'Fixture'},binding,overrides);
    return source;
  }
  function seal(source) {
    const identity=Object.fromEntries(Object.entries(target).filter(([k])=>!['identity_proof','target_binding_sha256'].includes(k)));
    const proof={schema:'team-qa/deployed-identity-proof/v1',target_binding_sha256:target.target_binding_sha256,identity,sources:[source]};
    writeFileSync(join(runDir,'proof.json'),JSON.stringify(proof));
    target.identity_proof.sha256=sha256(readFileSync(join(runDir,'proof.json')));
    roster.roster_hash=sha256(JSON.stringify(roster));
    return proof;
  }
  return {runDir,roster,target,marker,evidence,passive,seal,now};
}

test('old provisional roster marker becomes stale without hashing marker bytes',()=>{
  const f=setup(), provisional=f.roster.roster_hash;
  const ref=f.evidence('help',{}, {},'TEAMQA_PREFLIGHT run='+f.roster.run_id+' round=1 roster='+provisional);
  assert.equal(preflight.readHostToolEvidence(ref,{roster:f.roster,runDir:f.runDir}).name,'mcp__Dragon_Browser__dragon_rpc');
  const original=[ref.call_sha256,ref.result_sha256];
  f.seal(ref);
  assert.notEqual(f.roster.roster_hash,provisional);
  assert.deepEqual([ref.call_sha256,ref.result_sha256],original);
  failCode(()=>preflight.readHostToolEvidence(ref,{roster:f.roster,runDir:f.runDir}),'PREFLIGHT_CALL_BINDING');
  const late=JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',channel:'commentary',content:'TEAMQA_PREFLIGHT run='+f.roster.run_id+' round=1 roster='+f.roster.roster_hash}});
  writeFileSync(ref.path,readFileSync(ref.path,'utf8')+late+'\n');
  failCode(()=>preflight.readHostToolEvidence(ref,{roster:f.roster,runDir:f.runDir}),'PREFLIGHT_CALL_BINDING');
});

test('passive original HTML/network/tab proof closes generation-order bootstrap',()=>{
  const f=setup(), ref=f.passive();f.seal(ref);
  assert.equal(preflight.deployedIdentityBootstrapMarker({run_id:f.roster.run_id,round:1,target:f.target}),f.marker);
  const result=assertDeployedIdentityProof(f.target,{runDir:f.runDir,
    verifyOriginalSource:r=>preflight.readDeployedIdentityObservation(r,{roster:f.roster,runDir:f.runDir,requireFresh:true})});
  assert.equal(result.proof_sha256,f.target.identity_proof.sha256);
  const changed={...f.target,identity_proof:{path:'another.json',sha256:'b'.repeat(64)}};
  assert.equal(preflight.deployedIdentityBootstrapMarker({run_id:f.roster.run_id,round:1,target:changed}),f.marker);
  failCode(()=>preflight.readHostToolEvidence(ref,{roster:f.roster,runDir:f.runDir}),'PREFLIGHT_FIELDS');
});

test('bootstrap marker remains bound to exact run, round, target and visible-before-call source',()=>{
  for(const change of [{run_id:'another-run'},{round:2}]) {
    const f=setup(),ref=f.passive();Object.assign(f.roster,change);
    failCode(()=>preflight.readDeployedIdentityObservation(ref,{roster:f.roster,runDir:f.runDir}),'PREFLIGHT_CALL_BINDING');
  }
  const f=setup(),ref=f.passive();f.target.backend_origin='https://another.example';
  f.target.target_binding_sha256=deployedTargetBindingSha256(f.target);
  failCode(()=>preflight.readDeployedIdentityObservation(ref,{roster:f.roster,runDir:f.runDir}),'PREFLIGHT_CALL_BINDING');
});

test('passive sources reject redirect, tab/session drift, absent backend and incomplete network',()=>{
  const cases=[
    [{tab:{tabId:42,url:'https://fixture.example/redirect'}},'PREFLIGHT_WEB_PASSIVE_URL'],
    [{tabParams:{tabId:43}},'PREFLIGHT_GUI_TAB_DRIFT'],
    [{tabParams:{nonce:'other'}},'PREFLIGHT_GUI_SESSION_DRIFT'],
    [{network:{count:0,requests:[],cursor:0,truncated:false,omitted:0}},'PREFLIGHT_WEB_BACKEND_OBSERVATION'],
    [{network:{count:1,requests:[{t:Date.now(),url:backendUrl+'/fixture',status:500}],cursor:1,truncated:false,omitted:0}},'PREFLIGHT_WEB_BACKEND_OBSERVATION'],
    [{network:{count:1,requests:[{t:Date.now(),url:backendUrl+'/fixture',status:200}],cursor:1,truncated:true,omitted:1}},'PREFLIGHT_WEB_PASSIVE_NETWORK']
  ];
  for(const [options,code] of cases){const f=setup(),ref=f.passive(f.marker,options);failCode(()=>preflight.readDeployedIdentityObservation(ref,{roster:f.roster,runDir:f.runDir}),code);}
});

test('passive HTML parser rejects missing, duplicate, invalid, truncated and mismatched build content',()=>{
  const bad=[html.replace('id="__NEXT_DATA__"','id="OTHER"'),html.replace('</head>','<script id="__NEXT_DATA__">{}</script></head>'),html.replace(JSON.stringify({buildId:build}),'{broken}'),html+'\n<!-- truncated -->',html.replaceAll('/_next/static/','/other/static/')];
  for(const value of bad)assert.throws(()=>preflight.parsePassiveDeployedHtml(value,{preview_url:pageUrl}));
  const f=setup(),ref=f.passive(f.marker,{html:html.replaceAll('fixture-build','wrong-build')});
  failCode(()=>preflight.readDeployedIdentityObservation(ref,{roster:f.roster,runDir:f.runDir}),'PREFLIGHT_WEB_PASSIVE_BUILD');
  const extra=html.replace('</head>','<script src="https://third.example/_next/static/third.js"></script><script src="/_next/static/chunks/main.js"></script></head>');
  assert.equal(preflight.parsePassiveDeployedHtml(extra,{preview_url:pageUrl}).asset_manifest_sha256,sha256(JSON.stringify(assetManifest)));
});

test('passive intake retains exact source hash, freshness and unknown-field rejection',()=>{
  const stale=setup(),sr=stale.passive(stale.marker,{timeShift:-600000});
  failCode(()=>preflight.readDeployedIdentityObservation(sr,{roster:stale.roster,runDir:stale.runDir,requireFresh:true}),'PREFLIGHT_STALE');
  const drift=setup(),dr=drift.passive();dr.call_sha256='0'.repeat(64);
  failCode(()=>preflight.readDeployedIdentityObservation(dr,{roster:drift.roster,runDir:drift.runDir}),'PREFLIGHT_SOURCE_DRIFT');
  const unknown=setup(),ur=unknown.passive(unknown.marker,{params:{synthetic:true}});
  failCode(()=>preflight.readDeployedIdentityObservation(ur,{roster:unknown.roster,runDir:unknown.runDir}),'PREFLIGHT_FIELDS');
});

test('deployed BASIC accepts effective strict session and ordinary final-roster passive read',()=>{
  const f=setup(),identity=f.passive();f.seal(identity);
  const binding='TEAMQA_PREFLIGHT run='+f.roster.run_id+' round=1 roster='+f.roster.roster_hash;
  const status=f.evidence('unused',{}, {},binding);
  const lines=readFileSync(status.path,'utf8').trimEnd().split('\n');
  lines[1]=JSON.stringify({type:'response_item',payload:{type:'function_call',call_id:'status',name:'exec_command',arguments:JSON.stringify({cmd:'curl --fail --silent http://127.0.0.1:9233/status'})}});
  lines[2]=JSON.stringify({type:'response_item',payload:{type:'function_call_output',call_id:'status',output:JSON.stringify({exit_code:0,output:JSON.stringify({ok:true,ready:true,versionMatch:true,bridgeVersion:'1.6.9',extension:{version:'1.6.9'}})})}});
  writeFileSync(status.path,lines.join('\n')+'\n');status.call_sha256=sha256(lines[1]);status.result_sha256=sha256(lines[2]);
  const strict={...session,forbidSyntheticDOM:false,policy:{requireTrusted:true,forbidSyntheticDOM:false}};
  const read=f.passive(binding);delete read.network_source;
  const gui={status,session:f.evidence('session.create',{sessionId:session.sessionId,forbidSyntheticDOM:false},strict,binding),
    open:f.evidence('openTab',{...session,url:pageUrl,active:false},{tabId:42},binding),read};
  const p={schema:'team-qa/tool-preflight/v1',run_id:f.roster.run_id,round:1,roster_hash:f.roster.roster_hash,target:f.target,
    runtime:{node_version:process.version,contract_sha256:WEB_CONTRACT_SHA256},target_access:{kind:'dragon',gui},gui:null};
  writeFileSync(join(f.runDir,'preflight.json'),JSON.stringify(p));
  assert.equal(preflight.assertToolPreflight({runDir:f.runDir,roster:f.roster,stage:'basic'}).verified,true);
  gui.session=f.evidence('session.create',{sessionId:session.sessionId,forbidSyntheticDOM:true},{...session,forbidSyntheticDOM:true,policy:{requireTrusted:true,forbidSyntheticDOM:true}},binding);
  writeFileSync(join(f.runDir,'preflight.json'),JSON.stringify(p));
  failCode(()=>preflight.assertToolPreflight({runDir:f.runDir,roster:f.roster,stage:'basic'}),'PREFLIGHT_DRAGON_METADATA');
});

test('fresh strict deployed snapshot checks current effective policy without live probes',()=>{
  const f=setup(),identity=f.passive();f.seal(identity);
  const binding='TEAMQA_PREFLIGHT run='+f.roster.run_id+' round=1 roster='+f.roster.roster_hash;
  mkdirSync(join(f.runDir,'tools'));
  const servicePath=join(f.runDir,'tools/macos-service.mjs');writeFileSync(servicePath,'// fixture service helper; never executed\n');
  const native={node_path:process.execPath,service:{path:servicePath,sha256:sha256(readFileSync(servicePath))}};
  function status() {
    const ref=f.evidence('unused',{}, {},binding),lines=readFileSync(ref.path,'utf8').trimEnd().split('\n');
    const at=JSON.parse(lines[1]).timestamp;
    const service={loaded:true,loadedFromPlist:true,pid:1234,current:'releases/1.6.9',status:{ok:true,ready:true,versionMatch:true,bridgeVersion:'1.6.9',bridgeBuild:'fixture',extension:{version:'1.6.9'}}};
    lines[1]=JSON.stringify({type:'response_item',timestamp:at,payload:{type:'function_call',call_id:'status',name:'mcp__node_repl__js',arguments:JSON.stringify({code:preflight.nativeServiceStatusCode(native),title:'Fixture service status',timeout_ms:12000})}});
    lines[2]=JSON.stringify({type:'response_item',timestamp:at,payload:{type:'function_call_output',call_id:'status',output:JSON.stringify({content:[{type:'text',text:JSON.stringify({schema:'team-qa/native-service-status-result/v1',exit_code:0,signal:null,exceeded:false,stderr:'',output:JSON.stringify(service)})}]})}});
    writeFileSync(ref.path,lines.join('\n')+'\n');
    return {...ref,call_sha256:sha256(lines[1]),result_sha256:sha256(lines[2]),native};
  }
  const strict={...session,forbidSyntheticDOM:false,policy:{requireTrusted:true,forbidSyntheticDOM:false}};
  const gui={status:status(),session:f.evidence('session.create',{sessionId:session.sessionId,forbidSyntheticDOM:false},strict,binding),
    open:f.evidence('openTab',{...session,url:pageUrl,active:false},{tabId:42},binding)};
  const currentIdentity=f.passive(binding);
  gui.read=structuredClone(currentIdentity);delete gui.read.network_source;
  gui.fresh_status=status();
  const listed={sessionId:session.sessionId,browserInstanceId:session.browserInstanceId,alive:true,expired:false,circuitOpen:false,forbidSyntheticDOM:false,policy:strict.policy};
  gui.fresh_session=f.evidence('session.list',{}, {sessions:[listed]},binding);
  const p={schema:'team-qa/tool-preflight/v1',run_id:f.roster.run_id,round:1,roster_hash:f.roster.roster_hash,target:f.target,
    runtime:{node_version:process.version,contract_sha256:WEB_CONTRACT_SHA256},target_access:{kind:'dragon',gui},gui:null,current_identity:currentIdentity};
  const run=()=>{writeFileSync(join(f.runDir,'preflight.json'),JSON.stringify(p));return preflight.assertToolPreflight({runDir:f.runDir,roster:f.roster,stage:'basic',requireFresh:true});};
  assert.equal(run().verified,true);
  gui.fresh_session=f.evidence('session.list',{}, {sessions:[{...listed,policy:{requireTrusted:false,forbidSyntheticDOM:false}}]},binding);
  failCode(run,'PREFLIGHT_DRAGON_POLICY_DRIFT');
});

function htmlAtSize(chars,utf8Bytes=chars){
  const extraBytes=utf8Bytes-chars;
  assert.ok(extraBytes>=0&&chars-html.length>=extraBytes);
  // U+00E9 is one UTF-16 unit and two UTF-8 bytes.
  const text='\u00e9'.repeat(extraBytes)+'x'.repeat(chars-html.length-extraBytes);
  const value=html.replace('</body>',text+'</body>');
  assert.equal(value.length,chars);assert.equal(Buffer.byteLength(value,'utf8'),utf8Bytes);
  return value;
}
test('full passive HTML matches observed 261779 chars and 276625 bytes within 1MiB',()=>{
  const value=htmlAtSize(261779,276625);
  const parsed=preflight.parsePassiveDeployedHtml(value,{preview_url:pageUrl});
  assert.equal(parsed.asset_manifest_sha256,sha256(JSON.stringify(assetManifest)));
  failCode(()=>preflight.parsePassiveDeployedHtml(value,{preview_url:pageUrl,maxLength:200000}),'PREFLIGHT_WEB_PASSIVE_HTML');
  const f=setup(),source=f.passive(f.marker,{html:value,params:{maxLength:1048576}});f.seal(source);
  assert.equal(assertDeployedIdentityProof(f.target,{runDir:f.runDir,verifyOriginalSource:r=>preflight.readDeployedIdentityObservation(r,{roster:f.roster,runDir:f.runDir,requireFresh:true})}).proof_sha256,f.target.identity_proof.sha256);
});
test('passive HTML keeps exact 1MiB character and UTF8 byte bounds',()=>{
  assert.equal(preflight.parsePassiveDeployedHtml(htmlAtSize(1048576),{preview_url:pageUrl,maxLength:1048576}).frontend_build.id,build);
  for(const value of [htmlAtSize(1048577),htmlAtSize(600000,1048577)])failCode(()=>preflight.parsePassiveDeployedHtml(value,{preview_url:pageUrl,maxLength:1048576}),'PREFLIGHT_WEB_PASSIVE_HTML');
  failCode(()=>preflight.parsePassiveDeployedHtml(html,{preview_url:pageUrl,maxLength:1048577}),'PREFLIGHT_WEB_PASSIVE_HTML');
});
test('larger complete HTML never allows truncated or incomplete capture',()=>{
  const value=htmlAtSize(261779,276625);
  for(const suffix of ['\n<!-- truncated -->','\n…[truncated]'])failCode(()=>preflight.parsePassiveDeployedHtml(value+suffix,{preview_url:pageUrl}),'PREFLIGHT_WEB_PASSIVE_HTML');
  failCode(()=>preflight.parsePassiveDeployedHtml(value.slice(0,-7),{preview_url:pageUrl}),'PREFLIGHT_WEB_PASSIVE_HTML');
});

function directExecFixture(ref,header='// @exec: {"max_output_tokens": 1048576}\n',editBody=x=>x,outputPatch=x=>x){
 const lines=readFileSync(ref.path,'utf8').trimEnd().split('\n'),call=JSON.parse(lines[1]),result=JSON.parse(lines[2]);
 const request=JSON.parse(call.payload.arguments);
 call.payload={type:'custom_tool_call',name:'exec',namespace:'functions',call_id:call.payload.call_id,input:header+editBody('text(await tools.mcp__Dragon_Browser__dragon_rpc('+JSON.stringify(request)+'));')};
 const old=JSON.parse(result.payload.output);
 result.payload={type:'custom_tool_call_output',call_id:result.payload.call_id,output:[{type:'input_text',text:'Script completed\nWall time 0.1 seconds\nOutput:\n'},{type:'input_text',text:JSON.stringify(outputPatch(old))}]};
 lines[1]=JSON.stringify(call);lines[2]=JSON.stringify(result);writeFileSync(ref.path,lines.join('\n')+'\n');
 return {...ref,call_sha256:sha256(lines[1]),result_sha256:sha256(lines[2])};
}
test('bounded leading exec pragma preserves complete passive identity and original line hashes',()=>{
 const f=setup(),ref=f.passive(f.marker,{html:htmlAtSize(261779,276625),params:{maxLength:1048576}});
 Object.assign(ref,directExecFixture(ref));ref.network_source=directExecFixture(ref.network_source);ref.tab_source=directExecFixture(ref.tab_source);f.seal(ref);
 assert.equal(assertDeployedIdentityProof(f.target,{runDir:f.runDir,verifyOriginalSource:r=>preflight.readDeployedIdentityObservation(r,{roster:f.roster,runDir:f.runDir,requireFresh:true})}).proof_sha256,f.target.identity_proof.sha256);
 const line=readFileSync(ref.path,'utf8').trimEnd().split('\n')[1];assert.equal(ref.call_sha256,sha256(line));assert.ok(line.includes('max_output_tokens'));
});
test('ordinary direct passive pragma accepts bounded budgets and legacy wrapper remains supported',()=>{
 for(const budget of [1,10000,262144,1048576]){
  const f=setup(),marker='TEAMQA_PREFLIGHT run='+f.roster.run_id+' round=1 roster='+f.roster.roster_hash;
  const ref=directExecFixture(f.evidence('getTabInfo',{...session,tabId:42},{tabId:42,url:pageUrl},marker),'// @exec: {"max_output_tokens": '+budget+'}\n');
  assert.equal(preflight.readHostToolEvidence(ref,{roster:f.roster,runDir:f.runDir}).name,'mcp__Dragon_Browser__dragon_rpc');
 }
 const f=setup(),marker='TEAMQA_PREFLIGHT run='+f.roster.run_id+' round=1 roster='+f.roster.roster_hash;
 const ref=directExecFixture(f.evidence('getTabInfo',{...session,tabId:42},{tabId:42,url:pageUrl},marker),'');
 assert.equal(preflight.readHostToolEvidence(ref,{roster:f.roster,runDir:f.runDir}).input.method,'getTabInfo');
});
test('output pragma cannot allow unknown metadata, over-budget, comments, extra JS or non-passive calls',()=>{
 const headers=['// @exec: {"max_output_tokens": 1048577}\n','// @exec: {"max_output_tokens": 0}\n','// @exec: {"max_output_tokens": -1}\n','// @exec: {"max_output_tokens": 1.5}\n','// @exec: {"max_output_tokens": "10000"}\n','// @exec: {"max_output_tokens": 10000,"yield_time_ms":1}\n','// @exec: {"max_output_tokens":1,"max_output_tokens":10000}\n','// comment\n// @exec: {"max_output_tokens":10000}\n','// @exec: {"max_output_tokens":10000}\n// @exec: {"max_output_tokens":10000}\n'];
 for(const h of headers){const f=setup(),ref=f.passive();Object.assign(ref,directExecFixture(ref,h));assert.throws(()=>preflight.readDeployedIdentityObservation(ref,{roster:f.roster,runDir:f.runDir}));}
 for(const edit of [x=>x+'text("extra");',x=>'const r=await '+x.slice('text(await '.length,-2)+'text(r);',x=>x.replace('getPageHtml','trustedClick'),x=>x.replace('mcp__Dragon_Browser__dragon_rpc','mcp__Other__rpc'),x=>x.replace('"maxLength":200000','"maxLength":(1+1)')]){
  const f=setup(),ref=f.passive();Object.assign(ref,directExecFixture(ref,undefined,edit));assert.throws(()=>preflight.readDeployedIdentityObservation(ref,{roster:f.roster,runDir:f.runDir}));
 }
});
test('direct output pragma never legitimizes truncation markers or truncated metadata',()=>{
 const scope=setup(),marker='TEAMQA_PREFLIGHT run='+scope.roster.run_id+' round=1 roster='+scope.roster.roster_hash;
 const source=directExecFixture(scope.evidence('trustedClick',{...session,tabId:42},{ok:true},marker));failCode(()=>preflight.readHostToolEvidence(source,{roster:scope.roster,runDir:scope.runDir}),'PREFLIGHT_ADAPTER_UNSUPPORTED');
 const namespace=setup(),ns=directExecFixture(namespace.passive()),lines=readFileSync(ns.path,'utf8').trimEnd().split('\n'),call=JSON.parse(lines[1]);call.payload.namespace='other';lines[1]=JSON.stringify(call);writeFileSync(ns.path,lines.join('\n')+'\n');ns.call_sha256=sha256(lines[1]);failCode(()=>preflight.readDeployedIdentityObservation(ns,{roster:namespace.roster,runDir:namespace.runDir}),'PREFLIGHT_ADAPTER_UNSUPPORTED');

 for(const key of ['truncated','isTruncated']){const f=setup(),ref=f.passive();Object.assign(ref,directExecFixture(ref,undefined,x=>x,x=>({...x,[key]:true})));failCode(()=>preflight.readDeployedIdentityObservation(ref,{roster:f.roster,runDir:f.runDir}),'PREFLIGHT_EXEC_OUTPUT_TRUNCATED');}
 const f=setup(),ref=f.passive(f.marker,{html:html+'\n<!-- truncated -->'});Object.assign(ref,directExecFixture(ref));failCode(()=>preflight.readDeployedIdentityObservation(ref,{roster:f.roster,runDir:f.runDir}),'PREFLIGHT_WEB_PASSIVE_HTML');
});

function htmlEnvelope(value){
  const contentHash='sha256:'+sha256(JSON.stringify(['string',value])),ref='observation:'+contentHash.slice(7);
  return {value,evidence:{v:1,kind:'dom',ts:Date.now(),correlationId:null,contentHash,ref},telemetry:{durMs:1,bytesOut:Buffer.byteLength(value)+32,terminalReason:'complete',retryable:false,evidenceRef:ref}};
}
test('genuine-shaped HTML envelope retains exact HTML identity and legacy string support',()=>{
  const value=htmlAtSize(265916,282707);
  for(const wrapped of[false,true]){
    const f=setup(),source=f.passive(f.marker,{html:wrapped?htmlEnvelope(value):value,params:{maxLength:1048576}});
    const hashes=[source.call_sha256,source.result_sha256];
    const v=preflight.readDeployedIdentityObservation(source,{roster:f.roster,runDir:f.runDir,requireFresh:true});
    assert.equal(v.asset_manifest_sha256,f.target.asset_manifest_sha256);assert.deepEqual([source.call_sha256,source.result_sha256],hashes);
  }
});
test('HTML envelope rejects missing metadata, wrong types, content hashes and incomplete telemetry',()=>{
  const changes=[r=>{delete r.evidence},r=>{r.value={html}},r=>{r.value=''},r=>{r.evidence.v=2},r=>{r.evidence.kind='screenshot'},r=>{r.evidence.ts='today'},r=>{r.evidence.contentHash='sha256:'+'0'.repeat(64);r.evidence.ref='observation:'+'0'.repeat(64);r.telemetry.evidenceRef=r.evidence.ref},r=>{r.evidence.ref='observation:other'},r=>{r.telemetry.evidenceRef='observation:other'},r=>{r.telemetry.terminalReason='budget-bytes'},r=>{r.telemetry.retryable=true},r=>{r.telemetry.durMs=-1},r=>{r.telemetry.bytesOut=0}];
  for(const change of changes){const f=setup(),r=htmlEnvelope(html);change(r);const source=f.passive(f.marker,{html:r});assert.throws(()=>preflight.readDeployedIdentityObservation(source,{roster:f.roster,runDir:f.runDir}));}
});
test('HTML envelope rejects unknown fields at every envelope level',()=>{
  for(const key of['envelope','evidence','telemetry']){const f=setup(),r=htmlEnvelope(html);(key==='envelope'?r:r[key]).error='hidden failure';const source=f.passive(f.marker,{html:r});failCode(()=>preflight.readDeployedIdentityObservation(source,{roster:f.roster,runDir:f.runDir}),'PREFLIGHT_FIELDS');}
});
test('wrapped HTML cannot bypass truncation or character and UTF8 caps',()=>{
  for(const value of[html+'<!-- truncated -->',htmlAtSize(1048577),htmlAtSize(900000,1048577)]){const f=setup(),source=f.passive(f.marker,{html:htmlEnvelope(value),params:{maxLength:1048576}});failCode(()=>preflight.readDeployedIdentityObservation(source,{roster:f.roster,runDir:f.runDir}),'PREFLIGHT_WEB_PASSIVE_HTML');}
});
test('wrapped HTML retains original source hash, target and freshness gates',()=>{
  const f=setup(),source=f.passive(f.marker,{html:htmlEnvelope(html),timeShift:-600000});failCode(()=>preflight.readDeployedIdentityObservation(source,{roster:f.roster,runDir:f.runDir,requireFresh:true}),'PREFLIGHT_STALE');
  const g=setup(),drift=g.passive(g.marker,{html:htmlEnvelope(html)});drift.result_sha256='0'.repeat(64);failCode(()=>preflight.readDeployedIdentityObservation(drift,{roster:g.roster,runDir:g.runDir}),'PREFLIGHT_SOURCE_DRIFT');
  const h=setup(),wrong=h.passive(h.marker,{html:htmlEnvelope(html)});h.target.frontend_build.id='other';h.target.version='other';h.target.target_binding_sha256=deployedTargetBindingSha256(h.target);failCode(()=>preflight.readDeployedIdentityObservation(wrong,{roster:h.roster,runDir:h.runDir}),'PREFLIGHT_CALL_BINDING');
});
