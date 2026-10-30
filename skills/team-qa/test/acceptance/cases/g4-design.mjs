import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defineCase,
  expectRun,
  readJson,
  runCli,
  stageFixture,
  withTemp,
  writeJson,
  writeText,
} from '../lib/harness.mjs';

const synthetic = {
  provenance: 'synthetic',
  justification: 'Design and RTM validators need isolated tracked-plan schema variants.',
  base: 'red',
};

function withTracked(name, fixture, fn) {
  return withTemp(name, (cwd) => {
    const tracked = join(cwd, 'tracked-plan.json');
    stageFixture(`tracked/${fixture}`, tracked);
    return fn(cwd, tracked);
  });
}

export const cases = [
  defineCase({
    ...synthetic,
    id: 'G4-DESIGN-VALID',
    group: 'G4',
    requirement: 'G4: a tracked plan that meets the schema is green',
    expected: 'exit 0; verdict=pass; cases=6',
  }, () => withTracked('g4-valid', 'valid.json', (cwd) => {
    expectRun(runCli(cwd, ['design', 'validate']), {
      exit: 0,
      includes: ['verdict=pass', 'cases=6'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G4-DESIGN-MISSING-EXPECTED',
    group: 'G4',
    requirement: 'G4 Done when: in a 6-case fixture, CASE-002 without expected must be red on the exact case',
    expected: 'exit 2; CASE_FIELD CASE-002 expected',
  }, () => withTracked('g4-expected', 'invalid-missing-expected.json', (cwd) => {
    expectRun(runCli(cwd, ['design', 'validate']), {
      exit: 2,
      includes: ['verdict=fail', 'CASE_FIELD', 'CASE-002', 'expected'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G4-DESIGN-MISSING-STEPS',
    group: 'G4',
    requirement: 'G4: a case without steps must be red',
    expected: 'exit 2; CASE_FIELD CASE-001 steps',
  }, () => withTracked('g4-steps', 'valid.json', (cwd, tracked) => {
    const value = readJson(tracked);
    delete value.cases[0].steps;
    writeJson(tracked, value);
    expectRun(runCli(cwd, ['design', 'validate']), {
      exit: 2,
      includes: ['verdict=fail', 'CASE_FIELD', 'CASE-001', 'steps'],
    });
  })),

  defineCase({
    id: 'G4-RTM-EXPOSES-GAP',
    group: 'G4',
    requirement: 'G4 Done when: the RTM shows the bold empty marker for a requirement with no case',
    expected: 'exit 0; rtm.md contains REQ-UNTESTED and **EMPTY**',
    base: 'red',
    provenance: 'product-path',
    setup: 'teamqa rtm build creates rtm.md from test-plan.md and tracked-plan.json',
  }, () => withTracked('g4-rtm', 'valid.json', (cwd) => {
    const plan = readFileSync(join(new URL('../fixtures/plan/valid.md', import.meta.url).pathname), 'utf8')
      .replace('"REQ-LANDING": "SMOKE"', '"REQ-LANDING": "SMOKE",\n    "REQ-UNTESTED": "FULL"');
    writeText(join(cwd, 'test-plan.md'), plan);
    expectRun(runCli(cwd, ['rtm', 'build']), {
      exit: 0,
      includes: ['verdict=pass', 'effect=confirmed', 'rtm.md'],
    });
    const rtm = readFileSync(join(cwd, 'rtm.md'), 'utf8');
    assert.ok(rtm.includes('REQ-UNTESTED'), rtm);
    assert.ok(rtm.includes('**EMPTY**'), rtm);
  })),

  defineCase({
    ...synthetic,
    id: 'G4-DESIGN-MISSING-FILE',
    group: 'G4',
    requirement: 'C2/C3: a missing tracked-plan must fail closed',
    expected: 'exit 2; INPUT_MISSING tracked-plan.json',
  }, () => withTemp('g4-missing', (cwd) => {
    expectRun(runCli(cwd, ['design', 'validate']), {
      exit: 2,
      includes: ['verdict=fail', 'INPUT_MISSING', 'tracked-plan.json'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G4-DESIGN-MALFORMED-JSON',
    group: 'G4',
    requirement: 'C2/C3: broken tracked-plan JSON must fail closed',
    expected: 'exit 2; CASE_JSON_INVALID',
  }, () => withTracked('g4-json', 'malformed.json', (cwd) => {
    expectRun(runCli(cwd, ['design', 'validate']), {
      exit: 2,
      includes: ['verdict=fail', 'CASE_JSON_INVALID'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G4-DESIGN-UNKNOWN-FIELD',
    group: 'G4',
    requirement: 'C2/C3/C28: an unknown tracked case field must be rejected',
    expected: 'exit 2; CASE_UNKNOWN_FIELD CASE-UNKNOWN unexpected',
  }, () => withTracked('g4-unknown', 'invalid-unknown-field.json', (cwd) => {
    expectRun(runCli(cwd, ['design', 'validate']), {
      exit: 2,
      includes: ['verdict=fail', 'CASE_UNKNOWN_FIELD', 'CASE-UNKNOWN', 'unexpected'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G4-DESIGN-UNREADABLE-FILE',
    group: 'G4',
    requirement: 'C2/C3: an unreadable tracked-plan must fail closed',
    expected: 'exit 1; INPUT_UNREADABLE tracked-plan.json',
  }, () => withTracked('g4-unreadable', 'valid.json', (cwd, tracked) => {
    chmodSync(tracked, 0o000);
    try {
      expectRun(runCli(cwd, ['design', 'validate']), {
        exit: 1,
        includes: ['verdict=fail', 'INPUT_UNREADABLE', 'tracked-plan.json'],
      });
    } finally {
      chmodSync(tracked, 0o600);
    }
  })),
];
