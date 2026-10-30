import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { childVerdictIssue } from '../scripts/lib/child-verdict.mjs';
import { createTeamQaReceipt } from '../scripts/lib/release-truth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'teamqa.mjs');
const REPORT_FIXTURE = path.join(ROOT, 'test', 'acceptance', 'fixtures', 'report', 'base');
const CONTRACT_SHA = JSON.parse(readFileSync(path.join(ROOT, 'contracts/release-truth-contract/v2/CONTRACT.json'), 'utf8')).contract_sha256;
const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function seal(value) {
  const clean = structuredClone(value);
  delete clean.integrity;
  return { ...clean, integrity: sha(JSON.stringify(stable(clean))) };
}

function write(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function run(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
}

function markedReport(file) {
  const text = readFileSync(file, 'utf8');
  return JSON.parse(text.slice(
    text.indexOf('TEAMQA_REPORT_START') + 'TEAMQA_REPORT_START'.length,
    text.indexOf('TEAMQA_REPORT_END'),
  ).trim());
}

function reportWorkspace(name, tier = null) {
  const parent = mkdtempSync(path.join(os.tmpdir(), `team-qa-release-a-${name}-`));
  roots.push(parent);
  const cwd = path.join(parent, 'workspace');
  cpSync(REPORT_FIXTURE, cwd, { recursive: true });
  const runId = 'tq-report';
  const runDir = path.join(cwd, 'runs', runId);
  const planFile = path.join(runDir, 'test-plan.md');
  if (tier) {
    const text = readFileSync(planFile, 'utf8');
    const start = 'TEAMQA_PLAN_START';
    const end = 'TEAMQA_PLAN_END';
    const value = JSON.parse(text.slice(text.indexOf(start) + start.length, text.indexOf(end)).trim());
    value.tiers = Object.fromEntries(Object.keys(value.tiers).map((id) => [id, tier]));
    write(planFile, `# Release A tier fixture\n\n${start}\n${JSON.stringify(value, null, 2)}\n${end}\n`);
  }
  let result = run(cwd, [
    'gate', 'approve', '--run', runId, '--plan', planFile,
    '--signed-by', 'owner', '--ts', '2026-09-01T00:00:00.000Z',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(cwd, [
    'rtm', 'fill', '--rtm', path.join(runDir, 'rtm.md'),
    '--board', path.join(runDir, 'board.jsonl'), '--out', path.join(runDir, 'rtm.md'),
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { cwd, runDir, runId, planFile };
}

test('M01/M02: an absent tier is N/A and the grounded checker ledger still completes', () => {
  for (const [tier, absentMetric] of [['FULL', 'coverage_low_pct'], ['SMOKE', 'coverage_high_pct']]) {
    const f = reportWorkspace(`tier-${tier.toLowerCase()}`, tier);
    const result = run(f.cwd, ['report', 'build', '--run', f.runId]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = markedReport(path.join(f.runDir, 'summary-report.md'));
    assert.equal(report.metrics[absentMetric], 'N/A');
    assert.ok(report.red_checkers.length >= 12);
    assert.equal(report.red_checkers.find((entry) => entry.id === 'child-verdict')?.checked, 4);
  }
});

test('M04: a release-bound run without roles.json stops UNGRADED:UNGOVERNED', () => {
  const f = reportWorkspace('ungoverned');
  let result = run(f.cwd, ['report', 'build', '--run', f.runId]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const bindingFile = path.join(f.runDir, 'binding.json');
  write(bindingFile, {
    run_uuid: randomUUID(),
    task_base: 'a'.repeat(40),
    source_revision: 'release-a-fixture',
    exact_final_sha: 'b'.repeat(40),
    contract_sha256: CONTRACT_SHA,
    requirements_hash: 'c'.repeat(64),
  });
  result = run(f.cwd, [
    'receipt', 'create', '--run', f.runId, '--binding', bindingFile,
    '--out', path.join(f.runDir, 'team-qa.receipt.json'),
  ]);
  assert.equal(result.status, 5, result.stderr || result.stdout);
  assert.match(result.stderr + result.stdout, /verdict=ungraded.*UNGOVERNED|UNGOVERNED.*verdict=ungraded/);
});

test('M03: Team QA receipt uses the computed machine decision, never Markdown GO prose', () => {
  const runDir = mkdtempSync(path.join(os.tmpdir(), 'team-qa-release-a-computed-go-'));
  roots.push(runDir);
  write(path.join(runDir, 'test-plan.md'), '# plan\n');
  write(path.join(runDir, 'tracked-plan.json'), { cases: [{ id: 'TC-1', req_id: 'REQ-1' }] });
  write(path.join(runDir, 'board.jsonl'), `${JSON.stringify({ case_id: 'TC-1', verdict: 'ungraded' })}\n`);
  // The RTM "Requirement" column header is a Vietnamese format token parsed by Team QA, written here as escapes.
  write(path.join(runDir, 'rtm.md'), '| Y\u00eau c\u1ea7u | Tier | Case | Priority | Verdict |\n|---|---|---|---|---|\n| REQ-1 | FULL | TC-1 | P1 | UNGRADED |\n');
  write(path.join(runDir, 'summary-report.md'), '# Summary report\n\nDecision: **GO**\n');
  const receipt = createTeamQaReceipt({
    runDir,
    runUuid: randomUUID(),
    binding: {
      task_base: 'a'.repeat(40), source_revision: 'release-a-fixture',
      exact_final_sha: 'b'.repeat(40), contract_sha256: CONTRACT_SHA,
      requirements_hash: 'c'.repeat(64),
    },
    computedDecision: 'NO_GO',
  });
  assert.equal(receipt.release_verdict, 'NO-GO');
});

function canonicalGuiReceipt({ runUuid, caseId }) {
  return seal({
    schema: 'qa-gui/receipt/v2',
    contract_sha256: CONTRACT_SHA,
    run_uuid: runUuid,
    task_base: 'a'.repeat(40),
    source_revision: 'release-a-fixture',
    exact_final_sha: 'b'.repeat(40),
    requirements_hash: 'c'.repeat(64),
    verification_lane: 'gui',
    execution_status: 'completed',
    semantic_verdict: 'PASS',
    atomic_coverage: [{
      requirement_id: 'REQ-1', assertion_id: 'ASSERT-1', case_id: caseId,
      evidence_ref: 'screen.png', evidence_sha256: 'd'.repeat(64),
      evidence_type: 'gui-screenshot', result: 'PASS',
    }],
    evidence_manifest: [],
    created_at: '2026-09-01T00:00:00.000Z',
  });
}

function childContext(name, artifactValue, caseId = 'TC-1') {
  const root = mkdtempSync(path.join(os.tmpdir(), `team-qa-release-a-child-${name}-`));
  roots.push(root);
  const board = path.join(root, 'board.jsonl');
  const artifact = path.join(root, 'child.json');
  write(board, '');
  write(artifact, artifactValue);
  const raw = readFileSync(artifact);
  const runUuid = artifactValue.run_uuid ?? randomUUID();
  return {
    board,
    lock: { governed: true, declared: { project_id: 'fixture', preview_url: 'https://fixture.invalid', version: 'r1' } },
    binding: {
      task_base: 'a'.repeat(40), source_revision: 'release-a-fixture',
      exact_final_sha: 'b'.repeat(40), contract_sha256: CONTRACT_SHA,
      requirements_hash: 'c'.repeat(64),
    },
    record: {
      case_id: caseId, verdict: 'pass', source: 'qa-gui', run_id: runUuid,
      evidence: ['child.json'],
      child_verdict: { skill: 'qa-gui', verdict: 'pass', artifact: 'child.json', sha256: sha(raw) },
    },
  };
}

test('M05: aggregate qa-gui/verdict/v1 is rejected instead of passing a prefix check', () => {
  const runUuid = randomUUID();
  const f = childContext('aggregate-v1', {
    schema: 'qa-gui/verdict/v1', verdict: 'pass', run_uuid: runUuid,
    cases: { pass: 1, fail: 0, ungraded: 0 },
  });
  assert.equal(childVerdictIssue(f.record, f.board, f.lock, f.binding), 'CHILD_RECEIPT_SCHEMA');
});

test('M06: canonical child receipt must contain the exact board case membership', () => {
  const runUuid = randomUUID();
  let f = childContext('case-positive', canonicalGuiReceipt({ runUuid, caseId: 'TC-1' }));
  assert.equal(childVerdictIssue(f.record, f.board, f.lock, f.binding), null);

  f = childContext('case-foreign', canonicalGuiReceipt({ runUuid, caseId: 'TC-OTHER' }));
  assert.equal(childVerdictIssue(f.record, f.board, f.lock, f.binding), 'CHILD_RECEIPT_CASE_MISSING');
});

test('M16: receipt schema major mismatch is red before child execution', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'team-qa-release-a-schema-major-'));
  roots.push(root);
  const roles = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/data/roles-check.fixture.json'), 'utf8'));
  roles.skills['qa-gui'].verdict_schema = path.join(ROOT, 'fixtures/data/skill-schemas/qa-gui.json');
  roles.skills['qa-code'].verdict_schema = path.join(ROOT, 'fixtures/data/skill-schemas/qa-code.json');
  roles.skills['qa-gui'].receipt_schema = path.join(ROOT, 'contracts/release-truth-contract/v2/qa-gui.receipt.schema.json');
  roles.skills['qa-gui'].supported_receipt_major = 1;
  roles.skills['qa-code'].receipt_schema = path.join(ROOT, 'contracts/release-truth-contract/v2/qa-code.receipt.schema.json');
  roles.skills['qa-code'].supported_receipt_major = 2;
  const rolesFile = path.join(root, 'roles.json');
  write(rolesFile, roles);
  const result = run(root, ['smoke'], { TEAMQA_ROLES: rolesFile });
  assert.equal(result.status, 4, result.stderr || result.stdout);
  assert.match(result.stderr + result.stdout, /SCHEMA_MAJOR_MISMATCH.*qa-gui.*receipt.*expected=1.*actual=2/);
});
