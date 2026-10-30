import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  SOURCE_TRACEABILITY_VERSION,
  migrateTrackedSourceTraceability,
  sourceTraceabilityRows,
} from '../scripts/lib/source-traceability.mjs';
import { trackedErrors } from '../scripts/lib/validators.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'scripts/teamqa.mjs');
const qaBoardStub = join(root, 'test/qa-board-teamwork/support/qa-board-tool-stub.mjs');
const docColabStub = join(root, 'test/qa-board-teamwork/support/doc-colab-stub.py');
const notionStub = join(root, 'test/qa-board-teamwork/support/notion-board-stub.mjs');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/source-traceability/tracked-v2.valid.json', import.meta.url), 'utf8'));
const mutation = JSON.parse(readFileSync(new URL('./fixtures/source-traceability/unknown-ref.json', import.meta.url), 'utf8'));
const mapping = JSON.parse(readFileSync(new URL('./fixtures/source-traceability/migration-map.valid.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);

function run(cwd, args, env = {}, cliPath = cli) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function planText(runId) {
  return `# Source traceability plan

TEAMQA_PLAN_START
{
  "run_id": "${runId}",
  "app": "source-traceability-fixture",
  "plan_version": 1,
  "lanes": [
    {"id":"lane-high","scope":["REQ-HIGH"],"parallel_ok":false,"vi_sao":""},
    {"id":"lane-low","scope":["REQ-LOW"],"parallel_ok":false,"vi_sao":""}
  ],
  "tiers": {"REQ-HIGH":"FULL","REQ-LOW":"SMOKE"},
  "exit_criteria": {"p0_max":0,"p1_max":0,"p1_waivers":[],"coverage_high_pct":100,"coverage_low_pct":100}
}
TEAMQA_PLAN_END
`;
}

function parseReport(path) {
  const text = readFileSync(path, 'utf8');
  const match = text.match(/TEAMQA_REPORT_START\s*([\s\S]*?)\s*TEAMQA_REPORT_END/);
  assert.ok(match, 'report marker missing');
  return { text, value: JSON.parse(match[1]) };
}

test('tracked plan v2 validates many-to-many refs and explicit QA-derived guardrails', () => {
  assert.deepEqual(trackedErrors(clone(fixture), { lock: null }), []);
  assert.equal(SOURCE_TRACEABILITY_VERSION, 'team-qa/source-traceability/v1');
  const rows = sourceTraceabilityRows(fixture, []);
  assert.deepEqual(rows.map(({ sourceRef, caseId }) => [sourceRef, caseId]), [
    ['SRC-JIRA-42', 'TC-01'],
    ['SRC-JIRA-42', 'TC-02'],
    ['SRC-SPEC-7', 'TC-01'],
    ['SRC-QA-EMPTY', 'TC-03'],
  ]);
});

test('missing, duplicate, and unknown refs fail closed without title or ID inference', () => {
  const missing = clone(fixture);
  delete missing.cases[0].sourceRefs;
  assert.match(trackedErrors(missing, { lock: null }).join('\n'), /CASE_FIELD TC-01 sourceRefs/);

  const duplicate = clone(fixture);
  duplicate.cases[0].sourceRefs.push('SRC-JIRA-42');
  assert.match(trackedErrors(duplicate, { lock: null }).join('\n'), /CASE_SOURCE_REF_DUPLICATE TC-01 SRC-JIRA-42/);

  const unknown = clone(fixture);
  unknown.cases[0].sourceRefs[1] = mutation.value;
  assert.match(trackedErrors(unknown, { lock: null }).join('\n'), /CASE_SOURCE_REF_UNKNOWN TC-01 SRC-NOT-REGISTERED/);

  const noReason = clone(fixture);
  delete noReason.sourceItems[2].qaDerivedReason;
  assert.match(trackedErrors(noReason, { lock: null }).join('\n'), /SOURCE_QA_DERIVED_REASON sourceItems\[2\]/);
});

test('legacy v1 remains valid and migration requires an explicit title and refs for every case', () => {
  const legacy = clone(fixture);
  delete legacy.schemaVersion;
  delete legacy.sourceItems;
  legacy.cases.forEach((entry) => {
    delete entry.title;
    delete entry.sourceRefs;
  });
  assert.deepEqual(trackedErrors(legacy, { lock: null }), []);

  const incomplete = clone(mapping);
  incomplete.caseMappings.pop();
  assert.match(migrateTrackedSourceTraceability(legacy, incomplete).errors.join('\n'), /CASE_SOURCE_MAPPING_REQUIRED TC-03/);

  const noTitle = clone(mapping);
  delete noTitle.caseMappings[0].title;
  assert.match(migrateTrackedSourceTraceability(legacy, noTitle).errors.join('\n'), /SOURCE_MAPPING_FIELD caseMappings\[0\] title/);

  const migrated = migrateTrackedSourceTraceability(legacy, mapping);
  assert.deepEqual(migrated.errors, []);
  assert.equal(migrated.value.schemaVersion, 2);
  assert.deepEqual(migrated.value.cases.map(({ id, title, sourceRefs }) => ({ id, title, sourceRefs })), [
    { id: 'TC-01', title: 'Save preserves the selected owner', sourceRefs: ['SRC-JIRA-42', 'SRC-SPEC-7'] },
    { id: 'TC-02', title: 'Save is stable after refresh', sourceRefs: ['SRC-JIRA-42'] },
    { id: 'TC-03', title: 'Empty state remains actionable', sourceRefs: ['SRC-QA-EMPTY'] },
  ]);

  const cwd = mkdtempSync(join(tmpdir(), 'teamqa-source-migration-'));
  const legacyPath = join(cwd, 'tracked-v1.json');
  const mappingPath = join(cwd, 'source-mapping.json');
  const output = join(cwd, 'tracked-v2.json');
  writeFileSync(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);
  writeFileSync(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`);
  const before = readFileSync(legacyPath, 'utf8');
  const migratedCli = run(cwd, [
    'design', 'migrate-sources', '--file', legacyPath, '--mapping', mappingPath, '--out', output,
  ]);
  assert.equal(migratedCli.status, 0, migratedCli.stderr || migratedCli.stdout);
  assert.equal(readFileSync(legacyPath, 'utf8'), before);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), migrated.value);
  const overwrite = run(cwd, [
    'design', 'migrate-sources', '--file', legacyPath, '--mapping', mappingPath, '--out', output,
  ]);
  assert.equal(overwrite.status, 2, overwrite.stderr || overwrite.stdout);
  assert.match(overwrite.stderr, /SOURCE_MIGRATION_OUTPUT_EXISTS/);
});

test('CLI preserves refs through board, deterministic RTM, and report handoff', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'teamqa-source-traceability-'));
  const runId = 'source-traceability';
  const runDir = join(cwd, 'runs', runId);
  const plan = join(runDir, 'test-plan.md');
  const tracked = join(runDir, 'tracked-plan.json');
  const board = join(runDir, 'board.jsonl');
  const rtm = join(runDir, 'rtm.md');
  const report = join(runDir, 'summary-report.md');
  mkdirSync(join(runDir, 'evidence'), { recursive: true });
  writeFileSync(plan, planText(runId));
  writeFileSync(tracked, `${JSON.stringify(fixture, null, 2)}\n`);

  const approved = run(cwd, ['gate', 'approve', '--run', runId, '--plan', plan, '--signed-by', 'owner', '--ts', '2026-08-28T12:00:00.000Z']);
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);
  assert.equal(run(cwd, ['rtm', 'build', '--plan', plan, '--tracked', tracked, '--out', rtm]).status, 0);
  assert.equal(run(cwd, ['board', 'seed', '--run', runId, '--tracked', tracked, '--file', board]).status, 0);

  let records = readFileSync(board, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(({ case_id, sourceRefs }) => [case_id, sourceRefs]), [
    ['TC-01', ['SRC-JIRA-42', 'SRC-SPEC-7']],
    ['TC-02', ['SRC-JIRA-42']],
    ['TC-03', ['SRC-QA-EMPTY']],
  ]);
  records = records.map((record, index) => {
    const evidence = `evidence/${record.case_id}.txt`;
    writeFileSync(join(runDir, evidence), `proof-${record.case_id}\n`);
    return {
      ...record,
      verdict: 'pass',
      evidence: [evidence],
      source: 'script',
      reason: `SOURCE_FIXTURE_PASS_${index + 1}`,
      function_verdict: 'pass',
      ui_visual_verdict: 'pass',
    };
  });
  writeFileSync(board, `${records.map(JSON.stringify).join('\n')}\n`);
  const verified = run(cwd, ['board', 'verify', '--file', board, '--tracked', tracked]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);

  const filled = run(cwd, ['rtm', 'fill', '--rtm', rtm, '--board', board, '--out', rtm]);
  assert.equal(filled.status, 0, filled.stderr || filled.stdout);
  const rtmText = readFileSync(rtm, 'utf8');
  assert.match(rtmText, /\| Source \| Source system \| Source key \| Source title \| Case \| Requirement \| Tier \| Priority \| Verdict \| Evidence \|/);
  const edgeOrder = [...rtmText.matchAll(/^\| (SRC-[^| ]+) \|[^\n]*?\| (TC-[^| ]+) \|/gm)].map((match) => [match[1], match[2]]);
  assert.deepEqual(edgeOrder, [
    ['SRC-JIRA-42', 'TC-01'],
    ['SRC-JIRA-42', 'TC-02'],
    ['SRC-SPEC-7', 'TC-01'],
    ['SRC-QA-EMPTY', 'TC-03'],
  ]);
  assert.match(rtmText, /TC-01[^\n]*\| PASS \| evidence\/TC-01\.txt \|/);

  const built = run(cwd, ['report', 'build', '--run', runId]);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const parsed = parseReport(report);
  assert.equal(parsed.value.reportSchemaVersion, 2);
  assert.equal(parsed.value.traceabilityVersion, SOURCE_TRACEABILITY_VERSION);
  assert.deepEqual(parsed.value.sourceTraceability.rows.map(({ sourceRef, caseId }) => [sourceRef, caseId]), edgeOrder);
  assert.match(parsed.text, /## Source traceability/);
  assert.doesNotMatch(parsed.text, /Issue Group|issueGroup/);
  const reportVerified = run(cwd, ['report', 'verify', '--run', runId]);
  assert.equal(reportVerified.status, 0, reportVerified.stderr || reportVerified.stdout);

  const cleanRtm = readFileSync(rtm, 'utf8');
  writeFileSync(rtm, cleanRtm.replace('evidence/TC-01.txt', 'evidence/TAMPERED.txt'));
  const evidenceTamper = run(cwd, ['report', 'verify', '--run', runId]);
  assert.equal(evidenceTamper.status, 2, evidenceTamper.stderr || evidenceTamper.stdout);
  assert.match(evidenceTamper.stderr, /RTM_EVIDENCE_MISMATCH SRC-JIRA-42:TC-01/);
  writeFileSync(rtm, cleanRtm);

  const cleanReport = readFileSync(report, 'utf8');
  writeFileSync(report, cleanReport.replace('"sourceRef": "SRC-JIRA-42"', '"sourceRef": "SRC-NOT-REGISTERED"'));
  const reportTamper = run(cwd, ['report', 'verify', '--run', runId]);
  assert.equal(reportTamper.status, 2, reportTamper.stderr || reportTamper.stdout);
  assert.match(reportTamper.stderr, /REPORT_SOURCE_REF_UNKNOWN/);
  writeFileSync(report, cleanReport);

  const mutated = clone(records);
  mutated[0].sourceRefs = ['SRC-JIRA-42'];
  writeFileSync(board, `${mutated.map(JSON.stringify).join('\n')}\n`);
  const rejected = run(cwd, ['board', 'verify', '--file', board, '--tracked', tracked]);
  assert.equal(rejected.status, 2, rejected.stderr || rejected.stdout);
  assert.match(rejected.stderr, /BOARD_SOURCE_REFS_MISMATCH TC-01/);
});

test('qa-gui canonical and optional Notion handoffs receive exact tracked-plan refs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'teamqa-source-board-handoff-'));
  // This test owns reference handoff; the review gate has separate authenticity tests.
  const candidate = join(cwd, 'candidate');
  cpSync(join(root, 'scripts'), join(candidate, 'scripts'), { recursive: true });
  cpSync(join(root, 'schemas'), join(candidate, 'schemas'), { recursive: true });
  cpSync(join(root, 'test/qa-board-teamwork/support/board-quality-fixture.mjs'), join(candidate, 'scripts/lib/board-quality.mjs'));
  const candidateCli = join(candidate, 'scripts/teamqa.mjs');
  const tracked = join(cwd, 'tracked-plan.json');
  const canonical = join(cwd, 'qa-board.json');
  const callLog = join(cwd, 'calls.jsonl');
  const notionMap = join(cwd, 'notion-source-pages.json');
  const snapshot = join(cwd, 'notion-snapshot.json');
  writeFileSync(tracked, `${JSON.stringify(fixture, null, 2)}\n`);
  writeFileSync(notionMap, `${JSON.stringify({ 'SRC-JIRA-42': 'notion-page-app-42' }, null, 2)}\n`);
  const env = {
    TEAMQA_QA_GUI_BOARD_TOOL: qaBoardStub,
    TEAMQA_DOC_COLAB_SCRIPT: docColabStub,
    TEAMQA_NOTION_BOARD_ADAPTER: notionStub,
    TEAMQA_TEST_CALL_LOG: callLog,
  };
  const initialized = run(cwd, [
    'board', 'init', '--run', 'source-handoff', '--title', 'Source handoff', '--tracked', tracked, '--out', canonical,
  ], env, candidateCli);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const data = JSON.parse(readFileSync(canonical, 'utf8'));
  assert.deepEqual(data.sourceItems, fixture.sourceItems);
  assert.deepEqual(data.cases.map(({ id, sourceRefs }) => ({ id, sourceRefs })), fixture.cases.map(({ id, sourceRefs }) => ({ id, sourceRefs })));

  const qualityReview = join(cwd, 'quality-review.fixture.json');
  writeFileSync(qualityReview, JSON.stringify({ fixture: 'board-quality-cli-contract-test',
    board_sha256: createHash('sha256').update(readFileSync(canonical)).digest('hex') }));
  const pushed = run(cwd, [
    'board', 'sync', '--file', canonical, '--snapshot', snapshot, '--actor', 'owner', '--renderer', 'notion',
    '--mode', 'push', '--notion-source-map', notionMap, '--quality-review', qualityReview,
  ], env, candidateCli);
  assert.equal(pushed.status, 0, pushed.stderr || pushed.stdout);
  const calls = readFileSync(callLog, 'utf8').trim().split('\n').map(JSON.parse).filter((entry) => entry.tool === 'qa-gui');
  const exports = calls.find((entry) => entry.operation === 'export-notion');
  const compares = calls.find((entry) => entry.operation === 'compare-notion');
  assert.deepEqual(exports.args.slice(-2), ['--notion-source-map', notionMap]);
  assert.deepEqual(compares.args.slice(-2), ['--notion-source-map', notionMap]);
});
