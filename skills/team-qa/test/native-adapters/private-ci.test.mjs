import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,chmodSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

// Exercise the credential boundary without real keys or private network calls.
const workflow=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
const step=workflow.split('      - name: Fetch pinned QA parser and board tooling for fixture tests')[1].split('      - name: Verify package manifest')[0];
const script=step.split('        run: |\n')[1].split('\n').map(line=>line.slice(10)).join('\n');
function run(codeKey,guiKey,{hostMetadata='{"ssh_keys":["ssh-ed25519 synthetic-host-key"]}',curlExit=0}={}){
 const dir=mkdtempSync(join(tmpdir(),'teamqa-private-ci-')),bin=join(dir,'bin'),calls=join(dir,'calls');mkdirSync(bin);
 writeFileSync(join(bin,'git'),`#!/bin/sh\nprintf '%s | ssh=%s | code_env=%s | gui_env=%s\\n' "$*" "$GIT_SSH_COMMAND" "$QA_CODE_DEPLOY_KEY" "$QA_GUI_DEPLOY_KEY" >> '${calls}'\n`);chmodSync(join(bin,'git'),0o755);
 writeFileSync(join(bin,'curl'),`#!/bin/sh\nprintf '%s\\n' "$TEAMQA_SYNTHETIC_HOST_METADATA"\nexit "$TEAMQA_SYNTHETIC_CURL_EXIT"\n`);chmodSync(join(bin,'curl'),0o755);
 const result=spawnSync('bash',['-e','-c',script],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,QA_CODE_DEPLOY_KEY:codeKey,QA_GUI_DEPLOY_KEY:guiKey,TEAMQA_SYNTHETIC_HOST_METADATA:hostMetadata,TEAMQA_SYNTHETIC_CURL_EXIT:String(curlExit),RUNNER_TEMP:dir,GITHUB_ENV:join(dir,'exports')}});
 return {...result,dir,calls:readFileSync(calls,{encoding:'utf8',flag:'a+'})};
}
test('private CI dependencies fail before Git when either repository key is absent',()=>{
 for(const keys of [['',''],['synthetic-code-key',''],['','synthetic-gui-key']]){
  const result=run(...keys);assert.equal(result.status,20);assert.match(result.stderr,/QA_CODE_READ_DEPLOY_KEY and QA_GUI_READ_DEPLOY_KEY are required/);assert.equal(result.calls,'');
 }
});
test('repository-specific read keys retain host verification, exact pins and private storage',()=>{
 assert.match(step,/QA_CODE_DEPLOY_KEY: \$\{\{ secrets\.QA_CODE_READ_DEPLOY_KEY \}\}/);
 assert.match(step,/QA_GUI_DEPLOY_KEY: \$\{\{ secrets\.QA_GUI_READ_DEPLOY_KEY \}\}/);
 assert.doesNotMatch(step,/QA_DEPENDENCY_READ_TOKEN|StrictHostKeyChecking=no/);
 const result=run('synthetic-code-key','synthetic-gui-key');assert.equal(result.status,0,result.stderr);
 assert.equal(result.calls.split('\n').filter(Boolean).length,4);
 for(const repository of ['qa-code','qa-gui']){
  const line=result.calls.split('\n').find(line=>line.startsWith(`clone --no-checkout git@github.com:agentpro-tech/${repository}.git`));
  assert.ok(line);assert.match(line,new RegExp(`ssh -i ".*/${repository}"`));
  assert.match(line,/IdentitiesOnly=yes.*IdentityAgent=none.*BatchMode=yes.*StrictHostKeyChecking=yes.*UserKnownHostsFile=/);
  assert.match(line,/code_env= \| gui_env=$/);
 }
 for(const sha of ['925ae774ee31960be9ae653bdb3d07df46a6ed2a','4c6ad3bc565ccbdb9cf5d9e8405f2739cabeed53'])assert.ok(result.calls.includes('checkout '+sha));
 assert.doesNotMatch(result.calls+result.stdout+result.stderr,/synthetic-code-key|synthetic-gui-key/);
 const sshDir=join(result.dir,readdirSync(result.dir).find(name=>name.startsWith('teamqa-ci-ssh.')));
 for(const repository of ['qa-code','qa-gui'])assert.equal(statSync(join(sshDir,repository)).mode&0o777,0o600);
 const exports=readFileSync(join(result.dir,'exports'),'utf8');
 for(const variable of ['TEAMQA_NATIVE_TEST_QA_CODE_ROOT','TEAMQA_NATIVE_TEST_QA_GUI_ROOT','TEAMQA_PREFLIGHT_TEST_QA_CODE_ROOT','TEAMQA_QA_GUI_BOARD_TOOL'])assert.ok(exports.includes(variable+'='));
});
test('host metadata failure or an empty host key list blocks all private Git calls',()=>{
 for(const options of [{curlExit:22},{hostMetadata:'{"ssh_keys":[]}'}]){
  const result=run('synthetic-code-key','synthetic-gui-key',options);assert.notEqual(result.status,0);assert.equal(result.calls,'');
 }
});
