import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mcpRoute } from './roster.mjs';
import { nativeHostSource } from './native-host.mjs';
import { siblingSkillRoot } from './install-layout.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const DEFAULT_FIT=join(ROOT,'references/model-fit.json');
const DEFAULT_CODE=siblingSkillRoot('qa-code');
const DEFAULT_GUI=siblingSkillRoot('qa-gui');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const shaFile=path=>sha(readFileSync(path));
function fail(code,detail=''){const e=new Error(`${code}${detail?`: ${detail}`:''}`);e.code=code;throw e;}
function readJson(path,code){try{return JSON.parse(readFileSync(path,'utf8'));}catch(e){fail(code,e.message);}}
function probeEnvironment(provider,opts){
  let root;
  if(opts.probeDir){root=resolve(opts.probeDir);if(existsSync(root))fail('PROBE_DIR_MUST_BE_NEW',root);mkdirSync(root,{recursive:false,mode:0o700});}
  else root=mkdtempSync(join(tmpdir(),'teamqa-catalog-probe-'));
  // The sandbox profile matches real paths: on macOS tmpdir() is under /var/folders, really /private/var/folders.
  root=realpathSync(root);
  const configHome=join(root,provider==='openai'?'codex':'claude'),xdg=join(root,'xdg');
  mkdirSync(configHome,{recursive:true,mode:0o700});mkdirSync(xdg,{recursive:true,mode:0o700});
  const env={PATH:opts.env?.PATH||process.env.PATH||'/usr/bin:/bin',LANG:'C',HOME:root,XDG_CONFIG_HOME:xdg};
  if(provider==='openai')env.CODEX_HOME=configHome;else env.CLAUDE_CONFIG_DIR=configHome;
  for(const key of ['CATALOG_TEST_CALL_LOG','TEAMQA_TEST_CALL_LOG'])if(opts.env?.[key])env[key]=opts.env[key];
  return {root,env,network:opts.sandboxProbes===false?'not-isolated-test-mode':'denied'};
}
function run(bin,args,env,sandboxProbes=true,probeRoot){
  let command=bin,argv=args;
  if(sandboxProbes&&process.platform==='darwin'){
    const sandbox='/usr/bin/sandbox-exec';if(!existsSync(sandbox))fail('READONLY_SANDBOX_UNAVAILABLE');
    const profile=`(version 1) (allow default) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(probeRoot)})) (deny network*)`;
    command=sandbox;argv=['-p',profile,bin,...args];
  }else if(sandboxProbes&&process.platform!=='darwin')fail('READONLY_SANDBOX_UNAVAILABLE','provide platform read-only probe adapter');
  const r=spawnSync(command,argv,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024,env,windowsHide:true});
  if(r.error)fail('HARNESS_PROBE_FAILED',`${basename(bin)} ${args.join(' ')}: ${r.error.message}`);
  if(r.status!==0)fail('HARNESS_PROBE_FAILED',`${basename(bin)} ${args.join(' ')} exit=${r.status}`);
  return `${r.stdout||''}${r.stderr||''}`.trim();
}
function versionOf(provider,output){
  const pattern=provider==='openai'?/\b(?:codex-cli\s+)?(\d+\.\d+\.\d+)\b/i:/\b(\d+\.\d+\.\d+)\b/;
  const match=output.match(pattern);if(!match)fail('HARNESS_VERSION_UNPARSEABLE',output.slice(0,120));return match[1];
}
function resolveExecutable(input,provider){
  if(!input){
    const name=provider==='openai'?'codex':'claude';
    input=(process.env.PATH||'').split(':').map(dir=>join(dir,name)).find(path=>{try{accessSync(path,constants.X_OK);return true;}catch{return false;}});
  }
  if(!input)fail('HARNESS_NOT_FOUND',provider);
  let absolute=input;
  if(!isAbsolute(input)&&!input.includes('/')){
    absolute=(process.env.PATH||'').split(':').map(dir=>join(dir,input)).find(path=>{try{accessSync(path,constants.X_OK);return true;}catch{return false;}})||'';
  }else if(!isAbsolute(input))absolute=resolve(input);
  if(!absolute||!existsSync(absolute))fail('HARNESS_NOT_FOUND',input);
  const real=realpathSync(absolute);if(!statSync(real).isFile())fail('HARNESS_NOT_FILE',real);return real;
}
function interfaceProbe(root,relPaths){
  return {root,files:relPaths.map(path=>{const full=join(root,path);if(!existsSync(full))return {path,status:'missing'};try{return {path,status:'present',sha256:shaFile(full)};}catch{return {path,status:'unreadable'};}})};
}
function childInterfaces({qaCodeRoot=DEFAULT_CODE,qaGuiRoot=DEFAULT_GUI}={}){
  return {
    qa_code:interfaceProbe(qaCodeRoot,[
      'references/verdict.schema.json','contracts/release-truth-contract/v2/qa-code.receipt.schema.json','scripts/gate0.sh','scripts/qa-run.sh','scripts/verdict-validate.mjs'
    ]),
    qa_gui:interfaceProbe(qaGuiRoot,[
      'scripts/qa-board.schema.json','contracts/release-truth-contract/v2/qa-gui.receipt.schema.json','scripts/qa-gate.mjs','scripts/teamwork/canonical.schema.json','scripts/teamwork/cli.mjs'
    ]),
    mcp_read:'not-read',
    note:'Interface contract files only; installed tool execution and Dragon MCP readiness are not attested.'
  };
}
function fitMap(fit){
  if(fit?.schema!=='team-qa/model-fit/v1'||!Array.isArray(fit.models))fail('MODEL_FIT_SCHEMA');
  return new Map(fit.models.map(m=>[m.id,m]));
}
function quality(fit,fitSha,cacheStatus,extra={}){
  if(!fit||fit.fit_review==='pending')return {fit_review:'pending',source_url:fit?.source_url||null,model_fit_sha256:fitSha,benchmark_status:'not-run',catalog_status:cacheStatus,...extra};
  return {fit_review:fit.fit_review,source_url:fit.source_url||null,model_fit_sha256:fitSha,benchmark_status:fit.benchmark_status||'not-run',catalog_status:cacheStatus,default_eligible:fit.fit_review==='source-reviewed',...(Number.isInteger(fit.selection_priority)?{selection_priority:fit.selection_priority}:{}),...extra};
}
function fitFields(model,fit){
  const reviewed=fit&&fit.fit_review!=='pending';
  return {
    tier:fit?.tier||'general',
    roles:reviewed?[...(fit.roles||[])]:[],
    tools:reviewed?[...(fit.tools||[])]:[],
    quality_evidence:quality(fit,null,model.status)
  };
}
function collectOpenAI(opts,fit,fitSha,now){
  const cachePath=opts.codexCachePath||join(homedir(),'.codex/models_cache.json');if(!existsSync(cachePath))fail('CODEX_CACHE_MISSING',cachePath);
  const raw=readFileSync(cachePath),cache=readJson(cachePath,'CODEX_CACHE_INVALID');
  if(!Array.isArray(cache.models))fail('CODEX_CACHE_MODELS_INVALID');
  const cacheSha=sha(raw);
  const probe=probeEnvironment('openai',opts);
  const candidates=opts.codexBin?[resolveExecutable(opts.codexBin,'openai')]:[
    ...(process.env.PATH||'').split(':').map(dir=>join(dir,'codex')),
    ...(process.platform==='darwin'?['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex']:[])
  ].filter(path=>{try{accessSync(path,constants.X_OK);return true;}catch{return false;}}).map(path=>realpathSync(path));
  let selected;
  const discovery=[];
  for(const bin of [...new Set(candidates)]){
    const versionText=run(bin,['--version'],probe.env,opts.sandboxProbes!==false,probe.root),version=versionOf('openai',versionText);
    discovery.push({bin,version,cache_version_match:cache.client_version===version});
    selected||={bin,versionText,version};
    if(cache.client_version===version){selected={bin,versionText,version};break;}
  }
  if(!selected)fail('HARNESS_NOT_FOUND','openai');
  const {bin,versionText,version}=selected,compatible=cache.client_version===version;
  const help=run(bin,['--help'],probe.env,opts.sandboxProbes!==false,probe.root),execHelp=run(bin,['exec','--help'],probe.env,opts.sandboxProbes!==false,probe.root);
  const models=cache.models.map(rawModel=>{
    // Read only catalog fields; cache identity, messages, and credentials are deliberately ignored.
    const id=typeof rawModel?.slug==='string'?rawModel.slug:'';if(!id)return null;
    const modelFit=fit.get(id),visibility=rawModel.visibility;
    const listed=visibility!=='hide'&&rawModel.supported_in_api!==false;
    const reviewed=Boolean(modelFit&&modelFit.fit_review!=='pending');
    const status=!listed?'unavailable':reviewed&&compatible?'available':'unknown';
    const efforts=Array.isArray(rawModel.supported_reasoning_levels)?rawModel.supported_reasoning_levels.map(x=>x?.effort).filter(x=>typeof x==='string'):[];
    const fields=fitFields({status},modelFit);
    fields.quality_evidence=quality(modelFit,fitSha,status,{entitlement:'unprobed',quota:'unprobed',harness_compatibility:cache.client_version===version?'cache-client-version-match':'cache-client-version-mismatch-unverified'});
    return {id,provider:'openai',harness:'codex',efforts,tools:fields.tools,roles:fields.roles,tier:fields.tier,status,...(modelFit?.min_harness_version?{min_harness_version:modelFit.min_harness_version}:{}),...(modelFit?.family?{family:modelFit.family}:{}),quality_evidence:fields.quality_evidence};
  }).filter(Boolean);
  const collectedAt=now().toISOString();
  const reference={collector:'team-qa/catalog-collector/v1',harness:{id:'codex',bin,bin_sha256:shaFile(bin),version,version_output_sha256:sha(versionText),help_sha256:sha(`${help}\n${execHelp}`),cache_client_version:typeof cache.client_version==='string'?cache.client_version:null,cache_cli_version_match:compatible,discovery,explicit_binary:Boolean(opts.codexBin)},cache:{path:realpathSync(cachePath),sha256:cacheSha,fetched_at:typeof cache.fetched_at==='string'?cache.fetched_at:null,client_version:typeof cache.client_version==='string'?cache.client_version:null},model_fit:{path:resolve(opts.modelFitPath||DEFAULT_FIT),sha256:fitSha},quota:{status:'unprobed'},probe:{directory:probe.root,auth_config:'not-copied',network:probe.network,writable_scope:'task probe directory only'},collected_at:collectedAt,child_interfaces:childInterfaces(opts)};
  return {schema:'team-qa/model-catalog/v1',collected_at:collectedAt,source:{kind:'runtime',reference:JSON.stringify(reference)},harnesses:[{id:'codex',version,bin}],models};
}
function compareVersion(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++){if((x[i]||0)!==(y[i]||0))return (x[i]||0)>(y[i]||0)?1:-1;}return 0;}
function collectAnthropic(opts,fit,fitSha,now){
  const bin=resolveExecutable(opts.claudeBin,'anthropic');
  const probe=probeEnvironment('anthropic',opts);
  const versionText=run(bin,['--version'],probe.env,opts.sandboxProbes!==false,probe.root),version=versionOf('anthropic',versionText),help=run(bin,['--help'],probe.env,opts.sandboxProbes!==false,probe.root);
  const models=[...fit.values()].filter(m=>m.provider==='anthropic').map(m=>{
    const min=m.min_harness_version||null;
    const incompatible=min&&compareVersion(version,min)<0;
    const status=incompatible?'unavailable':m.fit_review==='pending'?'unknown':'unknown';
    const reviewed=m.fit_review!=='pending';
    return {id:m.id,provider:'anthropic',harness:'claude',efforts:[...(m.efforts||[])],tools:reviewed?[...(m.tools||[])]:[],roles:reviewed?[...(m.roles||[])]:[],tier:m.tier||'general',status,...(min?{min_harness_version:min}:{}),...(m.family?{family:m.family}:{}),quality_evidence:quality(m,fitSha,status,{entitlement:'unprobed',quota:'unprobed',harness_compatible:!incompatible})};
  });
  const collectedAt=now().toISOString();
  const reference={collector:'team-qa/catalog-collector/v1',harness:{id:'claude',bin,bin_sha256:shaFile(bin),version,version_output_sha256:sha(versionText),help_sha256:sha(help)},model_fit:{path:resolve(opts.modelFitPath||DEFAULT_FIT),sha256:fitSha},model_entitlement:{status:'unprobed'},quota:{status:'unprobed'},probe:{directory:probe.root,auth_config:'not-copied',network:probe.network,writable_scope:'task probe directory only'},collected_at:collectedAt,child_interfaces:childInterfaces(opts),note:'Model IDs and minimum harness versions come from the reviewed model-fit source URLs; --help/--version do not probe account entitlement.'};
  return {schema:'team-qa/model-catalog/v1',collected_at:collectedAt,source:{kind:'runtime',reference:JSON.stringify(reference)},harnesses:[{id:'claude',version,bin}],models};
}

