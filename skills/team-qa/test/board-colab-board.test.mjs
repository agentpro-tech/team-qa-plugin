// 1.18: the QA board as a Doc-Colab task board with a live overview page. A stand-in Doc-Colab keeps boards, tasks
// and docs the way the real server answers; the publish must write every card, keep cards people added, archive
// (never delete) a card whose case left the board, and stop when the readback differs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { colabBoardSpec, colabIds, colabOverviewBlocks, compareColabBoard, publishColabRun, verifyColabDelivery } from '../scripts/lib/board-colab.mjs';

const KEY = 'dc_agent_' + 'q'.repeat(32);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201e2a8f1b40000000049454e44ae426082', 'hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'board-colab2-'));
  const runDir = join(root, 'runs', 'run-b18');
  mkdirSync(join(runDir, 'board', 'evidence'), { recursive: true });
  writeFileSync(join(runDir, 'board', 'evidence', 'shot.png'), PNG);
  const board = JSON.parse(readFileSync(new URL('./fixtures/board-quality/positive.json', import.meta.url), 'utf8'));
  board.boardId = 'run-b18';
  board.cases.push({ ...board.cases[0], id: 'TC-02', status: 'PASS', functionVerdict: 'PASS', uiVerdict: 'PASS', priority: 'P1',
    evidence: [{ id: 'EV-1', type: 'image', path: 'evidence/shot.png', caption: 'Total at 375px' }] });
  const boardFile = join(runDir, 'board', 'qa-board.json');
  writeFileSync(boardFile, JSON.stringify(board));
  return { runDir, board, boardFile };
}

async function fakeColab({ mangleTask } = {}) {
  const docs = new Map(); const tasks = new Map(); const seen = { archived: [], uploads: 0 };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const input = chunks.length && /json/.test(req.headers['content-type'] || '') ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const url = new URL(req.url, 'http://x');
    const send = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'LOGIN_REQUIRED' });
    let m;
    if (req.method === 'POST' && url.pathname === '/api/boards') { docs.set(input.id, { id: input.id, template: 'board', rev: 1, body: input.body }); return send(201, { id: input.id }); }
    if (req.method === 'POST' && url.pathname === '/api/docs') { docs.set(input.id, { id: input.id, template: input.body.template, rev: 1, parentId: input.parentId, body: { ...input.body, blocks: input.body.blocks.map((b) => ({ ...b, ai: { by: 'agent' } })) } }); return send(201, { id: input.id }); }
    if ((m = /^\/api\/docs\/([^/]+)$/.exec(url.pathname))) {
      const d = docs.get(decodeURIComponent(m[1]));
      if (req.method === 'GET') return d ? send(200, { ...d, role: 'owner' }) : send(404, { error: 'NOT_FOUND' });
      if (input.baseRev !== d.rev) return send(409, { error: 'REV_CONFLICT' });
      d.rev += 1; d.body = input.body; return send(200, { id: d.id, rev: d.rev });
    }
    if ((m = /^\/api\/boards\/([^/]+)\/tasks$/.exec(url.pathname))) {
      const b = decodeURIComponent(m[1]);
      if (req.method === 'GET') return send(200, { board: docs.get(b), tasks: [...tasks.values()].filter((t) => t.board === b && !t.archived) });
      tasks.set(input.id || `k_${tasks.size}`, { id: input.id || `k_${tasks.size}`, board: b, rev: 1, title: input.title, status: input.status || 'todo', props: input.props || {}, description: input.description || null });
      return send(201, { id: input.id });
    }
    if ((m = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname)) && req.method === 'PATCH') {
      const t = tasks.get(decodeURIComponent(m[1]));
      if (input.baseRev !== t.rev) return send(409, { error: 'TASK_CONFLICT' });
      Object.assign(t, mangleTask ? mangleTask(structuredClone(input.set)) : input.set); t.rev += 1; return send(200, t);
    }
    if ((m = /^\/api\/tasks\/([^/]+)\/archive$/.exec(url.pathname))) { tasks.get(decodeURIComponent(m[1])).archived = true; seen.archived.push(m[1]); return send(201, { ok: true }); }
    if (url.pathname === '/api/assets') { seen.uploads += 1; return send(201, { url: `/a/f_${seen.uploads}.png` }); }
    return send(404, { error: 'NOT_FOUND' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, docs, tasks, seen, close: () => new Promise((r) => server.close(r)) };
}

