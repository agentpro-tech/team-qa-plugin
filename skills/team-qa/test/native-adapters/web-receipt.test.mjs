import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sha256 } from '../../scripts/lib/core.mjs';
import { seal, verifyReceiptShape } from '../../scripts/lib/release-truth.mjs';
import { childVerdictIssue } from '../../scripts/lib/child-verdict.mjs';
import { WEB_CONTRACT_SHA256 } from '../../scripts/lib/deployed-target.mjs';

const root = fileURLToPath(new URL('../fixtures/deployed-target/', import.meta.url));
const proofBytes = readFileSync(join(root,'proof.json'));
const proof = JSON.parse(proofBytes.toString('utf8'));
const target = { ...proof.identity, target_binding_sha256:proof.target_binding_sha256,
  identity_proof:{path:'proof.json',sha256:sha256(proofBytes)} };
const receiptBytes = readFileSync(join(root,'gui-web-receipt.json'));
const binding = { schema:'team-qa/web-binding/v1', run_uuid:'123e4567-e89b-42d3-a456-426614174000',
  requirements_hash:'d'.repeat(64),contract_sha256:WEB_CONTRACT_SHA256,
  verification_lane:'gui',target_kind:'deployed-build',target_binding_sha256:target.target_binding_sha256,target };
const record = {case_id:'GC-01',source:'qa-gui',verdict:'pass',target,
  evidence:['gui-web-receipt.json'],child_verdict:{skill:'qa-gui',verdict:'pass',
    artifact:'gui-web-receipt.json',sha256:sha256(receiptBytes)}};

test('web GUI child receipt binds case, requirements and deployed target', () => {
  assert.equal(childVerdictIssue(record,join(root,'board.jsonl'),{governed:true,declared:target},binding,'R1'),null);
  assert.equal(childVerdictIssue(record,join(root,'board.jsonl'),{governed:true,declared:target},{...binding,target_binding_sha256:'f'.repeat(64)},'R1'),'CHILD_WEB_BINDING_INVALID');
  assert.equal(childVerdictIssue(record,join(root,'board.jsonl'),{governed:true,declared:target},binding,'other'),'CHILD_RECEIPT_REQUIREMENT_MISMATCH');
});

test('Team QA web receipt rejects Git fields', () => {
  const base={schema:'team-qa/receipt/web-v1',contract_sha256:WEB_CONTRACT_SHA256,run_uuid:binding.run_uuid,
    requirements_hash:binding.requirements_hash,verification_lane:'gui',target_kind:'deployed-build',
    target_binding_sha256:target.target_binding_sha256,target,artifacts:{},plan_case_total:1,executed:1,
    missing_ids:[],rtm_filled:1,rtm_total:1,release_verdict:'GO',created_at:'2026-10-08T00:00:00Z',
    run_provenance:{schema:'team-qa/run-provenance/v1',roster_hash:'a'.repeat(64),artifacts:[]}};
  assert.equal(verifyReceiptShape(seal(base)).schema,'team-qa/receipt/web-v1');
  assert.throws(()=>verifyReceiptShape(seal({...base,exact_final_sha:'e'.repeat(40)})),/WEB_RECEIPT_FIELDS/);
});
