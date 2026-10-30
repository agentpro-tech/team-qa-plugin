import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {assertClaudeStreamWebRoute} from './claude-stream-route.mjs';
import {verifySignedRuntime} from './publisher-signature.mjs';
const hash=raw=>createHash('sha256').update(raw).digest('hex');
// Team QA's repository in the agentpro-tech organization; an installed Team QA's SOURCE.json must name it.
const TEAMQA_SOURCE_REPO='https://github.com/agentpro-tech/team-qa.git';
// Team QA is installed next to this QA GUI, by the suite's install.sh or as the Claude Code plugin team-qa@agentpro, from
// the same signed suite. An installed QA GUI (it holds SOURCE.json) looks for Team QA there; a source checkout keeps
// ~/.agents/skills. --teamqa-runtime still names another one.
const OWN_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
export function defaultTeamQaRoot({root=OWN_ROOT,home=homedir()}={}){
  if(existsSync(join(root,'SOURCE.json'))){let real=root;try{real=realpathSync(root);}catch{}return join(dirname(real),'team-qa');}
  return join(home,'.agents','skills','team-qa');
}
export function assertNativeGuiPolicyGuard(attestation,{targetBindingSha256=null}={}) {
  if(targetBindingSha256 && attestation?.source?.kind!=='codex-native')throw new Error('TEAMQA_WEB_NATIVE_SOURCE_REQUIRED');
  if(attestation?.source?.kind!=='codex-native')return attestation;
  const native=attestation.source.metadata_source?.native,policy=native?.gui_policy,verified=native?.gui_verification;
  if(typeof policy?.path!=='string'||!policy.path.startsWith('/')||!/^[a-f0-9]{64}$/.test(policy.sha256||'')||verified?.verdict!=='PASS'||verified.policy_sha256!==policy.sha256)throw new Error('TEAMQA_NATIVE_GUI_POLICY_REQUIRED');
  if(targetBindingSha256){
    if(hash(readFileSync(policy.path))!==policy.sha256)throw new Error('TEAMQA_NATIVE_GUI_POLICY_DRIFT');
    const value=JSON.parse(readFileSync(policy.path,'utf8'));
    if(value.schema!=='qa-gui/native-policy/v2'||value.target?.kind!=='deployed-build'||value.target?.target_binding_sha256!==targetBindingSha256)throw new Error('TEAMQA_WEB_NATIVE_POLICY_MISMATCH');
  }
  return attestation;
}
export function verifyTeamQaGuiAttestation({attestationPath,runtimeRoot,runUuid,exactFinalSha,requirementsHash,targetBindingSha256=null,caseId=null}) {
  const runtime=realpathSync(runtimeRoot||defaultTeamQaRoot());
  const source=JSON.parse(readFileSync(join(runtime,'SOURCE.json'),'utf8'));
  if(source.skill!=='team-qa'||source.repo!==TEAMQA_SOURCE_REPO)throw new Error('TEAMQA_CANONICAL_SOURCE_REQUIRED');
  if(source.schema!=='agentpro/skill-source/v1'||! /^[a-f0-9]{40}$/.test(source.commit||''))throw new Error('TEAMQA_SOURCE_SCHEMA');
  // Team QA public v1 (T4): a suite-installed Team QA carries the publisher's signature; it replaces the canonical
  // git checkout a user's machine does not have. Without a signature the git route below stays as it was.
  let signed;
  try{signed=verifySignedRuntime(runtime,{skill:'team-qa'});}catch(error){throw new Error('TEAMQA_RELEASE_SIGNATURE_INVALID:'+String(error?.message??error));}
  if(!signed){
    let anchor;
    try{anchor=JSON.parse(readFileSync(join(homedir(),'.agents/skills/team-qa/release-truth.json'),'utf8'));}
    catch{throw new Error('TEAMQA_CANONICAL_ANCHOR_UNAVAILABLE');}
    const committed=spawnSync('git',['-C',anchor.repo,'show',`${source.commit}:package-manifest.json`],{encoding:'utf8',timeout:10000});
    if(anchor.repo_url!==source.repo||committed.status!==0||hash(committed.stdout)!==source.manifest_sha256)throw new Error('TEAMQA_SOURCE_NOT_IN_CANONICAL_GIT');
  }
  const packageTool=resolve(dirname(fileURLToPath(import.meta.url)),'..','package-tool.mjs');
  const check=spawnSync(process.execPath,[packageTool,'verify-runtime','--root',runtime],{encoding:'utf8',timeout:10000});
  if(check.status!==0)throw new Error('TEAMQA_RUNTIME_PROVENANCE_INVALID');
  // The run's first GUI attestation (role-bindings/executor_gui.json) or, for a case-scoped receipt (--case; Team QA
  // case-scoped dispatch, upgrade U2), a later one at role-bindings/executor_gui/attempt-<n>.json.
  const path=realpathSync(attestationPath),attempt=/\/role-bindings\/executor_gui\/attempt-([1-9][0-9]*)\.json$/.exec(path);
  const runDir=attempt?dirname(dirname(dirname(path))):dirname(dirname(path));
  if(path!==join(runDir,'role-bindings/executor_gui.json')&&!(attempt&&Number(attempt[1])>=2&&path===join(runDir,'role-bindings/executor_gui',`attempt-${attempt[1]}.json`)))throw new Error('TEAMQA_GUI_BINDING_PATH_REQUIRED');
  if(attempt&&caseId===null)throw new Error('TEAMQA_GUI_CASE_SCOPE_REQUIRED');
  if(caseId!==null&&(typeof caseId!=='string'||!/^[A-Za-z0-9_.:-]{1,64}$/.test(caseId)))throw new Error('TEAMQA_GUI_CASE_SCOPE_INVALID');
  const binding=JSON.parse(readFileSync(join(runDir,'binding.json'),'utf8'));
  if(targetBindingSha256){
    if(binding.schema!=='team-qa/web-binding/v1'||binding.run_uuid!==runUuid||binding.requirements_hash!==requirementsHash||binding.verification_lane!=='gui'||binding.target_kind!=='deployed-build'||binding.target_binding_sha256!==targetBindingSha256||binding.target?.target_binding_sha256!==targetBindingSha256)throw new Error('TEAMQA_WEB_TARGET_MISMATCH');
    if(Object.hasOwn(binding,'task_base')||Object.hasOwn(binding,'source_revision')||Object.hasOwn(binding,'exact_final_sha'))throw new Error('TEAMQA_WEB_GIT_FIELD_FORBIDDEN');
  }else if(binding.run_uuid!==runUuid||binding.exact_final_sha!==exactFinalSha||binding.requirements_hash!==requirementsHash)throw new Error('TEAMQA_GUI_TARGET_MISMATCH');
  const code='const c=await import(process.argv[1]);const d=process.argv[2];const r=c.assertRunContract({runDir:d,action:"verify-result",role:"executor_gui"});const a=c.assertRoleAttestation({runDir:d,role:"executor_gui",roster:r.roster,attestationPath:process.argv[3]});process.stdout.write(JSON.stringify(a));';
  // Team QA upgrade dev run upgrade-dev-3 (29/10): with a case-scoped dispatch per case the run holds many attestations,
  // and the check took 22 s, past the old 20 s limit, so it was killed with an empty stderr. The limit is 120 s and a
  // killed check says so.
  const verified=spawnSync(process.execPath,['--input-type=module','-e',code,join(runtime,'scripts/lib/run-contract.mjs'),runDir,path],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
  if(verified.status!==0)throw new Error('TEAMQA_GUI_ROLE_UNATTESTED:'+(verified.error?.code==='ETIMEDOUT'?'VERIFY_TIMEOUT 120s':verified.stderr.trim().split('\n')[0]));
  // Web lane, Claude Code root: a verified claude-stream GUI executor passes the Dragon route check instead of native policy v2.
  let dispatch_proof,executor_route=null;
  if(targetBindingSha256&&JSON.parse(verified.stdout)?.source?.kind==='claude-stream'){dispatch_proof=JSON.parse(verified.stdout);executor_route=assertClaudeStreamWebRoute(dispatch_proof,{runDir,targetBindingSha256,withSessions:caseId!==null});}
  else dispatch_proof=assertNativeGuiPolicyGuard(JSON.parse(verified.stdout),{targetBindingSha256});
  // A case-scoped receipt is attested by that case's own dispatch.
  if(caseId!==null&&(!targetBindingSha256||dispatch_proof?.dispatch_case_id!==caseId))throw new Error('TEAMQA_GUI_CASE_SCOPE_MISMATCH');
  return {dispatch_proof,teamqa_provenance:{run_dir:runDir,attestation_path:path,...(caseId!==null?{case_id:caseId}:{}),attestation_sha256:hash(readFileSync(path)),runtime_root:runtime,...(signed?{runtime_provenance:'signed',release_key_id:signed.key_id}:{}),...(targetBindingSha256?{binding_sha256:hash(readFileSync(join(runDir,'binding.json'))),target_binding_sha256:targetBindingSha256}:{}),...(executor_route?{executor_route}:{})}};
}
export function verifyGuiReceiptTeamQa(value) {
  if(!Object.hasOwn(value,'dispatch_proof')&&!Object.hasOwn(value,'teamqa_provenance'))return [];
  try{
    const p=value.teamqa_provenance;if(!p||!value.dispatch_proof)throw new Error('TEAMQA_GUI_PROVENANCE_REQUIRED');
    const result=verifyTeamQaGuiAttestation({attestationPath:p.attestation_path,runtimeRoot:p.runtime_root,runUuid:value.run_uuid,exactFinalSha:value.exact_final_sha,requirementsHash:value.requirements_hash,targetBindingSha256:value.schema==='qa-gui/receipt/web-v1'?value.target_binding_sha256:null,caseId:p.case_id??null});
    if(JSON.stringify(result.dispatch_proof)!==JSON.stringify(value.dispatch_proof)||JSON.stringify(result.teamqa_provenance)!==JSON.stringify(p))throw new Error('TEAMQA_GUI_PROVENANCE_DRIFT');
    return [];
  }catch(error){return [value.schema==='qa-gui/receipt/web-v1'?'TEAMQA_GUI_PROVENANCE_INVALID:'+error.message:error.message];}
}
