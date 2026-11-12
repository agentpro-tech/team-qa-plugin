// A QA board published to Doc-Colab, the docs server the team uses in Buzz (`teamqa board publish --to colab`).
// The canonical qa-board.json becomes one Doc-Colab task-board: every case and defect is a card people can open,
// comment on and review beside the conversation, with its evidence uploaded to Doc-Colab's file store. The doc id
// is fixed per run, so publishing a new revision updates the same doc and keeps its comments. After writing, the
// doc is read back and compared field by field with what the board says; a mismatch fails the publish.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fail, sha256 } from './core.mjs';

export const COLAB_RECEIPT_SCHEMA = 'teamqa.board.colab/v1';
// A receipt checks a readback in the form it was written: "doc" (1.17, one task-board doc) or "board" (1.18).
export const verifyColabDelivery = ({ board, receipt, readback }) => (receipt.form === 'board' ? verifyColabBoardReadback : verifyColabReadback)({ board, receipt, readback });
const DEFAULT_URL = 'https://docs.agentpro.tech';
const MEDIA = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
const MAX_EVIDENCE_BYTES = 60 * 1024 * 1024;

// Where Doc-Colab is and the agent key to use. The key is read, never printed or written anywhere.
export function colabConfig({ url, keyFile, env = process.env, home = homedir() } = {}) {
  const dir = join(home, '.config', 'doc-colab');
  let conf = {};
  try { conf = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')); } catch {}
  const base = String(url || env.COLAB_URL || conf.url || DEFAULT_URL).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) fail(2, 'BOARD_COLAB_URL_INVALID', base);
  let key = keyFile ? '' : String(env.COLAB_KEY || '').trim();
  if (!key) {
    const path = resolve(keyFile || env.COLAB_KEY_FILE || join(dir, 'key'));
    if (!existsSync(path)) fail(5, 'BOARD_COLAB_KEY_MISSING', `${path} (run: colab login --name "<agent>" --owner "<owner>")`, 'ungraded');
    key = readFileSync(path, 'utf8').trim();
  }
  if (!/^dc_agent_[A-Za-z0-9_-]{16,}$/.test(key)) fail(5, 'BOARD_COLAB_KEY_INVALID', 'not a Doc-Colab agent key', 'ungraded');
  return { base, key };
}

// One doc per run: the same run always lands on the same doc.
export function colabDocId(runId) {
  const id = ('qa-' + String(runId || '')).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  if (id.length < 6) fail(2, 'BOARD_COLAB_RUN_ID', String(runId));
  return id;
}

// Doc-Colab stores bodies in Postgres JSONB, which reorders object keys; compare with keys sorted.
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());
const upper = (v, d) => (text(v) || d).toUpperCase();
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));

function evidenceOf(item, urls) {
  const out = [];
  for (const ev of Array.isArray(item.evidence) ? item.evidence : []) {
    const hit = urls[`${item.id}:${ev.id}`];
    if (!hit) continue;
    const label = text(ev.caption || ev.label || ev.title || ev.id);
    out.push(hit.mime.startsWith('video/') ? { video: hit.url, label } : { img: hit.url, label });
  }
  return out;
}

function caseTask(c, urls) {
  const requirements = Array.isArray(c.requirements) && c.requirements.length ? c.requirements : [c.requirement];
  return {
    id: text(c.id),
    title: text(c.title) || text(c.id),
    status: upper(c.status, 'TODO'),
    note: text(c.humanSummary?.function),
    detail: compact({ 'Steps': text(c.steps), 'Expected result': text(c.expected), 'UI': text(c.humanSummary?.ui) }),
    fields: compact({
      kind: 'Case',
      priority: text(c.priority),
      owner: text(c.assignee),
      function: text(c.functionVerdict),
      ui: text(c.uiVerdict),
      requirement: requirements.map(text).filter(Boolean).join(', '),
      evidence: evidenceOf(c, urls),
    }),
  };
}

