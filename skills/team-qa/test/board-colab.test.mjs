// C8: a QA board published to Doc-Colab. A stand-in Doc-Colab server checks the requests the publish makes; the
// readback comparison and the offline receipt check must catch a doc that no longer says what the board says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  colabBody, colabConfig, colabDocId, compareColab, evidenceFiles, publishColab, verifyColabReadback,
} from '../scripts/lib/board-colab.mjs';

const KEY = 'dc_agent_' + 'k'.repeat(32);
// A 1x1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e2a8f1b40000000049454e44ae426082', 'hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'board-colab-'));
  const runDir = join(root, 'runs', 'run-c8');
  const boardDir = join(runDir, 'board');
  mkdirSync(join(boardDir, 'evidence'), { recursive: true });
  writeFileSync(join(boardDir, 'evidence', 'menu.png'), PNG);
  const board = JSON.parse(readFileSync(new URL('./fixtures/board-quality/positive.json', import.meta.url), 'utf8'));
  board.boardId = 'run-c8';
  board.cases[0].evidence = [{ id: 'EV-1', type: 'image', path: 'evidence/menu.png', caption: 'Menu at 375px' }];
  board.defects[0].evidence = [{ id: 'EV-2', type: 'image', path: 'evidence/menu.png' }, { id: 'EV-3', type: 'image', path: 'evidence/missing.png' }];
  const boardFile = join(boardDir, 'qa-board.json');
  writeFileSync(boardFile, JSON.stringify(board));
  return { root, runDir, boardDir, boardFile, board };
}

// Just enough of Doc-Colab: docs by id, PUT with a base revision, file uploads. `mangle` alters what it stores.
async function fakeColab({ mangle } = {}) {
  const docs = new Map();
  const seen = { uploads: 0, puts: 0, auth: new Set() };
  const server = createServer(async (req, res) => {
    seen.auth.add(req.headers.authorization);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'LOGIN_REQUIRED' });
    const m = /^\/api\/docs\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const d = docs.get(decodeURIComponent(m[1]));
      return d ? send(200, { ...d, role: 'owner' }) : send(404, { error: 'NOT_FOUND' });
    }
    if (req.method === 'POST' && url.pathname === '/api/docs') {
      const input = JSON.parse(raw.toString('utf8'));
      if (docs.has(input.id)) return send(409, { error: 'DOC_EXISTS' });
      docs.set(input.id, { id: input.id, template: input.body.template, rev: 1, body: input.body, channel: input.channel, visibility: input.visibility });
      return send(201, { id: input.id, rev: 1 });
    }
    if (req.method === 'PUT' && m) {
      const d = docs.get(decodeURIComponent(m[1]));
      const input = JSON.parse(raw.toString('utf8'));
      if (input.baseRev !== d.rev) return send(409, { error: 'REV_CONFLICT' });
      seen.puts += 1;
      d.rev += 1;
      d.body = mangle ? mangle(structuredClone(input.body)) : input.body;
      return send(200, { id: d.id, rev: d.rev });
    }
    if (req.method === 'POST' && url.pathname === '/api/assets') {
      seen.uploads += 1;
      assert.equal(req.headers['content-type'], 'image/png');
      assert.ok(docs.has(url.searchParams.get('docId')), 'evidence goes to the run doc');
      return send(201, { url: `/a/f_${seen.uploads}.png` });
    }
    return send(404, { error: 'NOT_FOUND' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, docs, seen, close: () => new Promise((r) => server.close(r)) };
}

test('the board becomes one task-board: cases then defects, verdicts, steps, findings and evidence', () => {
  const { board } = fixture();
  const urls = { 'TC-01:EV-1': { url: '/a/f_1.png', mime: 'image/png', sha256: 'x' } };
  const body = colabBody(board, { runId: 'run-c8', version: '9.9.9', canonicalSha256: 'abc', urls });
  assert.equal(body.template, 'task-board');
  assert.equal(body.notifyOwner, true);
  assert.deepEqual(body.tasks.map((t) => [t.id, t.status, t.fields.kind]), [['TC-01', 'TODO', 'Case'], ['DF-01', 'BLOCKED', 'Defect']]);
  const tc = body.tasks[0];
  assert.equal(tc.fields.function, 'UNGRADED');
  assert.equal(tc.fields.requirement, 'REQ-QTY-01');
  assert.equal(tc.detail['Expected result'], board.cases[0].expected);
  assert.deepEqual(tc.fields.evidence, [{ img: '/a/f_1.png', label: 'Menu at 375px' }]);
  const df = body.tasks[1];
  assert.equal(df.fields.case, 'TC-01');
  assert.match(df.detail['Findings'], /isolated-cart-items/);
  assert.equal(df.fields.evidence, undefined, 'evidence that was not uploaded is left out, not linked to a local path');
  assert.ok(body.props.some((p) => p.label === 'Source' && p.value === 'Team QA 9.9.9 · run run-c8 · rev 0'));
  assert.equal(colabDocId('run-c8'), 'qa-run-c8');
  assert.equal(colabDocId('a b/c'), 'qa-a-b-c');
});

test('evidence: images next to the board are found; missing files and remote links are skipped', () => {
  const { board, boardFile, runDir } = fixture();
  board.cases[0].evidence.push({ id: 'EV-9', type: 'image', path: 'https://example.com/x.png' });
  const files = evidenceFiles(board, { boardFile, runDir });
  assert.deepEqual(files.map((f) => f.key), ['TC-01:EV-1', 'DF-01:EV-2']);
  assert.ok(files.every((f) => f.mime === 'image/png'));
});

