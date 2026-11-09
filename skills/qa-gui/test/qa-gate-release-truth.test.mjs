import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultGate = join(root, 'scripts/qa-gate.mjs');
const gate = process.env.QA_GATE_UNDER_TEST || defaultGate;
const pngSource = join(root, 'qa-evidence/fixture-a/round-1/1280x800/after-load.png');
const RUN_UUID = '11111111-1111-4111-8111-111111111111';
const COMMIT = 'a'.repeat(40);
const HASH = /^[a-f0-9]{64}$/;

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function runGate(board, cwd = dirname(board), target = gate) {
  return spawnSync(process.execPath, [target, board], { cwd, encoding: 'utf8' });
}

function manifestEntry(dir, path) {
  return { path, sha256: sha256(join(dir, path)) };
}

function baseCoverage() {
  return [
    ['happy', 'tick'], ['boundary', 'tick'], ['empty', 'tick'], ['loading', 'waive'],
    ['error', 'tick'], ['auth-role', 'waive'], ['navigation', 'tick'], ['keyboard', 'tick'],
    ['responsive', 'tick'], ['dark-mode', 'waive'],
  ].map(([area, status]) => ({ area, status, note: status === 'waive' ? 'not applicable' : undefined }));
}

function makeFixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-gui-release-truth-'));
  const schemaVersion = options.schemaVersion ?? 5;
  const caseId = options.caseId || 'TC-01';
  const state = options.state || 'after-load';
  const receiptRel = `evidence/${caseId}-${state}.state.json`;
  const shotRel = `evidence/${caseId}-${state}.png`;
  const rawRel = `evidence/${caseId}-assertion.json`;
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  copyFileSync(pngSource, join(dir, shotRel));
  writeFileSync(join(dir, rawRel), JSON.stringify({ observed: 'ok' }) + '\n');

  const requirements = options.requirements || ['REQ-1'];
  const assertionRequirements = options.assertionRequirements || requirements;
  const functionVerdict = options.functionVerdict || 'PASS';
  const writeMethod = options.writeMethod;
  const writesData = options.writesData === true || Boolean(writeMethod);
  const lifecycle = writesData ? {
    before: { verdict: 'PASS', evidence_ref: rawRel },
    action: { verdict: 'PASS', evidence_ref: rawRel, writes_data: true },
    network: { verdict: 'PASS', evidence_ref: rawRel, expect_net: true },
    readback: { verdict: 'PASS', evidence_ref: rawRel },
    refresh: { verdict: 'PASS', evidence_ref: rawRel },
    postcondition: { verdict: 'PASS', evidence_ref: rawRel },
  } : undefined;
  const receipt = {
    schema: 'qa-gui/state-receipt/v1',
    caseId,
    state,
    capturedAt: '2026-08-18T02:40:00.000Z',
    url: 'https://test.example/qa',
    build: 'qa-gui-test-build',
    viewport: '1280x800',
    domHash: options.domHash || 'b'.repeat(64),
    dragon: {
      sessionId: 'qa-release-truth', actionId: 'action-1', browserInstanceId: 'browser-1',
      tabId: 'tab-1', innerOk: true,
    },
    screenshot: { path: shotRel, sha256: sha256(join(dir, shotRel)) },
    function: {
      verdict: functionVerdict,
      assertions: assertionRequirements.map((requirementId, index) => ({
        requirement_id: requirementId,
        verdict: index === 0 ? functionVerdict : 'PASS',
        evidence_ref: rawRel,
      })),
    },
    ui: {
      verdict: 'PASS',
      uiSanity: { id: 'ui-sanity', verdict: 'PASS', evidence: 'raw ui sanity output' },
      a11y: { id: 'a11y', verdict: 'PASS', evidence: 'raw accessibility output' },
      console: { id: 'console', verdict: 'PASS', evidence: 'raw console output' },
      network: { id: 'network-ui', verdict: 'PASS', evidence: 'raw network sweep' },
    },
    preflight: { id: 'preflight', verdict: 'PASS', evidence: 'raw preflight output' },
    network: writeMethod && !options.omitNetwork
      ? [{ method: writeMethod, url: 'https://test.example/api/save', status: 200 }]
      : [],
    readback: writesData && !options.omitReadback
      ? { value: { status: 'saved' }, evidence_ref: rawRel }
      : null,
    ...(lifecycle ? { lifecycle } : {}),
    ...(options.equivalentTo ? { equivalentTo: options.equivalentTo, equivalenceReason: 'Hai state có DOM giống nhau.' } : {}),
  };
  if (options.createReceipt !== false) writeFileSync(join(dir, receiptRel), JSON.stringify(receipt, null, 2) + '\n');

  const evidence = [shotRel, rawRel];
  if (options.createReceipt !== false) evidence.push(receiptRel);
  const boardCase = {
    id: caseId,
    title: 'Kiểm chứng cổng nghiệm thu',
    requirement: requirements.join(','),
    requirements,
    steps: 'Mở trạng thái và thu bằng chứng máy đọc.',
    expected: 'Cổng tính lại đúng verdict từ receipt.',
    status: functionVerdict === 'FAIL' ? 'FAIL' : 'PASS',
    priority: 'P1',
    assignee: 'qa-agent',
    functionVerdict,
    uiVerdict: 'PASS',
    humanSummary: { function: 'Được tính từ receipt.', ui: 'Được tính từ receipt.' },
    machine: { rule: 'release-truth', selector: 'scripts/qa-gate.mjs' },
    kind: options.kind || (writesData ? 'behavioral' : 'static'),
    states: [state],
    stateReceipts: options.stateReceipts === false ? [] : [{ state, file: receiptRel }],
    results: [{
      round: 1, functionVerdict, uiVerdict: 'PASS', recordedAt: '2026-08-18T02:41:00.000Z', evidence,
    }],
    evidence,
    comments: [], history: [],
    ...(schemaVersion === 6 ? { sourceRefs: ['SRC-REQ-1'] } : {}),
  };
  const board = {
    schemaVersion,
    canonicalVersion: schemaVersion === 6 ? 'qa-board-teamwork/v2' : 'qa-board-teamwork/v1',
    ...(schemaVersion === 6 ? {
      boardKind: 'team-qa-board',
      sourceItems: [{
        id: 'SRC-REQ-1', kind: 'spec', sourceSystem: 'fixture-spec', externalKey: 'REQ-1',
        title: 'Release-truth fixture requirement', origin: 'upstream',
      }],
    } : {}),
    rev: 1,
    boardId: 'release-truth-fixture',
    title: 'Bộ kiểm chứng cổng nghiệm thu QA GUI',
    boardCreated: '2026-08-18T02:30:00.000Z',
    language: 'vi', deepCheck: 'available', app: 'qa-gui-fixture', envDb: 'TEST fixture DB',
    viewport: '1280x800', currentRound: 1,
    runUuid: RUN_UUID,
    commit: COMMIT,
    build: options.blankBuild ? '' : 'qa-gui-test-build',
    env: 'TEST', db: 'fixture-db', role: 'qa-agent', testProfile: 'release-truth-v1',
    cases: [boardCase], defects: [],
    rounds: [{ round: 1, startedAt: '2026-08-18T02:30:00.000Z', scope: 'Tái hiện sự cố và kiểm chứng cổng nghiệm thu' }],
    coverage: baseCoverage(), untested: [],
    release: { verdict: options.releaseVerdict || 'GO', risks: [] },
    evidenceManifest: [manifestEntry(dir, shotRel), manifestEntry(dir, rawRel)],
  };
  if (options.createReceipt !== false) board.evidenceManifest.push(manifestEntry(dir, receiptRel));
  if (options.stateReceipts === false) boardCase.evidence = boardCase.evidence.filter((path) => path !== receiptRel);
  const boardPath = join(dir, 'board.json');
  writeFileSync(boardPath, JSON.stringify(board, null, 2) + '\n');
  return { dir, boardPath, board, boardCase, receipt, receiptRel, rawRel, shotRel };
}