function defectTask(d, urls) {
  const findings = (Array.isArray(d.findings) ? d.findings : []).map((f) => text(f.caption)).filter(Boolean);
  return {
    id: text(d.id),
    title: text(d.title) || text(d.id),
    status: upper(d.status, 'OPEN'),
    note: text(d.actual),
    detail: compact({ 'Steps to reproduce': text(d.repro), 'Expected': text(d.expected), 'Actual': text(d.actual), 'Findings': findings.join('\n') }),
    fields: compact({
      kind: 'Defect',
      priority: text(d.priority),
      owner: text(d.assignee),
      case: text(d.caseId),
      evidence: evidenceOf(d, urls),
    }),
  };
}

// The Doc-Colab body for a board. `urls` maps "<case or defect id>:<evidence id>" to an uploaded file.
export function colabBody(board, { runId, version, canonicalSha256, urls = {} }) {
  const release = board.release || {};
  const source = `Team QA ${version} · run ${runId} · rev ${board.rev}`;
  return {
    template: 'task-board',
    title: `QA · ${text(board.title) || text(board.app) || runId}`,
    props: [
      { label: 'App', value: text(board.app) },
      { label: 'Environment', value: [text(board.env), text(board.db)].filter(Boolean).join(' / ') },
      { label: 'Viewport', value: text(board.viewport) },
      { label: 'Build', value: text(board.build) },
      { label: 'Round', value: text(board.currentRound) },
      { label: 'Verdict', value: text(release.verdict) },
      { label: 'Source', value: source },
    ].filter((p) => p.value),
    columns: [
      { key: 'kind', label: 'Kind', type: 'pill' },
      { key: 'priority', label: 'Priority', type: 'pill' },
      { key: 'owner', label: 'Owner', type: 'text' },
      { key: 'function', label: 'Function', type: 'verdict' },
      { key: 'ui', label: 'UI', type: 'verdict' },
      { key: 'requirement', label: 'Requirement', type: 'text' },
      { key: 'case', label: 'Case', type: 'text' },
      { key: 'evidence', label: 'Evidence', type: 'images' },
    ],
    tasks: [...(board.cases || []).map((c) => caseTask(c, urls)), ...(board.defects || []).map((d) => defectTask(d, urls))],
    risks: (Array.isArray(release.risks) ? release.risks : []).map(text).filter(Boolean),
    // Doc-Colab tells the board's owner (the QA agent) about every new comment, not only @mentions.
    notifyOwner: true,
    source: { tool: 'team-qa', version, runId, boardId: board.boardId, rev: board.rev, canonicalSha256 },
  };
}

// What must match after the round trip: every field of every task, in order, and the board-level facts.
export function colabFacts(body) {
  return {
    title: body.title,
    props: body.props,
    risks: body.risks || [],
    source: body.source,
    tasks: (body.tasks || []).map((t) => ({ id: t.id, title: t.title, status: t.status, note: t.note || '', detail: t.detail || {}, fields: t.fields || {} })),
  };
}

export function compareColab(expected, observed) {
  const want = colabFacts(expected);
  const got = colabFacts(observed || {});
  const mismatches = [];
  for (const k of ['title', 'props', 'risks', 'source']) if (canon(want[k]) !== canon(got[k])) mismatches.push({ field: k });
  const byId = new Map(got.tasks.map((t) => [t.id, t]));
  for (const t of want.tasks) {
    const o = byId.get(t.id);
    if (!o) { mismatches.push({ id: t.id, field: 'missing' }); continue; }
    for (const k of ['title', 'status', 'note', 'detail', 'fields']) if (canon(t[k]) !== canon(o[k])) mismatches.push({ id: t.id, field: k });
  }
  if (got.tasks.length !== want.tasks.length) mismatches.push({ field: 'task-count', expected: want.tasks.length, actual: got.tasks.length });
  if (canon(got.tasks.map((t) => t.id)) !== canon(want.tasks.map((t) => t.id))) mismatches.push({ field: 'task-order' });
  const total = 4 + want.tasks.length * 5;
  return { ok: mismatches.length === 0, matchPercent: mismatches.length ? Math.max(0, Math.floor(((total - mismatches.length) / total) * 100)) : 100, matchedFields: total - mismatches.length, totalFields: total, mismatches };
}

