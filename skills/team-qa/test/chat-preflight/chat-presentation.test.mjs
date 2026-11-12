import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rosterChat, assertRosterPresented, planChat, assertPlanPresented, verifyBoardLink, preparePlanPresentation, loadPlanPresentation } from '../../scripts/lib/chat-presentation.mjs';
import { selectRoster, approveRoster } from '../../scripts/lib/roster.mjs';
import { planErrors } from '../../scripts/lib/validators.mjs';
import { sha256, sha256File } from '../../scripts/lib/core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const catalogPath = join(root, 'test/roster-dynamic/catalog-openai-v1.json');
function roster() {
  const catalog = JSON.parse(readFileSync(catalogPath));
  const request = JSON.parse(readFileSync(join(root, 'test/roster-dynamic/request-default.json')));
  return {...selectRoster({catalog, request, catalogPath}), roster_hash:'a'.repeat(64)};
}
function source(messages) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-chat-source-')), path = join(dir, 'transcript.jsonl');
  writeFileSync(path, messages.map(payload=>JSON.stringify({type:'response_item', payload})).join('\n')+'\n');
  return {source:{path,line:messages.length+1}};
}
function assistant(text) {return {type:'message',role:'assistant',channel:'commentary',content:[{type:'output_text',text}]};}
const rejects = (fn, code) => assert.throws(fn, e=>e.code===code);