function writeBoard(fixture) {
  writeFileSync(fixture.boardPath, JSON.stringify(fixture.board, null, 2) + '\n');
}

test('QG1 incident replay: six-case schema 4 and 5 boards reject missing state receipts through A05', () => {
  for (const schemaVersion of [4, 5]) {
    const fixture = makeFixture({ schemaVersion, stateReceipts: false });
    for (let index = 2; index <= 6; index += 1) {
      fixture.board.cases.push({
        ...structuredClone(fixture.boardCase),
        id: `TC-0${index}`,
        requirement: `REQ-${index}`,
        requirements: [`REQ-${index}`],
      });
    }
    writeBoard(fixture);
    const result = runGate(fixture.boardPath);
    assert.equal(result.status, 20, result.stderr || result.stdout);
    assert.match(result.stderr, /A05/);
    assert.doesNotMatch(result.stdout, /QA gate: PASS/);
  }
});

test('QG1 A06: a manifest entry whose file is missing fails hard', () => {
  const fixture = makeFixture();
  fixture.board.evidenceManifest.push({ path: 'evidence/missing.bin', sha256: 'c'.repeat(64) });
  writeBoard(fixture);
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /A06.*missing\.bin/);
});

test('QG2 H15: missing schemaVersion is UNGRADED exit 20 with migration guidance', () => {
  const fixture = makeFixture();
  delete fixture.board.schemaVersion;
  writeBoard(fixture);
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 20, result.stderr || result.stdout);
  assert.match(result.stderr, /A17.*H15.*schemaVersion.*migrate/i);
  assert.match(result.stdout, /QA gate: UNGRADED/);
  assert.doesNotMatch(result.stdout, /QA gate: PASS/);
});