export function collectCatalog(options={}){
  const catalog=collectUnboundCatalog(options);
  if(options.mcpConfigPath){
    const config={path:realpathSync(resolve(options.mcpConfigPath)),sha256:shaFile(resolve(options.mcpConfigPath))};
    mcpRoute(config);
    for(const h of catalog.harnesses)if(h.id!=='codex-native')h.mcp_config=config;
    const ref=JSON.parse(catalog.source.reference);ref.explicit_mcp_config={...config,validation:'strict-single-Dragon-command',readiness:'unprobed',model_calls:0};catalog.source.reference=JSON.stringify(ref);
  }
  return catalog;
}
function collectUnboundCatalog(options={}){
  const opts={...options};const provider=opts.provider;
  if(!['openai','anthropic'].includes(provider))fail('PROVIDER_UNSUPPORTED',String(provider));
  const fitPath=opts.modelFitPath||DEFAULT_FIT;if(!existsSync(fitPath))fail('MODEL_FIT_MISSING',fitPath);
  const fitBytes=readFileSync(fitPath),fit=fitMap(JSON.parse(fitBytes.toString('utf8'))),fitSha=sha(fitBytes);
  const now=opts.now||(()=>new Date());
  if(opts.harness==='codex-native'){
    if(provider!=='openai')fail('NATIVE_PROVIDER_UNSUPPORTED');
    const host=nativeHostSource(opts.hostSourcePath),cachePath=opts.codexCachePath||join(homedir(),'.codex/models_cache.json'),cache=readJson(cachePath,'CODEX_CACHE_INVALID');
    if(!Array.isArray(cache.models))fail('CODEX_CACHE_MODELS_INVALID');
    const models=cache.models.flatMap(m=>{
      if(typeof m.slug!=='string')return [];
      const f=fit.get(m.slug),listed=m.visibility!=='hide'&&m.supported_in_api!==false,status=!listed?'unavailable':f&&f.fit_review!=='pending'?'available':'unknown';
      return [{id:m.slug,provider,harness:'codex-native',efforts:(m.supported_reasoning_levels||[]).map(x=>x.effort).filter(x=>typeof x==='string'),tools:f?.tools||[],roles:f?.fit_review!=='pending'?(f?.roles||[]).filter(role=>['test_manager','analyst','designer','executor_code','executor_gui'].includes(role)):[],tier:f?.tier||'general',status,...(f?.family?{family:f.family}:{}),quality_evidence:quality(f,fitSha,status,{entitlement:'unprobed',quota:'unprobed',harness_compatibility:'native-host-source',context_observation:'locked context packet first-read output required; comprehension not attested'})}];
    });
    return {schema:'team-qa/model-catalog/v1',collected_at:now().toISOString(),source:{kind:'runtime',reference:JSON.stringify({collector:'team-qa/native-catalog/v1',host,cache:{path:realpathSync(cachePath),sha256:shaFile(cachePath)},model_fit:{path:fitPath,sha256:fitSha},child_interfaces:childInterfaces(opts),model_calls:0,capability_scope:'Native five-role catalog; Code requires canonical native QA Code intent, GUI requires original Dragon trajectory. Host version is parent origin; child creation version is attested after spawn. Listing does not prove entitlement, readiness or per-role sandbox.'})},harnesses:[{id:'codex-native',version:host.version,native_host:host}],models};
  }
  return provider==='openai'?collectOpenAI(opts,fit,fitSha,now):collectAnthropic(opts,fit,fitSha,now);
}
