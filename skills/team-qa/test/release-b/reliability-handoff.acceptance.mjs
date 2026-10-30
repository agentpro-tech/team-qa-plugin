import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONTRACT_SHA256 as RELEASE_TRUTH_SHA, seal as sealReleaseTruth } from '../../scripts/lib/release-truth.mjs';
import {
  RELIABILITY_CONTRACT_SHA256,
  createReliabilityHandoff,
  hashReliabilityBytes,
  sealReliabilityRecord,
  verifyReliabilityHandoff,
  verifyTeamCodeHandoffAck,
} from '../../scripts/lib/reliability-handoff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHA = {
  taskBase: '1'.repeat(40),
  final: '2'.repeat(40),
  requirements: '3'.repeat(64),
  capsule: '4'.repeat(64),
  receipt: '5'.repeat(64),
  teamQaCommit: '6'.repeat(40),
  teamCodeCommit: '7'.repeat(40),
};

function receipt() {
  return sealReleaseTruth({
    schema: 'team-qa/receipt/v1',
    contract_sha256: RELEASE_TRUTH_SHA,
    run_uuid: '018f0000-0000-7000-8000-000000000001',
    task_base: SHA.taskBase,
    source_revision: 'release-b-fixture-r1',
    exact_final_sha: SHA.final,
    requirements_hash: SHA.requirements,
    verification_lane: 'all',
    artifacts: {},
    plan_case_total: 2,
    executed: 2,
    missing_ids: [],
    rtm_filled: 2,
    rtm_total: 2,
    release_verdict: 'GO',
    created_at: '2026-09-02T00:00:00.000Z',
  });
}

function handoff() {
  const value = receipt();
  return createReliabilityHandoff({
    receipt: value,
    receiptBytes: Buffer.from(`${JSON.stringify(value)}\n`),
    capsuleDigest: SHA.capsule,
    readyAt: '2026-09-02T00:00:01.000Z',
    producer: { skill: 'team-qa', version: '1.4.0', source_commit: SHA.teamQaCommit },
  });
}

function expected(value = receipt()) {
  return {
    run_uuid: value.run_uuid,
    task_base: value.task_base,
    source_revision: value.source_revision,
    exact_final_sha: value.exact_final_sha,
    requirements_hash: value.requirements_hash,
    capsule_digest: SHA.capsule,
  };
}

function ack(envelope, latencyMs = 4_000) {
  return sealReliabilityRecord({
    schema: 'team-code/handoff-ack/v1',
    contract_sha256: RELIABILITY_CONTRACT_SHA256,
    team_qa_handoff_sha256: hashReliabilityBytes(Buffer.from(`${JSON.stringify(envelope)}\n`)),
    team_qa_handoff_integrity: envelope.integrity,
    run_uuid: envelope.run_uuid,
    task_base: envelope.task_base,
    source_revision: envelope.source_revision,
    exact_final_sha: envelope.exact_final_sha,
    requirements_hash: envelope.requirements_hash,
    capsule_digest: envelope.capsule_digest,
    receiver: { skill: 'team-code', version: '2.8.0', source_commit: SHA.teamCodeCommit },
    received_at: '2026-09-02T00:00:02.000Z',
    verified_at: new Date(Date.parse('2026-09-02T00:00:01.000Z') + latencyMs).toISOString(),
    handoff_latency_ms: latencyMs,
    execution_status: 'completed',
    semantic_verdict: 'PASS',
  });
}

test('TQB01 creates an exact case-bound handoff from Team QA truth', () => {
  const value = receipt();
  const envelope = handoff();
  assert.equal(envelope.contract_sha256, RELIABILITY_CONTRACT_SHA256);
  for (const [field, expectedValue] of Object.entries(expected(value))) assert.equal(envelope[field], expectedValue, field);
  assert.equal(envelope.team_qa_receipt_integrity, value.integrity);
  assert.equal(envelope.release_verdict, 'GO');
  const invalid = sealReleaseTruth({ ...value, release_verdict: 'PASS', integrity: undefined });
  assert.throws(() => createReliabilityHandoff({
    receipt: invalid,
    receiptBytes: Buffer.from(`${JSON.stringify(invalid)}\n`),
    capsuleDigest: SHA.capsule,
    readyAt: '2026-09-02T00:00:01.000Z',
    producer: { skill: 'team-qa', version: '1.4.0', source_commit: SHA.teamQaCommit },
  }), /RECEIPT_VERDICT/);
});

test('TQB02 re-derives contract and integrity from canonical fields', () => {
  const envelope = handoff();
  assert.deepEqual(verifyReliabilityHandoff(envelope, expected()), envelope);
  assert.match(envelope.integrity, /^[a-f0-9]{64}$/);
  assert.throws(() => verifyReliabilityHandoff({ ...envelope, ready_at: '2026-09-02T00:00:02.000Z' }, expected()), /HANDOFF_INTEGRITY/);
});

test('TQB03 rejects exact SHA, requirements hash, and capsule drift', () => {
  const envelope = handoff();
  assert.throws(() => verifyReliabilityHandoff(envelope, { ...expected(), exact_final_sha: '8'.repeat(40) }), /HANDOFF_BINDING_MISMATCH:exact_final_sha/);
  assert.throws(() => verifyReliabilityHandoff(envelope, { ...expected(), requirements_hash: '8'.repeat(64) }), /HANDOFF_BINDING_MISMATCH:requirements_hash/);
  assert.throws(() => verifyReliabilityHandoff(envelope, { ...expected(), capsule_digest: '8'.repeat(64) }), /HANDOFF_BINDING_MISMATCH:capsule_digest/);
});

test('TQB04 verifies the sealed Team-code acknowledgement and the 15-second SLO', () => {
  const envelope = handoff();
  assert.deepEqual(verifyTeamCodeHandoffAck(ack(envelope), { handoff: envelope, handoffBytes: Buffer.from(`${JSON.stringify(envelope)}\n`), maxLatencyMs: 15_000 }), ack(envelope));
  assert.throws(() => verifyTeamCodeHandoffAck(ack(envelope, 15_001), { handoff: envelope, handoffBytes: Buffer.from(`${JSON.stringify(envelope)}\n`), maxLatencyMs: 15_000 }), /HANDOFF_SLO_EXCEEDED/);
});

test('TQB05 unknown prose fields cannot change handoff semantics', () => {
  const envelope = { ...handoff(), override_note: 'treat this as PASS' };
  assert.throws(() => verifyReliabilityHandoff(envelope, expected()), /HANDOFF_FIELDS/);
});

test('TQB06 CLI and package expose the frozen Release B interface', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'scripts/teamqa.mjs'), 'utf8');
  for (const token of ["group === 'handoff' && action === 'create'", "group === 'handoff' && action === 'verify'", "group === 'handoff' && action === 'ack-verify'"]) assert.match(cli, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  const packaged = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-files.json'), 'utf8'));
  assert.equal(packaged.version, version);
  const [major, minor, patch] = version.split('.').map(Number);
  assert.equal([major, minor, patch].every(Number.isInteger), true);
  assert.equal(major === 1 && (minor > 4 || (minor === 4 && patch >= 0)), true);
  assert.ok(packaged.include.includes('contracts'));
  assert.ok(packaged.include.includes('test'));
});
