import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url));
// The approval text is the Vietnamese "approve this roster", written as escapes: it exercises the Vietnamese branch of the approval regex.
function run(mode){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'qa-approval-wiring-'))),copy=join(dir,'source'),home=join(dir,'host');mkdirSync(copy);
 for(const name of ['scripts','references','agents','SKILL.md','contracts','schemas'])cpSync(join(root,name),join(copy,name),{recursive:true});
 // Controlled transport isolates approval wiring; the real preflight validator has its own suite.
 writeFileSync(join(copy,'scripts/lib/tool-preflight.mjs'),`import {existsSync} from 'node:fs';import {join} from 'node:path';import {fail} from './core.mjs';export function assertToolPreflight({runDir}){if(!existsSync(join(runDir,'preflight.json')))fail(3,'PREFLIGHT_MISSING','','ungraded');return {verified:true};}export function readHostToolEvidence(){throw Error('unused');}export function readDragonToolEvidence(){throw Error('unused');}`);
 const script=`import {mkdirSync,writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {readJson,sha256,sha256File} from './scripts/lib/core.mjs';import {selectRoster,approveRoster,dispatchRole} from './scripts/lib/roster.mjs';import {rosterChat} from './scripts/lib/chat-presentation.mjs';
 const catalogPath=${JSON.stringify(join(root,'test/roster-dynamic/catalog-openai-v1.json'))};const catalog=readJson(catalogPath);catalog.source={kind:'runtime',reference:'controlled integration fixture'};catalog.collected_at=new Date().toISOString();for(const m of catalog.models)m.quality_evidence={fit_review:'source-reviewed'};
 const request=readJson(${JSON.stringify(join(root,'test/roster-dynamic/request-default.json'))});request.run_id='approval-wiring';const roster=selectRoster({catalog,request,catalogPath});const runDir=join(process.cwd(),'runs',request.run_id);mkdirSync(runDir,{recursive:true});const file=join(runDir,'roster.json');writeFileSync(file,JSON.stringify(roster));const hash=sha256File(file);const mode=${JSON.stringify(mode)};
 const folder=join(process.env.HOME,'.codex/sessions');mkdirSync(folder,{recursive:true});const path=join(folder,'fixture.jsonl');const body=mode==='hidden'?rosterChat(roster,hash):mode==='hash-only'?'TEAMQA_ROSTER run='+roster.run_id+' sha256='+hash:rosterChat(roster,hash);
 const shown=JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',channel:mode==='hidden'?'analysis':'commentary',content:[{type:'output_text',text:body}]}});const text='Duy\u1ec7t roster n\u00e0y.';const human=JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});writeFileSync(path,shown+'\\n'+human+'\\n');
 const event={schema:'team-qa/roster-user-event/v1',id:'controlled-user',actor:'user',text,run_id:roster.run_id,round:roster.round,roster_hash:hash,source:{path,line:2,sha256:sha256(human)}};
 if(mode!=='missing-preflight')writeFileSync(join(runDir,'preflight.json'),'{}');let code='approved';try{await approveRoster({runDir,file,userEvent:event});}catch(e){code=e.code;}console.log(JSON.stringify({code,approvalWritten:existsSync(join(runDir,'control/approvals/roster.json'))}));`;
 const output=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:copy,encoding:'utf8',env:{...process.env,HOME:home,TEAMQA_SCROLL_ROOT:process.env.TEAMQA_SCROLL_ROOT||join(homedir(),'Dev/scroll')}});
 assert.equal(output.status,0,output.stderr);return JSON.parse(output.stdout.trim());
}
test('runtime approval integration accepts a visible complete roster and verified transport',()=>assert.deepEqual(run('ready'),{code:'approved',approvalWritten:true}));
test('runtime approval integration blocks hidden/hash-only chat before writing approval',()=>{for(const mode of ['hidden','hash-only'])assert.deepEqual(run(mode),{code:'ROSTER_CHAT_NOT_PRESENTED',approvalWritten:false});});
test('runtime approval integration blocks absent preflight before writing approval',()=>assert.deepEqual(run('missing-preflight'),{code:'PREFLIGHT_MISSING',approvalWritten:false}));
