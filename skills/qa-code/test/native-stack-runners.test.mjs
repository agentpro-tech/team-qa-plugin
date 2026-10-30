import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,renameSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {executeTestFiles,validateTestRunners,testExecutionOutcome} from '../scripts/lib/test-runners.mjs';
import {archiveOwnedPath} from '../scripts/lib/archive.mjs';

const run=(binary,args,extra={})=>spawnSync(binary,args,{cwd:extra.cwd,env:{...process.env,...extra.env,NODE_TEST_CONTEXT:undefined},encoding:'utf8',timeout:60000});
const matches=(pattern,file)=>pattern===file || pattern==='*';
test('stack configuration rejects shell, arbitrary flags and escaping mappings',()=>{
  for(const entry of [{type:'shell',testFiles:['*']},{type:'vitest',testFiles:['../escape']},{type:'deno',testFiles:['*'],permissions:['--filter=pass']},{type:'vitest',testFiles:['*'],args:['--passWithNoTests']},{type:'node',testFiles:['*'],env:{NODE_OPTIONS:'--import injected.mjs'}}]) assert.throws(()=>validateTestRunners([entry]));
});
test('Node cannot attest an ignored config and is rejected before execution',()=>{
  let calls=0;
  assert.throws(()=>executeTestFiles({repo:process.cwd(),files:['test/ordinary.test.mjs'],runners:[{type:'node',testFiles:['*'],config:'qa-code.json'}],run:()=>{calls++;},matches}),/Node runner does not consume/);assert.equal(calls,0);
});
test('unmapped and multiply mapped tests fail closed before dispatch',()=>{
  let calls=0;
  for(const runners of [[{type:'vitest',testFiles:['different']}],[{type:'node',testFiles:['*']},{type:'deno',testFiles:['*']}]] ) {
    const result=executeTestFiles({repo:process.cwd(),files:['security.test.tsx'],runners,run:()=>{calls++;},matches});
    assert.equal(result.status,null);assert.match(result.error.message,/mapping must be exact/);
  }
  assert.equal(calls,0);
});
test('archive-only cleanup preserves scratch bytes and rejects nonowned paths',()=>{
  const root=mkdtempSync(join(tmpdir(),'qa-code-archive-selftest-'));writeFileSync(join(root,'proof.txt'),'retain');
  const archived=archiveOwnedPath(root);assert.equal(existsSync(root),false);assert.equal(readFileSync(join(archived,'proof.txt'),'utf8'),'retain');
  assert.throws(()=>archiveOwnedPath(process.cwd()),/ownership denied/);
});
test('real Vitest TS/JSON loader, mapped V8 coverage and assertion RED',t=>{
  const dependencies=process.env.QA_CODE_VITEST_FIXTURE_MODULES;
  if(!dependencies||!existsSync(join(dependencies,'@vitest/coverage-v8/package.json'))) {t.skip('real Vitest/coverage-v8 runtime not supplied');return;}
  const root=mkdtempSync(join(tmpdir(),'qa-code-vitest-real-'));t.after(()=>archiveOwnedPath(root));
  symlinkSync(dependencies,join(root,'node_modules'));mkdirSync(join(root,'src'));mkdirSync(join(root,'test'));
  writeFileSync(join(root,'package.json'),'{"type":"module"}');writeFileSync(join(root,'src/rules.json'),'{"factor":2}');
  const original="import rules from './rules.json';\nexport class Box { constructor(readonly value:number){}; calculate(){return this.value*rules.factor;} }\n";
  writeFileSync(join(root,'src/math.ts'),original);
  writeFileSync(join(root,'vitest.config.mjs'),"export default {test:{coverage:{include:['src/**/*.ts']}}};");
  writeFileSync(join(root,'test/math.test.ts'),"import {test,expect} from 'vitest';import {Box} from '../src/math';test('native output',()=>expect(new Box(2).calculate()).toBe(4));");
  const execute=()=>executeTestFiles({repo:root,files:['test/math.test.ts'],runners:[{type:'vitest',testFiles:['*'],config:'vitest.config.mjs'}],coverageDir:join(root,'measurement'),run,matches});
  const green=execute();assert.equal(green.status,0,green.stderr);assert.equal(testExecutionOutcome(green),'pass');const lcov=green.reports.map(p=>readFileSync(p,'utf8')).join('\n');assert.match(lcov,/SF:.*math.ts/);assert.match(lcov,/DA:\d+,[1-9]/);assert.equal(green.records[0].receipt.stack_version,JSON.parse(readFileSync(join(dependencies,'vitest/package.json'))).version);
  renameSync(join(root,'src/math.ts'),join(root,'src/math.before-mutation.ts'));writeFileSync(join(root,'src/math.ts'),original.replace('this.value*rules.factor','this.value*3'));
  const red=execute();assert.equal(red.status,1);assert.equal(testExecutionOutcome(red),'fail');assert.match(red.stdout+red.stderr,/expected|AssertionError/);
  renameSync(join(root,'src/math.ts'),join(root,'src/math.mutant.ts'));renameSync(join(root,'src/math.before-mutation.ts'),join(root,'src/math.ts'));
  const restored=execute();assert.equal(restored.status,0,restored.stderr);assert.equal(testExecutionOutcome(restored),'pass');
});
test('real Deno TypeScript test and native mapped LCOV',t=>{
  const binary=process.env.QA_CODE_DENO_FIXTURE_BINARY;
  if(!binary||!existsSync(binary)){t.skip('real Deno runtime not supplied');return;}
  const root=mkdtempSync(join(tmpdir(),'qa-code-deno-real-'));t.after(()=>archiveOwnedPath(root));mkdirSync(join(root,'src'));mkdirSync(join(root,'test'));
  writeFileSync(join(root,'src/math.ts'),'export function twice(value:number){return value*2;}\n');writeFileSync(join(root,'test/math.test.ts'),"import {twice} from '../src/math.ts';Deno.test('actual result',()=>{if(twice(2)!==4)throw new Error('incorrect amount');});\n");
  const result=executeTestFiles({repo:root,files:['test/math.test.ts'],runners:[{type:'deno',binary,testFiles:['*']}],coverageDir:join(root,'measurement'),run,matches});
  assert.equal(result.status,0,result.stderr);assert.match(readFileSync(result.reports[0],'utf8'),/SF:.*math.ts/);assert.match(readFileSync(result.reports[0],'utf8'),/DA:\d+,[1-9]/);assert.equal(result.records[0].runner,'deno');assert.equal(testExecutionOutcome(result),'pass');
  renameSync(join(root,'src/math.ts'),join(root,'src/math.original.ts'));writeFileSync(join(root,'src/math.ts'),'export function twice(value:number){return value*3;}\n');
  const red=executeTestFiles({repo:root,files:['test/math.test.ts'],runners:[{type:'deno',binary,testFiles:['*']}],run,matches});assert.equal(red.status,1);assert.equal(testExecutionOutcome(red),'fail');
});