test('QG3: a valid board writes a sealed qa-gui receipt with separate statuses', () => {
  const fixture = makeFixture();
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /QA gate: PASS/);
  const receiptPath = join(fixture.dir, '.teamcode/runs', RUN_UUID, 'receipts/qa-gui.receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.schema, 'qa-gui/receipt/v1');
  assert.equal(receipt.execution_status, 'completed');
  assert.equal(receipt.semantic_verdict, 'PASS');
  assert.match(receipt.integrity, HASH);
  const { integrity, ...unsigned } = receipt;
  const actual = createHash('sha256').update(JSON.stringify(canonicalize(unsigned))).digest('hex');
  assert.equal(integrity, actual);
});

test('QG4 H16: release GO names the failed case and open defect', () => {
  const fixture = makeFixture({ functionVerdict: 'FAIL', schemaVersion: 4 });
  fixture.board.defects.push({
    id: 'DF-OPEN', title: 'Lỗi còn mở', caseId: 'TC-01', status: 'TODO', priority: 'P1',
    assignee: 'dev-agent', createdBy: 'qa-agent', repro: 'Chạy fixture.', expected: 'PASS',
    actual: 'FAIL', fixEvidence: [], lastRetestFixEvidenceCount: 0, comments: [], history: [],
    rejectionReason: null,
  });
  writeBoard(fixture);
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /A18.*H16.*TC-01/);
  assert.match(result.stderr, /A18.*H16.*DF-OPEN/);
});

test('QG4: GO-WITH-RISKS requires a named approval', () => {
  const fixture = makeFixture({ releaseVerdict: 'GO-WITH-RISKS' });
  writeBoard(fixture);
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 20, result.stderr || result.stdout);
  assert.match(result.stderr, /GO-WITH-RISKS.*approval/i);
});

test('QG5 A08: write lifecycle without raw network cannot compute Function PASS', () => {
  const fixture = makeFixture({ writeMethod: 'POST', omitNetwork: true });
  const result = runGate(fixture.boardPath);
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /A08.*network/i);
});

test('QG6 A25: mutating network derives behavioral and rejects declared static', () => {
  const fixture = makeFixture({ writeMethod: 'POST', kind: 'static' });
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /A25.*behavioral/i);
});

test('QG7 A09: every declared requirement needs its own assertion', () => {
  const requirements = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];
  const fixture = makeFixture({ requirements, assertionRequirements: ['R1'] });
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  for (const requirement of requirements.slice(1)) assert.match(result.stderr, new RegExp(`A09.*${requirement}`));
});

test('QG8 A11: changing one byte after manifest creation fails verification', () => {
  const fixture = makeFixture();
  appendFileSync(join(fixture.dir, fixture.rawRel), 'tampered\n');
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /A11.*SHA-256.*mismatch/i);
});

test('QG8: a blank runtime binding is UNGRADED', () => {
  const fixture = makeFixture({ blankBuild: true });
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 20, result.stderr || result.stdout);
  assert.match(result.stderr, /build.*UNGRADED|UNGRADED.*build/i);
});