// Evidence files a board points at: images and recordings that exist next to the board or in the run folder.
export function evidenceFiles(board, { boardFile, runDir }) {
  const bases = [dirname(boardFile), runDir].filter(Boolean);
  const out = [];
  for (const item of [...(board.cases || []), ...(board.defects || [])]) {
    for (const ev of Array.isArray(item.evidence) ? item.evidence : []) {
      const rel = text(ev.path);
      if (!rel || /^[a-z]+:\/\//i.test(rel)) continue;
      const mime = MEDIA[extname(rel).toLowerCase()];
      if (!mime) continue;
      const path = bases.map((b) => resolve(b, rel)).find((p) => existsSync(p) && statSync(p).isFile());
      if (!path || statSync(path).size > MAX_EVIDENCE_BYTES) continue;
      out.push({ key: `${item.id}:${ev.id}`, path, mime });
    }
  }
  return out;
}

// ---------- the Doc-Colab API, as the agent that owns the key
export function colabClient({ base, key, fetchImpl = globalThis.fetch }) {
  async function call(method, path, { json, raw, type } = {}) {
    const headers = { authorization: `Bearer ${key}` };
    let body;
    if (raw) { headers['content-type'] = type; body = raw; } else if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    let res;
    try { res = await fetchImpl(base + path, { method, headers, body }); } catch (err) { fail(5, 'BOARD_COLAB_UNREACHABLE', `${base}: ${err.message}`, 'ungraded'); }
    const txt = await res.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = { message: txt.slice(0, 200) }; }
    return { status: res.status, data };
  }
  const must = (r, code, ok = [200, 201]) => {
    if (!ok.includes(r.status)) fail(r.status === 401 || r.status === 403 ? 5 : 1, code, `${r.status} ${r.data?.error || ''} ${r.data?.message || ''}`.trim(), r.status === 401 || r.status === 403 ? 'ungraded' : 'fail');
    return r.data;
  };
  return { call, must };
}

// Create or update the run's doc, upload evidence, then read it back. `known` holds files already uploaded by an
// earlier publish of this run (sha256 -> url), so a re-publish does not upload the same file twice.
export async function publishColab({ board, boardFile, runDir, runId, version, canonicalSha256, channel, cfg, known = {}, fetchImpl }) {
  const api = colabClient({ ...cfg, fetchImpl });
  const id = colabDocId(runId);
  const enc = encodeURIComponent;
  const draft = colabBody(board, { runId, version, canonicalSha256 });
  let doc = await api.call('GET', `/api/docs/${enc(id)}`);
  if (doc.status === 404) {
    api.must(await api.call('POST', '/api/docs', { json: { id, body: draft, channel: channel || undefined, visibility: channel ? 'channel' : 'community', communityRole: 'commenter', note: `Team QA ${version}: board rev ${board.rev}` } }), 'BOARD_COLAB_CREATE_FAILED');
    doc = await api.call('GET', `/api/docs/${enc(id)}`);
  }
  const current = api.must(doc, 'BOARD_COLAB_READ_FAILED', [200]);
  if (current.template !== 'task-board') fail(3, 'BOARD_COLAB_DOC_CONFLICT', `${id} is a ${current.template}`);
  if (current.role !== 'owner' && current.role !== 'editor') fail(5, 'BOARD_COLAB_NOT_EDITOR', `${id}: ${current.role}`, 'ungraded');

  const urls = {};
  const uploaded = { ...known };
  for (const f of evidenceFiles(board, { boardFile, runDir })) {
    const bytes = readFileSync(f.path);
    const hash = sha256(bytes);
    if (!uploaded[hash]) {
      const r = api.must(await api.call('POST', `/api/assets?docId=${enc(id)}&filename=${enc(basename(f.path))}`, { raw: bytes, type: f.mime }), 'BOARD_COLAB_UPLOAD_FAILED');
      if (typeof r?.url !== 'string' || !/^\/a\/[A-Za-z0-9_.-]+$/.test(r.url)) fail(1, 'BOARD_COLAB_UPLOAD_INVALID', f.path);
      uploaded[hash] = r.url;
    }
    urls[f.key] = { url: uploaded[hash], mime: f.mime, sha256: hash };
  }
  const body = colabBody(board, { runId, version, canonicalSha256, urls });

  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = api.must(await api.call('GET', `/api/docs/${enc(id)}`), 'BOARD_COLAB_READ_FAILED', [200]);
    if (canon(colabFacts(latest.body)) === canon(colabFacts(body))) break;
    const r = await api.call('PUT', `/api/docs/${enc(id)}`, { json: { body, baseRev: latest.rev, note: `Team QA ${version}: board rev ${board.rev}` } });
    if (r.status === 409 && attempt < 2) continue;
    api.must(r, 'BOARD_COLAB_UPDATE_FAILED');
    break;
  }
  const read = api.must(await api.call('GET', `/api/docs/${enc(id)}`), 'BOARD_COLAB_READ_FAILED', [200]);
  const comparison = compareColab(body, read.body);
  if (!comparison.ok) fail(1, 'BOARD_COLAB_READBACK_MISMATCH', JSON.stringify(comparison.mismatches).slice(0, 300));
  return { id, url: `${cfg.base}/d/${enc(id)}`, rev: read.rev, readback: read.body, urls, uploaded, comparison };
}

