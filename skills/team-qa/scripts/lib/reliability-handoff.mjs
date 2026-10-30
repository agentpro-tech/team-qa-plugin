import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyCurrentTeamQaReceipt } from './current-run-receipt.mjs';
import { TeamQAError } from './core.mjs';
import { stable, verifyReceiptShape } from './release-truth.mjs';
import { deployedTargetShapeErrors } from './deployed-target.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONTRACT_ROOT = path.join(ROOT, 'contracts/reliability-handoff/v1');
const currentProducer=v=>{const [m,n]=String(v||'').split('.').map(Number);return m>1||(m===1&&n>=7);};
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const RELIABILITY_CONTRACT_SHA256 = 'e4599c02ee84591b3e20ec8902fb902b97281312192bd24a62c6f2c57116106f';
export const WEB_HANDOFF_CONTRACT_SHA256 = '2ce5542e4f1a7feff66082a34da1ca59d8c223eb97b12ac3a0f70a2c2a5a709f';
export const WEB_HANDOFF_FIELDS = ['schema','contract_sha256','run_uuid','requirements_hash','target_kind','target_binding_sha256','target','team_qa_receipt_sha256','team_qa_receipt_integrity','release_verdict','producer','ready_at','integrity'];
export const HANDOFF_FIELDS = [
  'schema', 'contract_sha256', 'run_uuid', 'task_base', 'source_revision', 'exact_final_sha',
  'requirements_hash', 'capsule_digest', 'team_qa_receipt_sha256', 'team_qa_receipt_integrity',
  'release_verdict', 'producer', 'ready_at', 'integrity',
];
export const ACK_FIELDS = [
  'schema', 'contract_sha256', 'team_qa_handoff_sha256', 'team_qa_handoff_integrity',
  'run_uuid', 'task_base', 'source_revision', 'exact_final_sha', 'requirements_hash',
  'capsule_digest', 'receiver', 'received_at', 'verified_at', 'handoff_latency_ms',
  'execution_status', 'semantic_verdict', 'integrity',
];
export const JOB_CAPSULE_FIELDS = [
  'schema', 'contract_sha256', 'capsule_version', 'run_uuid', 'task_id', 'task_base',
  'source_revision', 'exact_final_sha', 'requirements_hash', 'brief_hashes',
  'dependency_manifest_sha256', 'engine_contract', 'created_at', 'digest',
];

export class ReliabilityHandoffError extends TeamQAError {
  constructor(code, detail = '') {
    super(2, 'fail', code, detail);
  }
}

export function hashReliabilityBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function integrityFor(value) {
  const clean = structuredClone(value);
  delete clean.integrity;
  return hashReliabilityBytes(canonical(clean));
}

export function sealReliabilityRecord(value) {
  return { ...value, integrity: integrityFor(value) };
}

function exactKeys(value, expected, code) {
  const observed = Object.keys(value || {}).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(observed) !== JSON.stringify(wanted)) throw new ReliabilityHandoffError(code);
}

function assertEqual(actual, expected, code) {
  if (actual !== expected) throw new ReliabilityHandoffError(code);
}

function assertSha(value, regex, code) {
  if (!regex.test(value || '')) throw new ReliabilityHandoffError(code);
}

function assertTime(value, code) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new ReliabilityHandoffError(code);
}

function assertIntegrity(value, code) {
  assertSha(value.integrity, SHA256, code);
  if (integrityFor(value) !== value.integrity) throw new ReliabilityHandoffError(code);
}

function assertActor(value, skill, code) {
  exactKeys(value, ['skill', 'version', 'source_commit'], code);
  if (value.skill !== skill || !/^\d+\.\d+\.\d+$/.test(value.version || '') || !SHA40.test(value.source_commit || '')) {
    throw new ReliabilityHandoffError(code);
  }
}

function assertSameBytes(value, bytes, code) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new ReliabilityHandoffError(code); }
  if (canonical(parsed) !== canonical(value)) throw new ReliabilityHandoffError(code);
}

export function readReliabilityContract() {
  const contractFile = path.join(CONTRACT_ROOT, 'CONTRACT.json');
  let contract;
  try { contract = JSON.parse(fs.readFileSync(contractFile, 'utf8')); } catch { throw new ReliabilityHandoffError('HANDOFF_CONTRACT_MISSING'); }
  const observed = {};
  for (const name of fs.readdirSync(CONTRACT_ROOT).filter((item) => item.endsWith('.schema.json')).sort()) {
    observed[name] = hashReliabilityBytes(fs.readFileSync(path.join(CONTRACT_ROOT, name)));
  }
  if (canonical(observed) !== canonical(contract.schemas)) throw new ReliabilityHandoffError('HANDOFF_CONTRACT_SCHEMA_HASH');
  if (hashReliabilityBytes(canonical(observed)) !== contract.contract_sha256) throw new ReliabilityHandoffError('HANDOFF_CONTRACT_DIGEST');
  if (contract.contract_sha256 !== RELIABILITY_CONTRACT_SHA256) throw new ReliabilityHandoffError('HANDOFF_CONTRACT_PIN');
  return contract;
}

