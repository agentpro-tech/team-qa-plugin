#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

function copy(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function stage() {
  const parent = mkdtempSync(join(tmpdir(), 'teamqa-mutation-'));
  const root = join(parent, 'repo');
  mkdirSync(root, { recursive: true });
  for (const name of ['AGENTS.md', 'SKILL.md', 'roles.json']) copy(join(sourceRoot, name), join(root, name));
  for (const name of ['agents', 'fixtures', 'references', 'schemas', 'scripts']) copy(join(sourceRoot, name), join(root, name));
  copy(join(sourceRoot, 'test', 'phase-b', 'g1-roles.test.mjs'), join(root, 'test', 'phase-b', 'g1-roles.test.mjs'));
  copy(join(sourceRoot, 'test', 'phase-b', 'g7-playbook.test.mjs'), join(root, 'test', 'phase-b', 'g7-playbook.test.mjs'));
  copy(join(sourceRoot, 'test', 'phase-b', 'fix-loop-1.test.mjs'), join(root, 'test', 'phase-b', 'fix-loop-1.test.mjs'));
  for (const name of ['cases', 'fixtures', 'lib', 'support']) {
    copy(join(sourceRoot, 'test', 'acceptance', name), join(root, 'test', 'acceptance', name));
  }
  copy(
    join(sourceRoot, 'test', 'acceptance', 'run-acceptance.mjs'),
    join(root, 'test', 'acceptance', 'run-acceptance.mjs'),
  );
  return { parent, root };
}

function mutateText(path, before, after) {
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes(before), `mutation target missing in ${path}`);
  writeFileSync(path, text.replace(before, after), 'utf8');
}

function run(root, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, TEAMQA_NODE: process.execPath },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const mutations = [
  {
    id: 'G1-TOOL-BOUND',
    apply(root) {
      const path = join(root, 'roles.json');
      const roles = JSON.parse(readFileSync(path, 'utf8'));
      roles.roles.find((item) => item.role === 'executor_gui').engine = 'codex-terra';
      writeFileSync(path, `${JSON.stringify(roles, null, 2)}\n`, 'utf8');
    },
    command: ['--test', 'test/phase-b/g1-roles.test.mjs'],
    marker: 'ROLE_TOOL_UNAVAILABLE',
  },
  {
    id: 'G7-PLAYBOOK-PHASE',
    apply(root) {
      mutateText(join(root, 'SKILL.md'), 'Phase 5 — COMPLETE', 'Phase 5 — REMOVED');
    },
    command: ['--test', 'test/phase-b/g7-playbook.test.mjs'],
    marker: 'SKILL.md missing Phase 5',
  },
  {
    id: 'G3-INDEPENDENT-READBACK',
    apply(root) {
      mutateText(
        join(root, 'scripts', 'lib', 'core.mjs'),
        'if (JSON.stringify(observed) !== JSON.stringify(expected)) fail(1, \'EFFECT_UNCONFIRMED\', tool);',
        'if (false) fail(1, \'EFFECT_UNCONFIRMED\', tool);',
      );
    },
    command: ['test/acceptance/run-acceptance.mjs'],
    marker: '[RED] G3-PUBLISH-READBACK-MISMATCH',
  },
  {
    id: 'G5-EVIDENCE-DOWNGRADE',
    apply(root) {
      mutateText(
        join(root, 'scripts', 'lib', 'validators.mjs'),
        "const graded = record.verdict === 'pass' || record.verdict === 'fail';",
        'const graded = false;',
      );
    },
    command: ['test/acceptance/run-acceptance.mjs'],
    marker: '[RED] G5-BOARD-NO-EVIDENCE-DOWNGRADE',
  },
  {
    id: 'G6-UNGRADED-COVERAGE',
    apply(root) {
      mutateText(
        join(root, 'scripts', 'teamqa.mjs'),
        "['pass', 'fail'].includes(record.verdict)",
        "['pass', 'fail', 'ungraded'].includes(record.verdict)",
      );
    },
    command: ['test/acceptance/run-acceptance.mjs'],
    marker: '[RED] G6-REPORT-UNGRADED-NOT-COVERED',
  },
  {
    id: 'V5-BOARD-COMPLETENESS',
    apply(root) {
      mutateText(
        join(root, 'scripts', 'teamqa.mjs'),
        'for (const item of data.missingCases) {',
        'for (const item of []) {',
      );
    },
    command: ['--test', 'test/phase-b/fix-loop-1.test.mjs'],
    marker: 'V5 BOARD_CASE_MISSING prevents GO',
  },
];

for (const mutation of mutations) {
  const { parent, root } = stage();
  try {
    mutation.apply(root);
    const result = run(root, mutation.command);
    assert.notEqual(result.status, 0, `${mutation.id} survived\n${result.output}`);
    assert.ok(result.output.includes(mutation.marker), `${mutation.id} missing marker ${mutation.marker}\n${result.output}`);
    console.log(`MUTATION ${mutation.id}=KILLED`);
  } finally {
    if (parent.startsWith(join(tmpdir(), 'teamqa-mutation-'))) rmSync(parent, { recursive: true, force: true });
  }
}

console.log(`MUTATION_SUMMARY killed=${mutations.length} survived=0 node=${process.version}`);