test('native outcome rejects loader, zero-test and contradictory summaries',()=>{
 for(const r of [{runner:'vitest',status:1,stdout:'Tests 1 failed',stderr:'ERR_MODULE_NOT_FOUND'},{runner:'vitest',status:0,stdout:'Test Files 1 passed',stderr:''},{runner:'deno',status:1,stdout:'ok | 1 passed | 0 failed',stderr:''},{runner:'vitest',status:0,stdout:'Tests 1 failed',stderr:''}]) assert.equal(testExecutionOutcome({status:r.status,records:[r]}),'ungraded');
});


test('real configured Deno retains its native LCOV instead of re-resolving transpile cache',t=>{
  const binary=process.env.QA_CODE_DENO_FIXTURE_BINARY;
  if(!binary||!existsSync(binary)){t.skip('real Deno runtime not supplied');return;}
  const root=mkdtempSync(join(tmpdir(),'qa-code-deno-configured-'));t.after(()=>archiveOwnedPath(root));mkdirSync(join(root,'src'));mkdirSync(join(root,'test'));
  writeFileSync(join(root,'phase1-deno.json'),JSON.stringify({imports:{math:'./src/math.ts'},nodeModulesDir:'none'}));
  writeFileSync(join(root,'src/math.ts'),'export function twice(value:number){return value*2;}\n');
  writeFileSync(join(root,'test/math.test.ts'),"import {twice} from 'math';Deno.test('actual configured result',()=>{if(twice(2)!==4)throw new Error('incorrect amount');});\n");
  const result=executeTestFiles({repo:root,files:['test/math.test.ts'],runners:[{type:'deno',binary,config:'phase1-deno.json',testFiles:['*']}],coverageDir:join(root,'measurement'),run,matches});
  assert.equal(result.status,0,result.stderr);
  const nativeReport=join(root,'measurement','runner-0-deno','raw','lcov.info');
  assert.equal(result.reports[0],nativeReport,'must consume the successful native test reporter, not a second cache-dependent export');
  assert.match(readFileSync(nativeReport,'utf8'),/SF:.*math.ts/);assert.match(readFileSync(nativeReport,'utf8'),/DA:\d+,[1-9]/);
  assert.equal(result.records.some(r=>r.runner==='deno-coverage'),false);
});