export function createReliabilityHandoff({ receipt, receiptBytes, capsuleDigest, readyAt, producer, receiptFile }) {
  if (receipt?.schema === 'team-qa/receipt/web-v1') {
    if (!receiptFile) throw new ReliabilityHandoffError('WEB_HANDOFF_CURRENT_RECEIPT_FILE_REQUIRED');
    verifyCurrentTeamQaReceipt(receipt,receiptFile);
    assertSameBytes(receipt,receiptBytes,'HANDOFF_RECEIPT_BYTES');
    assertActor(producer,'team-qa','HANDOFF_PRODUCER');
    assertTime(readyAt,'HANDOFF_READY_AT');
    if (capsuleDigest !== undefined && capsuleDigest !== null) throw new ReliabilityHandoffError('WEB_HANDOFF_CAPSULE_FORBIDDEN');
    const envelope = sealReliabilityRecord({schema:'team-qa/handoff/web-v1',contract_sha256:WEB_HANDOFF_CONTRACT_SHA256,
      run_uuid:receipt.run_uuid,requirements_hash:receipt.requirements_hash,target_kind:'deployed-build',
      target_binding_sha256:receipt.target_binding_sha256,target:receipt.target,
      team_qa_receipt_sha256:hashReliabilityBytes(receiptBytes),team_qa_receipt_integrity:receipt.integrity,
      release_verdict:receipt.release_verdict,producer,ready_at:readyAt});
    return verifyWebHandoffEnvelope(envelope,{run_uuid:receipt.run_uuid,requirements_hash:receipt.requirements_hash,target_binding_sha256:receipt.target_binding_sha256,target:receipt.target});
  }
  readReliabilityContract();
  verifyReceiptShape(receipt);
  if(currentProducer(producer?.version)){if(!receiptFile)throw new ReliabilityHandoffError('HANDOFF_CURRENT_RECEIPT_FILE_REQUIRED');verifyCurrentTeamQaReceipt(receipt,receiptFile);}
  assertSameBytes(receipt, receiptBytes, 'HANDOFF_RECEIPT_BYTES');
  assertSha(capsuleDigest, SHA256, 'HANDOFF_CAPSULE_DIGEST');
  assertActor(producer, 'team-qa', 'HANDOFF_PRODUCER');
  assertTime(readyAt, 'HANDOFF_READY_AT');
  return sealReliabilityRecord({
    schema: 'team-qa/handoff/v1',
    contract_sha256: RELIABILITY_CONTRACT_SHA256,
    run_uuid: receipt.run_uuid,
    task_base: receipt.task_base,
    source_revision: receipt.source_revision,
    exact_final_sha: receipt.exact_final_sha,
    requirements_hash: receipt.requirements_hash,
    capsule_digest: capsuleDigest,
    team_qa_receipt_sha256: hashReliabilityBytes(receiptBytes),
    team_qa_receipt_integrity: receipt.integrity,
    release_verdict: receipt.release_verdict,
    producer,
    ready_at: readyAt,
  });
}

export function verifyJobCapsuleForHandoff(capsule) {
  readReliabilityContract();
  exactKeys(capsule, JOB_CAPSULE_FIELDS, 'JOB_CAPSULE_FIELDS');
  assertEqual(capsule.schema, 'team-code/job-capsule/v1', 'JOB_CAPSULE_SCHEMA');
  assertEqual(capsule.contract_sha256, RELIABILITY_CONTRACT_SHA256, 'JOB_CAPSULE_CONTRACT_SHA');
  assertEqual(capsule.capsule_version, 1, 'JOB_CAPSULE_VERSION');
  assertSha(capsule.task_base, SHA40, 'JOB_CAPSULE_TASK_BASE');
  assertSha(capsule.exact_final_sha, SHA40, 'JOB_CAPSULE_EXACT_SHA');
  for (const field of ['requirements_hash', 'dependency_manifest_sha256', 'digest']) assertSha(capsule[field], SHA256, `JOB_CAPSULE_HASH:${field}`);
  exactKeys(capsule.brief_hashes, ['source', 'spec', 'map'], 'JOB_CAPSULE_BRIEF_FIELDS');
  for (const value of Object.values(capsule.brief_hashes)) assertSha(value, SHA256, 'JOB_CAPSULE_BRIEF_HASH');
  exactKeys(capsule.engine_contract, ['mixer', 'scroll_outer_loop'], 'JOB_CAPSULE_ENGINE_FIELDS');
  if (capsule.engine_contract.mixer !== 'mixer-exec/v1' || capsule.engine_contract.scroll_outer_loop !== true) throw new ReliabilityHandoffError('JOB_CAPSULE_ENGINE_CONTRACT');
  assertTime(capsule.created_at, 'JOB_CAPSULE_CREATED_AT');
  const clean = structuredClone(capsule);
  delete clean.digest;
  if (hashReliabilityBytes(canonical(clean)) !== capsule.digest) throw new ReliabilityHandoffError('JOB_CAPSULE_DIGEST_MISMATCH');
  return capsule;
}