test('publish: creates the run doc, uploads each file once, reads back 100%; a new revision updates the same doc', async () => {
  const colab = await fakeColab();
  try {
    const { board, boardFile, runDir } = fixture();
    const cfg = { base: colab.base, key: KEY };
    const first = await publishColab({ board, boardFile, runDir, runId: 'run-c8', version: '9.9.9', canonicalSha256: 'abc', channel: 'qa-jobs', cfg });
    assert.equal(first.id, 'qa-run-c8');
    assert.equal(first.url, `${colab.base}/d/qa-run-c8`);
    assert.equal(first.comparison.matchPercent, 100);
    assert.equal(colab.seen.uploads, 1, 'the same image used twice is uploaded once');
    const stored = colab.docs.get('qa-run-c8');
    assert.equal(stored.channel, 'qa-jobs');
    assert.equal(stored.visibility, 'channel');
    assert.deepEqual(stored.body.tasks[1].fields.evidence, [{ img: '/a/f_1.png', label: 'EV-2' }]);

    board.cases[0].status = 'PASS';
    board.rev = 1;
    const known = Object.fromEntries(Object.values(first.urls).map((e) => [e.sha256, e.url]));
    const second = await publishColab({ board, boardFile, runDir, runId: 'run-c8', version: '9.9.9', canonicalSha256: 'def', cfg, known });
    assert.equal(second.id, first.id);
    assert.equal(colab.docs.size, 1);
    assert.equal(colab.seen.uploads, 1, 'a re-publish reuses uploaded files');
    assert.equal(colab.docs.get('qa-run-c8').body.tasks[0].status, 'PASS');
    assert.deepEqual([...colab.seen.auth], [`Bearer ${KEY}`]);
  } finally { await colab.close(); }
});

test('publish fails when Doc-Colab stores something other than the board', async () => {
  const colab = await fakeColab({ mangle: (body) => { body.tasks[1].status = 'FIXED'; return body; } });
  try {
    const { board, boardFile, runDir } = fixture();
    await assert.rejects(
      publishColab({ board, boardFile, runDir, runId: 'run-c8', version: '9.9.9', canonicalSha256: 'abc', cfg: { base: colab.base, key: KEY } }),
      (err) => err.code === 'BOARD_COLAB_READBACK_MISMATCH' && /DF-01/.test(err.detail));
  } finally { await colab.close(); }
});

test('a store that reorders object keys (Postgres JSONB) still reads back 100%', async () => {
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().reverse().map((k) => [k, sortKeys(v[k])])) : v);
  const colab = await fakeColab({ mangle: sortKeys });
  try {
    const { board, boardFile, runDir } = fixture();
    const out = await publishColab({ board, boardFile, runDir, runId: 'run-c8', version: '9.9.9', canonicalSha256: 'abc', cfg: { base: colab.base, key: KEY } });
    assert.equal(out.comparison.matchPercent, 100);
  } finally { await colab.close(); }
});

test('a wrong key is not a product verdict, and the key never appears in the error', async () => {
  const colab = await fakeColab();
  try {
    const { board, boardFile, runDir } = fixture();
    const bad = 'dc_agent_' + 'z'.repeat(32);
    await assert.rejects(publishColab({ board, boardFile, runDir, runId: 'run-c8', version: '9', canonicalSha256: 'a', cfg: { base: colab.base, key: bad } }),
      (err) => err.verdict === 'ungraded' && !String(err.detail).includes(bad) && !String(err.message).includes(bad));
  } finally { await colab.close(); }
});

test('offline check: the saved readback must still equal the board', () => {
  const { board } = fixture();
  const urls = { 'TC-01:EV-1': { url: '/a/f_1.png', mime: 'image/png', sha256: 'x' } };
  const receipt = { run_id: 'run-c8', version: '9.9.9', board: { sha256: 'abc' }, evidence: urls };
  const readback = colabBody(board, { runId: 'run-c8', version: '9.9.9', canonicalSha256: 'abc', urls });
  assert.equal(verifyColabReadback({ board, receipt, readback }).ok, true);
  const edited = structuredClone(readback);
  edited.tasks[0].fields.function = 'PASS';
  const cmp = verifyColabReadback({ board, receipt, readback: edited });
  assert.equal(cmp.ok, false);
  assert.deepEqual(cmp.mismatches, [{ id: 'TC-01', field: 'fields' }]);
  const dropped = structuredClone(readback);
  dropped.tasks.pop();
  assert.ok(compareColab(readback, dropped).mismatches.some((m) => m.field === 'missing'));
});

test('config: key from env, from a file, or refused; never echoed', () => {
  const home = mkdtempSync(join(tmpdir(), 'colab-home-'));
  assert.deepEqual(colabConfig({ env: { COLAB_KEY: KEY, COLAB_URL: 'https://docs.example/' }, home }), { base: 'https://docs.example', key: KEY });
  const file = join(home, 'qa.key');
  writeFileSync(file, KEY + '\n');
  assert.equal(colabConfig({ keyFile: file, env: { COLAB_KEY: 'ignored' }, home }).key, KEY);
  assert.throws(() => colabConfig({ env: {}, home }), (err) => err.code === 'BOARD_COLAB_KEY_MISSING' && err.verdict === 'ungraded');
  writeFileSync(file, 'sk-not-a-colab-key');
  assert.throws(() => colabConfig({ keyFile: file, env: {}, home }), (err) => err.code === 'BOARD_COLAB_KEY_INVALID' && !String(err.detail).includes('sk-not'));
  mkdirSync(join(home, '.config', 'doc-colab'), { recursive: true });
  writeFileSync(join(home, '.config', 'doc-colab', 'config.json'), JSON.stringify({ url: 'https://colab.example' }));
  writeFileSync(join(home, '.config', 'doc-colab', 'key'), KEY);
  assert.deepEqual(colabConfig({ env: {}, home }), { base: 'https://colab.example', key: KEY });
});
