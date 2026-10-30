import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  defineCase,
  expectRun,
  runCli,
  stageFixture,
  withTemp,
} from '../lib/harness.mjs';

function planCase(meta, fixture, expected, repeats = 1) {
  return defineCase(meta, () => withTemp(meta.id.toLowerCase(), (cwd) => {
    const plan = join(cwd, 'test-plan.md');
    stageFixture(`plan/${fixture}`, plan);
    for (let attempt = 0; attempt < repeats; attempt += 1) {
      expectRun(runCli(cwd, ['plan', 'validate', plan]), expected);
    }
  }));
}

const synthetic = {
  provenance: 'synthetic',
  justification: 'Validator contract needs isolated malformed and well-formed plan inputs.',
  base: 'red',
};

export const cases = [
  planCase({
    ...synthetic,
    id: 'G2-PLAN-VALID',
    group: 'G2',
    requirement: 'G2 Done when/V2: a complete fixture plan is green, stable 3 times',
    expected: 'exit 0 three times; verdict=pass',
  }, 'valid.md', { exit: 0, includes: ['verdict=pass'] }, 3),

  planCase({
    ...synthetic,
    id: 'G2-PLAN-MISSING-COVERAGE',
    group: 'G2',
    requirement: 'G2 Done when: missing coverage must be red on the exact field',
    expected: 'exit 2; PLAN_MISSING_FIELD exit_criteria.coverage_low_pct',
  }, 'invalid-missing-coverage.md', {
    exit: 2,
    includes: ['verdict=fail', 'PLAN_MISSING_FIELD', 'exit_criteria.coverage_low_pct'],
  }),

  planCase({
    ...synthetic,
    id: 'G2-PLAN-P0-WRONG-TYPE',
    group: 'G2',
    requirement: 'G2 Done when: a wrong p0_max type must be red',
    expected: 'exit 2; PLAN_TYPE exit_criteria.p0_max',
  }, 'invalid-p0-type.md', {
    exit: 2,
    includes: ['verdict=fail', 'PLAN_TYPE', 'exit_criteria.p0_max'],
  }),

  planCase({
    ...synthetic,
    id: 'G2-PLAN-MISSING-END-MARKER',
    group: 'G2',
    requirement: 'G2 Done when: a missing end marker must be red',
    expected: 'exit 2; PLAN_MARKER TEAMQA_PLAN_END',
  }, 'invalid-missing-end.md', {
    exit: 2,
    includes: ['verdict=fail', 'PLAN_MARKER', 'TEAMQA_PLAN_END'],
  }),

  planCase({
    ...synthetic,
    id: 'G2-PLAN-UNKNOWN-FIELD',
    group: 'G2',
    requirement: 'G2 Done when + C2/C3: an unknown field must be rejected',
    expected: 'exit 2; PLAN_UNKNOWN_FIELD unexpected',
  }, 'invalid-unknown-field.md', {
    exit: 2,
    includes: ['verdict=fail', 'PLAN_UNKNOWN_FIELD', 'unexpected'],
  }),

  planCase({
    ...synthetic,
    id: 'G2-PLAN-PARALLEL-NO-REASON',
    group: 'G2',
    requirement: 'G2 Done when: parallel_ok=true needs vi_sao',
    expected: 'exit 2; PLAN_PARALLEL_REASON lanes[0].vi_sao',
  }, 'invalid-parallel-reason.md', {
    exit: 2,
    includes: ['verdict=fail', 'PLAN_PARALLEL_REASON', 'lanes[0].vi_sao'],
  }),

  planCase({
    ...synthetic,
    id: 'G2-PLAN-MALFORMED-JSON',
    group: 'G2',
    requirement: 'C2/C3: broken JSON must fail closed',
    expected: 'exit 2; PLAN_JSON_INVALID',
  }, 'invalid-json.md', {
    exit: 2,
    includes: ['verdict=fail', 'PLAN_JSON_INVALID'],
  }),

  defineCase({
    ...synthetic,
    id: 'G2-PLAN-MISSING-FILE',
    group: 'G2',
    requirement: 'C2/C3: a missing file must fail closed',
    expected: 'exit 2; INPUT_MISSING test-plan.md',
  }, () => withTemp('g2-missing', (cwd) => {
    expectRun(runCli(cwd, ['plan', 'validate', join(cwd, 'test-plan.md')]), {
      exit: 2,
      includes: ['verdict=fail', 'INPUT_MISSING', 'test-plan.md'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G2-PLAN-UNREADABLE-FILE',
    group: 'G2',
    requirement: 'C2/C3: blocked read permission must fail closed',
    expected: 'exit 1; INPUT_UNREADABLE test-plan.md',
  }, () => withTemp('g2-unreadable', (cwd) => {
    const plan = join(cwd, 'test-plan.md');
    stageFixture('plan/valid.md', plan);
    chmodSync(plan, 0o000);
    try {
      expectRun(runCli(cwd, ['plan', 'validate', plan]), {
        exit: 1,
        includes: ['verdict=fail', 'INPUT_UNREADABLE', 'test-plan.md'],
      });
    } finally {
      chmodSync(plan, 0o600);
    }
  })),
];
