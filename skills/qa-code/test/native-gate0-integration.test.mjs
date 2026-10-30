import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync,chmodSync,realpathSync,copyFileSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {archiveOwnedPath} from '../scripts/lib/archive.mjs';

const gate0=process.env.QA_CODE_NATIVE_GATE0_SCRIPT||resolve('scripts/lib/gate0.mjs');
const preload=resolve('scripts/lib/archive-fs-preload.mjs');
function git(repo,args){const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function fixture(t,type='vitest'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'qa-code-native-gate-')));t.after(()=>archiveOwnedPath(root));
  const repo=join(root,'repo'),bin=join(root,'bin'),scratch=join(root,'scratch'),archive=join(root,'retained');
  for(const p of [repo,bin,scratch,archive,join(repo,'src'),join(repo,'test'),join(root,'versions')])mkdirSync(p,{recursive:true});
  const save=(file,text)=>{const p=join(repo,file);if(existsSync(p))copyFileSync(p,join(root,'versions',randomUUID()));writeFileSync(p,text);};
  git(repo,['init','-q']);git(repo,['config','user.email','fixture@example.invalid']);git(repo,['config','user.name','Native fixture']);
  save('.gitignore','node_modules\n*.config.json\n');save('package.json','{"type":"module"}\n');
  save('src/math.ts','export function twice(value:number):number{return value*1;}\n');
  if(type==='vitest'){
    const modules=process.env.QA_CODE_VITEST_FIXTURE_MODULES;assert.ok(modules&&existsSync(join(modules,'vitest/vitest.mjs')),'real Vitest fixture runtime required');
    symlinkSync(modules,join(repo,'node_modules'));save('vitest.config.mjs',"export default {test:{coverage:{include:['src/**/*.ts']}}};\n");
    save('test/behavior.test.ts',"import {test,expect} from 'vitest';import {twice} from '../src/math';test('selected behavior',()=>expect(twice(2)).toBe(4));\n");
    save('test/preservation.test.ts',"import {test,expect} from 'vitest';import {twice} from '../src/math';test('zero remains zero',()=>expect(twice(0)).toBe(0));\n");
  }else{
    const binary=process.env.QA_CODE_DENO_FIXTURE_BINARY;assert.ok(binary&&existsSync(binary),'real Deno fixture runtime required');
    save('phase1-deno.json',JSON.stringify({imports:{'@native/math':'./src/math.ts'},nodeModulesDir:'none'})+'\n');
    save('test/behavior.test.ts',"import {twice} from '@native/math';Deno.test('selected behavior',()=>{if(twice(2)!==4)throw new Error('expected four');});\n");
    save('test/preservation.test.ts',"import {twice} from '@native/math';Deno.test('zero remains zero',()=>{if(twice(0)!==0)throw new Error('expected zero');});\n");
  }
  git(repo,['add','.']);git(repo,['commit','-qm','immutable behavior baseline']);const base=git(repo,['rev-parse','HEAD']);
  save('src/math.ts','export function twice(value:number):number{return value*2;}\n');git(repo,['add','.']);git(repo,['commit','-qm','behavior candidate']);
  // These scanners isolate runner admission; the scanner integration suite uses real gitleaks.
  for(const [name,source] of Object.entries({gitleaks:`#!/bin/sh
if [ "$1" = version ] || [ "$1" = --version ]; then echo 'fixture gitleaks'; exit 0; fi
while [ "$#" -gt 0 ]; do if [ "$1" = --report-path ]; then report="$2"; shift 2; else shift; fi; done
printf '[]' > "$report"
`,semgrep:`#!/bin/sh
if [ "$1" = --version ]; then echo 'fixture semgrep'; exit 0; fi
printf '{"results":[]}'
`})){
    const p=join(bin,name);writeFileSync(p,source);chmodSync(p,0o755);
  }
  const runner={type,testFiles:['test/*.test.ts'],config:type==='vitest'?'vitest.config.mjs':'phase1-deno.json',...(type==='deno'?{binary:process.env.QA_CODE_DENO_FIXTURE_BINARY}:{})};
  const config={coverage:{threshold:80,testFiles:['test/*.test.ts']},test_runners:[runner]};
  const execute=(overrides={},imports=[])=>{
    const id=randomUUID(),configPath=join(repo,id+'.config.json'),json=join(root,id+'.gate.json');writeFileSync(configPath,JSON.stringify({...config,...overrides}));
    const r=spawnSync(process.execPath,['--import',preload,...imports.flatMap(p=>['--import',p]),gate0,'--repo',repo,'--base',base,'--config',configPath,'--json',json,'--cve-cmd',"printf '{\"results\":[]}'"],{encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024,env:{...process.env,PATH:bin+':/usr/bin:/bin',QA_CODE_NODE:process.execPath,TMPDIR:scratch,QA_CODE_SCRATCH_ROOT:scratch,QA_CODE_ARCHIVE_ROOT:archive,QA_CODE_FS_ARCHIVE_ROOT:archive,QA_CODE_FS_ARCHIVE_ALLOWED_ROOTS:JSON.stringify([scratch]),NODE_TEST_CONTEXT:undefined}});
    return {r,output:existsSync(json)?JSON.parse(readFileSync(json,'utf8')):null};
  };
  return {root,repo,base,save,config,execute};
}

