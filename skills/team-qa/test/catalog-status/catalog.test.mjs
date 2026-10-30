import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, chmodSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { collectCatalog } from '../../scripts/lib/catalog.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const fixture=name=>join(here,'fixtures',name);
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
function setup(){
  const dir=mkdtempSync(join(tmpdir(),'teamqa-catalog-'));
  const codex=join(dir,'codex.mjs'),claude=join(dir,'claude.mjs');
  for(const [src,dst] of [[fixture('fake-codex.mjs'),codex],[fixture('fake-claude.mjs'),claude]]){writeFileSync(dst,readFileSync(src));chmodSync(dst,0o755);}
  const log=join(dir,'calls.jsonl');
  return {dir,codex,claude,log,cleanup:()=>{}};
}

test('Codex catalog uses current read-only harness probes and safe cache whitelist',()=>{
  const s=setup();
  try{
    const catalog=collectCatalog({provider:'openai',codexBin:s.codex,codexCachePath:fixture('codex-models.json'),modelFitPath:fixture('model-fit.json'),repoRoot:resolve(here,'../..'),qaCodeRoot:join(s.dir,'missing-code'),qaGuiRoot:join(s.dir,'missing-gui'),sandboxProbes:false,now:()=>new Date('2026-10-02T14:00:00.000Z'),env:{PATH:process.env.PATH,HOME:process.env.HOME,CATALOG_TEST_CALL_LOG:s.log,OPENAI_API_KEY:'SENTINEL_NOT_TO_PASS'}});
    assert.equal(catalog.schema,'team-qa/model-catalog/v1');
    assert.equal(catalog.source.kind,'runtime');
    const ref=JSON.parse(catalog.source.reference);
    assert.equal(ref.harness.version,'0.151.7');
    assert.equal(ref.cache.sha256,hash(fixture('codex-models.json')));
    assert.equal(ref.cache.client_version,'0.150.0');
    assert.equal(ref.quota.status,'unprobed');
    assert.match(ref.harness.help_sha256,/^[a-f0-9]{64}$/);
    const byId=Object.fromEntries(catalog.models.map(m=>[m.id,m]));
    assert.deepEqual(byId['gpt-6.1-sol'].efforts,['low','medium','high','xhigh','max']);
    assert.equal(byId['gpt-6.1-sol'].status,'unknown');
    assert.equal(byId['gpt-6.1-sol'].quality_evidence.fit_review,'source-reviewed');
    assert.equal(byId['gpt-6.1-sol'].quality_evidence.selection_priority,1);
    assert.equal(byId['gpt-6.1-sol'].quality_evidence.harness_compatibility,'cache-client-version-mismatch-unverified');
    assert.equal(byId['gpt-6-astra'].status,'unknown');
    assert.equal(byId['gpt-6-astra'].quality_evidence.default_eligible,false);
    assert.equal(byId['gpt-new-unknown'].status,'unknown');
    assert.deepEqual(byId['gpt-new-unknown'].roles,[]);
    assert.equal(byId['gpt-hidden'].status,'unavailable');
    assert.ok(!JSON.stringify(catalog).includes('DO_NOT_COPY_SECRET_MARKER'));
    assert.ok(!JSON.stringify(catalog).includes('DO_NOT_COPY_PRIVATE_MARKER'));
    const calls=readFileSync(s.log,'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(x=>x.args),[['--version'],['--help'],['exec','--help']]);
    assert.ok(calls.every(x=>x.home.startsWith(join(tmpdir(),'teamqa-catalog-probe-'))&&x.config.startsWith(x.home)));
    assert.ok(ref.child_interfaces.qa_code && ref.child_interfaces.qa_gui);
    assert.equal(ref.child_interfaces.mcp_read,'not-read');
  }finally{s.cleanup();}
});

test('Claude catalog distinguishes documented fit from installed CLI compatibility and entitlement',()=>{
  const s=setup();
  try{
    const catalog=collectCatalog({provider:'anthropic',claudeBin:s.claude,modelFitPath:fixture('model-fit.json'),repoRoot:resolve(here,'../..'),qaCodeRoot:join(s.dir,'missing-code'),qaGuiRoot:join(s.dir,'missing-gui'),sandboxProbes:false,now:()=>new Date('2026-10-02T14:00:00.000Z'),env:{PATH:process.env.PATH,HOME:process.env.HOME,CATALOG_TEST_CALL_LOG:s.log,ANTHROPIC_API_KEY:'SENTINEL_NOT_TO_PASS'}});
    assert.equal(catalog.harnesses[0].version,'2.1.207');
    const opus=catalog.models.find(m=>m.id==='claude-opus-5-5');
    assert.equal(opus.status,'unavailable');
    assert.equal(opus.min_harness_version,'2.1.280');
    assert.deepEqual(opus.efforts,['low','medium','high','xhigh','max']);
    assert.equal(opus.quality_evidence.entitlement,'unprobed');
    const haiku=catalog.models.find(m=>m.id==='claude-haiku-4-5-20251001');
    assert.equal(haiku.status,'unknown');
    assert.deepEqual(haiku.roles,[]);
    const calls=readFileSync(s.log,'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(x=>x.args),[['--version'],['--help']]);
    assert.ok(calls.every(x=>x.home.startsWith(join(tmpdir(),'teamqa-catalog-probe-'))&&x.config.startsWith(x.home)));
  }finally{s.cleanup();}
});

test('collector rejects an unexpected provider instead of falling back',()=>{
  assert.throws(()=>collectCatalog({provider:'openai-ish'}),/provider|PROVIDER/i);
});

test('default discovery skips stale PATH Codex and selects an installed cache-matching binary',()=>{
  const s=setup(),originalPath=process.env.PATH;
  const stale=join(s.dir,'stale'),current=join(s.dir,'current');
  mkdirSync(stale);mkdirSync(current);
  for(const [dir,version] of [[stale,'0.149.0'],[current,'0.150.0']]){const path=join(dir,'codex');writeFileSync(path,readFileSync(fixture('fake-codex.mjs'),'utf8').replace('0.151.7',version));chmodSync(path,0o755);}
  try{
    process.env.PATH=`${stale}:${current}:${originalPath}`;
    const catalog=collectCatalog({provider:'openai',codexCachePath:fixture('codex-models.json'),modelFitPath:fixture('model-fit.json'),sandboxProbes:false,env:{PATH:process.env.PATH,CATALOG_TEST_CALL_LOG:s.log}});
    assert.equal(catalog.harnesses[0].bin,realpathSync(join(current,'codex')));
    assert.equal(catalog.models.find(m=>m.id==='gpt-6.1-sol').status,'available');
    const ref=JSON.parse(catalog.source.reference);assert.equal(ref.harness.cache_cli_version_match,true);
    assert.deepEqual(ref.harness.discovery.map(x=>x.version),['0.149.0','0.150.0']);
    const explicit=collectCatalog({provider:'openai',codexBin:join(stale,'codex'),codexCachePath:fixture('codex-models.json'),modelFitPath:fixture('model-fit.json'),sandboxProbes:false});
    assert.equal(explicit.harnesses[0].bin,realpathSync(join(stale,'codex')));
    assert.equal(explicit.models.find(m=>m.id==='gpt-6.1-sol').status,'unknown');
    assert.equal(JSON.parse(explicit.source.reference).harness.explicit_binary,true);
  }finally{process.env.PATH=originalPath;}
});

test('missing cache client version never attests Codex compatibility',()=>{
  const s=setup(),cache=JSON.parse(readFileSync(fixture('codex-models.json'),'utf8'));delete cache.client_version;
  const path=join(s.dir,'cache.json');writeFileSync(path,JSON.stringify(cache));
  const catalog=collectCatalog({provider:'openai',codexBin:s.codex,codexCachePath:path,modelFitPath:fixture('model-fit.json'),sandboxProbes:false});
  assert.equal(catalog.models.find(m=>m.id==='gpt-6.1-sol').status,'unknown');
  assert.equal(JSON.parse(catalog.source.reference).harness.cache_cli_version_match,false);
});

test('explicit strict Dragon config is hash-bound into catalog without claiming readiness or executing MCP',()=>{
 const s=setup(),mcp=join(s.dir,'dragon.json');
 writeFileSync(mcp,JSON.stringify({mcpServers:{dragon:{command:process.execPath,args:['/not-executed/dragon-bridge.mjs']}}}));
 const catalog=collectCatalog({provider:'openai',codexBin:s.codex,codexCachePath:fixture('codex-models.json'),modelFitPath:fixture('model-fit.json'),sandboxProbes:false,mcpConfigPath:mcp,env:{PATH:process.env.PATH,CATALOG_TEST_CALL_LOG:s.log}});
 assert.deepEqual(catalog.harnesses[0].mcp_config,{path:realpathSync(mcp),sha256:hash(mcp)});
 assert.equal(JSON.parse(catalog.source.reference).explicit_mcp_config.readiness,'unprobed');
 assert.deepEqual(readFileSync(s.log,'utf8').trim().split('\n').map(JSON.parse).map(c=>c.args),[['--version'],['--help'],['exec','--help']]);
});
for(const [name,data] of [
 ['another server',{mcpServers:{other:{command:process.execPath,args:[]}}}],
 ['two servers',{mcpServers:{dragon:{command:process.execPath,args:[]},other:{command:process.execPath,args:[]}}}],
 ['hidden config',{mcpServers:{dragon:{command:process.execPath,args:[]}},settings:{}}],
 ['undeclared server env',{mcpServers:{dragon:{command:process.execPath,args:[],env:{PRIVATE:'not-read'}}}}],
])test(`collector rejects ${name} instead of creating a GUI route`,()=>{
 const s=setup(),p=join(s.dir,'bad.json');writeFileSync(p,JSON.stringify(data));
 assert.throws(()=>collectCatalog({provider:'openai',codexBin:s.codex,codexCachePath:fixture('codex-models.json'),modelFitPath:fixture('model-fit.json'),sandboxProbes:false,mcpConfigPath:p}),/MCP_CONFIG_ROOT|GUI_DIRECT_DRAGON_ROUTE_REQUIRED|MCP_SERVER_FIELDS/);
});