// A stored Doc-Colab delivery checked again offline: the same board, the readback that was saved, and that readback
// still equal to the board as Team QA maps it today.
export function verifyColabReadback({ board, receipt, readback }) {
  const urls = receipt.evidence || {};
  const expected = colabBody(board, { runId: receipt.run_id, version: receipt.version, canonicalSha256: receipt.board.sha256, urls });
  return compareColab(expected, readback);
}

// ---------- 1.18: the board as a Doc-Colab task board (Kanban, table, timeline, filters, a comment thread on every
// card) and a live overview page under it. A run published by 1.17 as a single task-board doc keeps that form.

// Canonical status -> Doc-Colab status: [kind, colour]. Keys are the canonical names in lower case.
const STATUS_KIND = {
  TODO: ['todo', 'gray'], DOING: ['doing', 'blue'], ASSIGNED: ['doing', 'blue'], FIXING: ['doing', 'yellow'], RETEST: ['review', 'yellow'],
  FAIL: ['todo', 'red'], BLOCKED: ['todo', 'gray'], REOPENED: ['todo', 'red'],
  PASS: ['done', 'green'], VERIFIED: ['done', 'green'], CLOSED: ['done', 'green'],
  REJECTED: ['cancelled', 'gray'], DEFERRED: ['cancelled', 'gray'],
};
const VERDICT_COLOR = { PASS: 'green', FAIL: 'red', BLOCKED: 'gray', UNGRADED: 'gray' };
const PRIORITY_COLOR = { P0: 'red', P1: 'red', P2: 'orange', P3: 'yellow', P4: 'gray' };
const optKey = (v) => String(v).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40) || 'x';

// Every id Doc-Colab gives this run: the board, its overview page, and one task per case or defect.
export function colabIds(runId) {
  const board = colabDocId(runId);
  const tag = sha256(`teamqa:${runId}`).slice(0, 10);
  return {
    board,
    prefix: `qa${tag}-`,
    overview: `${board.slice(0, 55)}-overview`,
    task: (itemId) => {
      const clean = String(itemId).replace(/[^A-Za-z0-9_-]/g, '-');
      const id = `qa${tag}-${clean}`;
      return id.length <= 64 ? id : `qa${tag}-${sha256(String(itemId)).slice(0, 24)}`;
    },
  };
}

function blocksFor(sections, evidence) {
  const out = [];
  let n = 0;
  const id = () => `d${++n}`;
  for (const [head, body] of sections) {
    if (!body || (Array.isArray(body) && !body.length)) continue;
    out.push({ id: id(), type: 'heading3', text: head });
    out.push(Array.isArray(body) ? { id: id(), type: 'bullet_list', items: body } : { id: id(), type: 'paragraph', text: body });
  }
  for (const ev of evidence) out.push({ id: id(), type: 'image', src: ev.img || ev.video, ...(ev.label ? { caption: ev.label.slice(0, 300) } : {}) });
  return out;
}

