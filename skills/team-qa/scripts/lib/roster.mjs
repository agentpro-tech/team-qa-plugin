import { existsSync, readFileSync, mkdirSync, realpathSync, readdirSync, lstatSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeployedTarget, deployedTargetShapeErrors } from './deployed-target.mjs';
import { verifyNativeRoleSource } from './native-dispatch.mjs';
import { scanOriginalSource } from './original-source.mjs';
import { claudeHumanText, isClaudeTranscriptPath, orchestratorSessionId } from './host-transcript.mjs';
export { orchestratorSessionId };
import { verifyNativeHost } from './native-host.mjs';
import { sourceRepoUrl } from './source-repo.mjs';
import { assertRosterPresented } from './chat-presentation.mjs';
import { assertToolPreflight } from './tool-preflight.mjs';
import { fail, readJson, rejectUnknownFields, sha256File, sha256, stableJson, writeConfirmed } from './core.mjs';
import { verifyInstalledRelease } from './release-signature.mjs';
import { siblingSkillRoot } from './install-layout.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const POLICY_FILE = join(ROOT, 'references/roster-policy.json');
const WEB_ROLES = ['test_manager', 'analyst', 'designer', 'executor_gui', 'coverage_gate'];
const requireValue = (value, code, detail='') => { if (!value) fail(3, code, detail, 'ungraded'); };
const canonicalRole = role => String(role).replaceAll('-', '_');
const equal = (a,b) => stableJson(a) === stableJson(b);
function exact(value,keys,code) { requireValue(value && typeof value==='object' && !Array.isArray(value),code); rejectUnknownFields(value,keys,code); }
function event(value) { exact(value,['id','actor','text','source'],'USER_REQUEST_FIELDS'); requireValue(value.actor==='user' && typeof value.id==='string' && value.id && typeof value.text==='string' && value.text.trim(),'DIRECT_USER_REQUEST_REQUIRED'); return value; }
export function roleContext(role) {
  const folder=canonicalRole(role).replaceAll('_','-');
  return ['IDENTITY.md','SOUL.md','hard-rules.md','TOOLS.md'].map(name=>`agents/${folder}/${name}`).concat(['SKILL.md','references/interfaces.md']).map(path=>({path,sha256:sha256File(join(ROOT,path))}));
}
function semverAtLeast(actual,minimum) { const a=String(actual).replace(/^[^\d]*/,'').split('.').map(Number),b=String(minimum).split('.').map(Number); for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))return (a[i]||0)>(b[i]||0);} return true; }
function reasoning(harness,effort) {
  if(harness==='codex-native')return {kind:'native-spawn',model_field:'model',effort_field:'reasoning_effort',fork_turns:'none'};
  if(harness==='codex')return {kind:'codex-config',args:['-c',`model_reasoning_effort=${JSON.stringify(effort)}`]};
  if(harness==='claude')return {kind:'claude-effort',args:['--effort',effort]};
  fail(3,'HARNESS_REASONING_UNSUPPORTED',harness,'ungraded');
}
export function mcpRoute(config) {
  exact(config,['path','sha256'],'MCP_CONFIG_FIELDS');requireValue(existsSync(config.path)&&sha256File(config.path)===config.sha256,'MCP_CONFIG_DRIFT');
  const data=readJson(config.path);exact(data,['mcpServers'],'MCP_CONFIG_ROOT');
  const names=Object.keys(data.mcpServers||{});requireValue(names.length===1&&['dragon','Dragon_Browser'].includes(names[0]),'GUI_DIRECT_DRAGON_ROUTE_REQUIRED');
  for(const name of names){const v=data.mcpServers[name];exact(v,['command','args'],'MCP_SERVER_FIELDS');requireValue(typeof v.command==='string'&&v.command.startsWith('/')&&existsSync(v.command)&&Array.isArray(v.args)&&v.args.every(a=>typeof a==='string'),'MCP_SERVER_COMMAND');}
  return {data,names};
}
function checkTarget(target) { if(isDeployedTarget(target)){requireValue(deployedTargetShapeErrors(target,'roster').length===0,'TARGET_DEPLOYED_INVALID');return;} exact(target,['project_id','preview_url','version'],'TARGET_FIELDS'); for(const key of ['project_id','preview_url','version'])requireValue(typeof target[key]==='string'&&target[key].trim(),'TARGET_MISSING',key); try {requireValue(['https:','http:'].includes(new URL(target.preview_url).protocol),'TARGET_URL');}catch{fail(3,'TARGET_URL');} }
function checkCatalog(catalog) {
  exact(catalog,['schema','collected_at','source','harnesses','models'],'CATALOG_FIELDS'); requireValue(catalog.schema==='team-qa/model-catalog/v1','CATALOG_SCHEMA');
  requireValue(Number.isFinite(Date.parse(catalog.collected_at)),'CATALOG_TIMESTAMP'); if(catalog.source?.kind==='runtime'){const age=Date.now()-Date.parse(catalog.collected_at);requireValue(age>=-60000&&age<=readJson(POLICY_FILE).catalog_max_age_ms,'CATALOG_STALE');} exact(catalog.source,['kind','reference'],'CATALOG_SOURCE_FIELDS'); requireValue(['runtime','fixture'].includes(catalog.source.kind)&&catalog.source.reference,'CATALOG_SOURCE');
  requireValue(Array.isArray(catalog.harnesses)&&Array.isArray(catalog.models),'CATALOG_ARRAYS');
  for(const h of catalog.harnesses){exact(h,['id','version','bin','mcp_config','native_host'],'HARNESS_FIELDS'); requireValue(['codex','claude','codex-native'].includes(h.id)&&h.version&&(h.id==='codex-native'?h.native_host:h.bin),'HARNESS_UNSUPPORTED');if(h.id==='codex-native')verifyNativeHost(h.native_host);}
  for(const m of catalog.models){exact(m,['id','provider','harness','efforts','tools','roles','tier','status','min_harness_version','family','quality_evidence'],'MODEL_FIELDS'); requireValue(m.id&&m.provider&&['small','general','reasoning'].includes(m.tier)&&['available','unknown','unavailable'].includes(m.status),'MODEL_METADATA'); for(const k of ['efforts','tools','roles']) requireValue(Array.isArray(m[k]),'MODEL_CAPABILITY',k);}
}
// Run mode (upgrade U5): chosen when the roster is made (TEAMQA_RUN_MODE=unattended), written into the roster the user
// approves and fixed for the run; an interactive roster carries no field, so its bytes stay those of 1.13.1.
export const RUN_MODES=['interactive','unattended'];
export function runModeOf(value){if(value===undefined||value===null||value==='')return 'interactive';requireValue(RUN_MODES.includes(value),'ROSTER_RUN_MODE',String(value));return value;}
export function rosterRunMode(roster){return roster?.run_mode??'interactive';}
export function selectRoster({catalog,request,catalogPath,runMode}) {
  checkCatalog(catalog); exact(request,['schema','run_id','round','scope','target','provider','manager','overrides','allow_mixed_provider','caps'],'ROSTER_REQUEST_FIELDS');
  requireValue(request.schema==='team-qa/roster-request/v1','ROSTER_REQUEST_SCHEMA'); requireValue(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.run_id||'')&&Number.isInteger(request.round)&&request.round>0&&typeof request.scope==='string'&&request.scope.trim()&&request.provider,'RUN_BINDING'); checkTarget(request.target);
  exact(request.manager,['provider','model','effort','harness'],'MANAGER_FIELDS'); requireValue(request.manager.provider&&request.manager.model&&request.manager.effort&&request.manager.harness,'MANAGER_UNRESOLVED');
  const policy=readJson(POLICY_FILE),overrides=new Map();
  const selectedPolicyRoles=isDeployedTarget(request.target)?policy.roles.filter(role=>WEB_ROLES.includes(role.role)):policy.roles;
  if(isDeployedTarget(request.target))requireValue(equal(selectedPolicyRoles.map(role=>role.role),WEB_ROLES),'WEB_POLICY_ROLE_SET');
  for(const o of request.overrides||[]){exact(o,['role','provider','model','effort','user_event'],'OVERRIDE_FIELDS'); const role=canonicalRole(o.role); requireValue(selectedPolicyRoles.some(r=>r.role===role&&role!=='coverage_gate')&&!overrides.has(role),'OVERRIDE_ROLE',role); event(o.user_event);if(catalog.source.kind==='runtime')verifyUserMessageSource(o.user_event); overrides.set(role,o);}
  if(request.allow_mixed_provider){exact(request.allow_mixed_provider,['user_event'],'MIXED_PROVIDER_FIELDS');event(request.allow_mixed_provider.user_event);if(catalog.source.kind==='runtime')verifyUserMessageSource(request.allow_mixed_provider.user_event);}
  const caps={timeout_ms:120000,max_turns:20,...request.caps};exact(caps,['timeout_ms','max_turns'],'CAPS_FIELDS');requireValue(Number.isInteger(caps.timeout_ms)&&caps.timeout_ms>0&&caps.timeout_ms<=1800000&&Number.isInteger(caps.max_turns)&&caps.max_turns>0&&caps.max_turns<=100,'CAPS_INVALID');
  const roles=selectedPolicyRoles.map(role=>{
    if(role.role==='coverage_gate')return {...role,provider:null,model:null,effort:null,harness:'node',harness_version:process.versions.node,context:roleContext(role.role),caps,fallback:null,reasoning_control:null,user_request:null};
    const override=overrides.get(role.role),manager=role.role==='test_manager'?request.manager:null;
    const provider=override?.provider||manager?.provider||request.provider,model=override?.model||manager?.model,effort=override?.effort||manager?.effort||role.effort;
    requireValue(provider===request.provider||request.allow_mixed_provider,'MIXED_PROVIDER_USER_REQUEST_REQUIRED',role.role);
    let candidates=catalog.models.filter(m=>m.provider===provider&&(catalog.source.kind==='fixture'||m.quality_evidence?.harness_compatibility!=='cache-client-version-mismatch-unverified')&&(!model||m.id===model)&&(!manager||m.harness===manager.harness)&&(m.status==='available'||(catalog.source.kind==='fixture'&&m.status==='unknown')||(m.status==='unknown'&&m.quality_evidence?.model_fit_sha256===sha256File(join(ROOT,'references/model-fit.json'))&&readJson(join(ROOT,'references/model-fit.json')).models.some(f=>f.id===m.id&&String(f.fit_review).startsWith('source-reviewed'))))&&(catalog.source.kind==='fixture'||String(m.quality_evidence?.fit_review||'').startsWith('source-reviewed'))&&m.roles.map(canonicalRole).includes(role.role)&&m.efforts.includes(effort)&&role.tools.every(t=>m.tools.includes(t))&&role.tiers.includes(m.tier));
    candidates=candidates.filter(m=>{
      const excluded=policy.excluded_default_families.some(f=>`${m.id} ${m.family||''}`.toLowerCase().includes(f));
      if(excluded&&!(override?.model===m.id&&new RegExp(m.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'|astra','i').test(override.user_event.text)))return false;
      const h=catalog.harnesses.find(h=>h.id===m.harness);return h&&(!m.min_harness_version||semverAtLeast(h.version,m.min_harness_version));
    });
    candidates.sort((a,b)=>role.tiers.indexOf(a.tier)-role.tiers.indexOf(b.tier)||(a.quality_evidence?.selection_priority??999)-(b.quality_evidence?.selection_priority??999)||a.id.localeCompare(b.id)); requireValue(candidates.length,'ROLE_MODEL_UNAVAILABLE',role.role);
    const selected=candidates[0],h=catalog.harnesses.find(h=>h.id===selected.harness),bin=h.id==='codex-native'?null:resolve(dirname(catalogPath||join(ROOT,'catalog.json')),h.bin);
    return {role:role.role,provider,model:selected.id,effort,harness:h.id,harness_version:h.version,harness_bin:bin,harness_bin_sha256:bin&&existsSync(bin)?sha256File(bin):null,...(h.id==='codex-native'?{native_host:h.native_host}:{}),tools:role.tools,permission_profile:role.permission_profile,caps,fallback:null,context:roleContext(role.role),reasoning_control:reasoning(h.id,effort),user_request:override?.user_event||null,model_status:selected.status,mcp_config:h.mcp_config?{path:resolve(dirname(catalogPath),typeof h.mcp_config==='string'?h.mcp_config:h.mcp_config.path),sha256:sha256File(resolve(dirname(catalogPath),typeof h.mcp_config==='string'?h.mcp_config:h.mcp_config.path))}:null};
  });
  requireValue(roles.find(r=>r.role==='test_manager').model===request.manager.model&&roles.find(r=>r.role==='test_manager').effort===request.manager.effort,'MANAGER_MODEL_MISMATCH');
  return {schema:'team-qa/roster/v1',run_id:request.run_id,round:request.round,scope:request.scope,target:request.target,provider:request.provider,catalog_sha256:catalogPath?sha256File(catalogPath):sha256(stableJson(catalog)),policy_sha256:sha256File(POLICY_FILE),catalog_source:catalog.source,catalog_collected_at:catalog.collected_at,mixed_provider_request:request.allow_mixed_provider?.user_event||null,roles,selection_notes:['Availability remains unprobed until user-approved execution.','Role fit comes from supplied capability/eval metadata; no benchmark is inferred.'],...(runModeOf(runMode)==='unattended'?{run_mode:'unattended'}:{})};
}
export function checkRoster(roster) {
  requireValue(roster.schema==='team-qa/roster/v1'&&Array.isArray(roster.roles),'ROSTER_SCHEMA');checkTarget(roster.target);
  exact(roster,['schema','run_id','round','scope','target','provider','catalog_sha256','policy_sha256','catalog_source','catalog_collected_at','mixed_provider_request','roles','selection_notes','run_mode'],'ROSTER_FIELDS');requireValue(roster.run_mode===undefined||roster.run_mode==='unattended','ROSTER_RUN_MODE',String(roster.run_mode));
  if(roster.catalog_source.kind==='runtime'&&roster.mixed_provider_request)verifyUserMessageSource(roster.mixed_provider_request);
  const policy=readJson(POLICY_FILE);const expectedRoles=isDeployedTarget(roster.target)?WEB_ROLES:policy.roles.map(r=>r.role);
  if(isDeployedTarget(roster.target))requireValue(equal(policy.roles.filter(r=>WEB_ROLES.includes(r.role)).map(r=>r.role),WEB_ROLES),'WEB_POLICY_ROLE_SET');
  requireValue(equal(roster.roles.map(r=>r.role),expectedRoles),'ROSTER_ROLE_SET'); requireValue(roster.policy_sha256===sha256File(POLICY_FILE),'ROSTER_POLICY_DRIFT');
  for(const seat of roster.roles){exact(seat,seat.role==='coverage_gate'?['role','tiers','effort','tools','permission_profile','provider','model','harness','harness_version','context','caps','fallback','reasoning_control','user_request']:['role','provider','model','effort','harness','harness_version','harness_bin','harness_bin_sha256','tools','permission_profile','caps','fallback','context','reasoning_control','user_request','model_status','mcp_config',...(seat.harness==='codex-native'?['native_host']:[])],'ROSTER_SEAT_FIELDS');const declared=policy.roles.find(r=>r.role===seat.role);requireValue(equal(seat.tools,declared.tools)&&seat.permission_profile===declared.permission_profile,'ROSTER_ROLE_PERMISSION_DRIFT');requireValue(Number.isInteger(seat.caps?.timeout_ms)&&seat.caps.timeout_ms>0&&seat.caps.timeout_ms<=1800000&&Number.isInteger(seat.caps.max_turns)&&seat.caps.max_turns>0&&seat.caps.max_turns<=100,'ROSTER_CAPS_INVALID');requireValue(seat.fallback===null,'ROSTER_FALLBACK_UNAPPROVED');requireValue(equal(seat.context,roleContext(seat.role)),'ROSTER_CONTEXT_DRIFT',seat.role);if(seat.role==='coverage_gate'){requireValue(seat.provider===null&&seat.model===null&&seat.effort===null&&seat.harness==='node','COVERAGE_NOT_DETERMINISTIC');continue;}
    requireValue(equal(seat.reasoning_control,reasoning(seat.harness,seat.effort)),'ROSTER_REASONING_MAPPING',seat.role);
    requireValue(seat.provider===roster.provider||roster.mixed_provider_request,'ROSTER_PROVIDER_MISMATCH');
    if(roster.catalog_source.kind==='runtime'&&seat.user_request)verifyUserMessageSource(seat.user_request);
    const excluded=policy.excluded_default_families.some(f=>seat.model.toLowerCase().includes(f));if(excluded){event(seat.user_request);requireValue(new RegExp('astra|'+seat.model,'i').test(seat.user_request.text),'ASTRA_USER_REQUEST_REQUIRED');}
    if(seat.harness==='codex-native'){requireValue(seat.provider==='openai'&&seat.harness_bin===null&&seat.harness_bin_sha256===null&&seat.native_host.version===seat.harness_version,'NATIVE_HARNESS_BINDING');verifyNativeHost(seat.native_host);}else requireValue(seat.harness_bin&&existsSync(seat.harness_bin)&&sha256File(seat.harness_bin)===seat.harness_bin_sha256,'ROSTER_HARNESS_DRIFT',seat.role);
    if(roster.catalog_source.kind==='fixture')requireValue(realpathSync(seat.harness_bin)===realpathSync(join(ROOT,'test/roster-dynamic',`stub-${seat.harness}.mjs`)),'FIXTURE_HARNESS_NOT_TEST_STUB');
  }
}
// Approval text (1.15.1), one decision for the roster and the plan approval. A chat message approves only when it holds
// an affirmative word (approve, ok, yes, confirm, lgtm; Vietnamese duyet / chot / dong y, approve / settle / agree, with
// or without diacritics) and no negator or hold word anywhere (not, no, don't, never, cannot, disapprove, reject,
// decline, wait, hold, stop, not yet; Vietnamese khong / ko / k, no; dung, don't / stop; chua, not yet; khoan, hold on;
// huy, cancel; tu choi, refuse). Words are whole words (Unicode letters and digits), case-insensitive, after markdown is
// stripped; a hyphen, underscore or dot keeps an identifier (a run id like shop-no-login) one word. In doubt it is not an approval: an empty message, a struck-through word or no affirmative word fails.
// The Vietnamese words are written as escapes.
const APPROVAL_WORDS=['approve','approved','ok','okay','yes','confirm','confirmed','lgtm','duy\u1ec7t','ch\u1ed1t','\u0111\u1ed3ng \u00fd','duyet','chot','dong y'];
const APPROVAL_HOLDS=['not','no','dont','do not','never','cannot','cant','wont','disapprove','disapproved','reject','rejected','decline','declined','wait','hold','stop','not yet','cancel','abort',
  'kh\u00f4ng','khong','ko','k','\u0111\u1eebng','dung','ch\u01b0a','chua','khoan','h\u1ee7y','hu\u1ef7','huy','t\u1eeb ch\u1ed1i','tu choi','d\u1eebng'];
