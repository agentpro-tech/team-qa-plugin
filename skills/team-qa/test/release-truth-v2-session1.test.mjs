#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts/teamqa.mjs');
const incident = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/data/incident-replay-session1.json'), 'utf8'));
const contractSha = '77433f4c204e7f32848976b585cfb901152f97b775726467a0a5128eb3ec362c';
const run = (args, cwd, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function tracked() {
  return { cases: incident.requirement_ids.map((reqId, index) => ({
    id: `TC-${reqId}`, req_id: reqId, lane: index % 2 === 0 ? 'code' : 'gui', steps: ['Run the scrubbed deterministic check'], expected: 'Expected result',
    data: {}, priority: index < 3 ? 'P0' : 'P1', kind: 'behavioral', taxonomy: ['functional'], states: ['ideal'], viewports: ['desktop'],
  })) };
}

function plan(runId) {
  const tiers = Object.fromEntries(incident.requirement_ids.map((id) => [id, 'FULL']));
  const value = { run_id: runId, app: 'scrubbed-incident', plan_version: 1, lanes: [{ id: 'code', scope: incident.requirement_ids.filter((_id, index) => index % 2 === 0), parallel_ok: false, vi_sao: '' }, { id: 'gui', scope: incident.requirement_ids.filter((_id, index) => index % 2 === 1), parallel_ok: false, vi_sao: '' }], tiers, exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 70 } };
  return `# Test plan\n\nTEAMQA_PLAN_START\n${JSON.stringify(value, null, 2)}\nTEAMQA_PLAN_END\n`;
}

function workspace(runId = 'incident-session1') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'team-qa-session1-')); const runDir = path.join(cwd, 'runs', runId);
  const planText = plan(runId); write(path.join(runDir, 'test-plan.md'), planText); write(path.join(runDir, 'tracked-plan.json'), tracked());
  // The RTM "Requirement" column header is a Vietnamese format token parsed by Team QA, written here as escapes.
  const rtm = ['| Y\u00eau c\u1ea7u | Tier | Case | Priority | Verdict |', '|---|---|---|---|---|', ...incident.requirement_ids.map((id, index) => `| ${id} | FULL | TC-${id} | ${index < 3 ? 'P0' : 'P1'} |  |`)].join('\n');
  write(path.join(runDir, 'rtm.md'), `${rtm}\n`); write(path.join(runDir, 'board.jsonl'), '');
  write(path.join(cwd, 'control/approvals', runId, 'plan-v1.json'), { signed_by: 'owner', ts: '2026-08-24T00:00:00.000Z', plan_sha256: sha(planText) });
  write(path.join(runDir, 'binding.json'), { task_base: 'a'.repeat(40), source_revision: 'fixture-revision', exact_final_sha: 'b'.repeat(40), contract_sha256: contractSha, requirements_hash: 'c'.repeat(64) });
  return { cwd, runDir, runId };
}

test('I4 report verification rejects all 29 blank RTM verdicts', () => {
  const data = workspace('i4'); const result = run(['report', 'verify', '--run', data.runId], data.cwd);
  assert.equal(result.status, 2); assert.match(result.stderr, /RTM_VERDICT_EMPTY count=29/);
});

test('I16 receipt seals plan to summary and one-byte tamper is rejected', () => {
  const data = workspace('i16'); const binding = { task_base: 'a'.repeat(40), source_revision: 'fixture-revision', exact_final_sha: 'b'.repeat(40), contract_sha256: contractSha, requirements_hash: 'c'.repeat(64) };
  write(path.join(data.runDir, 'binding.json'), binding);
  write(path.join(data.runDir, 'board.jsonl'), '');
  write(path.join(data.runDir, 'summary-report.md'), 'summary fixture\n');
  let result = run(['receipt', 'create', '--run', data.runId, '--binding', path.join(data.runDir, 'binding.json'), '--out', path.join(data.runDir, 'team-qa.receipt.json')], data.cwd);
  assert.equal(result.status, 0, result.stderr);
  result = run(['receipt', 'verify', '--file', path.join(data.runDir, 'team-qa.receipt.json')], data.cwd); assert.equal(result.status, 0, result.stderr);
  fs.appendFileSync(path.join(data.runDir, 'rtm.md'), 'tamper\n');
  result = run(['receipt', 'verify', '--file', path.join(data.runDir, 'team-qa.receipt.json')], data.cwd); assert.notEqual(result.status, 0); assert.match(result.stderr, /RECEIPT_ARTIFACT_HASH:rtm/);
});