test('QG8: equivalentTo requires identical machine-measured DOM hashes', () => {
  const fixture = makeFixture();
  const secondReceiptRel = 'evidence/TC-02-after-load.state.json';
  const secondReceipt = structuredClone(fixture.receipt);
  secondReceipt.caseId = 'TC-02';
  secondReceipt.domHash = 'd'.repeat(64);
  secondReceipt.equivalentTo = 'TC-01:after-load';
  secondReceipt.equivalenceReason = 'Hai trạng thái có cùng ảnh chụp.';
  secondReceipt.function.assertions[0].requirement_id = 'REQ-2';
  writeFileSync(join(fixture.dir, secondReceiptRel), JSON.stringify(secondReceipt, null, 2) + '\n');
  fixture.board.evidenceManifest.push(manifestEntry(fixture.dir, secondReceiptRel));
  fixture.board.cases.push({
    ...structuredClone(fixture.boardCase),
    id: 'TC-02',
    requirement: 'REQ-2',
    requirements: ['REQ-2'],
    stateReceipts: [{ state: 'after-load', file: secondReceiptRel }],
    evidence: [fixture.shotRel, fixture.rawRel, secondReceiptRel],
    results: [{
      round: 1, functionVerdict: 'PASS', uiVerdict: 'PASS', recordedAt: '2026-08-18T02:42:00.000Z',
      evidence: [fixture.shotRel, fixture.rawRel, secondReceiptRel],
    }],
  });
  writeBoard(fixture);
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /equivalentTo.*domHash/i);
});

test('QG9 L22: unknown fields are UNGRADED and named', () => {
  const fixture = makeFixture();
  fixture.board.stateReceiptz = [];
  writeBoard(fixture);
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 20, result.stderr || result.stdout);
  assert.match(result.stderr, /L22.*stateReceiptz/);
});

test('QG9: the shipped qa-board template is well-formed and, with no case run, UNGRADED', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'qa-gui-template-gate-'));
  const result = runGate(join(root, 'assets/qa-board.html'), cwd);
  assert.equal(result.status, 20, result.stderr || result.stdout);
  assert.match(result.stdout, /QA gate: UNGRADED/);
  // The only issue is the unexecuted run: the template itself stays valid.
  assert.deepEqual(result.stderr.trim().split('\n'), ['UNGRADED CASES_NOT_EXECUTED']);
});

function todoCase(id) {
  return {
    id, title: 'Chưa chạy', requirement: 'REQ-TODO', requirements: ['REQ-TODO'],
    status: 'TODO', priority: 'P2', assignee: 'qa-agent',
    functionVerdict: 'UNGRADED', uiVerdict: 'UNGRADED',
    humanSummary: { function: 'Chưa chạy.', ui: 'Chưa chạy.' },
    machine: { rule: 'UNGRADED', selector: 'replace-with-selector' },
    kind: 'static', states: [], stateReceipts: [], results: [], evidence: [], comments: [], history: [],
  };
}

test('QG12: the shipped example board, every case TODO, is UNGRADED exit 20, never PASS', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'qa-gui-example-gate-'));
  const result = runGate(join(root, 'scripts/teamwork/example-canonical.json'), cwd);
  assert.equal(result.status, 20, result.stderr || result.stdout);
  assert.match(result.stdout, /QA gate: UNGRADED/);
  assert.doesNotMatch(result.stdout, /QA gate: PASS/);
  assert.match(result.stderr, /UNGRADED CASES_NOT_EXECUTED/);
});

test('QG12: a board that declares GO with no case run is UNGRADED exit 20', () => {
  const fixture = makeFixture();
  fixture.board.cases = [todoCase('TC-01')];
  fixture.board.release = { verdict: 'GO', risks: [] };
  writeBoard(fixture);
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 20, result.stderr || result.stdout);
  assert.match(result.stderr, /UNGRADED CASES_NOT_EXECUTED/);
  assert.match(result.stderr, /UNGRADED RELEASE_GO_WITH_TODO_CASES:TC-01/);
  assert.doesNotMatch(result.stdout, /QA gate: PASS/);
});

test('QG12: release GO while a TODO case remains is UNGRADED even when every run case passes', () => {
  const fixture = makeFixture();
  fixture.board.cases.push(todoCase('TC-02'));
  writeBoard(fixture);
  const result = runGate(fixture.boardPath);
  assert.equal(result.status, 20, result.stderr || result.stdout);
  assert.deepEqual(result.stderr.trim().split('\n'), ['UNGRADED RELEASE_GO_WITH_TODO_CASES:TC-02']);
  assert.match(result.stdout, /QA gate: UNGRADED/);

  fixture.board.release = { verdict: 'NO-GO', risks: ['TC-02 chưa chạy.'] };
  writeBoard(fixture);
  const noGo = runGate(fixture.boardPath);
  assert.equal(noGo.status, 0, noGo.stderr || noGo.stdout);
  assert.match(noGo.stdout, /QA gate: PASS/);
});