// The Doc-Colab board for a QA board: its statuses and columns, the facts shown on the overview, and the tasks.
export function colabBoardSpec(board, { runId, version, canonicalSha256, urls = {} }) {
  const ids = colabIds(runId);
  const release = board.release || {};
  const cases = board.cases || [];
  const defects = board.defects || [];
  const priorities = [...new Set([...cases, ...defects].map((x) => text(x.priority)).filter(Boolean))].sort();
  const select = (key, name, values, colors) => ({ key, name, type: 'select', options: values.map((v) => ({ key: optKey(v), name: v, color: colors[v] || 'gray' })) });
  // Only the statuses this board uses (and TODO and PASS, so the board always has a start and an end): thirteen
  // empty Kanban columns help nobody. A status a later revision brings is added then; one no longer used stays.
  const used = new Set(['TODO', 'PASS', ...[...cases, ...defects].map((x) => upper(x.status, 'TODO'))]);
  const statuses = Object.entries(STATUS_KIND).filter(([code]) => used.has(code)).map(([code, [kind, color]]) => ({ key: code.toLowerCase(), name: code, kind, color }));
  const properties = [
    { key: 'kind', name: 'Kind', type: 'select', options: [{ key: 'case', name: 'Case', color: 'blue' }, { key: 'defect', name: 'Defect', color: 'red' }] },
    { key: 'qaid', name: 'ID', type: 'text' },
    select('qaprio', 'Priority', priorities, PRIORITY_COLOR),   // "priority" is Doc-Colab's own field
    select('function', 'Function', Object.keys(VERDICT_COLOR), VERDICT_COLOR),
    select('ui', 'UI', Object.keys(VERDICT_COLOR), VERDICT_COLOR),
    { key: 'requirement', name: 'Requirement', type: 'text' },
    { key: 'case', name: 'Case', type: 'text' },
    { key: 'owner', name: 'Owner', type: 'text' },
  ];
  const statusOf = (v, d) => { const s = upper(v, d); return STATUS_KIND[s] ? s.toLowerCase() : d.toLowerCase(); };
  const verdict = (v) => { const s = upper(v, 'UNGRADED'); return VERDICT_COLOR[s] ? optKey(s) : 'ungraded'; };
  const tasks = [
    ...cases.map((c) => {
      const requirements = Array.isArray(c.requirements) && c.requirements.length ? c.requirements : [c.requirement];
      return {
        id: ids.task(c.id), title: text(c.title) || text(c.id), status: statusOf(c.status, 'TODO'),
        props: compact({ kind: 'case', qaid: text(c.id), qaprio: text(c.priority) && optKey(text(c.priority)), function: verdict(c.functionVerdict), ui: verdict(c.uiVerdict),
          requirement: requirements.map(text).filter(Boolean).join(', '), owner: text(c.assignee) }),
        description: blocksFor([['Steps', text(c.steps)], ['Expected result', text(c.expected)], ['Function', text(c.humanSummary?.function)], ['UI', text(c.humanSummary?.ui)]], evidenceOf(c, urls)),
      };
    }),
    ...defects.map((d) => {
      const findings = (Array.isArray(d.findings) ? d.findings : []).map((f) => text(f.caption)).filter(Boolean);
      return {
        id: ids.task(d.id), title: text(d.title) || text(d.id), status: statusOf(d.status, 'TODO'),
        props: compact({ kind: 'defect', qaid: text(d.id), qaprio: text(d.priority) && optKey(text(d.priority)), case: text(d.caseId), owner: text(d.assignee) }),
        description: blocksFor([['Steps to reproduce', text(d.repro)], ['Expected', text(d.expected)], ['Actual', text(d.actual)], ['Findings', findings]], evidenceOf(d, urls)),
      };
    }),
  ];
  const facts = compact({
    App: text(board.app), Environment: [text(board.env), text(board.db)].filter(Boolean).join(' / '), Viewport: text(board.viewport),
    Build: text(board.build), Round: text(board.currentRound), Verdict: text(release.verdict),
  });
  return {
    ids, title: `QA · ${text(board.title) || text(board.app) || runId}`, statuses, properties, tasks, facts,
    risks: (Array.isArray(release.risks) ? release.risks : []).map(text).filter(Boolean),
    source: { tool: 'team-qa', version, runId, boardId: board.boardId, rev: board.rev, canonicalSha256 },
  };
}