test('I17 board seed writes 29 PENDING rows, first planned verdict succeeds, and unknown ID is rejected', () => {
  const data = workspace('i17'); const board = path.join(data.runDir, 'board.jsonl');
  let result = run(['board', 'seed', '--tracked', path.join(data.runDir, 'tracked-plan.json'), '--file', board, '--run', data.runId], data.cwd); assert.equal(result.status, 0, result.stderr);
  const rows = fs.readFileSync(board, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(rows.length, 29); assert.ok(rows.every((row) => row.verdict === 'pending'));
  const evidence = path.join(data.runDir, 'evidence/first.txt'); write(evidence, 'first verdict proof\n');
  const record = { case_id: rows[0].case_id, lane: rows[0].lane, verdict: 'pass', evidence: ['evidence/first.txt'], source: 'qa-code', run_id: data.runId, ts: '2026-08-24T00:01:00.000Z', function_verdict: 'pass', ui_visual_verdict: 'pass', attempt: 1, started_at: '2026-08-24T00:00:00.000Z', ended_at: '2026-08-24T00:00:01.000Z', timeout_ms: 2000, task_base: rows[0].task_base, source_revision: rows[0].source_revision, verification_lane: rows[0].verification_lane, contract_sha256: rows[0].contract_sha256, exact_final_sha: rows[0].exact_final_sha, child_verdict: { skill: 'qa-code', verdict: 'pass', artifact: 'evidence/first.txt', sha256: sha('first verdict proof\n') } };
  write(path.join(data.runDir, 'record.json'), record); result = run(['board', 'add', '--file', board, '--record', path.join(data.runDir, 'record.json')], data.cwd); assert.equal(result.status, 0, result.stderr);
  record.case_id = 'TC-P3-CONFIG'; write(path.join(data.runDir, 'unknown.json'), record); result = run(['board', 'add', '--file', board, '--record', path.join(data.runDir, 'unknown.json')], data.cwd); assert.equal(result.status, 2); assert.match(result.stderr, /BOARD_CASE_UNKNOWN/);
});

test('TQa completeness gate names the seven incident IDs missing from execution', () => {
  const data = workspace('tqa'); const board = path.join(data.runDir, 'board.jsonl'); run(['board', 'seed', '--tracked', path.join(data.runDir, 'tracked-plan.json'), '--file', board, '--run', data.runId], data.cwd);
  const rows = fs.readFileSync(board, 'utf8').trim().split('\n').map(JSON.parse).filter((row) => !incident.missing_ids.includes(row.case_id.replace(/^TC-/, ''))); write(board, `${rows.map(JSON.stringify).join('\n')}\n`);
  const result = run(['board', 'verify', '--file', board, '--tracked', path.join(data.runDir, 'tracked-plan.json')], data.cwd); assert.notEqual(result.status, 0); for (const id of incident.missing_ids) assert.match(result.stderr, new RegExp(id));
});

test('TQd validator loads schema verdict enum including pending and blocked', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas/board.json'), 'utf8')); const verdicts = schema.properties.verdict.enum;
  assert.ok(verdicts.includes('pending')); assert.ok(verdicts.includes('blocked'));
  for (const field of ['task_base', 'source_revision', 'verification_lane', 'contract_sha256', 'exact_final_sha']) assert.ok(schema.properties[field]);
});