test('real Vitest Gate0 preserves 80 percent, stability and semantic baseline RED/current GREEN',t=>{
  const f=fixture(t),result=f.execute({stability:{runs:2},acceptance:{requirements:[{id:'NATIVE-1',fail_to_pass:['test/behavior.test.ts'],pass_to_pass:['test/preservation.test.ts']}]}});
  assert.equal(result.r.status,0,result.r.stderr);assert.equal(result.output.layers.coverage.status,'pass');assert.equal(result.output.layers.coverage.threshold,80);
  assert.deepEqual(result.output.stability.outcomes.map(v=>v.status),['pass','pass']);assert.equal(result.output.acceptance.status,'pass');
  const requirement=result.output.acceptance.results[0];assert.equal(requirement.fail_to_pass.base.outcome,'fail');assert.equal(requirement.fail_to_pass.head.outcome,'pass');assert.equal(requirement.pass_to_pass.base.outcome,'pass');
  assert.ok(result.output.native_test_runners.records.coverage.records[0].argv.includes('--coverage.provider=v8'));
  assert.equal(git(f.repo,['status','--porcelain']),'','product fixture source remains exact and clean');
});
test('real configured Deno Gate0 consumes mapped native LCOV with its selected import map',t=>{
  const f=fixture(t,'deno'),result=f.execute();assert.equal(result.r.status,0,result.r.stderr);assert.equal(result.output.layers.coverage.status,'pass');
  const record=result.output.native_test_runners.records.coverage.records[0];assert.ok(record.argv.includes('--config'));assert.equal(record.coverage_report.producer,'deno-test-native');
  const retained=join(result.output.native_test_runners.scratch_archive,'native-coverage',record.coverage_report.path.split('/native-coverage/')[1]);assert.match(readFileSync(retained,'utf8'),/SF:.*math.ts/);
});
test('native threshold downgrade and missing selected tests are rejected',t=>{
  const f=fixture(t),low=f.execute({coverage:{threshold:79,testFiles:['test/*.test.ts']}});assert.equal(low.r.status,2);assert.match(low.r.stderr,/COVERAGE_THRESHOLD_DOWNGRADE/);
  const absent=f.execute({coverage:{threshold:80,testFiles:['test/not-present.test.ts']}});assert.equal(absent.r.status,20);assert.equal(absent.output.layers.coverage.status,'ungraded');
});
test('suppressed source rows and an actual selected assertion failure cannot pass',t=>{
  const f=fixture(t);f.save('src/unrelated.ts','export function untouched():number{return 1;}\n');f.save('vitest.config.mjs',"export default {test:{coverage:{include:['src/unrelated.ts']}}};\n");git(f.repo,['add','.']);git(f.repo,['commit','-qm','coverage omission fixture']);
  const missing=f.execute();assert.equal(missing.r.status,1,missing.r.stderr);assert.equal(missing.output.layers.coverage.status,'fail');assert.equal(missing.output.layers.coverage.patch_pct,0);assert.ok(missing.output.layers.coverage.findings.some(v=>v.file==='src/math.ts'));
  f.save('test/behavior.test.ts',"import {test,expect} from 'vitest';import {twice} from '../src/math';test('selected behavior',()=>expect(twice(2)).toBe(999));\n");git(f.repo,['add','.']);git(f.repo,['commit','-qm','failing selected test fixture']);
  const red=f.execute();assert.equal(red.r.status,20);assert.equal(red.output.layers.coverage.status,'ungraded');assert.equal(red.output.native_test_runners.records.coverage.records[0].status,1);assert.match(red.output.native_test_runners.records.coverage.stdout,/1 failed/);
});
test('default Node Gate0 coverage path retains existing behavior without test_runners',t=>{
  const f=fixture(t);f.save('src/math.mjs','export function twice(value){return value*2;}\n');f.save('test/node.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';import {twice} from '../src/math.mjs';test('ordinary Node result',()=>assert.equal(twice(2),4));\n");
  git(f.repo,['add','.']);git(f.repo,['commit','-qm','ordinary Node fixture']);
  const result=f.execute({test_runners:undefined,coverage:{threshold:80,testFiles:['test/node.test.mjs']}});assert.equal(result.output.layers.coverage.tool,'node-test');assert.equal(result.output.native_test_runners,undefined);assert.notEqual(result.output.layers.coverage.status,'ungraded');
});
test('selected failing behavior cannot be suppressed by running only the preservation test',t=>{
  const f=fixture(t);f.save('test/behavior.test.ts',"import {test,expect} from 'vitest';import {twice} from '../src/math';test('selected failing behavior',()=>expect(twice(2)).toBe(999));\n");git(f.repo,['add','.']);git(f.repo,['commit','-qm','selected assertion failure fixture']);
  const result=f.execute();assert.equal(result.r.status,20,result.r.stderr);assert.equal(result.output.native_test_runners.records.coverage.records[0].status,1);assert.match(result.output.native_test_runners.records.coverage.stdout,/1 failed/);
});

// Both files are selected; config must not silently remove the failing one.
test('Vitest config exclusion of a selected failing file is UNGRADED',t=>{
  const f=fixture(t);f.save('test/behavior.test.ts',"import {test,expect} from 'vitest';import {twice} from '../src/math';test('excluded failing behavior',()=>expect(twice(2)).toBe(999));\n");
  f.save('vitest.config.mjs',"export default {test:{exclude:['**/behavior.test.ts'],coverage:{include:['src/**/*.ts']}}};\n");
  git(f.repo,['add','.']);git(f.repo,['commit','-qm','selected-file suppression fixture']);
  const result=f.execute();assert.equal(result.r.status,20,result.r.stderr);
  assert.equal(result.output.layers.coverage.status,'ungraded');
  assert.match(result.output.native_test_runners.records.coverage.first_error,/selected test execution mismatch/);
  const measured=result.output.native_test_runners.records.coverage.records[0];
  assert.equal(measured.files.length,2);assert.equal(measured.execution_report.files.length,1);
});
test('Vitest name filter cannot suppress a selected assertion',t=>{
  const f=fixture(t);f.save('vitest.config.mjs',"export default {test:{testNamePattern:'zero remains zero',coverage:{include:['src/**/*.ts']}}};\n");
  git(f.repo,['add','.']);git(f.repo,['commit','-qm','name-filter suppression fixture']);
  const result=f.execute();assert.equal(result.r.status,20,result.r.stderr);assert.match(result.output.native_test_runners.records.coverage.first_error,/selected test execution mismatch/);
});

test('aggregation retains raw FAIL but uses independently verified effective PASS (injected proof fixture only)',t=>{
  const f=fixture(t),scanner=join(f.root,'bin','gitleaks'),hook=join(f.root,'completed-proof-fixture.mjs');
  copyFileSync(scanner,join(f.root,'versions','scanner-before-proof-fixture'));
  writeFileSync(scanner,`#!/bin/sh
if [ "$1" = version ] || [ "$1" = --version ]; then echo 'fixture gitleaks'; exit 0; fi
while [ "$#" -gt 0 ]; do if [ "$1" = --report-path ]; then report="$2"; shift 2; else shift; fi; done
printf '[{"File":"src/math.ts","StartLine":1,"RuleID":"fixture"}]' > "$report"
exit 1
`);chmodSync(scanner,0o755);
  // This substitutes only the proof boundary to exercise the real Gate0 aggregate;
  // it cannot authorize a reviewer and is never packaged as runtime code.
  writeFileSync(hook,`import {registerHooks} from 'node:module';registerHooks({load(url,context,next){if(url.endsWith('/secret-adjudication.mjs'))return {format:'module',shortCircuit:true,source:"export const verifySecretAdjudication=()=>({status:'pass',review:{fixture:true}});export const verifiedSecretStatus=g=>g.layers.secret.effective_status??g.layers.secret.status;"};return next(url,context);}});`);
  const baseline=join(homedir(),'.qa-code',createHash('sha256').update(f.repo).digest('hex').slice(0,12),'coverage-baseline.json');
  const driftHook=join(f.root,'drifted-proof-fixture.mjs');
  writeFileSync(driftHook,readFileSync(hook,'utf8').replace('export const verifiedSecretStatus=g=>g.layers.secret.effective_status??g.layers.secret.status;',"export const verifiedSecretStatus=g=>{throw new Error('ADJUDICATION_RECEIPT_DRIFT');};"));
  const denied=f.execute({secret:{adjudication:{proof:'injected-boundary-fixture'}}},[driftHook]);
  assert.equal(denied.r.status,1);assert.equal(denied.output.layers.secret.effective_status,undefined);assert.equal(existsSync(baseline),false);
  assert.match(denied.output.summary,/secret/);
  const result=f.execute({secret:{adjudication:{proof:'injected-boundary-fixture'}}},[hook]);
  assert.equal(result.r.status,0,result.r.stderr);assert.equal(result.output.status,'pass');
  assert.equal(result.output.layers.secret.status,'fail');assert.equal(result.output.layers.secret.raw_scanner.status,'fail');assert.equal(result.output.layers.secret.effective_status,'pass');
  assert.match(result.output.summary,/exact reviewed adjudication/);assert.equal(existsSync(baseline),true);assert.equal(JSON.parse(readFileSync(baseline)).repo_pct,result.output.layers.coverage.repo_pct);
});