export function verifyReliabilityHandoff(handoff, expected, {receipt,receiptBytes,receiptFile}={}) {
  if (handoff?.schema === 'team-qa/handoff/web-v1') {
    if (!receipt || !receiptBytes || !receiptFile) throw new ReliabilityHandoffError('WEB_HANDOFF_CURRENT_RECEIPT_REQUIRED');
    verifyCurrentTeamQaReceipt(receipt,receiptFile);
    assertSameBytes(receipt,receiptBytes,'HANDOFF_RECEIPT_BYTES');
    verifyWebHandoffEnvelope(handoff,expected);
    for (const field of ['run_uuid','requirements_hash','target_binding_sha256','release_verdict']) assertEqual(handoff[field],receipt[field],'WEB_HANDOFF_RECEIPT_DRIFT:' + field);
    if (canonical(handoff.target) !== canonical(receipt.target) || handoff.team_qa_receipt_sha256 !== hashReliabilityBytes(receiptBytes) || handoff.team_qa_receipt_integrity !== receipt.integrity) throw new ReliabilityHandoffError('WEB_HANDOFF_RECEIPT_DRIFT');
    return handoff;
  }
  readReliabilityContract();
  if(receipt||currentProducer(handoff?.producer?.version)){if(!receipt||!receiptBytes||!receiptFile)throw new ReliabilityHandoffError('HANDOFF_CURRENT_RECEIPT_REQUIRED');verifyCurrentTeamQaReceipt(receipt,receiptFile);if(handoff.team_qa_receipt_sha256!==hashReliabilityBytes(receiptBytes)||handoff.team_qa_receipt_integrity!==receipt.integrity||handoff.release_verdict!==receipt.release_verdict)throw new ReliabilityHandoffError('HANDOFF_RECEIPT_DRIFT');}
  exactKeys(handoff, HANDOFF_FIELDS, 'HANDOFF_FIELDS');
  assertEqual(handoff.schema, 'team-qa/handoff/v1', 'HANDOFF_SCHEMA');
  assertEqual(handoff.contract_sha256, RELIABILITY_CONTRACT_SHA256, 'HANDOFF_CONTRACT_SHA');
  assertIntegrity(handoff, 'HANDOFF_INTEGRITY');
  assertSha(handoff.task_base, SHA40, 'HANDOFF_TASK_BASE');
  assertSha(handoff.exact_final_sha, SHA40, 'HANDOFF_EXACT_SHA');
  for (const field of ['requirements_hash', 'capsule_digest', 'team_qa_receipt_sha256', 'team_qa_receipt_integrity']) assertSha(handoff[field], SHA256, `HANDOFF_HASH:${field}`);
  if (!['GO', 'NO-GO', 'UNGRADED'].includes(handoff.release_verdict)) throw new ReliabilityHandoffError('HANDOFF_VERDICT');
  assertActor(handoff.producer, 'team-qa', 'HANDOFF_PRODUCER');
  assertTime(handoff.ready_at, 'HANDOFF_READY_AT');
  assertEqual(handoff.run_uuid, expected.run_uuid, 'HANDOFF_BINDING_MISMATCH:run_uuid');
  assertEqual(handoff.task_base, expected.task_base, 'HANDOFF_BINDING_MISMATCH:task_base');
  assertEqual(handoff.source_revision, expected.source_revision, 'HANDOFF_BINDING_MISMATCH:source_revision');
  assertEqual(handoff.exact_final_sha, expected.exact_final_sha, 'HANDOFF_BINDING_MISMATCH:exact_final_sha');
  assertEqual(handoff.requirements_hash, expected.requirements_hash, 'HANDOFF_BINDING_MISMATCH:requirements_hash');
  assertEqual(handoff.capsule_digest, expected.capsule_digest, 'HANDOFF_BINDING_MISMATCH:capsule_digest');
  return handoff;
}


