import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SESSION_TEST = join(ROOT, 'test', 'session3-release-truth-v2.test.mjs');

function mutant(name, file, transform) {
  const root = mkdtempSync(join(tmpdir(), `qa-gui-session3-mutant-${name}-`));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  cpSync(join(ROOT, 'contracts'), join(root, 'contracts'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'teamwork'), join(root, 'scripts', 'teamwork'), { recursive: true });
  for (const file of ['qa-gate.mjs', 'receipt-verify.mjs', 'visual-diff.mjs', 'qa-board.schema.json']) {
    cpSync(join(ROOT, 'scripts', file), join(root, 'scripts', file));
  }
  // The gate's whole import graph (scripts/lib and the responsive matrix it reads), so the copy loads and a mutant dies
  // on an assertion. A list of chosen files fell behind each new import and every mutant then died on a missing module.
  cpSync(join(ROOT, 'scripts', 'lib'), join(root, 'scripts', 'lib'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'loop7'), join(root, 'scripts', 'loop7'), { recursive: true });
  if (transform) {
    const target = join(root, 'scripts', 'lib', file);
    const source = readFileSync(target, 'utf8');
    const changed = transform(source);
    assert.notEqual(changed, source, `${name}: mutation marker was not found`);
    writeFileSync(target, changed);
  }
  return { root, gate: join(root, 'scripts', 'qa-gate.mjs'), verify: join(root, 'scripts', 'receipt-verify.mjs') };
}

function runSession(fixture, pattern) {
  const env = {
    ...process.env,
    QA_GATE_UNDER_TEST: fixture.gate,
    QA_RECEIPT_VERIFY_UNDER_TEST: fixture.verify,
  };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [
    '--test', '--test-concurrency=1', '--test-name-pattern', pattern, SESSION_TEST,
  ], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env,
    timeout: 120_000,
  });
}

function killed(name, pattern, transform, file = 'qa-gui-v2.mjs') {
  const fixture = mutant(name, file, transform);
  try {
    const result = runSession(fixture, pattern);
    assert.equal(result.error, undefined, `${name}: ${result.error?.message}`);
    assert.notEqual(result.status, 0, `${name} survived:\n${result.stdout}\n${result.stderr}`);
    // A mutant must die on an assertion, never on a module its copy cannot load.
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ERR_MODULE_NOT_FOUND|Cannot find module/, `${name} died on a missing module, not on an assertion`);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('Session 3 mutant copy runs the session tests green before any mutation', () => {
  const fixture = mutant('control', null, null);
  try {
    const result = runSession(fixture, 'I3/QGe|I5/QGa|I19/QGa-QGb|I6/QGb|I13/QGc|I20/QGd|Release A A2');
    assert.equal(result.error, undefined, `control: ${result.error?.message}`);
    assert.equal(result.status, 0, `the unmutated copy fails, so a mutant would die for the wrong reason:\n${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Session 3 mutation gate kills denominator, evidence, type, vision and dwell bypasses', () => {
  killed('denominator', 'I3/QGe', (source) => source.replace(
    'for (const requirementId of context.guiIds) {',
    'for (const requirementId of []) { // mutant: denominator bypassed',
  ));

  killed('physical-evidence', 'I5/QGa|I19/QGa-QGb', (source) => source
    .replace('for (const error of inspected.errors) issue(error);', 'void inspected.errors; // mutant: evidence errors discarded')
    .replace('if (!inspected.physicalValid) receiptEligible = false;', 'void inspected.physicalValid; // mutant: invalid evidence may issue'));

  killed('evidence-type', 'I6/QGb', (source) => source.replace(
    /if \(requirement && \(!requirement\.evidence_contract\.allowed_types\.includes\(assertion\.evidence_type\)[\s\S]*?\n        \}/,
    'if (false) { void requirement; } // mutant: evidence type bypassed',
  ));

  killed('vision', 'I13/QGc', (source) => source.replace(
    'checkVision(data, context, inspected.paths, issue);',
    'void data.vision; // mutant: visual and risk gate bypassed',
  ));

  killed('dwell', 'I20/QGd', (source) => source.replace(
    'checkDwell(receipt, planCase, primaryRequirement, label, issue);',
    'void primaryRequirement; // mutant: dwell gate bypassed',
  ));

  killed('case-producer', 'Release A A2', (source) => source.replace(
    'case_id: caseId,',
    'case_id: undefined, // mutant: producer dropped case binding',
  ));

  killed('case-membership', 'Release A A2', (source) => source.replace(
    "if (!planCase) errors.push(`ATOMIC_CASE_NOT_IN_PLAN:${row.case_id}`);",
    "if (false) errors.push(`ATOMIC_CASE_NOT_IN_PLAN:${row.case_id}`); // mutant: foreign case accepted",
  ), 'release-receipt-v2.mjs');
});
