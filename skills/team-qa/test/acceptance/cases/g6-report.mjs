import assert from 'node:assert/strict';
import { chmodSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  defineCase,
  expectRun,
  extractJsonBlock,
  readJson,
  runCli,
  signPlan,
  stageFixture,
  withTemp,
  writeJson,
  writeText,
} from '../lib/harness.mjs';

const runId = 'tq-report';
const synthetic = {
  provenance: 'synthetic',
  justification: 'Coverage arithmetic needs controlled board, RTM, priority, waiver, and tamper inputs.',
  base: 'red',
};

function withReportFixture(name, fn) {
  return withTemp(name, (temp) => {
    const cwd = join(temp, 'workspace');
    stageFixture('report/base', cwd);
    const runDir = join(cwd, 'runs', runId);
    const plan = join(runDir, 'test-plan.md');
    signPlan(cwd, runId, plan);
    return fn({ cwd, runDir, plan, board: join(runDir, 'board.jsonl') });
  });
}

function readLines(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
}

function writeLines(path, lines) {
  writeText(path, `${lines.join('\n')}\n`);
}

function updateBoard(path, update) {
  const records = readLines(path).map((line) => JSON.parse(line));
  const next = update(records) ?? records;
  writeLines(path, next.map((record) => JSON.stringify(record)));
}

function updateTracked(runDir, caseId, patch) {
  const path = join(runDir, 'tracked-plan.json');
  const tracked = readJson(path);
  const item = tracked.cases.find((entry) => entry.id === caseId);
  assert.ok(item, `missing tracked case ${caseId}`);
  Object.assign(item, patch);
  writeJson(path, tracked);
}

function updatePlan(planPath, update) {
  const text = readFileSync(planPath, 'utf8');
  const start = 'TEAMQA_PLAN_START';
  const end = 'TEAMQA_PLAN_END';
  const value = JSON.parse(text.slice(text.indexOf(start) + start.length, text.indexOf(end)).trim());
  update(value);
  writeText(planPath, `# Report plan fixture\n\n${start}\n${JSON.stringify(value, null, 2)}\n${end}\n`);
}

function reportPath(runDir) {
  return join(runDir, 'summary-report.md');
}

function assertReport(runDir, decision) {
  const report = extractJsonBlock(reportPath(runDir), 'TEAMQA_REPORT_START', 'TEAMQA_REPORT_END');
  assert.equal(report.run_id, runId);
  assert.equal(report.decision, decision);
  assert.ok(Array.isArray(report.reasons));
  return report;
}

function expectBuild(cwd, expected) {
  return expectRun(runCli(cwd, ['report', 'build', '--run', runId]), expected);
}

