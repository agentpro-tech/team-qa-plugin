import { appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTROL_ENTRY,
  defineCase,
  expectRun,
  mirrorRoles,
  runCli,
  signPlan,
  stageFixture,
  withTemp,
  writeJson,
  writeText,
} from '../lib/harness.mjs';

const runId = 'tq-20260805-sample-shop';
const synthetic = {
  provenance: 'synthetic',
  justification: 'Gate checker requires controlled approval hashes and malformed approval fixtures.',
  base: 'red',
};

function withPlan(name, fn) {
  return withTemp(name, (cwd) => {
    const plan = join(cwd, 'test-plan.md');
    stageFixture('plan/valid.md', plan);
    return fn(cwd, plan);
  });
}

export const cases = [
  defineCase({
    ...synthetic,
    id: 'G3-GATE-UNSIGNED',
    group: 'G3',
    requirement: 'G3 Done when: unsigned means gate status exits 3',
    expected: 'exit 3; GATE_UNSIGNED',
  }, () => withPlan('g3-unsigned', (cwd, plan) => {
    expectRun(runCli(cwd, ['gate', 'status', '--run', runId, '--plan', plan]), {
      exit: 3,
      includes: ['verdict=fail', 'GATE_UNSIGNED', runId],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G3-GATE-SIGNED-MATCH',
    group: 'G3',
    requirement: 'G3 Done when: an approval on the exact SHA exits 0',
    expected: 'exit 0; verdict=pass',
  }, () => withPlan('g3-match', (cwd, plan) => {
    signPlan(cwd, runId, plan);
    expectRun(runCli(cwd, ['gate', 'status', '--run', runId, '--plan', plan]), {
      exit: 0,
      includes: ['verdict=pass', runId],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G3-GATE-STALE-SIGNATURE',
    group: 'G3',
    requirement: 'G3 Done when: editing the plan after signing must lock',
    expected: 'exit 3; the exact message plan changed after signing',
  }, () => withPlan('g3-stale', (cwd, plan) => {
    signPlan(cwd, runId, plan);
    appendFileSync(plan, ' \n', 'utf8');
    expectRun(runCli(cwd, ['gate', 'status', '--run', runId, '--plan', plan]), {
      exit: 3,
      includes: ['verdict=fail', 'plan changed after signing'],
    });
  })),

  defineCase({
    id: 'G3-PUBLISH-DOC-COLAB-FALLBACK',
    group: 'G3',
    requirement: 'G3 Done when: a failed Notion probe falls back to doc-colab and exits 0',
    expected: 'exit 0; mirror=doc-colab; read-back confirmed',
    base: 'red',
    provenance: 'product-path',
    setup: 'teamqa gate publish invokes configured probe, publish, then separate readback',
  }, () => withPlan('g3-fallback', (cwd, plan) => {
    writeJson(join(cwd, 'roles.json'), mirrorRoles('fallback'));
    expectRun(runCli(cwd, ['gate', 'publish', '--run', runId, '--plan', plan]), {
      exit: 0,
      includes: ['verdict=pass', 'mirror=doc-colab', 'effect=confirmed'],
    });
  })),

  defineCase({
    id: 'G3-PUBLISH-NOTION-CONFIRMED',
    group: 'G3',
    requirement: 'G3 C6: Notion publish is green only after a separate readback command',
    expected: 'exit 0; mirror=notion; effect=confirmed',
    base: 'red',
    provenance: 'product-path',
    setup: 'teamqa gate publish invokes configured Notion write and independent readback',
  }, () => withPlan('g3-notion', (cwd, plan) => {
    writeJson(join(cwd, 'roles.json'), mirrorRoles('notion'));
    expectRun(runCli(cwd, ['gate', 'publish', '--run', runId, '--plan', plan]), {
      exit: 0,
      includes: ['verdict=pass', 'mirror=notion', 'effect=confirmed'],
    });
  })),

  defineCase({
    id: 'G3-PUBLISH-READBACK-MISMATCH',
    group: 'G3',
    requirement: 'G3 C6: a mismatched read-back must exit non-zero',
    expected: 'exit 1; EFFECT_UNCONFIRMED',
    base: 'red',
    provenance: 'product-path',
    setup: 'teamqa gate publish invokes a successful write then a mismatching independent readback',
  }, () => withPlan('g3-mismatch', (cwd, plan) => {
    writeJson(join(cwd, 'roles.json'), mirrorRoles('mismatch'));
    expectRun(runCli(cwd, ['gate', 'publish', '--run', runId, '--plan', plan]), {
      exit: 1,
      includes: ['verdict=fail', 'EFFECT_UNCONFIRMED'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G3-APPROVAL-MALFORMED-JSON',
    group: 'G3',
    requirement: 'C2/C3: broken approval JSON must fail closed',
    expected: 'exit 2; APPROVAL_JSON_INVALID',
  }, () => withPlan('g3-bad-json', (cwd, plan) => {
    writeText(join(cwd, 'control', 'approvals', runId, 'plan-v1.json'), '{"signed_by":');
    expectRun(runCli(cwd, ['gate', 'status', '--run', runId, '--plan', plan]), {
      exit: 2,
      includes: ['verdict=fail', 'APPROVAL_JSON_INVALID'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G3-APPROVAL-UNKNOWN-FIELD',
    group: 'G3',
    requirement: 'C2/C3/C28: an unknown approval field must be rejected',
    expected: 'exit 2; APPROVAL_UNKNOWN_FIELD unexpected',
  }, () => withPlan('g3-unknown', (cwd, plan) => {
    const approval = signPlan(cwd, runId, plan);
    const value = {
      signed_by: 'owner',
      ts: '2026-08-05T00:00:00.000Z',
      plan_sha256: 'a'.repeat(64),
      unexpected: true,
    };
    writeJson(approval, value);
    expectRun(runCli(cwd, ['gate', 'status', '--run', runId, '--plan', plan]), {
      exit: 2,
      includes: ['verdict=fail', 'APPROVAL_UNKNOWN_FIELD', 'unexpected'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G3-GATE-UNREADABLE-PLAN',
    group: 'G3',
    requirement: 'C2/C3: an unreadable plan must fail closed',
    expected: 'exit 1; INPUT_UNREADABLE test-plan.md',
  }, () => withPlan('g3-unreadable', (cwd, plan) => {
    chmodSync(plan, 0o000);
    try {
      expectRun(runCli(cwd, ['gate', 'status', '--run', runId, '--plan', plan]), {
        exit: 1,
        includes: ['verdict=fail', 'INPUT_UNREADABLE', 'test-plan.md'],
      });
    } finally {
      chmodSync(plan, 0o600);
    }
  })),

  defineCase({
    id: 'G3-CONTROL-GREEN',
    group: 'G3',
    requirement: 'Phase A item 4: GREEN control for the signing gate',
    expected: 'exit 0 on a known-good control',
    base: 'green',
    provenance: 'synthetic',
    justification: 'Test-only control proves the acceptance harness can record a known-good gate result.',
  }, () => withTemp('g3-control', (cwd) => {
    expectRun(runCli(cwd, ['gate', 'status'], { entry: CONTROL_ENTRY }), {
      exit: 0,
      includes: ['verdict=pass', 'control=G3'],
    });
  })),
];