// The overview page: the run's facts and verdict, then numbers and charts Doc-Colab keeps up to date from the board.
export function colabOverviewBlocks(spec) {
  const b = spec.ids.board;
  const live = (id, v) => ({ id, type: 'live', docId: b, ...v });
  const verdict = spec.facts.Verdict;
  return [
    { id: 'o1', type: 'callout', icon: verdict === 'GO' ? '✅' : verdict ? '⛔' : '🧪', text: `Release verdict: ${verdict || 'not decided yet'}. ${spec.source.tool} ${spec.source.version}, run ${spec.source.runId}, board rev ${spec.source.rev}.` },
    { id: 'o2', type: 'bullet_list', items: Object.entries(spec.facts).filter(([k]) => k !== 'Verdict').map(([k, v]) => `${k}: ${v}`) },
    live('o3', { show: 'numbers', title: 'Cases', items: [
      { measure: 'count', state: 'all', where: 'p:kind=case', label: 'Cases' },
      { measure: 'count', state: 'done', where: 'p:kind=case', label: 'Passed' },
      { measure: 'count', state: 'open', where: 'p:kind=defect', label: 'Open defects' },
      { measure: 'count', state: 'done', where: 'p:kind=defect', label: 'Closed defects' },
    ] }),
    live('o4', { show: 'chart', title: 'Cases by Function verdict', measure: 'count', group: 'p:function', state: 'all', where: 'p:kind=case', kind: 'bar' }),
    live('o5', { show: 'chart', title: 'Open defects by priority', measure: 'count', group: 'p:qaprio', state: 'open', where: 'p:kind=defect', kind: 'bar' }),
    ...(spec.risks.length ? [{ id: 'o6', type: 'heading3', text: 'Risks' }, { id: 'o7', type: 'bullet_list', items: spec.risks }] : []),
  ];
}

const taskFacts = (t) => ({ title: t.title, status: t.status, props: t.props || {}, description: t.description || [] });
// Doc-Colab marks blocks an agent wrote (`ai`: who and when); that mark is not part of what the board says.
const unmarked = (blocks) => (blocks || []).map(({ ai, ...b }) => b);

// Compare what the board should say with what Doc-Colab returned: the columns, every task field, and the overview.
export function compareColabBoard(spec, observed) {
  const mismatches = [];
  const body = observed?.board?.body || {};
  const keys = (list) => (list || []).filter((x) => !x.archived).map((x) => x.key);
  if (canon(keys(body.statuses).slice(0, spec.statuses.length)) !== canon(spec.statuses.map((s) => s.key))) mismatches.push({ field: 'statuses' });
  if (canon(keys(body.properties).slice(0, spec.properties.length)) !== canon(spec.properties.map((p) => p.key))) mismatches.push({ field: 'properties' });
  if (canon(body.teamqa?.source) !== canon(spec.source)) mismatches.push({ field: 'source' });
  const byId = new Map((observed?.tasks || []).map((t) => [t.id, t]));
  for (const t of spec.tasks) {
    const o = byId.get(t.id);
    if (!o) { mismatches.push({ id: t.id, field: 'missing' }); continue; }
    const want = taskFacts(t); const got = taskFacts(o);
    for (const k of ['title', 'status', 'props', 'description']) if (canon(want[k]) !== canon(got[k])) mismatches.push({ id: t.id, field: k });
  }
  // Cards people added to the board themselves are theirs; only Team QA's own cards must match the board.
  const extra = [...byId.keys()].filter((id) => id.startsWith(spec.ids.prefix) && !spec.tasks.some((t) => t.id === id));
  if (extra.length) mismatches.push({ field: 'extra-tasks', ids: extra });
  if (canon(unmarked(observed?.overview?.blocks)) !== canon(colabOverviewBlocks(spec))) mismatches.push({ field: 'overview' });
  const total = 4 + spec.tasks.length * 4;
  return { ok: !mismatches.length, matchPercent: mismatches.length ? Math.max(0, Math.floor(((total - mismatches.length) / total) * 100)) : 100, matchedFields: total - mismatches.length, totalFields: total, mismatches };
}