export function isApprovalText(text) {
  if(typeof text!=='string')return false;
  const plain=text.normalize('NFC').toLowerCase();
  if(/~~|<\/?(?:s|del|strike)\b/.test(plain))return false;
  const words=plain.replace(/\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[\u2018\u2019\u02bc\uff07`]/g,"'").match(/[\p{L}\p{M}\p{N}]+(?:['_.\-][\p{L}\p{M}\p{N}]+)*/gu)??[];
  const line=` ${words.join(' ')} `,has=word=>line.includes(` ${word} `);
  if(words.some(word=>/n't$/.test(word))||APPROVAL_HOLDS.some(has))return false;
  return APPROVAL_WORDS.some(has);
}
function approvalEvent(e,roster,hash) {
  exact(e,['schema','id','actor','text','run_id','round','roster_hash','source'],'APPROVAL_EVENT_FIELDS'); requireValue(e.schema==='team-qa/roster-user-event/v1'&&e.id&&e.actor==='user'&&typeof e.text==='string'&&e.text.trim()&&isApprovalText(e.text),'USER_APPROVAL_REQUIRED'); requireValue(e.run_id===roster.run_id&&e.round===roster.round&&e.roster_hash===hash,'APPROVAL_BINDING');
  if(roster.catalog_source.kind!=='fixture'){
    verifyHumanEventSource(e,{hash,runId:roster.run_id});
    assertRosterPresented(e,roster,hash);
  }
}
export async function approveRoster({runDir,file,userEvent}) {
  const roster=readJson(file),hash=sha256File(file);checkRoster(roster);approvalEvent(userEvent,roster,hash);
  if(roster.catalog_source.kind==='runtime')assertToolPreflight({runDir,roster:{...roster,roster_hash:hash},stage:'basic'});
  const dest=join(resolve(runDir),'roster.json'),approval=join(resolve(runDir),'control/approvals/roster.json');requireValue(!existsSync(approval),'ROSTER_ALREADY_APPROVED');
  if(resolve(file)!==dest){requireValue(!existsSync(dest),'ROSTER_DEST_EXISTS');await writeConfirmed(dest,readFileSync(file,'utf8'),'teamqa.roster.snapshot');}
  await writeConfirmed(approval,stableJson({schema:'team-qa/roster-approval/v1',run_id:roster.run_id,round:roster.round,roster_hash:hash,event:userEvent,approved_at:new Date().toISOString(),fixture:roster.catalog_source.kind==='fixture'}),'teamqa.roster.approve');
  return assertApprovedRoster({runDir});
}
export function assertApprovedRoster({runDir,role,round,target}) {
  runDir=resolve(runDir);const file=join(runDir,'roster.json'),path=join(runDir,'control/approvals/roster.json');requireValue(existsSync(file)&&existsSync(path),'ROSTER_NOT_APPROVED');const roster=readJson(file),approval=readJson(path),hash=sha256File(file);checkRoster(roster);
  {exact(approval,['schema','run_id','round','roster_hash','event','approved_at','fixture'],'ROSTER_APPROVAL_FIELDS');requireValue(approval.schema==='team-qa/roster-approval/v1'&&approval.roster_hash===hash&&approval.run_id===roster.run_id&&approval.round===roster.round,'ROSTER_APPROVAL_DRIFT');approvalEvent(approval.event,roster,hash);}
  // The run mode is fixed by the approved roster: a different TEAMQA_RUN_MODE refuses the command.
  if(process.env.TEAMQA_RUN_MODE)requireValue(runModeOf(process.env.TEAMQA_RUN_MODE)===rosterRunMode(roster),'RUN_MODE_DRIFT',`TEAMQA_RUN_MODE=${process.env.TEAMQA_RUN_MODE}, roster=${rosterRunMode(roster)}`);
  if(round!=null)requireValue(round===roster.round,'ROSTER_ROUND_MISMATCH');if(target)requireValue(equal(target,roster.target),'ROSTER_TARGET_MISMATCH');if(role)requireValue(roster.roles.some(r=>r.role===canonicalRole(role)),'ROSTER_ROLE_UNKNOWN');return {...roster,roster_hash:hash};
}
// One check of a run (QA GUI's gate runs it in a child with a 20 s limit) used to verify the
// child skills' provenance again for every attestation (git, the release gate and the runtime manifest each time),
// 10 of its 22 s, and parsed the same worker streams again. Within one process a verified interface is reused while
// nothing it read has changed (the root's provenance files and every manifest file's size and mtime), and a stream
// parse is reused for the same bytes. A failed check is never kept.
const providerInterfaceVerified=new Map();
const fileStamp=(p)=>{try{const s=lstatSync(p);return `${s.size}:${s.mtimeMs}:${sha256(readFileSync(p))}`;}catch{return 'missing';}};
function providerInterfaceKey({skill='qa-code',root,allowLocalCandidate=process.env.TEAMQA_ALLOW_LOCAL_CANDIDATE==='yes'}={}){
  root??=siblingSkillRoot(skill);
  let real,manifest;try{real=realpathSync(root);manifest=JSON.parse(readFileSync(join(real,'package-manifest.json'),'utf8'));}catch{return null;}
  if(!Array.isArray(manifest?.files))return null;
  const skills=join(homedir(),'.agents','skills');
  const files=manifest.files.map(r=>{try{const s=lstatSync(join(real,String(r.path)));return `${r.path}:${s.size}:${s.mtimeMs}`;}catch{return `${r.path}:missing`;}});
  return sha256(JSON.stringify([skill,real,allowLocalCandidate,ROOT,...['SOURCE.json','package-manifest.json','release-truth.json','release-signature.json'].map(f=>fileStamp(join(real,f))),
    fileStamp(join(skills,skill,'release-truth.json')),fileStamp(join(skills,'team-code','SOURCE.json')),fileStamp(join(skills,'team-code','package-manifest.json')),files]));
}
export function verifyProviderInterface(options={}){
  const key=providerInterfaceKey(options);if(key&&providerInterfaceVerified.has(key))return providerInterfaceVerified.get(key);
  const value=verifyProviderInterfaceOnce(options);if(key)providerInterfaceVerified.set(key,value);return value;
}
const parsedExecutions=new Map();
function verifyProviderInterfaceOnce({skill='qa-code',root=siblingSkillRoot(skill),allowLocalCandidate=process.env.TEAMQA_ALLOW_LOCAL_CANDIDATE==='yes'}={}) {
  requireValue(['qa-code','qa-gui'].includes(skill),'CHILD_INTERFACE_SKILL');
  // Installed next to this Team QA (install.sh or the plugin) and nowhere else (BA plugin C1).
  requireValue(existsSync(root),'SIBLING_SKILL_MISSING',`${skill}: expected at ${root}`);
  root=realpathSync(root);
  const source=readJson(join(root,'SOURCE.json'));requireValue(source.schema==='agentpro/skill-source/v1'&&source.skill===skill&&source.repo===sourceRepoUrl(skill)&&/^[a-f0-9]{40}$/.test(source.commit||'')&&/^[a-f0-9]{64}$/.test(source.manifest_sha256||''),'PROVIDER_INTERFACE_SOURCE');
  // A skill installed from the signed suite proves its origin by the publisher's signature over its SOURCE and
  // manifest (public v1, T4); the owner's machine keeps the canonical-git route below.
  if(existsSync(join(root,'release-signature.json'))){
    let signed;try{signed=verifyInstalledRelease(root,{skill});}catch(error){fail(3,'PROVIDER_RELEASE_SIGNATURE',String(error?.message??error).split('\n')[0],'ungraded');}
    const check=spawnSync(process.execPath,[join(ROOT,'scripts/package-tool.mjs'),'verify-runtime','--root',root],{encoding:'utf8',timeout:10000});requireValue(check.status===0,'PROVIDER_INTERFACE_PROVENANCE');
    const path=join(root,skill==='qa-code'?'scripts/lib/provider-execution.mjs':'scripts/lib/native-gui-trajectory.mjs');requireValue(existsSync(path),'PROVIDER_ATTESTATION_INTERFACE_MISSING');
    return {root,path,canonicalRepo:null,source,provenance:'signed',release_key_id:signed.key_id};
  }
  const anchorPath=join(homedir(),'.agents/skills',skill,'release-truth.json');
  const hasAnchor=existsSync(anchorPath),anchor=hasAnchor?readJson(anchorPath):null;requireValue(hasAnchor&&/^[a-f0-9]{40}$/.test(anchor?.head||''),'PROVIDER_CANONICAL_ANCHOR_REQUIRED');
  if(hasAnchor)requireValue(anchor&&typeof anchor==='object'&&!Array.isArray(anchor)&&anchor.repo_url===source.repo&&typeof anchor.repo==='string'&&anchor.repo.startsWith('/'),'PROVIDER_CANONICAL_ANCHOR');
  const canonicalRepo=hasAnchor?anchor.repo:join(homedir(),'Dev',skill);
  const origin=spawnSync('git',['-C',canonicalRepo,'config','--get','remote.origin.url'],{encoding:'utf8',timeout:10000});
  const committed=spawnSync('git',['-C',canonicalRepo,'show',`${source.commit}:package-manifest.json`],{encoding:'utf8',timeout:10000});requireValue(origin.status===0&&origin.stdout.trim()===source.repo&&committed.status===0&&sha256(committed.stdout)===source.manifest_sha256,'PROVIDER_SOURCE_NOT_IN_CANONICAL_GIT');
  let localCandidate=null;
  if(hasAnchor&&/^[a-f0-9]{40}$/.test(anchor.head||'')&&source.commit!==anchor.head){
    const released=spawnSync('git',['-C',canonicalRepo,'merge-base','--is-ancestor',source.commit,anchor.head],{encoding:'utf8',timeout:10000});
    if(released.status!==0){
      requireValue(allowLocalCandidate===true&&root!==realpathSync(join(homedir(),'.agents/skills',skill)),'PROVIDER_LOCAL_CANDIDATE_REQUIRED');
      const receiptPath=join(root,'release-truth.json'),receipt=readJson(receiptPath);
      requireValue(receipt.scope==='local_candidate'&&receipt.local_only===true&&receipt.head===source.commit&&receipt.repo_url===source.repo&&receipt.canonical_manifest_sha256===source.manifest_sha256,'PROVIDER_CANDIDATE_BINDING');
      const tree=spawnSync('git',['-C',canonicalRepo,'rev-parse',source.commit+'^{tree}'],{encoding:'utf8',timeout:10000});requireValue(tree.status===0&&tree.stdout.trim()===source.tree,'PROVIDER_CANDIDATE_TREE');
      const teamcode=join(homedir(),'.agents/skills/team-code'),gate=join(teamcode,'scripts/release-truth-gate.mjs'),tcSource=readJson(join(teamcode,'SOURCE.json')),tcManifest=readJson(join(teamcode,'package-manifest.json'));
      requireValue(tcSource.schema==='agentpro/skill-source/v1'&&tcSource.skill==='team-code'&&tcSource.repo===sourceRepoUrl('team-code')&&sha256File(join(teamcode,'package-manifest.json'))===tcSource.manifest_sha256,'PROVIDER_CANDIDATE_GATE_SOURCE');
      const tcAnchor=readJson(join(teamcode,'release-truth.json')),tcCommitted=spawnSync('git',['-C',tcAnchor.repo,'show',tcSource.commit+':package-manifest.json'],{encoding:'utf8',timeout:10000});requireValue(tcAnchor.repo_url===tcSource.repo&&tcAnchor.head===tcSource.commit&&tcCommitted.status===0&&sha256(tcCommitted.stdout)===tcSource.manifest_sha256,'PROVIDER_CANDIDATE_GATE_NOT_CANONICAL');
      for(const name of ['scripts/release-truth-gate.mjs','scripts/release-policy.mjs'])requireValue(tcManifest.files.some(row=>row.path===name&&sha256File(join(teamcode,name))===row.sha256),'PROVIDER_CANDIDATE_GATE_DRIFT');
      const envelope=spawnSync(process.execPath,[gate,'verify-envelope','--receipt',receiptPath,'--source',join(root,'SOURCE.json'),'--allow-local-candidate','yes'],{encoding:'utf8',timeout:10000});requireValue(envelope.status===0&&!envelope.error,'PROVIDER_CANDIDATE_ENVELOPE');
      localCandidate={scope:'local_candidate',receipt_path:receiptPath,receipt_sha256:sha256File(receiptPath)};
    }
  }
  const check=spawnSync(process.execPath,[join(ROOT,'scripts/package-tool.mjs'),'verify-runtime','--root',root],{encoding:'utf8',timeout:10000});requireValue(check.status===0,'PROVIDER_INTERFACE_PROVENANCE');
  const path=join(root,skill==='qa-code'?'scripts/lib/provider-execution.mjs':'scripts/lib/native-gui-trajectory.mjs');requireValue(existsSync(path),'PROVIDER_ATTESTATION_INTERFACE_MISSING');return {root,path,canonicalRepo,source,...(localCandidate?{localCandidate}: {})};
}
function providerParser() {
  const {path}=verifyProviderInterface();return {parseNativeExecution(args){const code='const m=await import(process.argv[1]);let raw="";for await(const chunk of process.stdin)raw+=chunk;process.stdout.write(JSON.stringify(m.parseCodexNativeExecution(JSON.parse(raw))));';const r=spawnSync(process.execPath,['--input-type=module','-e',code,path],{input:JSON.stringify(args),encoding:'utf8',maxBuffer:32*1024*1024,timeout:10000});requireValue(r.status===0,'NATIVE_METADATA_PARSE');return JSON.parse(r.stdout);},parseProviderExecution(args){const input=JSON.stringify(args),key=sha256(`${path}\n${input}`);if(parsedExecutions.has(key))return structuredClone(parsedExecutions.get(key));const code='const m=await import(process.argv[1]);let raw="";for await(const chunk of process.stdin)raw+=chunk;process.stdout.write(JSON.stringify(m.parseProviderExecution(JSON.parse(raw))));';const r=spawnSync(process.execPath,['--input-type=module','-e',code,path],{input,encoding:'utf8',maxBuffer:32*1024*1024,timeout:10000});requireValue(r.status===0,'PROVIDER_METADATA_PARSE');const value=JSON.parse(r.stdout);parsedExecutions.set(key,value);return structuredClone(value);},validateProviderExecution(p,l){const errors=[...(p.errors||[])];if(p.provider!==l.provider)errors.push('PROVIDER_MISMATCH');if(p.observed?.model!==l.model)errors.push('MODEL_MISMATCH');if(p.observed?.reasoning!==l.reasoning)errors.push('REASONING_MISMATCH');if(!p.session_id)errors.push('SESSION_MISSING');return errors;}};
}
export function parseNativeRoleExecution(args){return providerParser().parseNativeExecution(args);}
export function verifyRoleSource(a,{runDir}) {
  if(a.source?.kind==='codex-native')return verifyNativeRoleSource(a,{runDir});
  const roster=assertApprovedRoster({runDir,role:a.role}),seat=roster.roles.find(s=>s.role===a.role);const allowedMcpServers=a.role==='executor_gui'?mcpRoute(seat.mcp_config).names:[];
  const source=a.source; requireValue(source&&['codex-rollout','codex-stream','claude-stream'].includes(source.kind)&&a.graded===true,'ROLE_RUNTIME_UNATTESTED');
  const path=resolve(runDir,source.path),stderrPath=source.stderr_path?resolve(runDir,source.stderr_path):null;requireValue(path.startsWith(resolve(runDir)+'/')&&existsSync(path)&&sha256File(path)===source.sha256,'ROLE_RUNTIME_SOURCE_HASH');
  requireValue(stderrPath&&stderrPath.startsWith(resolve(runDir)+'/')&&existsSync(stderrPath)&&sha256File(stderrPath)===source.stderr_sha256,'ROLE_RUNTIME_STDERR_HASH');
  const parser=providerParser(),parsed=parser.parseProviderExecution({provider:a.runtime.provider,stdout:readFileSync(path,'utf8'),stderr:readFileSync(stderrPath,'utf8'),metadataSource:source.metadata_source,allowedMcpServers});const errors=parser.validateProviderExecution(parsed,{provider:a.runtime.provider,model:a.runtime.model,reasoning:a.runtime.effort});requireValue(!errors.length,'ROLE_RUNTIME_METADATA',errors.join(','));requireValue(parsed.session_id===a.session_id,'ROLE_RUNTIME_SESSION');
  if(a.runtime.provider==='anthropic'){
    requireValue(source.metadata_source?.kind==='claude-transcript'&&source.metadata_source.path,'ROLE_CONTEXT_SOURCE_MISSING');
    requireValue(a.session_id!==orchestratorSessionId(runDir),'ROLE_SESSION_NOT_INDEPENDENT');
    // A case-scoped GUI dispatch (U2) names its case and requested session after the binding: the worker got exactly that scope.
    const marker=`TEAMQA_RUN_BINDING run=${a.run_id} round=${a.round} role=${a.role} roster=${a.roster_hash}${Object.hasOwn(a,'dispatch_case_id')?` case=${a.dispatch_case_id} attempt=${a.session_id}`:''}`;
    const context=seat.context.map(x=>readFileSync(join(ROOT,x.path),'utf8'));let supplied=false;
    scanOriginalSource(source.metadata_source.path,line=>{
      if(supplied)return;
      try{const e=JSON.parse(line),text=e.type==='user'&&e.isMeta!==true&&e.isSidechain!==true&&e.message?.role==='user'?extractHumanText(e.message):'';if(text.includes(marker)&&context.every(value=>text.includes(value)))supplied=true;}
      catch{return;}
    });
    requireValue(supplied,'ROLE_CONTEXT_NOT_SUPPLIED');
  }
  if(a.runtime.provider==='openai'){
    requireValue(source.metadata_source?.path,'ROLE_CONTEXT_SOURCE_MISSING');
    const marker=`TEAMQA_RUN_BINDING run=${a.run_id} round=${a.round} role=${a.role} roster=${a.roster_hash}`;
    const context=seat.context.map(x=>readFileSync(join(ROOT,x.path),'utf8'));let supplied=false;
    scanOriginalSource(source.metadata_source.path,line=>{
      if(supplied)return;
      try{const e=JSON.parse(line),p=e.payload,text=p?.role==='user'?extractHumanText(p):'';if(text.includes(marker)&&context.every(value=>text.includes(value)))supplied=true;}
      catch{return;}
    });
    requireValue(supplied,'ROLE_CONTEXT_NOT_SUPPLIED');
  }
  return a;
}
export function verifyChildDispatchProof(proof,{stage='pre',attestation}={}) {
  requireValue(['pre','post','sealed'].includes(stage),'CHILD_PROOF_STAGE');exact(proof,['schema','run_dir','run_id','round','role','roster_hash','target','repo_target','approval','seat','coder','context','attestation_path','attestation_sha256','lock_hash'],'CHILD_PROOF_FIELDS');
  requireValue(proof?.schema==='team-qa/child-dispatch-proof/v1','CHILD_PROOF_SCHEMA');const runDir=resolve(proof.run_dir),roster=assertApprovedRoster({runDir,role:proof.role,round:proof.round,target:proof.target});requireValue(proof.run_id===roster.run_id&&proof.roster_hash===roster.roster_hash&&proof.role==='executor_code','CHILD_PROOF_BINDING');const seat=roster.roles.find(r=>r.role===proof.role);requireValue(proof.seat.provider===seat.provider&&proof.seat.model===seat.model&&proof.seat.effort===seat.effort,'CHILD_PROOF_SEAT');
  const locked=readJson(join(runDir,'dispatch-proofs',`${proof.role}.json`));requireValue(proof.lock_hash===sha256(stableJson({...locked,lock_hash:null})),'CHILD_PROOF_LOCK');for(const key of ['run_id','round','role','roster_hash','target','repo_target','approval','coder','context'])requireValue(equal(proof[key],locked[key]),'CHILD_PROOF_DRIFT',key);
  requireValue(roster.catalog_source.kind==='runtime','CHILD_PROOF_FIXTURE');
  if(stage==='post'){if(!attestation)requireValue(proof.attestation_path&&sha256File(proof.attestation_path)===proof.attestation_sha256,'CHILD_ATTESTATION_HASH');const a=attestation||readJson(proof.attestation_path);verifyRoleSource(a,{runDir});requireValue(a.role===proof.role&&a.roster_hash===roster.roster_hash&&a.session_id!==proof.coder.session_id&&a.agent_id!==proof.coder.agent_id,'CHILD_REVIEWER_INDEPENDENCE');requireValue(a.runtime.provider===seat.provider&&a.runtime.model===seat.model&&a.runtime.effort===seat.effort,'CHILD_ACTUAL_CONFIG');return {authorized:true,stage,roster,attestation:a};}
  requireValue(proof.coder?.provider&&proof.coder.agent_id&&proof.coder.session_id,'CODER_IDENTITY_MISSING');
  if(stage==='sealed')return {authorized:true,dispatch_authorized:false,stage,roster};
  requireValue(!existsSync(join(runDir,'role-bindings/executor_code.json')),'CHILD_ROLE_ALREADY_COMPLETED');
  const code='const c=await import(process.argv[1]);c.assertRunContract({runDir:process.argv[2],action:"execute",role:"executor_code",preDispatch:true});';const phase=spawnSync(process.execPath,['--input-type=module','-e',code,join(ROOT,'scripts/lib/run-contract.mjs'),runDir],{encoding:'utf8',timeout:20000});requireValue(phase.status===0,'CHILD_PRE_DISPATCH_CONTRACT',phase.stderr.trim().split('\n')[0]);return {authorized:true,stage,roster};
}
// A Claude CLI worker launched from a Claude Code root inherits the parent session (and remote
// session ingress) through the environment. Workers get an allowlisted environment only.
const CLAUDE_WORKER_ENV=/^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TERM|TMPDIR|TZ|XDG_[A-Z_]+|ANTHROPIC_[A-Z0-9_]+|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|AWS_[A-Z0-9_]+|CLOUD_ML_REGION|GOOGLE_[A-Z0-9_]+|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/;
export function isolatedClaudeEnv(env=process.env){return Object.fromEntries(Object.entries(env).filter(([key])=>CLAUDE_WORKER_ENV.test(key)));}
// Harness argv of a CLI role dispatch. Claude Code 2.1.311 `-p --safe-mode` disables every MCP server (also --mcp-config
// ones) and `--permission-mode plan` refuses MCP calls, so only a Claude seat with a locked Dragon route (executor_gui)
// runs without --safe-mode: slash commands disabled, default permissions, and only the route's MCP servers allowed.
// The Dragon bridge writes the executor's screenshots and recordings under its output root (DRAGON_OUT_DIR, default
// ~/.dragon/out), outside the run directory, where `-p` default permissions deny Read and the parser then fails the
// attestation; `--add-dir` opens that root to Read (Edit and Write stay disallowed).
// Every other flag, every other role and the Codex harness keep their argv.
export function dragonOutputRoot(env=process.env){return env.DRAGON_OUT_DIR?resolve(env.DRAGON_OUT_DIR):join(homedir(),'.dragon','out');}
// Output buffer of a role dispatch. A Claude stream-json stream carries every image the GUI executor Reads in full
// (0.5-1 MB each); 16 MB killed the executor of eval pilot-6 after 27 screenshots, mid-case. The Claude seat with a
// locked Dragon route keeps up to 256 MB; every other seat keeps 16 MB.
export function dispatchMaxBuffer({seat,route}){return seat.harness==='claude'&&route?256*1024*1024:16*1024*1024;}
// Claude Code saves a tool result above its output limit under the session's own project directory and tells the
// model to Read it there: <CLAUDE_CONFIG_DIR>/projects/<cwd, every non-alphanumeric as '-' (lib/claude-refs.mjs)>/
// <session id>/tool-results/. `-p` default permissions deny that Read, so the GUI executor of eval pilot-7 lost each
// large Dragon result (214,285 and 60,998 characters). The Claude seat with a locked Dragon route gets exactly that
// directory, created before launch, as one more --add-dir (eval compat 10); other seats keep their argv.
export function claudeToolResultsDir({runDir,attempt,env=process.env}){return join(env.CLAUDE_CONFIG_DIR?resolve(env.CLAUDE_CONFIG_DIR):join(homedir(),'.claude'),'projects',String(resolve(runDir)).replace(/[^A-Za-z0-9]/g,'-'),attempt,'tool-results');}
export function dispatchArgs({seat,role,route,attempt,toolResultsDir=null}) {
  const claudeRoute=seat.harness==='claude'&&Boolean(route);
  const args=seat.harness==='codex'?['exec','--skip-git-repo-check','--ignore-user-config','--json','--sandbox',role==='executor_gui'?'workspace-write':'read-only','--disable','multi_agent','-m',seat.model,...seat.reasoning_control.args,'-']:['-p',claudeRoute?'--disable-slash-commands':'--safe-mode','--model',seat.model,...seat.reasoning_control.args,'--output-format','stream-json','--verbose','--permission-mode',claudeRoute?'default':'plan','--max-turns',String(seat.caps.max_turns),'--setting-sources','','--strict-mcp-config','--mcp-config',route?seat.mcp_config.path:'{"mcpServers":{}}','--tools',role==='executor_gui'?'Read,Glob,Grep,Bash':'Read,Glob,Grep',...(claudeRoute?['--allowedTools',...route.names.map(name=>`mcp__${name}`),'--add-dir',dragonOutputRoot(),...(toolResultsDir?['--add-dir',toolResultsDir]:[])]:[]),'--disallowedTools','Agent,Task,Edit,Write,NotebookEdit,WebSearch,WebFetch','--session-id',attempt];
  if(route&&seat.harness==='codex'){for(const [name,server] of Object.entries(route.data.mcpServers)){args.push('-c',`mcp_servers.${name}.command=${JSON.stringify(server.command)}`,'-c',`mcp_servers.${name}.args=${JSON.stringify(server.args)}`);}}
  if(seat.harness==='codex')args.push('-c','approval_policy="never"');
  return args;
}
// Executor inputs (upgrade U3): the regular files under --inputs, checked before anything runs and later copied under the
// dispatch directory inside the run, where the worker's default permissions read them; at most 200 files and 32 MB, no
// symlinks. Returns [{from, rel}].
export function listDispatchInputs(from){
  requireValue(existsSync(from)&&lstatSync(from).isDirectory(),'DISPATCH_INPUTS_NOT_DIRECTORY',from);
  const files=[];let bytes=0;
  const walk=(dir,rel)=>{for(const name of readdirSync(dir).sort()){const s=join(dir,name),r=rel?`${rel}/${name}`:name,st=lstatSync(s);
    requireValue(!st.isSymbolicLink(),'DISPATCH_INPUT_SYMLINK',s);
    if(st.isDirectory()){walk(s,r);continue;}
    if(!st.isFile())continue;
    bytes+=st.size;requireValue(files.length<200&&bytes<=32*1024*1024,'DISPATCH_INPUTS_TOO_LARGE',`${files.length+1} files, ${bytes} bytes`);
    files.push({from:s,rel:r});}};
  walk(from,'');return files;
}
// A root that passes --out role-bindings/<role>.json, the path the attestation is bound to,
// would run the worker on every dispatch and then fail ROLE_ATTESTATION_EXISTS. Refused before any worker runs.
export const outputIsBinding=(runDir,out)=>{const dir=resolve(runDir,'role-bindings'),target=resolve(out);return target===dir||target.startsWith(dir+'/');};
// The pre-dispatch checks read the root's live transcript; a root that keeps writing while a detached dispatch runs
// them can change the file during the read (ORIGINAL_SOURCE_CHANGED): they run again on a fresh read, up to five times.
const raceReread=(read)=>{for(let attempt=1;;attempt++){try{return read();}catch(error){if(![error?.code,error?.detail].includes('ORIGINAL_SOURCE_CHANGED')||attempt>=5)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150*attempt);}}};
export async function dispatchRole({runDir,role,prompt,out,caseId=null,inputs=null,attemptId=null,progress=null}) {
  runDir=resolve(runDir);role=canonicalRole(role);const roster=raceReread(()=>assertApprovedRoster({runDir,role})),seat=roster.roles.find(r=>r.role===role);const caseScoped=caseId!==null&&caseId!==undefined;
  // U1: a case-scoped GUI dispatch on a deployed target proves the build in the executor's own stream (executor-identity.mjs),
  // so it needs the execute-stage preflight but not a dispatch-time fresh identity read by the root.
  const executorProvesIdentity=caseScoped&&role==='executor_gui'&&isDeployedTarget(roster.target);requireValue(seat.harness!=='codex-native','NATIVE_USE_PREPARE_AND_ATTEST');requireValue(role!=='coverage_gate','DETERMINISTIC_ROLE_NO_LLM');requireValue(!existsSync(out),'DISPATCH_OUTPUT_EXISTS');requireValue(!outputIsBinding(runDir,out),'DISPATCH_OUTPUT_IS_BINDING',`${out}: role-bindings/ is where Team QA binds the attestation; write it elsewhere, e.g. attestations/${role}${caseScoped?`-${caseId}`:''}.json`);
  if(roster.catalog_source.kind!=='fixture'){
    requireValue(roster.run_id===basename(runDir),'RUN_ID_MISMATCH');
    raceReread(()=>assertToolPreflight({runDir,roster,stage:'basic'}));
    const contract=await import('./run-contract.mjs');if(!['test_manager','analyst'].includes(role))contract.assertRunContract({runDir,action:role==='designer'?'design':'execute',role,preDispatch:true,...(executorProvesIdentity?{preflightFresh:false}:{})});
    const version=spawnSync(seat.harness_bin,['--version'],{encoding:'utf8',timeout:5000});requireValue(version.status===0&&/\d+\.\d+\.\d+/.exec(version.stdout)?.[0]===seat.harness_version,'HARNESS_VERSION_DRIFT');
    const help=spawnSync(seat.harness_bin,['--help'],{encoding:'utf8',timeout:5000});requireValue(help.status===0,'HARNESS_HELP_UNAVAILABLE');requireValue(seat.harness==='codex'||help.stdout.includes('--effort'),'HARNESS_EFFORT_UNSUPPORTED');
    requireValue(role!=='executor_code','EXECUTOR_CODE_USE_QA_CODE','Create a locked child dispatch proof and invoke the declared QA Code interface.');
  }
  let route=null;if(roster.catalog_source.kind==='runtime'&&role==='executor_gui'){requireValue(seat.mcp_config,'GUI_DIRECT_DRAGON_ROUTE_REQUIRED');route=mcpRoute(seat.mcp_config);}
  // Case-scoped GUI dispatch (U2): one signed case per attempt, its budget checked and the start recorded before any worker runs.
  const hasInputs=inputs!==null&&inputs!==undefined;
  if(hasInputs)requireValue(role==='executor_gui'&&seat.harness==='claude','DISPATCH_INPUTS_ROUTE','--inputs is for the Claude CLI GUI executor');
  const inputFiles=hasInputs?listDispatchInputs(resolve(inputs)):[];
  if(caseScoped)requireValue(role==='executor_gui'&&seat.harness==='claude'&&roster.catalog_source.kind==='runtime','DISPATCH_CASE_ROUTE','--case-id is for the Claude CLI GUI executor of a runtime roster');
  // U6: a detached dispatch runs under the attempt id its starter recorded (dispatch-detach.mjs), in this very process.
  const detach=attemptId!==null||progress!==null?await import('./dispatch-detach.mjs'):null;
  if(attemptId!==null){requireValue(detach.ATTEMPT_ID.test(String(attemptId)),'DISPATCH_ATTEMPT_INVALID',String(attemptId));const st=join(runDir,'dispatch',role,attemptId,'state.json');requireValue(existsSync(st)&&(s=>s.status==='running'&&s.attempt===attemptId&&s.role===role&&s.pid===process.pid)(readJson(st)),'DISPATCH_ATTEMPT_INVALID',st);}
  const attempt=attemptId??randomUUID(),dir=join(runDir,'dispatch',role,attempt);
  if(caseScoped){const c=await import('./run-contract.mjs');await c.startCaseDispatch({runDir,role,caseId,attempt});}
  mkdirSync(dir,{recursive:true});const stdoutPath=join(dir,'stdout.jsonl'),stderrPath=join(dir,'stderr.txt');
  // Executor workspace (U3): the inputs it may read, and for a case-scoped dispatch the evidence draft it must print.
  let workspace='';
  if(caseScoped||hasInputs){
    const copied=inputFiles.map(f=>{const d=join(dir,'inputs',...f.rel.split('/'));mkdirSync(dirname(d),{recursive:true});copyFileSync(f.from,d);return d;});
    workspace=`TEAMQA_EXECUTOR_WORKSPACE${caseScoped?` case=${caseId}`:''}\nInput files (read them with Read; all are inside the run folder):\n${copied.length?copied.map(p=>`- ${p}`).join('\n'):'- (none)'}\n\n${caseScoped?`${readFileSync(join(ROOT,'references/executor-evidence.md'),'utf8')}\n\n`:''}`;
  }
  const toolResultsDir=seat.harness==='claude'&&route?claudeToolResultsDir({runDir,attempt}):null;if(toolResultsDir)mkdirSync(toolResultsDir,{recursive:true});
  const args=dispatchArgs({seat,role,route,attempt,toolResultsDir});
  const context=seat.context.map(x=>readFileSync(join(ROOT,x.path),'utf8')).join('\n\n');const input=`TEAMQA_RUN_BINDING run=${roster.run_id} round=${roster.round} role=${role} roster=${roster.roster_hash}${caseScoped?` case=${caseId} attempt=${attempt}`:''}\n${context}\n\n${workspace}${readFileSync(prompt,'utf8')}`;const runOptions={cwd:runDir,input,timeout:seat.caps.timeout_ms,maxBuffer:dispatchMaxBuffer({seat,route}),env:seat.harness==='claude'?isolatedClaudeEnv():process.env};const result=progress?await detach.runStreaming(seat.harness_bin,args,{...runOptions,progress}):spawnSync(seat.harness_bin,args,{...runOptions,encoding:'utf8'});await writeConfirmed(stdoutPath,result.stdout||'','teamqa.dispatch.log');await writeConfirmed(stderrPath,result.stderr||'','teamqa.dispatch.stderr');
  requireValue(result.status===0&&!result.error,'HARNESS_EXECUTION_FAILED',String(result.error||result.status));
  let parsed; if(roster.catalog_source.kind==='runtime'){const parser=providerParser();parsed=parser.parseProviderExecution({provider:seat.provider,stdout:result.stdout,stderr:result.stderr,allowedMcpServers:route?.names||[]});const errors=parser.validateProviderExecution(parsed,{provider:seat.provider,model:seat.model,reasoning:seat.effort});requireValue(!errors.length,'ROLE_RUNTIME_UNATTESTED',errors.join(','));}
  const session=parsed?.session_id||null;
  if(roster.catalog_source.kind==='runtime'&&seat.harness==='claude'){requireValue(session===attempt,'ROLE_SESSION_NOT_REQUESTED');requireValue(session!==orchestratorSessionId(runDir),'ROLE_SESSION_NOT_INDEPENDENT');}
  if(executorProvesIdentity&&roster.catalog_source.kind==='runtime'){const{executorIdentity}=await import('./executor-identity.mjs');executorIdentity({stream:result.stdout||'',target:roster.target});}
  const a={schema:'team-qa/role-attestation/v1',run_id:roster.run_id,round:roster.round,roster_hash:roster.roster_hash,role,agent_id:session?`${seat.harness}:${session}`:null,session_id:session,runtime:{provider:seat.provider,model:seat.model,effort:seat.effort,harness:seat.harness,version:seat.harness_version,sent:{model:seat.model,effort:seat.effort},observed:{model:parsed?.observed.model||null,effort:parsed?.observed.reasoning||null,session_id:session}},context:seat.context,source:{kind:roster.catalog_source.kind==='fixture'?'fixture':`${seat.harness}-stream`,path:stdoutPath,sha256:sha256File(stdoutPath),stderr_path:stderrPath,stderr_sha256:sha256File(stderrPath),...(parsed?.metadata_source?{metadata_source:parsed.metadata_source}:{})},graded:roster.catalog_source.kind==='runtime',...(caseScoped?{dispatch_case_id:caseId}:{})};
  const contract=await import('./run-contract.mjs');const bound=caseScoped?contract.sequenceCaseAttestation({runDir,attestation:a}):a;
  await writeConfirmed(out,stableJson(bound),'teamqa.dispatch.receipt');if(bound.graded)await contract.bindRoleAttestation({runDir,attestation:bound}); return bound;
}

export async function createChildDispatchProof({runDir,repo,base,head,coder,out}) {
  runDir=resolve(runDir);repo=realpathSync(repo);
  const roster=assertApprovedRoster({runDir,role:'executor_code'});
  const contract=await import('./run-contract.mjs');contract.assertRunContract({runDir,action:'execute',role:'executor_code',preDispatch:true});
  exact(coder,['provider','agent_id','session_id'],'CODER_FIELDS');requireValue(coder.provider&&coder.agent_id&&coder.session_id,'CODER_IDENTITY_MISSING');
  const git=ref=>{const p=spawnSync('git',['-C',repo,'rev-parse','--verify',`${ref}^{commit}`],{encoding:'utf8'});requireValue(p.status===0,'REPO_REVISION_MISSING',ref);return p.stdout.trim();};
  const baseSha=git(base),headSha=git(head);requireValue(git('HEAD')===headSha,'REPO_HEAD_DRIFT');
  const seat=roster.roles.find(s=>s.role==='executor_code'),approval=readJson(join(runDir,'control/approvals/roster.json'));
  const proof={schema:'team-qa/child-dispatch-proof/v1',run_dir:runDir,run_id:roster.run_id,round:roster.round,role:seat.role,roster_hash:roster.roster_hash,target:roster.target,repo_target:{repo_root:repo,base_sha:baseSha,head_sha:headSha},approval:{event_id:approval.event.id,user:'user',scope:roster.scope},seat:{provider:seat.provider,model:seat.model,effort:seat.effort,agent_id:null,session_id:null},coder,context:seat.context,attestation_path:null,attestation_sha256:null,lock_hash:null};
  proof.lock_hash=sha256(stableJson(proof));const path=join(runDir,'dispatch-proofs/executor_code.json');requireValue(!existsSync(path),'CHILD_PROOF_ALREADY_LOCKED');
  await writeConfirmed(path,stableJson(proof),'teamqa.child.dispatch.lock');if(out&&resolve(out)!==path)await writeConfirmed(out,stableJson(proof),'teamqa.child.dispatch.export');
  verifyChildDispatchProof(proof);return proof;
}

export function extractHumanText(p) {
  const parts=typeof p?.content==='string'?p.content:(p?.content||[]).map(x=>x.text||'').join('\n');
  const reply=/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/.exec(parts);
  if(reply){const answers=JSON.parse(reply[1]);return answers.map(x=>x.answer).join('\n').trim();}
  return parts.trim();
}
export function verifyUserMessageSource(e,{hash,runId}={}) {
  requireValue(typeof e.text==='string'&&!e.text.includes('TEAMQA_AUTOMATIC_CONTINUATION'),'HUMAN_EVENT_AUTOMATIC_CONTINUATION');
  exact(e.source,['path','sha256','line'],'HUMAN_EVENT_SOURCE_FIELDS');requireValue(e.source.path&&e.source.sha256&&Number.isInteger(e.source.line)&&e.source.line>0,'HUMAN_EVENT_SOURCE_REQUIRED');
  const path=realpathSync(e.source.path);requireValue([join(homedir(),'.codex','sessions'),join(homedir(),'.claude','projects')].some(root=>path.startsWith(root+'/')),'HUMAN_EVENT_SOURCE_UNTRUSTED');
  if(path.startsWith(join(homedir(),'.claude')+'/'))requireValue(isClaudeTranscriptPath(path),'HUMAN_EVENT_SOURCE_UNTRUSTED');
  let line='',prior=false;
  scanOriginalSource(path,(raw,index)=>{
    if(index===e.source.line-1)line=raw;
    if(index<e.source.line-1&&hash&&raw.includes(hash)&&raw.includes(runId))prior=true;
  });
  requireValue(sha256(line)===e.source.sha256,'HUMAN_EVENT_SOURCE_DRIFT');
  const entry=JSON.parse(line);
  if(isClaudeTranscriptPath(path))requireValue(claudeHumanText(entry)===e.text.trim(),'HUMAN_EVENT_NOT_USER');
  else{const p=entry?.payload||entry?.message||entry;requireValue(p?.role==='user'&&extractHumanText(p)===e.text.trim(),'HUMAN_EVENT_NOT_USER');}
  return {e,prior};
}
// The same approval decision as approvalEvent above (isApprovalText).
export function verifyHumanEventSource(e,{hash,runId}) {
  const {prior}=verifyUserMessageSource(e,{hash,runId});
  requireValue(isApprovalText(e.text),'USER_APPROVAL_REQUIRED');
  requireValue(prior,'ARTIFACT_NOT_SHOWN_BEFORE_APPROVAL');return e;
}
export function verifyPlanUserEvent(e,{runId,round,rosterHash,planHash}) {
  exact(e,['schema','id','actor','text','run_id','round','roster_hash','plan_sha256','source'],'PLAN_USER_EVENT_FIELDS');
  requireValue(e.schema==='team-qa/plan-user-event/v1'&&e.id&&e.run_id===runId&&e.round===round&&e.roster_hash===rosterHash&&e.plan_sha256===planHash,'PLAN_APPROVAL_BINDING');
  return verifyHumanEventSource(e,{hash:planHash,runId});
}