test('full six-seat roster inline chat is accepted without user typing a hash', () => {
  const r=roster(), body=rosterChat(r,r.roster_hash), e=source([assistant(body)]);
  e.text='Approve this roster.';
  assert.doesNotThrow(()=>assertRosterPresented(e,r,r.roster_hash));
});
test('tool output and a hash-only assistant message do not present a roster', () => {
  const r=roster(), body=rosterChat(r,r.roster_hash);
  for(const payload of [{type:'function_call_output',call_id:'fixture',output:body},assistant(`TEAMQA_ROSTER run=${r.run_id} round=1 sha256=${r.roster_hash}`)])
    rejects(()=>assertRosterPresented(source([payload]),r,r.roster_hash),'ROSTER_CHAT_NOT_PRESENTED');
});
test('hidden analysis, unclassified Codex messages and thinking blocks cannot present roster or plan', () => {
  const r=roster(), body=rosterChat(r,r.roster_hash), input=planInput();
  for(const hidden of [{...assistant(body),channel:'analysis'},{...assistant(body),channel:undefined},{...assistant(body),content:[{type:'thinking',text:body}]}])
    rejects(()=>assertRosterPresented(source([hidden]),r,r.roster_hash),'ROSTER_CHAT_NOT_PRESENTED');
  rejects(()=>assertPlanPresented(source([{...assistant(planChat(input)),channel:'analysis'}]),input),'PLAN_CHAT_NOT_PRESENTED');
});
test('Claude visible assistant text is supported, while Claude thinking is excluded', () => {
  const r=roster(), body=rosterChat(r,r.roster_hash), e=source([]);
  writeFileSync(e.source.path,JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:body}]}})+'\n');e.source.line=2;
  assert.doesNotThrow(()=>assertRosterPresented(e,r,r.roster_hash));
  writeFileSync(e.source.path,JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'thinking',text:body}]}})+'\n');
  rejects(()=>assertRosterPresented(e,r,r.roster_hash),'ROSTER_CHAT_NOT_PRESENTED');
});
test('omitting a seat or changing its model, effort or route rejects approval', () => {
  const r=roster(), body=rosterChat(r,r.roster_hash);
  const row=body.split('\n').find(l=>l.startsWith('| Analyst |'));
  for(const text of [body.replace(row,''),body.replace('gpt-6.1-sol','unapproved-model'),body.replace('medium','low'),body.replace('Codex CLI','hidden-helper')])
    rejects(()=>assertRosterPresented(source([assistant(text)]),r,r.roster_hash),'ROSTER_CHAT_NOT_PRESENTED');
});
test('a later proposal makes a bare approval ambiguous for the older roster', () => {
  const r=roster(), later={...r,run_id:'another-run'};
  rejects(()=>assertRosterPresented(source([assistant(rosterChat(r,r.roster_hash)),assistant(rosterChat(later,'b'.repeat(64)))]),r,r.roster_hash),'ROSTER_CHAT_NOT_PRESENTED');
});
test('source mutation after rendering changes the actual roster hash and rejects approval', () => {
  const r=roster();
  rejects(()=>assertRosterPresented(source([assistant(rosterChat(r,r.roster_hash))]),r,'c'.repeat(64)),'ROSTER_CHAT_NOT_PRESENTED');
});
function planInput() {
  const r=roster();
  return {roster:r,plan:{app:'Sample Cart',plan_version:1,lanes:[{id:'cart',scope:['REQ']}],tiers:{REQ:'FULL'},exit_criteria:{p0_max:0,p1_max:0,coverage_high_pct:100,coverage_low_pct:70}},planHash:'d'.repeat(64),boardLink:{label:'QA board — Sample Cart — TEST',url:'https://chatgpt.com/p/example',provider:'space',canonical_sha256:'e'.repeat(64)},preflight:{lanes:{runtime:'verified',target:'verified',code:'verified',gui:{status:'BLOCKED',code:'PREFLIGHT_SOURCE_MISSING'},recording:'pending'}}};
}
test('plan shows approved roster, explicit QA board link and honest preflight statuses', () => {
  const input=planInput(), body=planChat(input);
  assert.match(body,/Approved roster/);
  assert.match(body,/\[QA board — Sample Cart — TEST\]\(https:\/\/chatgpt.com\/p\/example\)/);
  assert.match(body,/\| Dragon \/ QA GUI \| BLOCKED \|/);
  assert.match(body,/\| Recording \/ privacy \| NOT RUN \|/);
  assert.doesNotThrow(()=>assertPlanPresented(source([assistant(body)]),input));
});
test('plan approval rejects missing board link or hidden preflight details', () => {
  const input=planInput(), body=planChat(input);
  for(const text of [body.replace(/\[QA board[^\n]+/, 'board definition saved'),body.replace('PREFLIGHT_SOURCE_MISSING','PASS')])
    rejects(()=>assertPlanPresented(source([assistant(text)]),input),'PLAN_CHAT_NOT_PRESENTED');
});
test('preflight scope is typed and recording cannot be N/A while GUI disabled', () => {
  const p=planInput().plan;
  p.lanes=[{id:'cart',scope:['REQ'],parallel_ok:false,vi_sao:''}];p.exit_criteria.p1_waivers=[];p.run_id='sample';
  p.preflight={code:true,gui:false,recording:false};
  assert.deepEqual(planErrors(p),[]);
  for(const bad of [{code:'true',gui:false,recording:false},{code:true,gui:false,recording:true},{code:true,gui:false,recording:false,skip:true}]){
    p.preflight=bad;assert.notEqual(planErrors(p).length,0);
  }
});
test('board-link definition or prepared payload cannot substitute for a verified board', () => {
  const r=roster(), dir=mkdtempSync(join(tmpdir(),'qa-link-proof-'));
  rejects(()=>verifyBoardLink({runDir:dir,roster:r}),'QA_BOARD_LINK_MISSING');
  writeFileSync(join(dir,'board-link.json'),JSON.stringify({schema:'team-qa/board-link/v1',run_id:r.run_id,round:r.round,roster_hash:r.roster_hash,target:r.target,provider:'space',canonical:'missing.json',url:'https://chatgpt.com/p/missing'}));
  rejects(()=>verifyBoardLink({runDir:dir,roster:r}),'QA_BOARD_LINK_STALE');
});
test('board URL from a prepared/echo response is not a connector readback', () => {
  const r=roster(), dir=mkdtempSync(join(tmpdir(),'qa-link-source-'));
  const canonical=join(dir,'board.json'),snapshot=join(dir,'snapshot.json');
  writeFileSync(canonical,JSON.stringify({boardId:r.run_id,currentRound:r.round,title:'Cart',env:'TEST'}));
  writeFileSync(snapshot,JSON.stringify({url:'https://chatgpt.com/p/prepared'}));
  const payload=join(dir,'payload.json'),quality=payload+'.quality.json';
  writeFileSync(payload,JSON.stringify({protocol:'qa-gui/page-export/v1',title:'Cart',initial_blocks:[],canonical:{boardId:r.run_id,rev:1,sha256:'a'.repeat(64)}}));
  writeFileSync(quality,JSON.stringify({fixture:'chat-presentation-link-gate'}));
  writeFileSync(join(dir,'board-link.json'),JSON.stringify({schema:'team-qa/board-link/v1',run_id:r.run_id,round:r.round,roster_hash:r.roster_hash,target:r.target,provider:'space',canonical,canonical_sha256:sha256File(canonical),snapshot,snapshot_sha256:sha256File(snapshot),payload,payload_sha256:sha256File(payload),quality,quality_sha256:sha256File(quality),url:'https://chatgpt.com/p/prepared',read_source:{}}));
  rejects(()=>verifyBoardLink({runDir:dir,roster:r,
    verifyDelivery:({file,artifactPath,renderer})=>{assert.equal(file,canonical);assert.equal(artifactPath,payload);assert.equal(renderer,'space');return{};},
    readToolEvidence:()=>({name:'functions.exec_command',output:JSON.parse(readFileSync(snapshot))})}),'QA_BOARD_READ_TOOL_REQUIRED');
});

test('Notion board link without a pinned sealed payload is rejected before comparison',()=>{
  const r=roster(),dir=mkdtempSync(join(tmpdir(),'qa-link-notion-quality-'));
  const canonical=join(dir,'board.json'),snapshot=join(dir,'snapshot.json');
  writeFileSync(canonical,JSON.stringify({boardId:r.run_id,currentRound:r.round,title:'Cart',env:'TEST'}));
  const observed={url:'https://notion.so/fixture'};writeFileSync(snapshot,JSON.stringify(observed));
  writeFileSync(join(dir,'board-link.json'),JSON.stringify({schema:'team-qa/board-link/v1',run_id:r.run_id,round:r.round,roster_hash:r.roster_hash,target:r.target,provider:'notion',canonical,canonical_sha256:sha256File(canonical),snapshot,snapshot_sha256:sha256File(snapshot),url:observed.url,read_source:{fixture:true}}));
  let compared=false;
  rejects(()=>verifyBoardLink({runDir:dir,roster:r,readToolEvidence:()=>({name:'mcp__notion__retrieve_page',output:observed}),compareNotion:()=>{compared=true;return{};}}),'QA_BOARD_QUALITY_REQUIRED');
  assert.equal(compared,false);
});

test('Notion board link verifies its pinned delivery before the readback comparator',()=>{
  const r=roster(),dir=mkdtempSync(join(tmpdir(),'qa-link-notion-payload-'));
  const canonical=join(dir,'board.json'),snapshot=join(dir,'snapshot.json'),payload=join(dir,'payload.json'),quality=payload+'.quality.json';
  writeFileSync(canonical,JSON.stringify({boardId:r.run_id,currentRound:r.round,title:'Cart',env:'TEST'}));
  const observed={url:'https://notion.so/fixture'};writeFileSync(snapshot,JSON.stringify(observed));
  writeFileSync(payload,JSON.stringify({cases:[],defects:[]}));writeFileSync(quality,JSON.stringify({fixture:'explicit-chat-board-link-test'}));
  writeFileSync(join(dir,'board-link.json'),JSON.stringify({schema:'team-qa/board-link/v1',run_id:r.run_id,round:r.round,roster_hash:r.roster_hash,target:r.target,provider:'notion',canonical,canonical_sha256:sha256File(canonical),snapshot,snapshot_sha256:sha256File(snapshot),payload,payload_sha256:sha256File(payload),quality,quality_sha256:sha256File(quality),url:observed.url,read_source:{fixture:true}}));
  const order=[];
  const verified=verifyBoardLink({runDir:dir,roster:r,readToolEvidence:()=>({name:'mcp__notion__retrieve_page',output:observed}),
    verifyDelivery:({file,artifactPath,renderer})=>{assert.equal(file,canonical);assert.equal(artifactPath,payload);assert.equal(renderer,'notion');order.push('quality');return{fixture:true};},
    compareNotion:({canonical:source,snapshot:readback})=>{assert.equal(source,canonical);assert.equal(readback,snapshot);order.push('compare');return{fixture:true};}});
  assert.equal(verified.url,observed.url);assert.deepEqual(order,['quality','compare']);
});
test('Colab board link: the sealed HTML, the receipt and a readback still equal to the board', async () => {
  const { colabBody, COLAB_RECEIPT_SCHEMA } = await import('../../scripts/lib/board-colab.mjs');
  const r=roster(), dir=mkdtempSync(join(tmpdir(),'qa-link-colab-'));
  const canonical=join(dir,'board.json'),artifact=join(dir,'index.html'),readback=join(dir,'readback.json'),receiptPath=join(dir,'receipt.json');
  const board={boardId:r.run_id,currentRound:r.round,rev:2,title:'Cart',env:'TEST',cases:[{id:'TC-01',title:'Qty',status:'PASS',functionVerdict:'PASS',uiVerdict:'PASS'}],defects:[]};
  writeFileSync(canonical,JSON.stringify(board));writeFileSync(artifact,'<html>sealed</html>');
  const url='https://docs.example/d/qa-'+r.run_id;
  const write=(body,receiptExtra={})=>{
    writeFileSync(readback,JSON.stringify(body));
    const receipt={schema:COLAB_RECEIPT_SCHEMA,run_id:r.run_id,version:'9.9.9',board:{path:canonical,sha256:sha256File(canonical)},artifact:{path:artifact,sha256:sha256File(artifact)},
      readback:{path:readback,sha256:sha256File(readback)},doc:{id:'qa-'+r.run_id,url,rev:3},evidence:{},...receiptExtra};
    writeFileSync(receiptPath,JSON.stringify(receipt));
    writeFileSync(join(dir,'board-link.json'),JSON.stringify({schema:'team-qa/board-link/v1',run_id:r.run_id,round:r.round,roster_hash:r.roster_hash,target:r.target,provider:'colab',
      canonical,canonical_sha256:sha256File(canonical),artifact,artifact_sha256:sha256File(artifact),snapshot:readback,snapshot_sha256:sha256File(readback),
      payload:receiptPath,payload_sha256:sha256File(receiptPath),url}));
  };
  const good=colabBody(board,{runId:r.run_id,version:'9.9.9',canonicalSha256:sha256File(canonical)});
  const checked=[];
  const verifyArtifact=(c,a)=>{checked.push([c,a]);};
  write(good);
  assert.equal(verifyBoardLink({runDir:dir,roster:r,verifyArtifact}).url,url);
  assert.deepEqual(checked,[[canonical,artifact]]);
  const edited=structuredClone(good);edited.tasks[0].status='FAIL';write(edited);
  rejects(()=>verifyBoardLink({runDir:dir,roster:r,verifyArtifact}),'QA_BOARD_COLAB_READBACK');
  write(good,{doc:{id:'x',url:'https://docs.example/d/other',rev:1}});
  rejects(()=>verifyBoardLink({runDir:dir,roster:r,verifyArtifact}),'QA_BOARD_COLAB_RECEIPT');
  write(good);
  const link=JSON.parse(readFileSync(join(dir,'board-link.json')));link.url='file:///tmp/board.html';writeFileSync(join(dir,'board-link.json'),JSON.stringify(link));
  rejects(()=>verifyBoardLink({runDir:dir,roster:r,verifyArtifact}),'QA_BOARD_CLOUD_LINK');
});
test('CLI emits the same reviewable table rather than the historical log-only display', () => {
  const r=roster(), dir=mkdtempSync(join(tmpdir(),'qa-chat-cli-')),file=join(dir,'roster.json');
  writeFileSync(file,JSON.stringify(r));
  const result=spawnSync(process.execPath,[join(root,'scripts/roster.mjs'),'show','--file',file],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),rosterChat(r,sha256File(file)));
});


