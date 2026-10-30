import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'scripts/teamqa.mjs');
const qaTool = join(root, 'test/qa-board-teamwork/support/qa-board-tool-stub.mjs');
const renderer = join(root, 'test/qa-board-teamwork/support/qa-board-renderer-stub.mjs');
const docTool = join(root, 'test/qa-board-teamwork/support/doc-colab-stub.py');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'teamqa-final-verify-'));
  const log = join(dir, 'calls.jsonl');
  const canonical = join(dir, 'qa-board.json');
  const artifact = join(dir, 'index.html');
  const board = {
    schemaVersion: 4,
    canonicalVersion: 'qa-board-teamwork/v1',
    boardId: 'final-verify',
    title: 'Final verify',
    revision: 1,
    cases: [],
    defects: [],
    rounds: [],
    coverage: [],
    untested: [],
    release: {},
    history: [],
  };
  writeFileSync(canonical, `${JSON.stringify(board, null, 2)}\n`);
  writeFileSync(artifact, `<html><script id="doc-data">window.DOC_DATA = ${JSON.stringify({ qaBoard: board })};</script></html>`);
  return { dir, log, canonical, artifact, board };
}

function run(paths, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, 'board', 'verify', '--file', paths.canonical, '--artifact', paths.artifact], {
    cwd: paths.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      TEAMQA_QA_GUI_BOARD_TOOL: qaTool,
      TEAMQA_QA_GUI_BOARD_RENDERER: renderer,
      TEAMQA_DOC_COLAB_SCRIPT: docTool,
      TEAMQA_TEST_CALL_LOG: paths.log,
      ...extraEnv,
    },
  });
}

function calls(paths) {
  return readFileSync(paths.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('final board verifier validates canonical, calls qa-gui and confirms exact artifact readback', () => {
  const paths = setup();
  const result = run(paths);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /verdict=pass/);
  assert.match(result.stdout, /integrity=verified/);
  assert.deepEqual(calls(paths).map((entry) => `${entry.tool}:${entry.operation}`), [
    'qa-gui:validate',
    'qa-gui-renderer:verify-existing',
  ]);
});

test('final board verifier fails closed when qa-gui rejects the artifact', () => {
  const paths = setup();
  const result = run(paths, { TEAMQA_TEST_RENDERER_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BOARD_INTEGRITY_FAILED/);
});

test('final board verifier rejects a successful process without one machine verdict', () => {
  const paths = setup();
  const result = run(paths, { TEAMQA_TEST_RENDERER_NO_VERDICT: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BOARD_INTEGRITY_VERDICT_INVALID/);
});

test('final board verifier independently rejects canonical readback mismatch', () => {
  const paths = setup();
  writeFileSync(paths.artifact, `<html><script id="doc-data">window.DOC_DATA = ${JSON.stringify({ qaBoard: { ...paths.board, title: 'workaround' } })};</script></html>`);
  const result = run(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BOARD_RENDER_CANONICAL_MISMATCH/);
});
