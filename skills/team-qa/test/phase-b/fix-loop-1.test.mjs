import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const entry = join(repoRoot, 'scripts', 'teamqa.mjs');
const reportFixture = join(repoRoot, 'test', 'acceptance', 'fixtures', 'report', 'base');
const runId = 'tq-report';

function runCli(cwd, args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`,
  };
}

function withReportFixture(name, fn) {
  const parent = mkdtempSync(join(tmpdir(), `teamqa-fix-loop-1-${name}-`));
  const cwd = join(parent, 'workspace');
  try {
    cpSync(reportFixture, cwd, { recursive: true });
    const runDir = join(cwd, 'runs', runId);
    return fn({
      cwd,
      runDir,
      plan: join(runDir, 'test-plan.md'),
      tracked: join(runDir, 'tracked-plan.json'),
      rtm: join(runDir, 'rtm.md'),
      report: join(runDir, 'summary-report.md'),
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function mutateTracked(path, mutator) {
  const tracked = readJson(path);
  mutator(tracked);
  writeJson(path, tracked);
}

function approvePlan(cwd, plan) {
  const result = runCli(cwd, [
    'gate', 'approve', '--run', runId, '--plan', plan,
    '--signed-by', 'owner', '--ts', '2026-08-06T00:00:00.000Z',
  ]);
  assert.equal(result.status, 0, result.output);
}

function runRtmBuild(paths) {
  return runCli(paths.cwd, [
    'rtm', 'build',
    '--plan', paths.plan,
    '--tracked', paths.tracked,
    '--out', paths.rtm,
  ]);
}

function runReportBuild(paths) {
  approvePlan(paths.cwd, paths.plan);
  const fill = runCli(paths.cwd, ['rtm', 'fill', '--rtm', paths.rtm, '--board', join(paths.runDir, 'board.jsonl'), '--out', paths.rtm]);
  assert.equal(fill.status, 0, fill.output);
  return runCli(paths.cwd, ['report', 'build', '--run', runId]);
}

function extractReport(path) {
  const text = readFileSync(path, 'utf8');
  const start = 'TEAMQA_REPORT_START';
  const end = 'TEAMQA_REPORT_END';
  return JSON.parse(text.slice(text.indexOf(start) + start.length, text.indexOf(end)).trim());
}

test('V5 BOARD_CASE_MISSING prevents GO when a sibling case still covers the requirement', () => {
  withReportFixture('missing-board-row', (paths) => {
    mutateTracked(paths.tracked, (tracked) => {
      tracked.cases.push({
        ...tracked.cases[0],
        id: 'CASE-HIGH-1-SIBLING',
        steps: ['Run the high 1 sibling flow'],
        expected: 'High 1 sibling passes',
      });
    });
    const rtm = runRtmBuild(paths);
    assert.equal(rtm.status, 0, rtm.output);

    const result = runReportBuild(paths);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /verdict=fail/);
    assert.match(result.output, /decision=NO_GO/);
    assert.match(result.output, /BOARD_CASE_MISSING CASE-HIGH-1-SIBLING/);

    const report = extractReport(paths.report);
    assert.equal(report.decision, 'NO_GO');
    assert.ok(report.reasons.includes('BOARD_CASE_MISSING CASE-HIGH-1-SIBLING'));
  });
});

test('packaging ignores SCROLL and agent build renderings', () => {
  const lines = readFileSync(join(repoRoot, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(lines.includes('.scroll/'), '.gitignore missing .scroll/');
  assert.ok(lines.includes('agents/**/.build/'), '.gitignore missing agents/**/.build/');
});

test('SKILL explains absolute TEAMQA_ROLES when invoked from an app repo', () => {
  const text = readFileSync(join(repoRoot, 'SKILL.md'), 'utf8');
  assert.ok(text.includes('app repo'), 'SKILL.md must name the app-repo invocation context');
  assert.ok(
    text.includes('export TEAMQA_ROLES="/absolute/path/to/team-qa/roles.json"'),
    'SKILL.md must show an absolute TEAMQA_ROLES path to the skill roles.json',
  );
  assert.ok(text.includes('relative adapter'), 'SKILL.md must explain relative adapter resolution');
});