test('TQe missing lane is rejected and code PASS cannot cover a GUI requirement', () => {
  const data = workspace('tqe'); const graph = { schema: 'requirements.freeze/v2', contract_sha256: contractSha, repo: 'fixture', task_base: 'a'.repeat(40), source_revision: 'fixture-revision', gate_policy: { coverage_threshold: 100, required_layers: ['code', 'gui', 'team-qa'] }, requirements: [{ id: 'REQ-CODE', expectation: 'code', requirement_owner: 'ExampleBrand', verification_lane: 'code', risk_dimensions: [], acceptance_ids: ['A-CODE'], evidence_contract: { allowed_types: ['test-log'], atomic: true, multi_evidence: false } }, { id: 'REQ-GUI', expectation: 'gui', requirement_owner: 'ExampleBrand', risk_dimensions: [], acceptance_ids: ['A-GUI'], evidence_contract: { allowed_types: ['gui-screenshot'], atomic: true, multi_evidence: false } }] };
  write(path.join(data.runDir, 'requirements.json'), graph); const result = run(['coverage', 'verify', '--requirements', path.join(data.runDir, 'requirements.json'), '--board', path.join(data.runDir, 'board.jsonl')], data.cwd);
  assert.equal(result.status, 2); assert.match(result.stderr, /REQUIREMENT_LANE_MISSING:REQ-GUI/);
});

test('TQe rejects undeclared two-lane claims and never counts a waived requirement PASS', () => {
  const data = workspace('tqe-multi');
  const cases = [
    { id: 'C-CODE', req_id: 'REQ-MULTI', lane: 'code', steps: ['code'], expected: 'pass', data: {}, priority: 'P1', kind: 'behavioral', taxonomy: ['functional'], states: ['ideal'], viewports: ['desktop'] },
    { id: 'C-GUI', req_id: 'REQ-MULTI', lane: 'gui', steps: ['gui'], expected: 'pass', data: {}, priority: 'P1', kind: 'behavioral', taxonomy: ['functional'], states: ['ideal'], viewports: ['desktop'] },
  ];
  write(path.join(data.runDir, 'tracked-plan.json'), { cases });
  const record = (item) => ({ case_id: item.id, lane: item.lane, verdict: 'pass', evidence: ['proof.txt'], source: item.lane === 'code' ? 'qa-code' : 'qa-gui', run_id: data.runId, ts: '2026-08-24T00:00:02.000Z', function_verdict: 'pass', ui_visual_verdict: 'pass', attempt: 1, started_at: '2026-08-24T00:00:00.000Z', ended_at: '2026-08-24T00:00:01.000Z', timeout_ms: 2000 });
  write(path.join(data.runDir, 'proof.txt'), 'proof\n'); write(path.join(data.runDir, 'board.jsonl'), `${cases.map((item) => JSON.stringify(record(item))).join('\n')}\n`);
  const requirement = { id: 'REQ-MULTI', expectation: 'multi', requirement_owner: 'ExampleBrand', verification_lane: 'multi', risk_dimensions: [], acceptance_ids: ['A-MULTI'], evidence_contract: { allowed_types: ['test-log'], atomic: true, multi_evidence: false } };
  const graph = { schema: 'requirements.freeze/v2', contract_sha256: contractSha, repo: 'fixture', task_base: 'a'.repeat(40), source_revision: 'fixture-revision', gate_policy: { coverage_threshold: 100, required_layers: ['code', 'gui', 'team-qa'] }, requirements: [requirement] };
  write(path.join(data.runDir, 'requirements.json'), graph);
  let result = run(['coverage', 'verify', '--requirements', path.join(data.runDir, 'requirements.json'), '--board', path.join(data.runDir, 'board.jsonl')], data.cwd);
  assert.equal(result.status, 2); assert.match(result.stderr, /MULTI_EVIDENCE_UNDECLARED/);
  graph.requirements[0] = { ...requirement, verification_lane: 'code', waiver: { type: 'external-owner', reason: 'Owned outside this run', approver: 'Owner' } };
  write(path.join(data.runDir, 'requirements.json'), graph); write(path.join(data.runDir, 'board.jsonl'), `${JSON.stringify(record(cases[0]))}\n`);
  result = run(['coverage', 'verify', '--requirements', path.join(data.runDir, 'requirements.json'), '--board', path.join(data.runDir, 'board.jsonl')], data.cwd);
  assert.equal(result.status, 2); assert.match(result.stderr, /WAIVER_CANNOT_PASS/);
});