export const cases = [
  defineCase({
    ...synthetic,
    id: 'G6-REPORT-GO',
    group: 'G6',
    requirement: 'G6 Done when: a board that meets every criterion gives decision GO',
    expected: 'exit 0; GO; high=100; low=100; P0=0; P1=0',
  }, () => withReportFixture('g6-go', ({ cwd, runDir }) => {
    expectBuild(cwd, {
      exit: 0,
      includes: ['verdict=pass', 'decision=GO', 'effect=confirmed'],
    });
    const report = assertReport(runDir, 'GO');
    assert.equal(report.metrics.coverage_high_pct, 100);
    assert.equal(report.metrics.coverage_low_pct, 100);
    assert.equal(report.metrics.defects.p0, 0);
    assert.equal(report.metrics.defects.p1, 0);
  })),

  defineCase({
    ...synthetic,
    id: 'G6-REPORT-HIGH-COVERAGE-NO-GO',
    group: 'G6',
    requirement: 'G6 Done when: removing one high-risk case must give NO_GO with the exact reason',
    expected: 'exit 1; NO_GO; coverage_high_pct 50 < 100',
  }, () => withReportFixture('g6-high', ({ cwd, runDir, board }) => {
    updateBoard(board, (records) => records.filter((entry) => entry.case_id !== 'CASE-HIGH-2'));
    expectBuild(cwd, {
      exit: 1,
      includes: ['verdict=fail', 'decision=NO_GO', 'coverage_high_pct', '50', '100'],
    });
    const report = assertReport(runDir, 'NO_GO');
    assert.equal(report.metrics.coverage_high_pct, 50);
    assert.ok(report.reasons.some((reason) => reason.includes('coverage_high_pct')));
  })),

  defineCase({
    ...synthetic,
    id: 'G6-REPORT-LOW-COVERAGE-NO-GO',
    group: 'G6',
    requirement: 'G6: low coverage below 70% must be NO_GO',
    expected: 'exit 1; NO_GO; coverage_low_pct 50 < 70',
  }, () => withReportFixture('g6-low', ({ cwd, runDir, board }) => {
    updateBoard(board, (records) => records.filter((entry) => entry.case_id !== 'CASE-LOW-2'));
    expectBuild(cwd, {
      exit: 1,
      includes: ['verdict=fail', 'decision=NO_GO', 'coverage_low_pct', '50', '70'],
    });
    const report = assertReport(runDir, 'NO_GO');
    assert.equal(report.metrics.coverage_low_pct, 50);
  })),

  defineCase({
    ...synthetic,
    id: 'G6-REPORT-P0-NO-GO',
    group: 'G6',
    requirement: 'G6/L3: P0 defects above 0 must be NO_GO',
    expected: 'exit 1; NO_GO; p0_count 1 > 0',
  }, () => withReportFixture('g6-p0', ({ cwd, runDir, board }) => {
    updateTracked(runDir, 'CASE-HIGH-1', { priority: 'P0' });
    updateBoard(board, (records) => {
      records.find((entry) => entry.case_id === 'CASE-HIGH-1').verdict = 'fail';
      return records;
    });
    expectBuild(cwd, {
      exit: 1,
      includes: ['verdict=fail', 'decision=NO_GO', 'p0_count', '1', '0'],
    });
    assert.equal(assertReport(runDir, 'NO_GO').metrics.defects.p0, 1);
  })),

  defineCase({
    ...synthetic,
    id: 'G6-REPORT-P1-NO-WAIVER',
    group: 'G6',
    requirement: 'G6/L3: a P1 defect without a waiver must be NO_GO',
    expected: 'exit 1; NO_GO; P1 case id appears in reason',
  }, () => withReportFixture('g6-p1', ({ cwd, runDir, board }) => {
    updateTracked(runDir, 'CASE-HIGH-1', { priority: 'P1' });
    updateBoard(board, (records) => {
      records.find((entry) => entry.case_id === 'CASE-HIGH-1').verdict = 'fail';
      return records;
    });
    expectBuild(cwd, {
      exit: 1,
      includes: ['verdict=fail', 'decision=NO_GO', 'P1_UNWAIVED', 'CASE-HIGH-1'],
    });
    assert.equal(assertReport(runDir, 'NO_GO').metrics.defects.p1, 1);
  })),

  defineCase({
    ...synthetic,
    id: 'G6-REPORT-P1-WAIVER-GO',
    group: 'G6',
    requirement: 'L3: P1 may pass only when a waiver signed beforehand holds the exact case',
    expected: 'exit 0; GO; waived_p1 includes CASE-HIGH-1',
  }, () => withReportFixture('g6-waiver', ({ cwd, runDir, plan, board }) => {
    updateTracked(runDir, 'CASE-HIGH-1', { priority: 'P1' });
    updateBoard(board, (records) => {
      records.find((entry) => entry.case_id === 'CASE-HIGH-1').verdict = 'fail';
      return records;
    });
    updatePlan(plan, (value) => value.exit_criteria.p1_waivers.push('CASE-HIGH-1'));
    signPlan(cwd, runId, plan);
    expectBuild(cwd, {
      exit: 0,
      includes: ['verdict=pass', 'decision=GO', 'waived_p1=CASE-HIGH-1'],
    });
    const report = assertReport(runDir, 'GO');
    assert.deepEqual(report.waived_p1, ['CASE-HIGH-1']);
  })),

  defineCase({
    ...synthetic,
    id: 'G6-REPORT-UNGRADED-NOT-COVERED',
    group: 'G6',
    requirement: 'L11/§29: ungraded must not count as coverage',
    expected: 'exit 1; NO_GO; coverage_high_pct 50',
  }, () => withReportFixture('g6-ungraded', ({ cwd, runDir, board }) => {
    updateBoard(board, (records) => {
      const target = records.find((entry) => entry.case_id === 'CASE-HIGH-1');
      target.verdict = 'ungraded';
      target.reason = 'CHECKER_UNAVAILABLE';
      return records;
    });
    expectBuild(cwd, {
      exit: 1,
      includes: ['verdict=fail', 'decision=NO_GO', 'coverage_high_pct', '50'],
    });
    const report = assertReport(runDir, 'NO_GO');
    assert.equal(report.metrics.ungraded, 1);
    assert.equal(report.metrics.coverage_high_pct, 50);
  })),

  defineCase({
    id: 'G6-REPORT-TAMPER-DETECTED',
    group: 'G6',
    requirement: 'G6 Done when: hand-editing one number must turn report verify red',
    expected: 'build exit 0, tamper high coverage, verify exit 2 REPORT_MISMATCH',
    base: 'red',
    provenance: 'product-path',
    setup: 'teamqa report build creates the report before the acceptance case tampers one machine field',
  }, () => withReportFixture('g6-tamper', ({ cwd, runDir }) => {
    expectBuild(cwd, { exit: 0, includes: ['decision=GO'] });
    const report = assertReport(runDir, 'GO');
    report.metrics.coverage_high_pct = 99;
    writeText(
      reportPath(runDir),
      `# Summary report\n\nTEAMQA_REPORT_START\n${JSON.stringify(report, null, 2)}\nTEAMQA_REPORT_END\n`,
    );
    expectRun(runCli(cwd, ['report', 'verify', '--run', runId]), {
      exit: 2,
      includes: ['verdict=fail', 'REPORT_MISMATCH', 'coverage_high_pct'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G6-REPORT-UNSIGNED-PLAN',
    group: 'G6',
    requirement: 'L2/G6: the report must not use unsigned exit criteria',
    expected: 'exit 3; GATE_UNSIGNED',
  }, () => withReportFixture('g6-unsigned', ({ cwd, plan }) => {
    renameSync(join(cwd, 'control', 'approvals', runId, 'plan-v1.json'), join(cwd, 'approval-held.json'));
    expectBuild(cwd, {
      exit: 3,
      includes: ['verdict=fail', 'GATE_UNSIGNED', plan.split('/').pop()],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G6-REPORT-MISSING-BOARD',
    group: 'G6',
    requirement: 'C2/C3: a missing board must fail closed',
    expected: 'exit 2; INPUT_MISSING board.jsonl',
  }, () => withReportFixture('g6-missing', ({ cwd, board }) => {
    renameSync(board, `${board}.held`);
    expectBuild(cwd, {
      exit: 2,
      includes: ['verdict=fail', 'INPUT_MISSING', 'board.jsonl'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G6-REPORT-MISSING-END-MARKER',
    group: 'G6',
    requirement: 'C2/C3: a broken report marker must fail closed',
    expected: 'exit 2; REPORT_MARKER TEAMQA_REPORT_END',
  }, () => withReportFixture('g6-marker', ({ cwd, runDir }) => {
    stageFixture('report/invalid-report-missing-end.md', reportPath(runDir));
    expectRun(runCli(cwd, ['report', 'verify', '--run', runId]), {
      exit: 2,
      includes: ['verdict=fail', 'REPORT_MARKER', 'TEAMQA_REPORT_END'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G6-REPORT-UNKNOWN-FIELD',
    group: 'G6',
    requirement: 'C2/C3/C28: an unknown report field must be rejected',
    expected: 'exit 2; REPORT_UNKNOWN_FIELD unexpected',
  }, () => withReportFixture('g6-unknown', ({ cwd, runDir }) => {
    stageFixture('report/invalid-report-unknown-field.md', reportPath(runDir));
    expectRun(runCli(cwd, ['report', 'verify', '--run', runId]), {
      exit: 2,
      includes: ['verdict=fail', 'REPORT_UNKNOWN_FIELD', 'unexpected'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G6-REPORT-UNREADABLE-BOARD',
    group: 'G6',
    requirement: 'C2/C3: an unreadable board must fail closed',
    expected: 'exit 1; INPUT_UNREADABLE board.jsonl',
  }, () => withReportFixture('g6-unreadable', ({ cwd, board }) => {
    chmodSync(board, 0o000);
    try {
      expectBuild(cwd, {
        exit: 1,
        includes: ['verdict=fail', 'INPUT_UNREADABLE', 'board.jsonl'],
      });
    } finally {
      chmodSync(board, 0o600);
    }
  })),
];
