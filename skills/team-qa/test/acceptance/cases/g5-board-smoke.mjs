import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTROL_ENTRY,
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
  justification: 'Board and schema validators need isolated records for each fail-closed branch.',
  base: 'red',
};

function withBoard(name, fixture, fn) {
  return withTemp(name, (cwd) => {
    const board = join(cwd, 'board.jsonl');
    stageFixture(`board/${fixture}`, board);
    stageFixture('evidence', join(cwd, 'evidence'));
    return fn(cwd, board);
  });
}

function firstRecord(board) {
  return JSON.parse(readFileSync(board, 'utf8').trim().split('\n')[0]);
}

function writeSmokeRoles(cwd, qaCodeFixture = 'qa-code-v1.json', qaGuiFixture = 'qa-gui-v1.json') {
  const schemaDir = join(cwd, 'skill-schemas');
  const qaGui = join(schemaDir, 'qa-gui.json');
  const qaCode = join(schemaDir, 'qa-code.json');
  stageFixture(`schema/${qaGuiFixture}`, qaGui);
  if (qaCodeFixture) stageFixture(`schema/${qaCodeFixture}`, qaCode);
  writeJson(join(cwd, 'roles.json'), {
    roles: [],
    mirror: {},
    skills: {
      'qa-gui': { verdict_schema: qaGui, supported_major: 1 },
      'qa-code': { verdict_schema: qaCode, supported_major: 1 },
    },
  });
}

