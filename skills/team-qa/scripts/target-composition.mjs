#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { parseFlags, runEntrypoint, emit, fail } from './lib/core.mjs';
import { readComposition, prepareComposition, writeCompositionReport, verifyCompositionReport } from './lib/target-composition.mjs';
export async function compositionCommand(action,args){
 const f=parseFlags(args,{'--file':{key:'file',required:true},...(['prepare','build'].includes(action)?{'--out':{key:'out',required:true}}:{}),...(action==='build'?{'--children':{key:'children',required:true}}:{})});
 if(action==='validate'){const i=readComposition(resolve(f.file));emit('pass','COMPOSITION_INPUT_VALID',`cases=${i.tracked.cases.length}`);}
 else if(action==='prepare'){await prepareComposition(resolve(f.file),resolve(f.out));emit('pass','PROJECTION_PREPARED','current_run_graded=false','approval_required=true');}
 else if(action==='build'){const report=await writeCompositionReport(resolve(f.file),resolve(f.children),resolve(f.out));emit('pass',`release_verdict=${report.release_verdict}`);}
 else if(action==='verify'){const r=verifyCompositionReport(resolve(f.file));emit('pass',`release_verdict=${r.release_verdict}`);}
 else fail(2,'COMPOSITION_COMMAND');
}
// Through realpath, so a linked path (~/.claude/skills/team-qa) still runs the command instead of exiting 0 silently.
const isMain=()=>{try{return Boolean(process.argv[1])&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}};
if(isMain())await runEntrypoint(()=>compositionCommand(process.argv[2],process.argv.slice(3)));
