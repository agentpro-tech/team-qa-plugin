import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url));
const cases=[
 {id:'structured-readback',file:'scripts/lib/tool-preflight.mjs',from:'if (value.content.length === 0) {',to:'if (false) {',test:'tool-preflight.test.mjs',failed:'Pages structured-only readback preserves'},
 {id:'structured-error',file:'scripts/lib/tool-preflight.mjs',from:"must(structured.isError !== true && !structured.error, 'TOOL_ERROR');",to:'',test:'tool-preflight.test.mjs',failed:'Pages structured-only readback rejects tool errors'},
 {id:'structured-truncation',file:'scripts/lib/tool-preflight.mjs',from:"must(structured.truncated !== true && structured.isTruncated !== true, 'EXEC_OUTPUT_TRUNCATED');",to:'',test:'tool-preflight.test.mjs',failed:'Pages structured-only readback rejects tool errors'},
 {id:'hidden-channel',file:'scripts/lib/chat-presentation.mjs',from:"if (codex && !visibleCodexAssistantText(e)) return;",to:'',test:'chat-presentation.test.mjs',failed:'hidden analysis'},
 {id:'roster-presentation',file:'scripts/lib/roster.mjs',from:'assertRosterPresented(e,roster,hash);',to:'',test:'approval-integration.test.mjs',failed:'blocks hidden/hash-only'},
 {id:'approval-preflight',file:'scripts/lib/roster.mjs',from:"if(roster.catalog_source.kind==='runtime')assertToolPreflight({runDir,roster:{...roster,roster_hash:hash},stage:'basic'});",to:'',test:'approval-integration.test.mjs',failed:'blocks absent preflight'},
 {id:'plan-presentation',file:'scripts/lib/chat-presentation.mjs',from:'need(latest?.text.includes(planChat(input)),',to:'need(true,',test:'chat-presentation.test.mjs',failed:'plan approval rejects'},
 {id:'executor-scope',file:'scripts/lib/tool-preflight.mjs',from:"if (stage === 'execute') must(!(role === 'executor_code' && !requirements.code || role === 'executor_gui' && !requirements.gui), 'ROLE_OUT_OF_SCOPE');",to:'',test:'tool-preflight.test.mjs',failed:'N/A cannot authorize'},
 {id:'session-binding',file:'scripts/lib/tool-preflight.mjs',from:"if (session) must(['sessionId', 'nonce', 'browserInstanceId'].every(k => params[k] === session[k]), 'GUI_SESSION_DRIFT');",to:'',test:'tool-preflight.test.mjs',failed:'actual Dragon request binding'},
 {id:'freshness',file:'scripts/lib/tool-preflight.mjs',from:"must(age >= -60000 && age <= maximum, 'STALE');",to:"must(age >= -60000, 'STALE');",test:'tool-preflight.test.mjs',failed:'fresh dispatch accepts recent'},
];
for(const item of cases){
 const copy=mkdtempSync(join(tmpdir(),`tq-chat-mutant-${item.id}-`));
 for(const name of ['scripts','references','agents','SKILL.md','contracts','schemas','test/chat-preflight','test/roster-dynamic']){mkdirSync(join(copy,name,'..'),{recursive:true});cpSync(join(root,name),join(copy,name),{recursive:true});}
 const git=(...args)=>{const r=spawnSync('git',['-C',copy,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 git('init','-q');git('add','.');git('-c','user.name=QA fixture','-c','user.email=qa-fixture@example.invalid','commit','-qm','Retained mutation baseline');
 const path=join(copy,item.file),before=readFileSync(path,'utf8');assert.ok(before.includes(item.from),`mutation missing: ${item.id}`);
 const control=spawnSync(process.execPath,['--test',join(copy,'test/chat-preflight',item.test)],{encoding:'utf8',maxBuffer:4*1024*1024});
 assert.equal(control.status,0,`positive control failed: ${item.id}\n${control.stdout}${control.stderr}`);
 writeFileSync(path,before.replace(item.from,item.to));
 const result=spawnSync(process.execPath,['--test',join(copy,'test/chat-preflight',item.test)],{encoding:'utf8',maxBuffer:4*1024*1024});
 assert.equal(result.status,1,result.stdout+result.stderr);assert.ok(result.stdout.includes(item.failed),result.stdout);assert.match(result.stdout+result.stderr,/AssertionError/);
 console.log(`MUTATION_KILLED ${item.id} retained=${copy}`);
}
