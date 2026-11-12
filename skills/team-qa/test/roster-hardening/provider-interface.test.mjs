import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyProviderInterface} from '../../scripts/lib/roster.mjs';

function candidate(overrides={}) {
  const root=mkdtempSync(join(tmpdir(),'teamqa-provider-anchor-'));
  mkdirSync(join(root,'scripts/lib'),{recursive:true});
  writeFileSync(join(root,'SOURCE.json'),JSON.stringify({schema:'agentpro/skill-source/v1',skill:'qa-code',repo:'https://github.com/agentpro-tech/qa-code.git',commit:'0'.repeat(40),manifest_sha256:'a'.repeat(64),...overrides}));
  writeFileSync(join(root,'scripts/package-tool.mjs'),'console.log("PASS");');
  writeFileSync(join(root,'scripts/lib/provider-execution.mjs'),'throw new Error("UNTRUSTED_IMPORT");');
  return root;
}
test('a self-certifying candidate cannot replace the canonical provider repository',()=>{
  assert.throws(()=>verifyProviderInterface({root:candidate({repo:'https://example.invalid/qa-code.git'})}),e=>e.code==='PROVIDER_INTERFACE_SOURCE');
});
test('provider source requires exact commit and manifest hashes before Git lookup',()=>{
  for(const overrides of [{commit:'HEAD'},{manifest_sha256:'made-up'}])assert.throws(()=>verifyProviderInterface({root:candidate(overrides)}),e=>e.code==='PROVIDER_INTERFACE_SOURCE');
});
async function isolatedRoster(anchorPath, modulePath) {
  const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  const code=readFileSync(join(sourceRoot,'scripts/lib/roster.mjs'),'utf8')
    .replace("from './native-dispatch.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/native-dispatch.mjs')).href}'`)
    .replace("from './native-host.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/native-host.mjs')).href}'`)
    .replace("from './host-transcript.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/host-transcript.mjs')).href}'`)
    .replace("from './buzz-host.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/buzz-host.mjs')).href}'`)
    .replace("from './original-source.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/original-source.mjs')).href}'`)
    .replace("from './core.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/core.mjs')).href}'`)
    .replace("from './chat-presentation.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/chat-presentation.mjs')).href}'`)
    .replace("from './deployed-target.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/deployed-target.mjs')).href}'`)
    .replace("from './tool-preflight.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/tool-preflight.mjs')).href}'`)
    .replace("from './release-signature.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/release-signature.mjs')).href}'`)
    .replace("from './source-repo.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/source-repo.mjs')).href}'`)
    .replace("from './install-layout.mjs'",`from '${pathToFileURL(join(sourceRoot,'scripts/lib/install-layout.mjs')).href}'`)
    .replace("const ROOT = fileURLToPath(new URL('../../', import.meta.url));",`const ROOT = ${JSON.stringify(sourceRoot)};`)
    .replace("const anchorPath=join(homedir(),'.agents/skills',skill,'release-truth.json');",`const anchorPath=${JSON.stringify(anchorPath)};`);
  writeFileSync(modulePath,code);
  return import(pathToFileURL(modulePath).href);
}
test('an uncommitted fake provider manifest cannot certify a helper even with matching repo identity',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'teamqa-uncommitted-provider-'));
  const repo=join(dir,'canonical'),anchorPath=join(dir,'anchor.json');
  assert.equal(spawnSync('git',['init',repo],{encoding:'utf8'}).status,0);
  assert.equal(spawnSync('git',['-C',repo,'remote','add','origin','https://github.com/agentpro-tech/qa-code.git'],{encoding:'utf8'}).status,0);
  writeFileSync(anchorPath,JSON.stringify({head:'1'.repeat(40),repo_url:'https://github.com/agentpro-tech/qa-code.git',repo}));
  const isolated=await isolatedRoster(anchorPath,join(dir,'roster.mjs'));
  assert.throws(()=>isolated.verifyProviderInterface({root:candidate()}),e=>e.code==='PROVIDER_SOURCE_NOT_IN_CANONICAL_GIT');
});
test('an existing malformed anchor never falls back to the default canonical checkout',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'teamqa-invalid-anchor-'));
  const anchorPath=join(dir,'anchor.json');
  const isolated=await isolatedRoster(anchorPath,join(dir,'roster.mjs'));
  for(const invalid of [null,false,0,[],{}, {repo_url:'wrong',repo:dir}]) {
    writeFileSync(anchorPath,JSON.stringify(invalid));
    assert.throws(()=>isolated.verifyProviderInterface({root:candidate()}),e=>['PROVIDER_CANONICAL_ANCHOR_REQUIRED','PROVIDER_CANONICAL_ANCHOR'].includes(e.code));
  }
});

// One gate check used to verify the child skills again for every attestation. Within one
// process a verified interface is reused while what it read is unchanged; a failed check is never kept (the tests above
// still fail every time). Needs an installed QA GUI (TEAMQA_QA_GUI_ROOT or ~/.agents/skills/qa-gui).
const installed = (() => { try { return verifyProviderInterface({ skill: 'qa-gui' }); } catch { return null; } })();
test('a verified provider interface is reused within the process', { skip: !installed && 'no verifiable QA GUI install' }, () => {
  assert.equal(verifyProviderInterface({ skill: 'qa-gui' }), installed);
  assert.equal(verifyProviderInterface({ skill: 'qa-gui', root: installed.root }), installed);
});
