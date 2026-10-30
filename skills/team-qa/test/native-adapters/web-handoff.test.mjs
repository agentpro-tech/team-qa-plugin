import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sha256 } from '../../scripts/lib/core.mjs';
import { sealReliabilityRecord, verifyWebHandoffEnvelope, WEB_HANDOFF_CONTRACT_SHA256 } from '../../scripts/lib/reliability-handoff.mjs';

const root=fileURLToPath(new URL('../fixtures/deployed-target/',import.meta.url));
const raw=readFileSync(join(root,'proof.json'));
const proof=JSON.parse(raw.toString('utf8'));
const target={...proof.identity,target_binding_sha256:proof.target_binding_sha256,identity_proof:{path:'proof.json',sha256:sha256(raw)}};
const base={schema:'team-qa/handoff/web-v1',contract_sha256:WEB_HANDOFF_CONTRACT_SHA256,
  run_uuid:'123e4567-e89b-42d3-a456-426614174000',requirements_hash:'d'.repeat(64),
  target_kind:'deployed-build',target_binding_sha256:target.target_binding_sha256,target,
  team_qa_receipt_sha256:'e'.repeat(64),team_qa_receipt_integrity:'f'.repeat(64),release_verdict:'GO',
  producer:{skill:'team-qa',version:'1.10.1',source_commit:'a'.repeat(40)},ready_at:'2026-10-08T00:00:00Z'};
const expected={run_uuid:base.run_uuid,requirements_hash:base.requirements_hash,target_binding_sha256:base.target_binding_sha256,target};

test('web handoff binds receipt target without product Git or Team-code capsule',()=>{
  assert.equal(verifyWebHandoffEnvelope(sealReliabilityRecord(base),expected).target_binding_sha256,target.target_binding_sha256);
  assert.throws(()=>verifyWebHandoffEnvelope(sealReliabilityRecord({...base,exact_final_sha:'a'.repeat(40)}),expected),/WEB_HANDOFF_FIELDS/);
  assert.throws(()=>verifyWebHandoffEnvelope(sealReliabilityRecord(base),{...expected,target_binding_sha256:'0'.repeat(64)}),/WEB_HANDOFF_BINDING_MISMATCH/);
  assert.throws(()=>verifyWebHandoffEnvelope(sealReliabilityRecord({...base,run_uuid:'not-a-uuid'}),{...expected,run_uuid:'not-a-uuid'}),/WEB_HANDOFF_RUN_UUID/);
});
