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
