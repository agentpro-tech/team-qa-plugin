import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { sha256File } from '../../scripts/lib/core.mjs';

const root = new URL('../../', import.meta.url).pathname;
const support = join(root, 'test/qa-board-teamwork/support');
// Synthetic CLI wiring fixtures, not an approved roster, role proof or quality review.
// Only the run-contract and authenticated-review dependencies are replaced in a temp copy.
function setup() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'tq-plan-board-')));
  const candidate = join(cwd, 'candidate');
  for (const path of ['scripts', 'schemas']) cpSync(join(root, path), join(candidate, path), { recursive: true });
  cpSync(join(support, 'board-quality-fixture.mjs'), join(candidate, 'scripts/lib/board-quality.mjs'));
  writeFileSync(join(candidate, 'scripts/lib/run-contract.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function assertRunContract({ runDir, action }) {
  appendFileSync(process.env.TEAMQA_TEST_CALL_LOG, JSON.stringify({tool:'run-contract-fixture',runDir,action})+'\\n');
  const state=JSON.parse(readFileSync(join(runDir,'phase.json'),'utf8'));
  const allowed=action==='plan' ? ['PLAN','SIGN'] : action==='design' ? ['SIGN','DESIGN'] : ['EXECUTE'];
  if(!allowed.includes(state.phase)) throw Object.assign(new Error('RUN_PHASE_REQUIRED '+action),{code:'RUN_PHASE_REQUIRED',exitCode:3});
  if(action==='design' && !state.fixtureDesigner) throw Object.assign(new Error('ROLE_ATTESTATION_MISSING designer'),{code:'ROLE_ATTESTATION_MISSING',exitCode:3});
  return { runDir };
}
export const assertArtifactPath=()=>{};
export const lockRunDocuments=()=>{};
export const transitionRun=()=>{};
export const readLockedRunDocuments=()=>{};
`);
  const run = join(cwd, 'runs', 'draft-test');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'phase.json'), JSON.stringify({ phase: 'PLAN' }));
  return { cwd, run, board: join(run, 'qa-board.json'), log: join(cwd, 'calls.jsonl'), cli: join(candidate, 'scripts/teamqa.mjs') };
}
function cli(p, ...args) {
  const r = spawnSync(process.execPath, [p.cli, ...args], { cwd: p.cwd, encoding: 'utf8', env: {
    ...process.env, TEAMQA_TEST_CALL_LOG: p.log,
    TEAMQA_QA_GUI_BOARD_TOOL: join(support, 'qa-board-tool-stub.mjs'),
    TEAMQA_QA_GUI_BOARD_RENDERER: join(support, 'doc-colab-renderer-stub.mjs'),
    TEAMQA_DOC_COLAB_SCRIPT: join(support, 'doc-colab-stub.py'),
    TEAMQA_OPEN_CMD: JSON.stringify([process.execPath, join(support, 'open-stub.mjs')]),
  } });
  return { status: r.status, text: r.stdout + r.stderr };
}
function init(p, ...extra) { return cli(p, 'board', 'init', '--run', 'draft-test', '--title', 'Synthetic PLAN draft', '--out', p.board, ...extra); }
function calls(p) { return existsSync(p.log) ? readFileSync(p.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
function pass(r) { assert.equal(r.status, 0, r.text); }

test('PLAN empty board init reaches canonical creation without SIGN or Designer', () => {
  const p = setup();
  pass(init(p));
  assert.deepEqual(JSON.parse(readFileSync(p.board, 'utf8')).cases, []);
  assert.deepEqual(calls(p).filter(x => x.tool === 'run-contract-fixture').map(x => x.action), ['plan']);
  assert.equal(calls(p).filter(x => x.operation === 'validate').length, 1, 'independent canonical readback');
});

test('PLAN tracked board init stays behind SIGN and Designer', () => {
  const p = setup();
  const r = init(p, '--tracked', join(p.run, 'tracked-plan.json'));
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.text, /RUN_PHASE_REQUIRED design/);
  assert.equal(existsSync(p.board), false);
  assert.equal(calls(p).some(x => x.operation === 'init'), false);
  writeFileSync(join(p.run, 'phase.json'), JSON.stringify({ phase: 'SIGN' }));
  const unsignedDesigner = init(p, '--tracked', join(p.run, 'tracked-plan.json'));
  assert.match(unsignedDesigner.text, /ROLE_ATTESTATION_MISSING designer/);
  assert.equal(existsSync(p.board), false);
});

test('governed init cannot overwrite an existing empty or nonempty canonical board', () => {
  for (const cases of [[], [{ id: 'smuggled-case', status: 'PASS' }]]) {
    const p = setup(), before = JSON.stringify({ cases });
    writeFileSync(p.board, before);
    const r = init(p);
    assert.notEqual(r.status, 0, r.text);
    assert.match(r.text, /BOARD_OUTPUT_EXISTS/);
    assert.equal(readFileSync(p.board, 'utf8'), before);
    assert.equal(calls(p).some(x => x.operation === 'init'), false);
  }
});

test('explicit output parent and run identity both retain their contract guards', () => {
  const p = setup(), other = join(p.cwd, 'runs', 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'phase.json'), JSON.stringify({ phase: 'EXECUTE' }));
  const r = cli(p, 'board', 'init', '--run', 'draft-test', '--title', 'Synthetic', '--out', join(other, 'draft.json'));
  assert.match(r.text, /RUN_PHASE_REQUIRED plan/);
  assert.equal(existsSync(join(other, 'draft.json')), false);
  assert.deepEqual(calls(p).filter(x => x.tool === 'run-contract-fixture').map(x => x.runDir), [p.run, other]);
});

test('PLAN draft render and open retain quality, seal and independent readback checks', () => {
  const p = setup();
  pass(init(p));
  const html = join(p.cwd, 'index.html'), review = join(p.cwd, 'review.fixture.json');
  const missingReview = cli(p, 'board', 'render', '--file', p.board, '--out', html);
  assert.match(missingReview.text, /BOARD_QUALITY_REVIEW_REQUIRED/);
  assert.equal(existsSync(html), false);
  writeFileSync(review, JSON.stringify({ fixture: 'board-quality-cli-contract-test', board_sha256: sha256File(p.board) }));
  pass(cli(p, 'board', 'render', '--file', p.board, '--out', html, '--quality-review', review));
  pass(cli(p, 'board', 'verify', '--file', p.board, '--artifact', html));
  pass(cli(p, 'board', 'open', '--file', html, '--canonical', p.board));
  const actions = calls(p).map(x => x.operation ?? x.tool);
  assert.ok(actions.includes('verify-review') && actions.includes('seal') && actions.includes('verify-delivery') && actions.includes('open'));
  const opens = actions.filter(x => x === 'open').length;
  writeFileSync(html, readFileSync(html, 'utf8') + '<!-- tampered -->');
  const tampered = cli(p, 'board', 'open', '--file', html, '--canonical', p.board);
  assert.notEqual(tampered.status, 0, tampered.text);
  assert.match(tampered.text, /BOARD_QUALITY_DELIVERY_STALE/);
  assert.equal(calls(p).filter(x => x.tool === 'open').length, opens);
  assert.deepEqual(JSON.parse(readFileSync(p.board, 'utf8')).cases, []);
});

test('PLAN draft exception does not authorize canonical verdict updates', () => {
  const p = setup();
  pass(init(p));
  const before = readFileSync(p.board, 'utf8');
  const r = cli(p, 'board', 'apply', '--file', p.board, '--change', join(p.cwd, 'uncreated-change.json'), '--actor', 'fixture');
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.text, /RUN_PHASE_REQUIRED intake/);
  assert.equal(readFileSync(p.board, 'utf8'), before);
  assert.equal(calls(p).some(x => x.operation === 'apply'), false);
});

test('real contract still rejects a draft without an approved roster', () => {
  const p = setup();
  const result = spawnSync(process.execPath, [join(root, 'scripts/teamqa.mjs'), 'board', 'init', '--run', 'draft-test', '--title', 'Unsigned fixture', '--out', p.board], { cwd: p.cwd, encoding: 'utf8' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /ROSTER_(MISSING|NOT_APPROVED|UNAPPROVED)/);
  assert.equal(existsSync(p.board), false);
});
