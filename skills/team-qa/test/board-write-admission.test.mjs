import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { inspectBoardWrite, prepareBoardWrite, SPACE_CREATE_PAGE_TOOL } from '../scripts/lib/board-write-admission.mjs';
import { boardWriteFixture } from './qa-board-teamwork/support/board-write-fixture.mjs';

function fixture() { return boardWriteFixture(join(mkdtempSync(join(tmpdir(), 'board-write-')), 'runs', 'fixture-run')); }

test('write-request derives exact Page create input from a verified sealed payload', () => {
  const f = fixture(); let verified;
  const out = join(f.runDir, 'second-request.json');
  const request = prepareBoardWrite({ file: f.canonical, artifactPath: f.payload,
    destination: { space_id: 'space-fixture', idempotency_key: 'fixture-key', position: 0 }, out,
    verifyDelivery: args => { verified = args; return { fixture: true }; } });
  assert.deepEqual(verified, { file: realpathSync(f.canonical), artifactPath: realpathSync(f.payload), renderer: 'space' });
  assert.equal(request.schema, 'team-qa/board-write/v1');
  assert.equal(request.tool_name, SPACE_CREATE_PAGE_TOOL);
  assert.deepEqual(request.tool_input, f.toolInput);
  assert.throws(() => prepareBoardWrite({ file: f.canonical, artifactPath: f.payload,
    destination: { space_id: 'space-fixture', content: 'unreviewed' }, out: join(f.runDir, 'bad-request.json'), verifyDelivery: f.verifyDelivery }), /BOARD_WRITE_DESTINATION_FIELDS/);
  assert.throws(() => prepareBoardWrite({ file: f.canonical, artifactPath: f.payload,
    destination: { position: 'start' }, out: join(f.runDir, 'bad-position.json'), verifyDelivery: f.verifyDelivery }), /BOARD_WRITE_DESTINATION_INVALID/);
});

test('registered admission verifies lock refs and exact create request before allowing connector', () => {
  const f = fixture(); let verifyCount = 0;
  const verifyDelivery = args => { verifyCount++; return f.verifyDelivery(args); };
  const result = inspectBoardWrite({ runDir: f.runDir, toolName: SPACE_CREATE_PAGE_TOOL, toolInput: f.toolInput, verifyDelivery });
  assert.equal(result.allowed, true, result.code);
  assert.equal(verifyCount, 1);
  for (const mutate of [
    x => { x.title = 'attacker changed'; },
    x => { x.unreviewed = true; },
    x => { x.initial_blocks[0].markdown = 'different payload'; },
    x => { x.space_id = 'another-space'; },
  ]) {
    const changed = structuredClone(f.toolInput); mutate(changed);
    const denied = inspectBoardWrite({ runDir: f.runDir, toolName: SPACE_CREATE_PAGE_TOOL, toolInput: changed, verifyDelivery });
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 'BOARD_WRITE_TOOL_INPUT_MISMATCH');
  }
  assert.equal(inspectBoardWrite({ runDir: f.runDir, toolName: 'mcp__notion__create_page', toolInput: {} }).code, 'BOARD_CONNECTOR_UNSUPPORTED_PROJECTION');
});

test('realistic roster omits roster_hash and the lock binds its file digest', () => {
  const f = fixture();
  const roster = JSON.parse(readFileSync(join(f.runDir, 'roster.json'), 'utf8'));
  assert.equal(Object.hasOwn(roster, 'roster_hash'), false);
  assert.equal(inspectBoardWrite({ runDir: f.runDir, toolName: SPACE_CREATE_PAGE_TOOL, toolInput: f.toolInput, verifyDelivery: f.verifyDelivery }).allowed, true);
});

test('stale payload, altered locked request, wrong target receipt, or failed quality authentication deny admission', () => {
  const stale = fixture(); appendFileSync(stale.payload, '\n');
  assert.equal(inspectBoardWrite({ runDir: stale.runDir, toolName: SPACE_CREATE_PAGE_TOOL, toolInput: stale.toolInput, verifyDelivery: stale.verifyDelivery }).allowed, false);

  const changedRequest = fixture();
  writeFileSync(changedRequest.requestPath, JSON.stringify({ ...changedRequest.request, tool_input: { ...changedRequest.toolInput, title: 'forged' } }));
  assert.equal(inspectBoardWrite({ runDir: changedRequest.runDir, toolName: SPACE_CREATE_PAGE_TOOL, toolInput: changedRequest.toolInput, verifyDelivery: changedRequest.verifyDelivery }).code, 'RUN_DOCUMENT_STALE');

  const wrongTarget = fixture();
  assert.equal(inspectBoardWrite({ runDir: wrongTarget.runDir, toolName: SPACE_CREATE_PAGE_TOOL, toolInput: wrongTarget.toolInput,
    verifyDelivery: () => { throw Object.assign(new Error('BOARD_DELIVERY_TARGET_MISMATCH'), { code: 'BOARD_DELIVERY_TARGET_MISMATCH' }); } }).code, 'BOARD_DELIVERY_TARGET_MISMATCH');

  const unverified = fixture();
  assert.equal(inspectBoardWrite({ runDir: unverified.runDir, toolName: SPACE_CREATE_PAGE_TOOL, toolInput: unverified.toolInput,
    verifyDelivery: () => { throw Object.assign(new Error('BOARD_QUALITY_REVIEW_NOT_PASS'), { code: 'BOARD_QUALITY_REVIEW_NOT_PASS' }); } }).code, 'BOARD_QUALITY_REVIEW_NOT_PASS');
  assert.ok(JSON.parse(readFileSync(join(unverified.runDir, 'docs-lock.json'), 'utf8')).artifacts.board_quality);
});