test('QG10 A16: disconnecting the release-truth checker flips the incident fixture to false PASS', () => {
  const source = readFileSync(defaultGate, 'utf8')
    .replace('"./visual-diff.mjs"', JSON.stringify(pathToFileURL(join(root, 'scripts/visual-diff.mjs')).href))
    .replace('"./teamwork/canonical.mjs"', JSON.stringify(pathToFileURL(join(root, 'scripts/teamwork/canonical.mjs')).href))
    .replace('"./teamwork/board-gates.mjs"', JSON.stringify(pathToFileURL(join(root, 'scripts/teamwork/board-gates.mjs')).href))
    .replace('"./lib/qa-gui-v2.mjs"', JSON.stringify(pathToFileURL(join(root, 'scripts/lib/qa-gui-v2.mjs')).href))
    .replace('"./lib/release-receipt-v2.mjs"', JSON.stringify(pathToFileURL(join(root, 'scripts/lib/release-receipt-v2.mjs')).href))
    .replace('"./lib/release-truth-v2.mjs"', JSON.stringify(pathToFileURL(join(root, 'scripts/lib/release-truth-v2.mjs')).href));
  const marker = 'checkReleaseTruthSemantics(data, boardPath, issues, notes, computed);';
  assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const dir = mkdtempSync(join(tmpdir(), 'qa-gui-a16-mutant-'));
  const mutant = join(dir, 'qa-gate-mutant.mjs');
  writeFileSync(mutant, source.replace(marker, 'void computed; // A16 mutant: checker disconnected'));
  const fixture = makeFixture({ stateReceipts: false });
  const original = runGate(fixture.boardPath, fixture.dir, defaultGate);
  const mutated = runGate(fixture.boardPath, fixture.dir, mutant);
  assert.equal(original.status, 20, original.stderr || original.stdout);
  assert.equal(mutated.status, 0, 'A16 mutation did not disconnect the semantic checker as intended');
  assert.match(mutated.stdout, /QA gate: PASS/);
});

test('QG10: release package ships the incident suite and the default test command runs it once', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packageFiles = JSON.parse(readFileSync(join(root, 'package-files.json'), 'utf8'));
  assert.equal(packageJson.scripts['test:release-truth'], 'node --test --test-concurrency=1 test/qa-gate-release-truth.test.mjs test/session3-release-truth-v2.test.mjs test/session3-mutation.test.mjs');
  assert.equal(packageJson.scripts.test, 'node --test --test-concurrency=1 test/*.test.mjs');
  assert.ok(packageFiles.include.includes('package.json'));
  assert.ok(packageFiles.include.includes('test'));
  assert.ok(packageFiles.include.includes('contracts'));
});

test('QG11: schema 6 gates exact source references and prints deterministic coverage', () => {
  const fixture = makeFixture({ schemaVersion: 6 });
  const valid = runGate(fixture.boardPath);
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);
  assert.match(valid.stdout, /Source traceability: 1 source · 1 case link/);

  fixture.board.cases[0].sourceRefs = ['SRC-UNKNOWN'];
  writeBoard(fixture);
  const unknown = runGate(fixture.boardPath);
  assert.equal(unknown.status, 20, unknown.stderr || unknown.stdout);
  assert.match(unknown.stderr, /cases\[0\]\.sourceRefs\[0\].*unknown source ref SRC-UNKNOWN/);
  assert.match(unknown.stdout, /QA gate: UNGRADED/);
});

// L1: the receipt went to <cwd>/.teamcode, which is inside the plugin cache or a skill install when the gate runs from
// there.
test('a gate run from inside a plugin or skill install writes its receipt next to the board', () => {
  const fixture = makeFixture();
  const home = mkdtempSync(join(tmpdir(), 'qa-gui-receipt-home-'));
  for (const inside of [join(home, '.claude', 'plugins', 'cache', 'agentpro', 'team-qa', '1.15.2', 'skills', 'qa-gui'), join(home, '.agents', 'skills', 'qa-gui')]) {
    mkdirSync(inside, { recursive: true });
    const result = spawnSync(process.execPath, [gate, fixture.boardPath], { cwd: inside, encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const receipt = join(dirname(fixture.boardPath), '.teamcode/runs', RUN_UUID, 'receipts/qa-gui.receipt.json');
    assert.ok(readFileSync(receipt, 'utf8').includes(RUN_UUID), 'the receipt is next to the board');
    assert.equal(spawnSync('find', [inside, '-name', '*.receipt.json'], { encoding: 'utf8' }).stdout.trim(), '', `no receipt inside ${inside}`);
    assert.match(result.stdout, new RegExp(`Receipt: ${dirname(fixture.boardPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});