export function verifyWebHandoffEnvelope(handoff, expected) {
  const contractPath=path.join(ROOT,'contracts/deployed-build-handoff/v1/CONTRACT.json');
  if (hashReliabilityBytes(fs.readFileSync(contractPath)) !== WEB_HANDOFF_CONTRACT_SHA256) throw new ReliabilityHandoffError('WEB_HANDOFF_CONTRACT_DRIFT');
  exactKeys(handoff,WEB_HANDOFF_FIELDS,'WEB_HANDOFF_FIELDS');
  assertEqual(handoff.schema,'team-qa/handoff/web-v1','WEB_HANDOFF_SCHEMA');
  assertEqual(handoff.contract_sha256,WEB_HANDOFF_CONTRACT_SHA256,'WEB_HANDOFF_CONTRACT_SHA');
  assertIntegrity(handoff,'WEB_HANDOFF_INTEGRITY');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(handoff.run_uuid || '')) throw new ReliabilityHandoffError('WEB_HANDOFF_RUN_UUID');
  assertEqual(handoff.target_kind,'deployed-build','WEB_HANDOFF_TARGET_KIND');
  if (deployedTargetShapeErrors(handoff.target).length || handoff.target_binding_sha256 !== handoff.target.target_binding_sha256) throw new ReliabilityHandoffError('WEB_HANDOFF_TARGET');
  for (const field of ['requirements_hash','target_binding_sha256','team_qa_receipt_sha256','team_qa_receipt_integrity']) assertSha(handoff[field],SHA256,'WEB_HANDOFF_HASH:' + field);
  if (!['GO','NO-GO','UNGRADED'].includes(handoff.release_verdict)) throw new ReliabilityHandoffError('WEB_HANDOFF_VERDICT');
  assertActor(handoff.producer,'team-qa','WEB_HANDOFF_PRODUCER');
  assertTime(handoff.ready_at,'WEB_HANDOFF_READY_AT');
  for (const field of ['run_uuid','requirements_hash','target_binding_sha256']) assertEqual(handoff[field],expected[field],'WEB_HANDOFF_BINDING_MISMATCH:' + field);
  if (expected.target && canonical(handoff.target) !== canonical(expected.target)) throw new ReliabilityHandoffError('WEB_HANDOFF_BINDING_MISMATCH:target');
  return handoff;
}
export function verifyTeamCodeHandoffAck(ack, { handoff, handoffBytes, maxLatencyMs = 15_000 }) {
  if (handoff?.schema === 'team-qa/handoff/web-v1') throw new ReliabilityHandoffError('WEB_HANDOFF_TEAM_CODE_ACK_NOT_APPLICABLE');
  readReliabilityContract();
  verifyReliabilityHandoff(handoff, handoff);
  assertSameBytes(handoff, handoffBytes, 'HANDOFF_BYTES');
  exactKeys(ack, ACK_FIELDS, 'HANDOFF_ACK_FIELDS');
  assertEqual(ack.schema, 'team-code/handoff-ack/v1', 'HANDOFF_ACK_SCHEMA');
  assertEqual(ack.contract_sha256, RELIABILITY_CONTRACT_SHA256, 'HANDOFF_ACK_CONTRACT_SHA');
  assertIntegrity(ack, 'HANDOFF_ACK_INTEGRITY');
  assertActor(ack.receiver, 'team-code', 'HANDOFF_ACK_RECEIVER');
  assertTime(ack.received_at, 'HANDOFF_ACK_RECEIVED_AT');
  assertTime(ack.verified_at, 'HANDOFF_ACK_VERIFIED_AT');
  if (!Number.isInteger(ack.handoff_latency_ms) || ack.handoff_latency_ms < 0) throw new ReliabilityHandoffError('HANDOFF_ACK_LATENCY');
  const derivedLatency = Date.parse(ack.verified_at) - Date.parse(handoff.ready_at);
  assertEqual(ack.handoff_latency_ms, derivedLatency, 'HANDOFF_ACK_LATENCY_MISMATCH');
  if (ack.handoff_latency_ms > maxLatencyMs) throw new ReliabilityHandoffError('HANDOFF_SLO_EXCEEDED');
  assertEqual(ack.team_qa_handoff_sha256, hashReliabilityBytes(handoffBytes), 'HANDOFF_ACK_HASH');
  assertEqual(ack.team_qa_handoff_integrity, handoff.integrity, 'HANDOFF_ACK_INTEGRITY_BINDING');
  for (const field of ['run_uuid', 'task_base', 'source_revision', 'exact_final_sha', 'requirements_hash', 'capsule_digest']) {
    assertEqual(ack[field], handoff[field], `HANDOFF_ACK_BINDING_MISMATCH:${field}`);
  }
  assertEqual(ack.execution_status, 'completed', 'HANDOFF_ACK_EXECUTION_STATUS');
  assertEqual(ack.semantic_verdict, 'PASS', 'HANDOFF_ACK_SEMANTIC_VERDICT');
  return ack;
}
