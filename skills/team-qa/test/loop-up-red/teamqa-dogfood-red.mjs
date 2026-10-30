import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CLI = join(ROOT, 'scripts', 'teamqa.mjs');
const ROLES = join(ROOT, 'roles.json');
const SCROLL = process.env.TEAMQA_SCROLL_ROOT || join(homedir(), 'Dev', 'scroll');

function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TEAMQA_ROLES: options.roles || ROLES,
      TEAMQA_SCROLL_ROOT: SCROLL,
      ...options.env,
    },
  });
}

function tempCase(name) {
  return mkdtempSync(join(tmpdir(), `teamqa-red-${name}-`));
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function boardRecord(runId, evidence, source = 'qa-gui') {
  return {
    case_id: `CASE-${runId}`,
    lane: 'lane-red',
    verdict: 'pass',
    evidence: [evidence],
    source,
    run_id: runId,
    ts: '2026-08-11T00:00:00.000Z',
  };
}

test('RED-TQ-LIVE-CAP-001 — roles check fails closed when Dragon is unavailable', () => {
  const result = run(['roles', 'check'], {
    env: { TEAMQA_DRAGON_STATUS_URL: 'http://127.0.0.1:9/status' },
  });
  assert.notEqual(result.status, 0, `actual exit=0 stdout=${result.stdout.trim()}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /ungraded|unavailable/i);
});
test('RED-TQ-CHILD-CANARY-001 — smoke executes declared child gate canary', () => {
  const dir = tempCase('child-canary');
  const roles = json(ROLES);
  roles.skills['qa-gui'].commands.gate = [process.execPath, '-e', 'process.exit(1)'];
  const rolesPath = join(dir, 'roles.json');
  writeFileSync(rolesPath, `${JSON.stringify(roles, null, 2)}\n`);
  const result = run(['smoke'], { roles: rolesPath });
  assert.notEqual(result.status, 0, `actual exit=0 stdout=${result.stdout.trim()}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /qa-gui.*ungraded|canary/i);
});

test('RED-TQ-TARGET-LOCK-001 — PASS without exact target identity is ungraded', () => {
  const dir = tempCase('target-lock');
  writeFileSync(join(dir, 'proof.txt'), 'readable but not target-bound\n');
  const recordPath = join(dir, 'record.json');
  writeFileSync(recordPath, JSON.stringify(boardRecord('red-target-lock', 'proof.txt')));
  const result = run(['board', 'add', '--file', join(dir, 'board.jsonl'), '--record', recordPath], { cwd: dir });
  assert.notEqual(result.status, 0, `actual accepted missing target identity: ${result.stdout.trim()}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /TARGET_IDENTITY_MISSING/);
});

test('RED-TQ-VERDICT-BINDING-001 — PASS text without child verdict hash is rejected', () => {
  const dir = tempCase('verdict-binding');
  writeFileSync(join(dir, 'proof.txt'), 'PASS\n');
  const recordPath = join(dir, 'record.json');
  writeFileSync(recordPath, JSON.stringify(boardRecord('red-verdict-binding', 'proof.txt')));
  const result = run(['board', 'add', '--file', join(dir, 'board.jsonl'), '--record', recordPath], { cwd: dir });
  assert.notEqual(result.status, 0, `actual accepted unsigned child claim: ${result.stdout.trim()}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /CHILD_VERDICT_MISSING|CHILD_VERDICT_HASH/);
});

test('RED-TQ-DUAL-VERDICT-001 — board contract preserves Function and UI+Visual separately', () => {
  const schema = json(join(ROOT, 'schemas', 'board.json'));
  const props = schema.properties || {};
  assert.ok(props.function_verdict, 'board schema missing function_verdict');
  assert.ok(props.ui_visual_verdict, 'board schema missing ui_visual_verdict');
  assert.ok(schema.required.includes('function_verdict') && schema.required.includes('ui_visual_verdict'));
});

test('RED-TQ-EVIDENCE-CONTRACT-001 — zero-byte evidence cannot support PASS', () => {
  const dir = tempCase('evidence-contract');
  writeFileSync(join(dir, 'empty-proof.txt'), '');
  const recordPath = join(dir, 'record.json');
  writeFileSync(recordPath, JSON.stringify(boardRecord('red-evidence-contract', 'empty-proof.txt', 'script')));
  const result = run(['board', 'add', '--file', join(dir, 'board.jsonl'), '--record', recordPath], { cwd: dir });
  assert.notEqual(result.status, 0, `actual accepted 0-byte proof: ${result.stdout.trim()}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /EVIDENCE_EMPTY|EVIDENCE_CONTRACT/);
});

test('RED-TQ-COVERAGE-MATRIX-001 — tracked case contract requires taxonomy, states and viewports', () => {
  const schema = json(join(ROOT, 'schemas', 'case.json'));
  const item = schema.properties.cases.items;
  for (const field of ['taxonomy', 'states', 'viewports']) {
    assert.ok(item.properties[field], `case schema missing ${field}`);
    assert.ok(item.required.includes(field), `case schema does not require ${field}`);
  }
});

test('RED-TQ-TRIES-SEQUENCE-001 — board contract requires attempts, timing and timeout', () => {
  const schema = json(join(ROOT, 'schemas', 'board.json'));
  for (const field of ['attempt', 'parent_attempt_id', 'started_at', 'ended_at', 'timeout_ms']) {
    assert.ok(schema.properties[field], `board schema missing ${field}`);
  }
});

test('RED-TQ-FAILURE-SEPARATION-001 — report contract separates product, harness and environment', () => {
  const schema = json(join(ROOT, 'schemas', 'report.json'));
  const metrics = schema.properties.metrics;
  assert.equal(metrics.additionalProperties, false, 'metrics remains unbounded');
  for (const field of ['product_defects', 'harness_failures', 'environment_failures']) {
    assert.ok(metrics.properties?.[field], `report metrics missing ${field}`);
  }
});

test('RED-TQ-REPORT-INTEGRITY-001 — report requires grounded issues, RED checkers and child gates', () => {
  const schema = json(join(ROOT, 'schemas', 'report.json'));
  for (const field of ['grounded_issues', 'red_checkers', 'child_gates']) {
    assert.ok(schema.properties[field], `report schema missing ${field}`);
    assert.ok(schema.required.includes(field), `report schema does not require ${field}`);
  }
});