// Write the board, its tasks and the overview, then read all of it back. Tasks are matched by id, so a new revision
// moves cards and keeps their comments; a case or defect gone from the board is archived, never deleted.
export async function publishColabBoard({ board, boardFile, runDir, runId, version, canonicalSha256, channel, cfg, known = {}, fetchImpl }) {
  const api = colabClient({ ...cfg, fetchImpl });
  const enc = encodeURIComponent;
  const ids = colabIds(runId);
  const first = colabBoardSpec(board, { runId, version, canonicalSha256 });
  const head = (spec) => ({ template: 'board', title: spec.title, statuses: spec.statuses, properties: spec.properties, notifyOwner: true, teamqa: { source: spec.source, facts: spec.facts, risks: spec.risks } });
  let doc = await api.call('GET', `/api/docs/${enc(ids.board)}`);
  if (doc.status === 404) {
    api.must(await api.call('POST', '/api/boards', { json: { id: ids.board, title: first.title, body: head(first), channel: channel || undefined, visibility: channel ? 'channel' : 'community', communityRole: 'commenter', note: `Team QA ${version}: board rev ${board.rev}` } }), 'BOARD_COLAB_CREATE_FAILED');
    doc = await api.call('GET', `/api/docs/${enc(ids.board)}`);
  }
  const current = api.must(doc, 'BOARD_COLAB_READ_FAILED', [200]);
  if (current.template !== 'board') fail(3, 'BOARD_COLAB_DOC_CONFLICT', `${ids.board} is a ${current.template}`);
  if (current.role !== 'owner' && current.role !== 'editor') fail(5, 'BOARD_COLAB_NOT_EDITOR', `${ids.board}: ${current.role}`, 'ungraded');

  const urls = {};
  const uploaded = { ...known };
  for (const f of evidenceFiles(board, { boardFile, runDir })) {
    const bytes = readFileSync(f.path);
    const hash = sha256(bytes);
    if (!uploaded[hash]) {
      const r = api.must(await api.call('POST', `/api/assets?docId=${enc(ids.board)}&filename=${enc(basename(f.path))}`, { raw: bytes, type: f.mime }), 'BOARD_COLAB_UPLOAD_FAILED');
      if (typeof r?.url !== 'string' || !/^\/a\/[A-Za-z0-9_.-]+$/.test(r.url)) fail(1, 'BOARD_COLAB_UPLOAD_INVALID', f.path);
      uploaded[hash] = r.url;
    }
    urls[f.key] = { url: uploaded[hash], mime: f.mime, sha256: hash };
  }
  const spec = colabBoardSpec(board, { runId, version, canonicalSha256, urls });

  // The board's columns and facts (a new priority adds an option), keeping anything people added to the board.
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = api.must(await api.call('GET', `/api/docs/${enc(ids.board)}`), 'BOARD_COLAB_READ_FAILED', [200]);
    const mine = head(spec);
    // Statuses and columns people added to the board stay after Team QA's own.
    const keep = (ours, theirs) => [...ours, ...(theirs || []).filter((x) => !ours.some((o) => o.key === x.key))];
    const want = { ...latest.body, ...mine, statuses: keep(mine.statuses, latest.body.statuses), properties: keep(mine.properties, latest.body.properties) };
    if (canon(want) === canon(latest.body)) break;
    const r = await api.call('PUT', `/api/docs/${enc(ids.board)}`, { json: { body: want, baseRev: latest.rev, note: `Team QA ${version}: board rev ${board.rev}` } });
    if (r.status === 409 && attempt < 2) continue;
    api.must(r, 'BOARD_COLAB_UPDATE_FAILED');
    break;
  }
  const have = api.must(await api.call('GET', `/api/boards/${enc(ids.board)}/tasks`), 'BOARD_COLAB_READ_FAILED', [200]);
  const byId = new Map((have.tasks || []).map((t) => [t.id, t]));
  for (const t of spec.tasks) {
    const o = byId.get(t.id);
    if (!o) {
      api.must(await api.call('POST', `/api/boards/${enc(ids.board)}/tasks`, { json: { id: t.id, title: t.title, status: t.status, props: t.props, description: t.description } }), 'BOARD_COLAB_TASK_FAILED');
      continue;
    }
    const change = {};
    for (const [k, v] of Object.entries(taskFacts(t))) if (canon(v) !== canon(taskFacts(o)[k])) change[k] = v;
    if (Object.keys(change).length) api.must(await api.call('PATCH', `/api/tasks/${enc(t.id)}`, { json: { set: change, baseRev: o.rev, note: `Team QA ${version}: board rev ${board.rev}` } }), 'BOARD_COLAB_TASK_FAILED');
  }
  for (const id of byId.keys()) if (id.startsWith(ids.prefix) && !spec.tasks.some((t) => t.id === id)) api.must(await api.call('POST', `/api/tasks/${enc(id)}/archive`, { json: {} }), 'BOARD_COLAB_TASK_FAILED');

  // The overview page, made once under the board and rewritten when its facts change.
  const blocks = colabOverviewBlocks(spec);
  let ov = await api.call('GET', `/api/docs/${enc(ids.overview)}`);
  if (ov.status === 404) {
    api.must(await api.call('POST', '/api/docs', { json: { id: ids.overview, parentId: ids.board, body: { template: 'doc', title: `Overview · ${spec.title}`, icon: '📊', blocks }, note: `Team QA ${version}: overview` } }), 'BOARD_COLAB_CREATE_FAILED');
  } else {
    const o = api.must(ov, 'BOARD_COLAB_READ_FAILED', [200]);
    if (canon(unmarked(o.body.blocks)) !== canon(blocks)) api.must(await api.call('PUT', `/api/docs/${enc(ids.overview)}`, { json: { body: { ...o.body, blocks }, baseRev: o.rev, note: `Team QA ${version}: overview` } }), 'BOARD_COLAB_UPDATE_FAILED');
  }

  const readBoard = api.must(await api.call('GET', `/api/docs/${enc(ids.board)}`), 'BOARD_COLAB_READ_FAILED', [200]);
  const readTasks = api.must(await api.call('GET', `/api/boards/${enc(ids.board)}/tasks`), 'BOARD_COLAB_READ_FAILED', [200]);
  const readOverview = api.must(await api.call('GET', `/api/docs/${enc(ids.overview)}`), 'BOARD_COLAB_READ_FAILED', [200]);
  const readback = { board: { id: readBoard.id, rev: readBoard.rev, body: readBoard.body }, tasks: (readTasks.tasks || []).map((t) => ({ id: t.id, ...taskFacts(t) })), overview: { id: readOverview.id, rev: readOverview.rev, blocks: readOverview.body.blocks || [] } };
  const comparison = compareColabBoard(spec, readback);
  if (!comparison.ok) fail(1, 'BOARD_COLAB_READBACK_MISMATCH', JSON.stringify(comparison.mismatches).slice(0, 300));
  return { id: ids.board, url: `${cfg.base}/d/${enc(ids.board)}`, overviewUrl: `${cfg.base}/d/${enc(ids.overview)}`, rev: readBoard.rev, readback, urls, uploaded, comparison, form: 'board' };
}

// A stored 1.18 delivery checked again offline: the saved readback still says what the board says.
export function verifyColabBoardReadback({ board, receipt, readback }) {
  const spec = colabBoardSpec(board, { runId: receipt.run_id, version: receipt.version, canonicalSha256: receipt.board.sha256, urls: receipt.evidence || {} });
  return compareColabBoard(spec, readback);
}

// Publish a run's board: a run first published by 1.17 as one task-board doc keeps that form; every other run gets
// a Doc-Colab task board and its overview page.
export async function publishColabRun(args) {
  const api = colabClient({ ...args.cfg, fetchImpl: args.fetchImpl });
  const doc = await api.call('GET', `/api/docs/${encodeURIComponent(colabDocId(args.runId))}`);
  if (doc.status === 200 && doc.data?.template === 'task-board') return { ...(await publishColab(args)), form: 'doc' };
  return publishColabBoard(args);
}
