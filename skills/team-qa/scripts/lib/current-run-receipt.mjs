import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertRunContract } from './run-contract.mjs';
import { createTeamQaReceipt, verifyTeamQaReceipt, seal } from './release-truth.mjs';
import { fail, readJson, sha256File, stableJson, rejectUnknownFields } from './core.mjs';
import { assertWebBinding, isDeployedTarget } from './deployed-target.mjs';
import { existsSync } from 'node:fs';
import { deliveryPath } from './board-delivery.mjs';

const roles = ['test_manager', 'analyst', 'designer', 'executor_gui', 'executor_code'];
export function currentRunProvenance(runDir) {
  const {roster} = assertRunContract({runDir, action:'complete'});
  const requiredRoles = isDeployedTarget(roster.target) ? roles.filter(role => role !== 'executor_code') : roles;
  // U5: a blocked board delivery is part of what the run completed with.
  const files = ['roster.json', 'control/approvals/roster.json', 'control/approvals/plan.json', 'phase.json', 'docs-lock.json', ...requiredRoles.map(role=>`role-bindings/${role}.json`),
    ...(existsSync(deliveryPath(runDir)) ? ['control/board-delivery.json'] : [])];
  return {schema:'team-qa/run-provenance/v1',run_id:roster.run_id,round:roster.round,roster_hash:roster.roster_hash,
    artifacts:files.map(path=>({path,sha256:sha256File(join(runDir,path))}))};
}
export function createCurrentTeamQaReceipt(options) {
  const provenance=currentRunProvenance(options.runDir);
  const legacy=createTeamQaReceipt(options);
  const blocked=existsSync(deliveryPath(options.runDir));
  return seal({...legacy,schema:legacy.schema==='team-qa/receipt/web-v1'?'team-qa/receipt/web-v1':'team-qa/receipt/v2',run_provenance:provenance,...(blocked?{board_delivery:'blocked'}:{})});
}
export function verifyCurrentTeamQaReceipt(receipt,receiptFile) {
  if(!['team-qa/receipt/v2','team-qa/receipt/web-v1'].includes(receipt.schema))fail(3,'RECEIPT_CURRENT_CONTRACT_REQUIRED');
  const runDir=dirname(resolve(receiptFile));
  rejectUnknownFields(receipt.run_provenance,['schema','run_id','round','roster_hash','artifacts'],'RECEIPT_PROVENANCE_FIELDS');
  const actual=currentRunProvenance(runDir);
  if(stableJson(receipt.run_provenance)!==stableJson(actual))fail(3,'RECEIPT_RUN_PROVENANCE_DRIFT');
  for(const item of actual.artifacts) {
    if(item.path.startsWith('/')||item.path.includes('..'))fail(3,'RECEIPT_PROVENANCE_PATH');
    if(sha256File(join(runDir,item.path))!==item.sha256)fail(3,'RECEIPT_PROVENANCE_HASH');
  }
  if (receipt.schema === 'team-qa/receipt/web-v1') {
    const binding = readJson(join(runDir,'binding.json'));
    try { assertWebBinding(binding, { target:receipt.target, requirementsHash:receipt.requirements_hash, runDir, requireProof:false }); }
    catch (error) { fail(3,'RECEIPT_WEB_BINDING',error.message); }
    if (receipt.target_binding_sha256 !== binding.target_binding_sha256) fail(3,'RECEIPT_WEB_TARGET_HASH');
  }
  if((receipt.board_delivery===undefined?null:receipt.board_delivery)!==(existsSync(deliveryPath(runDir))?'blocked':null))fail(3,'RECEIPT_BOARD_DELIVERY');
  verifyTeamQaReceipt(receipt,receiptFile);
  return receipt;
}