test('the board maps to Doc-Colab statuses, columns and cards; ids are fixed per run', () => {
  const { board } = fixture();
  const spec = colabBoardSpec(board, { runId: 'run-b18', version: '1.18.0', canonicalSha256: 'a' });
  assert.deepEqual(spec.statuses.map((s) => s.key), ['todo', 'blocked', 'pass'], 'only the statuses the board uses, with TODO and PASS');
  assert.ok(spec.properties.some((p) => p.key === 'qaprio' && p.name === 'Priority'), 'priority is a column of its own');
  assert.deepEqual(spec.tasks.map((t) => [t.props.qaid, t.props.kind, t.status]), [['TC-01', 'case', 'todo'], ['TC-02', 'case', 'pass'], ['DF-01', 'defect', 'blocked']]);
  assert.equal(spec.tasks[0].id, colabIds('run-b18').task('TC-01'));
  assert.ok(spec.tasks[0].id.startsWith(colabIds('run-b18').prefix));
  const overview = colabOverviewBlocks(spec);
  assert.deepEqual(overview.filter((b) => b.type === 'live').map((b) => b.where || b.items.map((x) => x.where).join(',')),
    ['p:kind=case,p:kind=case,p:kind=defect,p:kind=defect', 'p:kind=case', 'p:kind=defect']);
});

test('publish writes the board, cards and overview; republish moves cards, keeps people\'s cards, archives a gone case', async () => {
  const { runDir, board, boardFile } = fixture();
  const colab = await fakeColab();
  try {
    const cfg = { base: colab.base, key: KEY };
    const first = await publishColabRun({ board, boardFile, runDir, runId: 'run-b18', version: '1.18.0', canonicalSha256: 'a', cfg });
    assert.equal(first.form, 'board');
    assert.equal(first.comparison.matchPercent, 100);
    assert.equal(colab.seen.uploads, 1);
    const ids = colabIds('run-b18');
    assert.ok(colab.docs.get(ids.overview).parentId === ids.board, 'overview sits under the board');
    colab.tasks.set('k_people', { id: 'k_people', board: ids.board, rev: 1, title: 'Added by a developer', status: 'todo', props: {} });
    board.cases = board.cases.filter((c) => c.id !== 'TC-02');
    board.defects[0].status = 'RETEST';
    board.rev += 1;
    writeFileSync(boardFile, JSON.stringify(board));
    const second = await publishColabRun({ board, boardFile, runDir, runId: 'run-b18', version: '1.18.0', canonicalSha256: 'b', cfg, known: first.uploaded });
    assert.equal(second.comparison.matchPercent, 100);
    assert.deepEqual(colab.seen.archived, [ids.task('TC-02')], 'only the gone case is archived');
    assert.equal(colab.tasks.get(ids.task('DF-01')).status, 'retest');
    assert.ok(!colab.tasks.get('k_people').archived);
    const receipt = { form: 'board', run_id: 'run-b18', version: '1.18.0', board: { sha256: 'b' }, evidence: second.urls };
    assert.equal(verifyColabDelivery({ board, receipt, readback: second.readback }).ok, true);
    const edited = structuredClone(second.readback); edited.tasks.find((t) => t.id === ids.task('DF-01')).title = 'changed by hand';
    assert.equal(verifyColabDelivery({ board, receipt, readback: edited }).ok, false);
  } finally { await colab.close(); }
});

test('a readback that differs stops the publish', async () => {
  const { runDir, board, boardFile } = fixture();
  const colab = await fakeColab({ mangleTask: (set) => ({ ...set, title: 'not what the board says' }) });
  try {
    const cfg = { base: colab.base, key: KEY };
    await publishColabRun({ board, boardFile, runDir, runId: 'run-b18', version: '1.18.0', canonicalSha256: 'a', cfg });
    board.cases[0].title = 'Renamed case'; board.rev += 1;
    await assert.rejects(publishColabRun({ board, boardFile, runDir, runId: 'run-b18', version: '1.18.0', canonicalSha256: 'b', cfg }), /BOARD_COLAB_READBACK_MISMATCH/);
  } finally { await colab.close(); }
});

test('mismatch report names the field', () => {
  const { board } = fixture();
  const spec = colabBoardSpec(board, { runId: 'run-b18', version: '1.18.0', canonicalSha256: 'a' });
  const readback = { board: { body: { statuses: spec.statuses, properties: spec.properties, teamqa: { source: spec.source } } }, tasks: spec.tasks.map((t) => ({ ...t })), overview: { blocks: colabOverviewBlocks(spec) } };
  assert.equal(compareColabBoard(spec, readback).ok, true);
  readback.tasks[1].status = 'fail';
  assert.deepEqual(compareColabBoard(spec, readback).mismatches, [{ id: spec.tasks[1].id, field: 'status' }]);
});