export const cases = [
  defineCase({
    ...synthetic,
    id: 'G5-BOARD-NO-EVIDENCE-DOWNGRADE',
    group: 'G5',
    requirement: 'G5 Done when: a pass without evidence must be downgraded to ungraded with a reason',
    expected: 'exit 1; verdict=ungraded; board record rewritten and confirmed',
  }, () => withBoard('g5-empty', 'pass-no-evidence.jsonl', (cwd, board) => {
    expectRun(runCli(cwd, ['board', 'verify', '--file', board]), {
      exit: 1,
      includes: ['verdict=ungraded', 'BOARD_EVIDENCE_EMPTY', 'CASE-001', 'effect=confirmed'],
    });
    const record = firstRecord(board);
    assert.equal(record.verdict, 'ungraded');
    assert.equal(record.reason, 'BOARD_EVIDENCE_EMPTY');
  })),

  defineCase({
    ...synthetic,
    id: 'G5-BOARD-MISSING-EVIDENCE-PATH',
    group: 'G5',
    requirement: 'L11/C4: evidence that is declared but cannot be opened is still ungraded',
    expected: 'exit 1; BOARD_EVIDENCE_UNREADABLE',
  }, () => withBoard('g5-proof-path', 'pass-with-evidence.jsonl', (cwd, board) => {
    const record = firstRecord(board);
    record.evidence = ['evidence/does-not-exist.txt'];
    writeText(board, `${JSON.stringify(record)}\n`);
    expectRun(runCli(cwd, ['board', 'verify', '--file', board]), {
      exit: 1,
      includes: ['verdict=ungraded', 'BOARD_EVIDENCE_UNREADABLE', 'CASE-001'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G5-BOARD-BLOCKED-NORMALIZES-UNGRADED',
    group: 'G5',
    requirement: 'L11/H1: blocked must be stored as ungraded with a reason',
    expected: 'exit 1; verdict=ungraded; reason=ENV_DOWN',
  }, () => withBoard('g5-blocked', 'blocked.jsonl', (cwd, board) => {
    expectRun(runCli(cwd, ['board', 'verify', '--file', board]), {
      exit: 1,
      includes: ['verdict=ungraded', 'ENV_DOWN', 'CASE-BLOCKED'],
    });
    const record = firstRecord(board);
    assert.equal(record.verdict, 'ungraded');
    assert.equal(record.reason, 'ENV_DOWN');
  })),

  defineCase({
    ...synthetic,
    id: 'G5-BOARD-EVIDENCE-PASS',
    group: 'G5',
    requirement: 'G5 control path: a pass with readable evidence stays pass',
    expected: 'exit 0; verdict=pass',
  }, () => withBoard('g5-pass', 'pass-with-evidence.jsonl', (cwd, board) => {
    expectRun(runCli(cwd, ['board', 'verify', '--file', board]), {
      exit: 0,
      includes: ['verdict=pass', 'CASE-001'],
    });
    assert.equal(firstRecord(board).verdict, 'pass');
  })),

  defineCase({
    id: 'G5-BOARD-ADD-PRODUCT-PATH',
    group: 'G5',
    requirement: 'G5: board add writes the record, then reads it back to confirm',
    expected: 'exit 0; one record; effect=confirmed',
    base: 'red',
    provenance: 'product-path',
    setup: 'teamqa board add creates the ledger record through the operator path',
  }, () => withTemp('g5-add', (cwd) => {
    const board = join(cwd, 'board.jsonl');
    stageFixture('evidence', join(cwd, 'evidence'));
    const recordPath = writeJson(join(cwd, 'record.json'), {
      case_id: 'CASE-001',
      lane: 'lane-checkout',
      verdict: 'pass',
      evidence: ['evidence/case-checkout.txt'],
      source: 'qa-gui',
      run_id: 'tq-board',
      ts: '2026-08-05T00:00:00.000Z',
    });
    expectRun(runCli(cwd, ['board', 'add', '--file', board, '--record', recordPath]), {
      exit: 0,
      includes: ['verdict=pass', 'effect=confirmed', 'CASE-001'],
    });
    assert.equal(readFileSync(board, 'utf8').trim().split('\n').length, 1);
  })),

  defineCase({
    ...synthetic,
    id: 'G5-SMOKE-SCHEMA-MATCH',
    group: 'G5',
    requirement: 'G5: qa-gui and qa-code on supported majors make smoke green',
    expected: 'exit 0; verdict=pass',
  }, () => withTemp('g5-schema-ok', (cwd) => {
    writeSmokeRoles(cwd);
    expectRun(runCli(cwd, ['smoke']), {
      exit: 0,
      includes: ['verdict=pass', 'qa-gui', 'qa-code'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G5-SMOKE-QA-CODE-MAJOR-MISMATCH',
    group: 'G5',
    requirement: 'G5 Done when: a mismatched qa-code major must exit 4 with the skill name',
    expected: 'exit 4; SCHEMA_MAJOR_MISMATCH qa-code',
  }, () => withTemp('g5-schema-bad', (cwd) => {
    writeSmokeRoles(cwd, 'qa-code-v2.json');
    expectRun(runCli(cwd, ['smoke']), {
      exit: 4,
      includes: ['verdict=fail', 'SCHEMA_MAJOR_MISMATCH', 'qa-code'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G5-SMOKE-SCHEMA-MISSING',
    group: 'G5',
    requirement: 'C2/C3/L10: a missing child skill schema must stop, never patch itself',
    expected: 'exit 5; verdict=ungraded; SKILL_SCHEMA_MISSING qa-code',
  }, () => withTemp('g5-schema-missing', (cwd) => {
    writeSmokeRoles(cwd, null);
    expectRun(runCli(cwd, ['smoke']), {
      exit: 5,
      includes: ['verdict=ungraded', 'SKILL_SCHEMA_MISSING', 'qa-code'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G5-BOARD-MALFORMED-JSONL',
    group: 'G5',
    requirement: 'C2/C3: broken board JSONL must fail closed',
    expected: 'exit 2; BOARD_JSON_INVALID line=1',
  }, () => withBoard('g5-json', 'malformed.jsonl', (cwd, board) => {
    expectRun(runCli(cwd, ['board', 'verify', '--file', board]), {
      exit: 2,
      includes: ['verdict=fail', 'BOARD_JSON_INVALID', 'line=1'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G5-BOARD-UNKNOWN-FIELD',
    group: 'G5',
    requirement: 'C2/C3/C28: an unknown board field must be rejected',
    expected: 'exit 2; BOARD_UNKNOWN_FIELD unexpected',
  }, () => withBoard('g5-unknown', 'unknown-field.jsonl', (cwd, board) => {
    expectRun(runCli(cwd, ['board', 'verify', '--file', board]), {
      exit: 2,
      includes: ['verdict=fail', 'BOARD_UNKNOWN_FIELD', 'unexpected'],
    });
  })),

  defineCase({
    ...synthetic,
    id: 'G5-BOARD-UNREADABLE-FILE',
    group: 'G5',
    requirement: 'C2/C3: an unreadable board must fail closed',
    expected: 'exit 1; INPUT_UNREADABLE board.jsonl',
  }, () => withBoard('g5-unreadable', 'pass-with-evidence.jsonl', (cwd, board) => {
    chmodSync(board, 0o000);
    try {
      expectRun(runCli(cwd, ['board', 'verify', '--file', board]), {
        exit: 1,
        includes: ['verdict=fail', 'INPUT_UNREADABLE', 'board.jsonl'],
      });
    } finally {
      chmodSync(board, 0o600);
    }
  })),

  defineCase({
    id: 'G5-CONTROL-GREEN',
    group: 'G5',
    requirement: 'Phase A item 4: GREEN control for board evidence',
    expected: 'exit 0 on a known-good control',
    base: 'green',
    provenance: 'synthetic',
    justification: 'Test-only control proves the acceptance harness can record a known-good board result.',
  }, () => withTemp('g5-control', (cwd) => {
    expectRun(runCli(cwd, ['board', 'verify'], { entry: CONTROL_ENTRY }), {
      exit: 0,
      includes: ['verdict=pass', 'control=G5'],
    });
  })),
];
