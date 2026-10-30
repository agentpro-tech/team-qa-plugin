import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  compileEscapedDefects,
  createEscapedDefectCompileReceipt,
  verifyEscapedDefectCompileReceipt,
} from '../scripts/lib/escaped-defect-registry.mjs';
import { trackedErrors } from '../scripts/lib/validators.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/teamqa.mjs');
const layers = ['qa-code', 'qa-gui', 'team-qa', 'team-code'];
const roots = [];
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

test.after(() => {
  fs.mkdirSync(path.join(os.tmpdir(), 'teamqa-test-archive'), { recursive: true });
  for (const root of roots) fs.renameSync(root, path.join(os.tmpdir(), 'teamqa-test-archive', path.basename(root)));
});

function registry() {
  return {
    schema: 'agentpro/escaped-defect-registry/v1',
    registry_id: 'release-c-incident-corpus',
    source_revision: 'fable-consult-20260901',
    defects: [{
      incident_id: 'INC-SAMPLESHOP-PARTA',
      title: 'Controller-authored PASS bypassed canonical child gates',
      source: { kind: 'incident', ref: 'sampleshop-part-a', sha256: 'a'.repeat(64) },
      affected_component: 'release truth chain',
      escaped_gate: 'cross-layer child receipt wiring',
      severity: 'P0',
      reproduction: ['Run the release path with an aggregate GUI artifact.', 'Observe the false GO.'],
      expected: 'The release remains blocked until every canonical child gate passes.',
      observed: 'A controller-authored board produced GO without canonical child receipts.',
      root_cause_class: 'gate-wiring-bypass',
      affected_layers: [...layers],
      regression_tests: layers.map((layer) => ({
        layer,
        case_id: `RC-${layer.toUpperCase()}`,
        requirement_id: `REQ-${layer.toUpperCase()}`,
        verification_lane: layer === 'qa-gui' ? 'gui' : 'code',
        case_kind: layer === 'qa-gui' ? 'behavioral' : 'static',
        fixture: 'fixtures/release-c/incident.json',
        positive_test: 'test/release-c/positive.test.mjs',
        mutation_test: 'test/release-c/mutation.test.mjs',
        gate: 'scripts/release-gate.sh',
        fixture_sha256: 'b'.repeat(64),
        positive_test_sha256: 'c'.repeat(64),
        mutation_test_sha256: 'd'.repeat(64),
        gate_sha256: 'e'.repeat(64),
      })),
      owner: 'CASE',
      closure_evidence: [{ layer: 'team-qa', kind: 'incident-replay', path: 'evidence/replay.json', sha256: 'f'.repeat(64) }],
    }],
  };
}

const tracked = () => ({ schemaVersion: 2, sourceItems: [], cases: [] });
const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

test('C3 positive: registry compiles to one source and one tracked case per regression binding', () => {
  const input = registry();
  const compiled = compileEscapedDefects(input, tracked());
  assert.equal(compiled.sourceItems.length, 1);
  assert.equal(compiled.cases.length, 4);
  assert.deepEqual(compiled.cases.map((item) => item.id), layers.map((layer) => `RC-${layer.toUpperCase()}`));
  assert.ok(compiled.cases.every((item) => item.sourceRefs.length === 1 && item.sourceRefs[0] === 'SRC-ESCAPED-INC-SAMPLESHOP-PARTA'));
  assert.deepEqual(trackedErrors(compiled, { lock: null }), []);

  const receipt = createEscapedDefectCompileReceipt({
    registry: input,
    registryBytes: bytes(input),
    trackedInputBytes: bytes(tracked()),
    trackedOutput: compiled,
    trackedOutputBytes: bytes(compiled),
    createdAt: '2026-09-02T00:00:00.000Z',
  });
  assert.equal(receipt.schema, 'team-qa/escaped-defect-compile-receipt/v1');
  assert.equal(receipt.source_count, 1);
  assert.equal(receipt.case_count, 4);
  assert.equal(receipt.edge_total, 4);
  assert.equal(receipt.edge_covered, 4);
  assert.equal(receipt.trace_pct, 100);
  assert.deepEqual(verifyEscapedDefectCompileReceipt(receipt, {
    registryBytes: bytes(input), trackedOutputBytes: bytes(compiled),
  }), receipt);
});

test('C3 mutation: affected layers without a tracked regression binding fail closed', () => {
  const input = registry();
  input.defects[0].regression_tests.pop();
  assert.throws(() => compileEscapedDefects(input, tracked()), /DEFECT_LAYER_TRACE:INC-SAMPLESHOP-PARTA/);
});

test('C3 mutation: source to case trace cannot be detached before receipt creation', () => {
  const input = registry();
  const compiled = compileEscapedDefects(input, tracked());
  compiled.cases[0].sourceRefs = ['SRC-FOREIGN'];
  assert.throws(() => createEscapedDefectCompileReceipt({
    registry: input,
    registryBytes: bytes(input),
    trackedInputBytes: bytes(tracked()),
    trackedOutput: compiled,
    trackedOutputBytes: bytes(compiled),
  }), /COMPILE_CASE_SOURCE_REF:RC-QA-CODE/);
});

test('C3 mutation: receipt cannot verify against changed tracked-plan bytes', () => {
  const input = registry();
  const compiled = compileEscapedDefects(input, tracked());
  const receipt = createEscapedDefectCompileReceipt({
    registry: input, registryBytes: bytes(input), trackedInputBytes: bytes(tracked()),
    trackedOutput: compiled, trackedOutputBytes: bytes(compiled),
  });
  assert.throws(() => verifyEscapedDefectCompileReceipt(receipt, {
    registryBytes: bytes(input), trackedOutputBytes: Buffer.concat([bytes(compiled), Buffer.from('tampered\n')]),
  }), /COMPILE_RECEIPT_OUTPUT_HASH/);
});

test('C3 safety: duplicate case IDs across incidents are rejected', () => {
  const input = registry();
  const second = structuredClone(input.defects[0]);
  second.incident_id = 'INC-SECOND';
  second.source.ref = 'second';
  input.defects.push(second);
  assert.throws(() => compileEscapedDefects(input, tracked()), /COMPILE_CASE_DUPLICATE:RC-QA-CODE/);
});

test('C3 CLI writes tracked plan and receipt once, then refuses overwrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-qa-release-c-cli-'));
  roots.push(root);
  const registryFile = path.join(root, 'registry.json');
  const trackedFile = path.join(root, 'tracked.json');
  const out = path.join(root, 'tracked.compiled.json');
  const receipt = path.join(root, 'compile.receipt.json');
  fs.writeFileSync(registryFile, bytes(registry()));
  fs.writeFileSync(trackedFile, bytes(tracked()));
  let result = spawnSync(process.execPath, [CLI, 'design', 'compile-defects', '--registry', registryFile, '--tracked', trackedFile, '--out', out, '--receipt', receipt], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /trace_pct=100/);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).cases.length, 4);
  result = spawnSync(process.execPath, [CLI, 'design', 'compile-defects', '--registry', registryFile, '--tracked', trackedFile, '--out', out, '--receipt', receipt], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /ESCAPED_DEFECT_OUTPUT_EXISTS/);
});

