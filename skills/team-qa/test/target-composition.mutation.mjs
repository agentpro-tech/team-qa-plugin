#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=process.argv[2]?resolve(process.argv[2]):mkdtempSync(join(tmpdir(),'teamqa-composition-mutants-'));
mkdirSync(out,{recursive:true});
const variants=[
 {id:'cross-target-one-pass',path:'scripts/lib/target-composition.mjs',from:"components.every(c=>c.verdict==='pass')",to:"components.some(c=>c.verdict==='pass')",test:'test/target-composition.test.mjs'},
 {id:'missing-cross-target',path:'scripts/lib/target-composition.mjs',from:"need(declared.length>0&&same(entry.target_ids,declared),'COMPOSITION_EXPLICIT_APP_MAPPING',c.id);",to:'/* planted omission of required target components */',test:'test/target-composition.test.mjs'},
 {id:'missing-dependency-proof',path:'scripts/lib/target-composition.mjs',from:"if(!child?.run_dir||candidates.length!==1)return {status:'ungraded',reason:'COMPOSITION_DEPENDENCY_MISSING'};",to:"if(!child?.run_dir||candidates.length!==1)return {status:'verified'};",test:'test/target-composition.test.mjs'},
 {id:'wrong-dependency-build',path:'scripts/lib/target-composition.mjs',from:"need(same(proof.targets,targets),'COMPOSITION_DEPENDENCY_TARGETS');",to:'/* planted stale dependency acceptance */',test:'test/target-composition.test.mjs'},
 {id:'overwrite-output',path:'scripts/lib/target-composition.mjs',from:' assertNewCompositionOutput(out);',to:' /* planted output preflight bypass */',test:'test/target-composition.test.mjs'},
 {id:'racing-output-overwrite',path:'scripts/lib/core.mjs',from:"writeAtomic(path, content, { exclusive });",to:"writeAtomic(path, content, { exclusive: false });",test:'test/target-composition.test.mjs'},
 {id:'extra-mcp-server',path:'scripts/lib/catalog.mjs',from:'    mcpRoute(config);',to:'    /* planted bypass of strict Dragon route */',test:'test/catalog-status/catalog.test.mjs'},
];
const results=[];
for(const v of variants){
 const dir=join(out,v.id);mkdirSync(dir);
 for(const item of ['scripts','schemas','contracts','references','agents','fixtures','test'])cpSync(join(root,item),join(dir,item),{recursive:true});
 const p=join(dir,v.path),before=readFileSync(p,'utf8');mkdirSync(join(dir,'mutation-archive'));writeFileSync(join(dir,'mutation-archive/original-source.txt'),before);assert.equal(before.split(v.from).length,2,`unique mutation ${v.id}`);writeFileSync(p,before.replace(v.from,v.to));
 const r=spawnSync(process.execPath,['--test',v.test],{cwd:dir,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
 writeFileSync(join(dir,'stdout.log'),r.stdout||'');writeFileSync(join(dir,'stderr.log'),r.stderr||'');
 assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,1,`mutation ${v.id} must be RED`);
 assert.match(r.stdout,/fail [1-9]/);
 writeFileSync(join(dir,'mutation-archive/mutant-source.txt'),readFileSync(p));writeFileSync(p,before);
 const green=spawnSync(process.execPath,['--test',v.test],{cwd:dir,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
 writeFileSync(join(dir,'restored.stdout.log'),green.stdout||'');writeFileSync(join(dir,'restored.stderr.log'),green.stderr||'');
 assert.equal(green.error,undefined);assert.equal(green.status,0,`restored ${v.id} must be GREEN`);assert.equal(readFileSync(p,'utf8'),before);
 results.push({id:v.id,exit:r.status,restoredExit:green.status,originalBytesRestored:true,canonicalChanged:false,retained:dir});
}
writeFileSync(join(out,'RESULT.json'),JSON.stringify({scope:'tool fixture calibrations only',variants:results},null,2)+'\n');console.log(`MUTATION_RED_PROVEN variants=${results.length} retained=${out}`);
