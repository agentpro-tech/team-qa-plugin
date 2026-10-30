import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sealBoardDelivery } from './qa-board-teamwork/support/board-quality-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'notion-board-env-'));
  const scripts = join(dir, 'scripts'), adapter = join(scripts, 'adapters/notion-board-env.mjs'), helper = join(scripts, 'lib/board-quality.mjs');
  mkdirSync(join(scripts, 'adapters'), { recursive: true }); mkdirSync(join(scripts, 'lib'), { recursive: true });
  const source = readFileSync(join(root, 'scripts/adapters/notion-board-env.mjs'), 'utf8');
  writeFileSync(adapter, source);
  copyFileSync(join(root, 'test/qa-board-teamwork/support/board-quality-fixture.mjs'), helper);
  const canonical = join(dir, 'qa-board.json'), snapshot = join(dir, 'notion-payload.json'), review = join(dir, 'review.fixture.json'), marker = join(dir, 'push-invoked');
  writeFileSync(canonical, JSON.stringify({ boardId: 'fixture-board', rev: 1 }));
  writeFileSync(snapshot, JSON.stringify({ cases: [], defects: [] }));
  writeFileSync(review, JSON.stringify({ fixture: 'board-quality-cli-contract-test', board_sha256: hash(readFileSync(canonical)) }));
  return { dir, adapter, canonical, snapshot, review, marker };
}

function seal(f) { sealBoardDelivery({ file: f.canonical, reviewPath: f.review, artifactPath: f.snapshot, renderer: 'notion' }); }
function run(f, operation, extra = {}) {
  return spawnSync(process.execPath, [f.adapter, operation, ...(extra.args || [])], { encoding: 'utf8', env: {
    ...process.env, TEAMQA_BOARD_PATH: f.canonical, TEAMQA_BOARD_SNAPSHOT: f.snapshot,
    TEAMQA_TEST_CALL_LOG: '', ...extra.env,
  } });
}
function pushCommand(f) {
  return JSON.stringify([process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1],"called")', f.marker]);
}

test('Notion env adapter denies missing or stale delivery before spawning push command', () => {
  const missing = fixture();
  const denied = run(missing, 'push', { env: { TEAMQA_NOTION_BOARD_PUSH_CMD: pushCommand(missing) } });
  assert.equal(denied.status, 5);
  assert.match(denied.stderr, /NOTION_BOARD_QUALITY_UNVERIFIED BOARD_QUALITY_DELIVERY_MISSING/);
  assert.equal(existsSync(missing.marker), false);

  const stale = fixture(); seal(stale); writeFileSync(stale.snapshot, JSON.stringify({ cases: [{ id: 'changed' }], defects: [] }));
  const rejected = run(stale, 'push', { env: { TEAMQA_NOTION_BOARD_PUSH_CMD: pushCommand(stale) } });
  assert.equal(rejected.status, 5);
  assert.match(rejected.stderr, /NOTION_BOARD_QUALITY_UNVERIFIED BOARD_QUALITY_DELIVERY_STALE/);
  assert.equal(existsSync(stale.marker), false);
});

test('Notion env adapter permits only a fixture-verified sealed delivery to reach push', () => {
  const f = fixture(); seal(f);
  const result = run(f, 'push', { env: { TEAMQA_NOTION_BOARD_PUSH_CMD: pushCommand(f) } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(f.marker, 'utf8'), 'called');
});

test('probe and readback retain their existing no-quality adapter contract', () => {
  const f = fixture(), marker = join(f.dir, 'probe-called'), value = { id: 'notion-page-fixture' };
  const probe = run(f, 'probe', { env: { TEAMQA_NOTION_BOARD_PROBE_CMD: pushCommand({ ...f, marker }) } });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.equal(readFileSync(marker, 'utf8'), 'called');
  const out = join(f.dir, 'readback.json');
  const readback = run(f, 'readback', { args: ['--out', out], env: { TEAMQA_NOTION_BOARD_READBACK_CMD: JSON.stringify([process.execPath, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`]) } });
  assert.equal(readback.status, 0, readback.stderr || readback.stdout);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), value);
});