test('real Deno fallback conversion is accurate when unconfigured and never drops a declared config',t=>{
  const binary=process.env.QA_CODE_DENO_FIXTURE_BINARY;
  if(!binary||!existsSync(binary)){t.skip('real Deno runtime not supplied');return;}
  for(const configured of [false,true]){
    const root=mkdtempSync(join(tmpdir(),'qa-code-deno-conversion-'));t.after(()=>archiveOwnedPath(root));mkdirSync(join(root,'src'));mkdirSync(join(root,'test'));
    writeFileSync(join(root,'src/math.ts'),'export function twice(value:number){return value*2;}\n');
    writeFileSync(join(root,'config.json'),JSON.stringify({imports:{math:'./src/math.ts'},nodeModulesDir:'none'}));
    writeFileSync(join(root,'test/math.test.ts'),`import {twice} from '${configured?'math':'../src/math.ts'}';Deno.test('conversion fixture',()=>{if(twice(2)!==4)throw new Error('wrong output');});\n`);
    const observed=[];
    const execute=(bin,args,extra)=>{
      observed.push(args);const result=run(bin,args,extra);
      if(args[0]==='test'&&result.status===0){const raw=args.find(a=>a.startsWith('--coverage='))?.slice('--coverage='.length),lcov=join(raw,'lcov.info');if(existsSync(lcov))renameSync(lcov,join(dirname(raw),'native-before-fallback.lcov'));}
      return result;
    };
    const result=executeTestFiles({repo:root,files:['test/math.test.ts'],runners:[{type:'deno',binary,testFiles:['*'],...(configured?{config:'config.json'}:{})}],coverageDir:join(root,'measurement'),run:execute,matches});
    const converter=observed.find(a=>a[0]==='coverage');assert.ok(converter);
    if(configured){assert.equal(converter[1],'--config');assert.equal(converter[2],realpathSync(join(root,'config.json')));assert.equal(result.status,1,'Deno2.5.4 cannot accept configured converter; no alternate-map PASS');assert.equal(testExecutionOutcome(result),'ungraded');}
    else{assert.equal(result.status,0,result.stderr);assert.match(readFileSync(result.reports[0],'utf8'),/SF:.*math.ts/);assert.match(readFileSync(result.reports[0],'utf8'),/DA:\d+,[1-9]/);}
  }
});

test('missing import map, selected failing test and no mapped reporter never become PASS',t=>{
  const binary=process.env.QA_CODE_DENO_FIXTURE_BINARY;
  if(!binary||!existsSync(binary)){t.skip('real Deno runtime not supplied');return;}
  const root=mkdtempSync(join(tmpdir(),'qa-code-deno-negatives-'));t.after(()=>archiveOwnedPath(root));mkdirSync(join(root,'src'));mkdirSync(join(root,'test'));
  writeFileSync(join(root,'src/math.ts'),'export function value():number{return 2;}\n');writeFileSync(join(root,'config.json'),JSON.stringify({imports:{math:'./src/math.ts'}}));
  writeFileSync(join(root,'test/math.test.ts'),"import {value} from 'math';Deno.test('selected real assertion',()=>{if(value()!==3)throw new Error('expected three');});\n");
  const plain=executeTestFiles({repo:root,files:['test/math.test.ts'],runners:[{type:'deno',binary,testFiles:['*']}],run,matches});assert.equal(testExecutionOutcome(plain),'ungraded');
  const red=executeTestFiles({repo:root,files:['test/math.test.ts'],runners:[{type:'deno',binary,testFiles:['*'],config:'config.json'}],run,matches});assert.equal(testExecutionOutcome(red),'fail');
  const noReporter=executeTestFiles({repo:root,files:['test/math.test.ts'],runners:[{type:'node',testFiles:['*']}],coverageDir:join(root,'measurement'),run:()=>({status:0,stdout:'',stderr:''}),matches});assert.equal(noReporter.status,null);assert.match(noReporter.error.message,/executed-file report missing|no mapped LCOV/);
});

test('real Deno ignored selected assertions remain UNGRADED',t=>{
  const binary=process.env.QA_CODE_DENO_FIXTURE_BINARY;assert.ok(binary&&existsSync(binary),'actual Deno runtime required');
  const root=mkdtempSync(join(tmpdir(),'qa-code-deno-ignored-'));t.after(()=>archiveOwnedPath(root));mkdirSync(join(root,'test'));
  writeFileSync(join(root,'test/ignored.test.ts'),"Deno.test('passes',()=>{});Deno.test({name:'ignored selected assertion',ignore:true,fn(){throw new Error('must execute');}});\n");
  const result=executeTestFiles({repo:root,files:['test/ignored.test.ts'],runners:[{type:'deno',binary,testFiles:['*']}],run,matches});
  assert.equal(result.status,null);assert.match(result.error.message,/selected test execution mismatch/);assert.equal(result.records[0].execution_report.files[0].skipped,1);
});