test('verified draft Page precedes DESIGN, and signed chat replays its frozen readback', async () => {
  const dir=mkdtempSync(join(tmpdir(),'qa-plan-presentation-')), r=roster();
  const git=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim();r.target.version=git;
  const child=process.env.TEAMQA_QA_GUI_BOARD_TOOL||join(homedir(),'.agents/skills/qa-gui/scripts/teamwork/cli.mjs');
  const canonical=join(dir,'draft-board.json'), projected=join(dir,'page.json'), snapshot=join(dir,'read-page.json');
  for(const args of [['init','--board-id',r.run_id,'--title','Sample Cart — Shopping cart','--language','en','--environment','TEST','--out',canonical],['export-page','--file',canonical,'--out',projected]]){
    const result=spawnSync(process.execPath,[child,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }
  assert.equal(JSON.parse(readFileSync(canonical)).cases.length,0,'draft must not invent designed cases');
  const page=JSON.parse(readFileSync(projected)), url='https://chatgpt.com/pages/fixture-readback';
  const observed={content:[],structuredContent:{content:{page_id:'fixture-readback',title:page.title,blocks:page.initial_blocks.map((markdown,i)=>({id:`b${i}`,hash:'observed-fixture',kind:'markdown',markdown}))},metadata:{page_id:'fixture-readback',url}},isError:false};
  writeFileSync(snapshot,JSON.stringify(observed));
  const rows=[{type:'response_item',payload:assistant(`TEAMQA_PREFLIGHT run=${r.run_id} round=${r.round} roster=${r.roster_hash}`)},
    {type:'response_item',payload:{type:'function_call',call_id:'read',name:'mcp__pages__read_page',arguments:JSON.stringify({page_id:'fixture-readback'})}},
    {type:'response_item',payload:{type:'function_call_output',call_id:'read',output:JSON.stringify(observed)}}].map(JSON.stringify);
  const transcript=join(dir,'host-fixture.jsonl');writeFileSync(transcript,rows.join('\n')+'\n');
  const quality=projected+'.quality.json';writeFileSync(quality,JSON.stringify({fixture:'explicit-chat-board-link-test'}));
  const link={schema:'team-qa/board-link/v1',run_id:r.run_id,round:r.round,roster_hash:r.roster_hash,target:r.target,provider:'space',canonical,canonical_sha256:sha256File(canonical),snapshot,snapshot_sha256:sha256File(snapshot),payload:projected,payload_sha256:sha256File(projected),quality,quality_sha256:sha256File(quality),url,read_source:{path:transcript,call_line:2,result_line:3,call_sha256:sha256(rows[1]),result_sha256:sha256(rows[2])}};
  writeFileSync(join(dir,'board-link.json'),JSON.stringify(link));
  const source=spawnSync('git',['-C',root,'show','HEAD:SKILL.md'],{encoding:'utf8'}).stdout;
  const {readContract}=await import('../../scripts/lib/release-truth.mjs');
  const preflight={schema:'team-qa/tool-preflight/v1',run_id:r.run_id,round:r.round,roster_hash:r.roster_hash,target:r.target,runtime:{node_version:process.version,contract_sha256:readContract().contract_sha256},target_access:{kind:'git',repo_root:root,source_path:'SKILL.md',source_sha256:sha256(source)}};
  writeFileSync(join(dir,'preflight.json'),JSON.stringify(preflight));
  const plan={...planInput().plan,preflight:{code:true,gui:true,recording:true}}, planPath=join(dir,'test-plan.md');writeFileSync(planPath,JSON.stringify(plan));
  // Test-only gate injection; production callers omit it and use verifyBoardDelivery.
  const verifyDelivery=({file,artifactPath,renderer})=>{assert.equal(file,canonical);assert.equal(artifactPath,projected);assert.equal(renderer,'space');return{fixture:true};};
  const comparePage=(args)=>{assert.ok(args.includes('--payload'));assert.equal(args[args.indexOf('--payload')+1],projected);return{url};};
  const packet=await preparePlanPresentation({runDir:dir,roster:r,plan,planPath,verifyDelivery,comparePage});
  assert.match(packet.text,/\[QA board — Sample Cart — Shopping cart — TEST\]/);
  assert.match(packet.text,/\| Dragon \/ QA GUI \| BLOCKED \|/);
  const user=sourceEvent(packet.text);assert.doesNotThrow(()=>assertPlanPresented(user,loadPlanPresentation({runDir:dir,roster:r,plan,planPath,verifyDelivery,comparePage}).input));
  writeFileSync(join(dir,'preflight.json'),'{}');writeFileSync(join(dir,'board-link.json'),'{}');
  assert.equal(loadPlanPresentation({runDir:dir,roster:r,plan,planPath,verifyDelivery,comparePage}).packet.text,packet.text,'refresh cannot rewrite approved presentation');
  const drift=structuredClone(observed);drift.structuredContent.content.title='other';writeFileSync(snapshot,JSON.stringify(drift));
  rejects(()=>loadPlanPresentation({runDir:dir,roster:r,plan,planPath,verifyDelivery,comparePage}),'QA_BOARD_LINK_STALE');
});
function sourceEvent(text){return source([assistant(text)]);}
