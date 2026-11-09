import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifySignedRuntime} from './publisher-signature.mjs';

// Team QA's repository in the agentpro-tech organization; an installed Team QA's SOURCE.json must name it.
const TEAMQA_SOURCE_REPO='https://github.com/agentpro-tech/team-qa.git';
// Team QA is installed next to this QA Code, by the suite's install.sh or as the Claude Code plugin team-qa@agentpro,
// from the same signed suite. An installed QA Code (it holds SOURCE.json) looks for Team QA there; a source checkout
// keeps ~/.agents/skills. --teamqa-runtime still names another one.
const OWN_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
export function defaultTeamQaRoot({root=OWN_ROOT,home=homedir()}={}){
  if(existsSync(join(root,'SOURCE.json'))){let real=root;try{real=realpathSync(root);}catch{}return join(dirname(real),'team-qa');}
  return join(home,'.agents','skills','team-qa');
}
// The Team QA runtime check (L4): every process it starts (git show of the canonical manifest, package-tool
// verify-runtime) stops after TEAMQA_RUNTIME_CHECK_TIMEOUT_MS, the same bound in QA GUI and QA Code, and a check that
// ran out of time fails TEAMQA_RUNTIME_CHECK_TIMEOUT, not as an invalid provenance.
export const TEAMQA_RUNTIME_CHECK_TIMEOUT_MS=10000;
const timedOut=r=>r?.error?.code==='ETIMEDOUT';
function runtimeCheck(command,args,label){
  const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:1024*1024,timeout:TEAMQA_RUNTIME_CHECK_TIMEOUT_MS});
  if(timedOut(r))throw new Error(`TEAMQA_RUNTIME_CHECK_TIMEOUT:${label} did not finish in ${TEAMQA_RUNTIME_CHECK_TIMEOUT_MS/1000} s`);
  return r;
}
export function verifyTeamQaReviewProof({proofPath,runtimePath,repo,base,head,provider,model,reasoning,stage="pre",attestation=null,bindRole=false}) {
  if(!proofPath)throw new Error('TEAMQA_PROOF_REQUIRED');
  let runtime,source;
  try {
    runtime=realpathSync(runtimePath || defaultTeamQaRoot());
    source=JSON.parse(readFileSync(join(runtime,'SOURCE.json'),'utf8'));
  } catch(error) {throw new Error('TEAMQA_RUNTIME_UNAVAILABLE:'+(error.code??error.name),{cause:error});}
  if(source.skill!=='team-qa'||source.repo!==TEAMQA_SOURCE_REPO||!/^[0-9a-f]{40}$/.test(source.commit || ''))throw new Error('TEAMQA_CANONICAL_SOURCE_REQUIRED');
  // Team QA public v1 (T4): a suite-installed Team QA carries the publisher's signature, which replaces the
  // canonical git checkout a user's machine does not have. Without a signature the git route stays as it was.
  let signed;
  try{signed=verifySignedRuntime(runtime,{skill:'team-qa'});}catch(error){throw new Error('TEAMQA_RELEASE_SIGNATURE_INVALID:'+String(error?.message??error));}
  if(!signed){
    let anchor;
    try {anchor=JSON.parse(readFileSync(join(homedir(),'.agents/skills/team-qa/release-truth.json'),'utf8'));}
    catch(error){throw new Error('TEAMQA_CANONICAL_ANCHOR_UNAVAILABLE:'+(error.code??error.name),{cause:error});}
    const manifest=runtimeCheck('git',['-C',anchor.repo,'show',`${source.commit}:package-manifest.json`],'git show of the canonical manifest');
    if(anchor.repo_url!==source.repo||manifest.status!==0||createHash("sha256").update(manifest.stdout).digest("hex")!==source.manifest_sha256)throw new Error("TEAMQA_SOURCE_NOT_IN_CANONICAL_GIT");
  }
  const packageTool=resolve(dirname(fileURLToPath(import.meta.url)),'..','package-tool.mjs');
  const verify=runtimeCheck(process.execPath,[packageTool,'verify-runtime','--root',runtime],'package-tool verify-runtime');
  if(verify.status!==0)throw new Error('TEAMQA_RUNTIME_PROVENANCE_INVALID:'+verify.stderr.trim());
  const proof=JSON.parse(readFileSync(proofPath,'utf8'));
  if(proof.repo_target?.repo_root!==realpathSync(repo)||proof.repo_target?.base_sha!==base||proof.repo_target?.head_sha!==head)throw new Error('TEAMQA_REPO_TARGET_MISMATCH');
  if(proof.role!=='executor_code'||proof.seat?.provider!==provider||proof.seat?.model!==model||proof.seat?.effort!==reasoning)throw new Error('TEAMQA_SEAT_MISMATCH');
  if(!proof.coder?.agent_id||!proof.coder?.session_id||(proof.seat?.agent_id && proof.coder.agent_id===proof.seat.agent_id)||(proof.seat?.session_id && proof.coder.session_id===proof.seat.session_id))throw new Error('TEAMQA_REVIEWER_NOT_INDEPENDENT');
  const modulePath=join(runtime,'scripts','lib','roster.mjs');
  const code='const m=await import(process.argv[1]);const p=JSON.parse((await import("node:fs")).readFileSync(process.argv[2],"utf8"));const o=JSON.parse(process.argv[3]);const v=await m.verifyChildDispatchProof(p,o);if(v?.authorized!==true)throw new Error("TEAMQA_PROOF_REJECTED");if(o.bindRole){const c=await import((await import("node:url")).pathToFileURL(process.argv[1].replace(/roster\.mjs$/,"run-contract.mjs")).href);await c.bindRoleAttestation({runDir:p.run_dir,attestation:o.attestation});}process.stdout.write(JSON.stringify({ok:true,seat:v.roster.roles.find(r=>r.role===p.role)}));';
  const result=spawnSync(process.execPath,['--input-type=module','-e',code,modulePath,proofPath,JSON.stringify({stage,attestation,bindRole})],{encoding:'utf8',maxBuffer:1024*1024});
  if(result.status!==0)throw new Error(`TEAMQA_PROOF_REJECTED:${result.stderr.trim()}`);
  const checked=JSON.parse(result.stdout);
  if(checked.ok!==true)throw new Error('TEAMQA_PROOF_REJECTED');
  return {...proof,runtime_root:runtime,resolved_seat:checked.seat};
}
