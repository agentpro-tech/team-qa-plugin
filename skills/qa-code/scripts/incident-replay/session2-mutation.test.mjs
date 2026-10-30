import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const mutations = [
  {
    name: 'I2 denominator cannot absorb gui requirements',
    file: 'scripts/lib/release-truth-v2.mjs',
    from: "['code', 'multi'].includes(item.verification_lane)",
    to: "['code', 'multi', 'gui'].includes(item.verification_lane)",
  },
  {
    name: 'I8 frozen threshold cannot be lowered',
    file: 'scripts/lib/gate0.mjs',
    from: 'threshold < frozenThreshold',
    to: 'threshold > frozenThreshold',
  },
  {
    name: 'I7 stale receipt cannot verify against a newer HEAD',
    file: 'scripts/lib/release-receipt.mjs',
    from: "if (currentHead !== receipt.head) errors.push('RECEIPT_STALE');",
    to: "if (false) errors.push('RECEIPT_STALE');",
  },
  {
    name: 'I18 atomic coverage cannot be omitted',
    file: 'scripts/lib/release-receipt.mjs',
    from: 'if (missing.length > 0) errors.push(`ATOMIC_COVERAGE_MISSING:${missing.join(\',\')}`);',
    to: 'if (false) errors.push(`ATOMIC_COVERAGE_MISSING:${missing.join(\',\')}`);',
  },
  {
    name: 'Release A producer cannot drop case binding',
    file: 'scripts/lib/release-receipt.mjs',
    from: 'case_id: result.case_id || mapping?.case_id,',
    to: 'case_id: undefined,',
  },
  {
    name: 'Release A verifier cannot accept a foreign case',
    file: 'scripts/lib/release-receipt.mjs',
    from: 'if (!acceptedCases.has(row.case_id)) errors.push(`ATOMIC_CASE_NOT_IN_REQUIREMENT:${row.requirement_id}:${row.case_id}`);',
    to: 'if (false) errors.push(`ATOMIC_CASE_NOT_IN_REQUIREMENT:${row.requirement_id}:${row.case_id}`);',
  },
];

test('Session 2 incident replay kills live contract/binding mutants', () => {
  for (const mutation of mutations) {
    const root = mkdtempSync(join(tmpdir(), 'qa-code-session2-mutant-'));
    roots.push(root);
    for (const directory of ['contracts', 'references', 'scripts']) {
      cpSync(join(ROOT, directory), join(root, directory), { recursive: true });
    }
    const target = join(root, mutation.file);
    const source = readFileSync(target, 'utf8');
    assert.equal(source.includes(mutation.from), true, `mutation anchor missing: ${mutation.name}`);
    writeFileSync(target, source.replace(mutation.from, mutation.to));

    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--test', 'scripts/incident-replay/session2.test.mjs',
    ], {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    });
    assert.equal(result.error, undefined, `${mutation.name}: ${result.error?.message}`);
    assert.notEqual(result.status, 0, `${mutation.name} survived\n${result.stdout}\n${result.stderr}`);
  }
});
