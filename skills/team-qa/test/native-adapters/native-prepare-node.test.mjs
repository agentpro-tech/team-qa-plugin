import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from '../../scripts/lib/core.mjs';
import {nativePrepareNodeCode} from '../../scripts/lib/native-dispatch.mjs';
const modulePath=fileURLToPath(new URL('../../scripts/lib/native-dispatch.mjs',import.meta.url));
function fixture(){const runDir=mkdtempSync(join(tmpdir(),'teamqa-native-prepare-archive-'));const prompt=join(runDir,'task.md'),factsPath=join(runDir,'facts.json');writeFileSync(prompt,'Fixture only');writeFileSync(factsPath,'{}');return {helper:{path:modulePath,sha256:sha256(readFileSync(modulePath))},node_path:process.execPath,request:{runDir,role:'test_manager',prompt,factsPath,nativeNodeReads:true}};}
async function execute(code){const output=[],previous=globalThis.nodeRepl;globalThis.nodeRepl={write:value=>output.push(value)};try{await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));}finally{globalThis.nodeRepl=previous;}return output;}
test('prepare recipe uses pinned normal Node API rather than importing runtime into REPL',()=>{const f=fixture();const code=nativePrepareNodeCode(f);assert.match(code,/nativeChild.spawnSync/);assert.match(code,/NATIVE_PREPARE_MODULE_DRIFT/);assert.doesNotMatch(code,/nativeModule.prepareNativeRole/);});
test('prepare rejects helper byte drift and unknown recipe fields',()=>{const f=fixture();assert.throws(()=>nativePrepareNodeCode({...f,helper:{...f.helper,sha256:'0'.repeat(64)}}),/NATIVE_PREPARE_MODULE_DRIFT/);assert.throws(()=>nativePrepareNodeCode({...f,helper:{...f.helper,extra:true}}),/NATIVE_PREPARE_HELPER_FIELDS/);assert.throws(()=>nativePrepareNodeCode({...f,request:{...f.request,out:'/elsewhere'}}),/NATIVE_PREPARE_REQUEST_FIELDS/);assert.throws(()=>nativePrepareNodeCode({...f,node_path:'relative-node'}),/NATIVE_PREPARE_NODE_PATH/);});
test('original generated prepare fails before dispatch when real roster approval is absent',async()=>{const f=fixture();await assert.rejects(()=>execute(nativePrepareNodeCode(f)),/NATIVE_PREPARE_EXECUTION_FAILED/);assert.equal(existsSync(join(f.request.runDir,'native-dispatch/test_manager.json')),false);});
