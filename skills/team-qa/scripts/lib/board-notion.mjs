// Board delivery to Notion through the hosted Notion MCP (upgrade B0, BA "Team QA full-feature upgrade").
//
// Agents used to write a Notion page by hand instead of the board the skill defines. Here the board reaches Notion
// only as exact tool calls that Team QA computes from the canonical qa-board.json:
//
//   1. `teamqa board publish --to notion` seals the QA GUI projection (renderer notion-mcp) with the board review and
//      writes a plan: create the Cases database, create the Defects database, create the rows in batches, then read
//      both databases back with planned queries. It locks the first call as `board-notion/next.json`.
//   2. The agent makes that one call with the JSON of next.json unchanged. In a registered run the hook admits a
//      Notion write only when its input equals the locked call, and records the result.
//   3. `teamqa board publish --next` reads the result (hook record, or the root's original transcript), captures the
//      data source ids, and locks the next call. After the last write it locks the readback queries.
//   4. When every planned query has a result, the readback is compared with a fresh projection of the canonical
//      board (QA GUI compare-notion-mcp); 100% writes `board-notion/receipt.json`, which the run locks as board_notion.
//
// Nothing here talks to Notion: the agent's own Notion MCP connection does, and every write it makes is either a
// planned call or a recorded nonconforming write (auditBoardWrites).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fail, readJson, sha256, sha256File, stableJson } from './core.mjs';
import { scanOriginalSource } from './original-source.mjs';
import { claudeToolPair } from './host-transcript.mjs';

export const NOTION_PLAN_SCHEMA = 'team-qa/board-notion-plan/v1';
export const NOTION_STEP_SCHEMA = 'team-qa/board-notion-step/v1';
export const NOTION_RESULT_SCHEMA = 'team-qa/board-notion-result/v1';
export const NOTION_RECEIPT_SCHEMA = 'team-qa/board-notion-receipt/v1';
export const PAGE_BATCH = 50;
export const READ_PAGE = 100;
// Fields a Notion MCP tool accepts for its own tracking; they never change what the call writes.
const TRACKING_KEYS = ['telemetry', 'skill', 'instructions_version'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requireValue = (ok, code, detail = '') => { if (!ok) fail(3, code, detail, 'ungraded'); };

export const notionDir = (runDir) => join(resolve(runDir), 'board-notion');

// The kind of a Notion MCP tool, whatever the server is called (claude.ai connector, `claude mcp add notion`, Codex
// apps): create-database, create-pages, read, or write (every other Notion tool that changes the workspace).
export function notionToolKind(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
  if (!m) return null;
  const server = m[1], tool = m[2].toLowerCase().replace(/_/g, '-');
  if (!/notion/i.test(server) && !tool.startsWith('notion-')) return null;
  const verb = tool.replace(/^(?:notion-+)+/, '');
  if (verb === 'create-database') return 'create-database';
  if (verb === 'create-pages') return 'create-pages';
  if (/^(?:fetch|search|query|get|list|read|view|download)(?:-|$)/.test(verb)) return 'read';
  return 'write';
}

// Every tool call that can put a board somewhere other than Team QA's own files.
export function boardWriteKind(name) {
  const notion = notionToolKind(name);
  if (notion) return notion === 'read' ? null : `notion-${notion}`;
  const n = String(name || '');
  if (/^mcp__.*claude[_-]?docs.*__(?:batch|update|create|delete)$/i.test(n)) return 'docs-write';
  if (/^mcp__.*google[_-]?drive.*__(?:create_file|update_file|copy_file|share_file)$/i.test(n)) return 'drive-write';
  if (/^mcp__codex_apps__chatgpt_space_{1,2}(?:create_page|update|edit|append|delete|create_visualization|update_visualization)/i.test(n)) return 'space-write';
  return null;
}

// A Notion page id from a 32-hex id, a dashed id or a notion.so / app.notion.com URL.
export function normalizeNotionId(value) {
  const s = String(value || '').trim().toLowerCase();
  const m = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?![0-9a-f])/.exec(s.split('?')[0]);
  requireValue(m, 'BOARD_NOTION_PARENT_INVALID', String(value || ''));
  return `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`;
}

export function stripTracking(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([key]) => !TRACKING_KEYS.includes(key)));
}
export const inputHash = (input) => sha256(stableJson(stripTracking(input)));

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function readbackQuery(database, page) {
  return { data: { mode: 'rows', data_source_url: `collection://{{${database}}}`, sort: [{ property: 'Order', direction: 'ascending' }], limit: READ_PAGE,
    filter: { type: 'group', operator: 'and', filters: [{ type: 'property', property: 'Order', propertyType: 'number', operator: 'number_greater_than', value: { type: 'exact', value: page * READ_PAGE } }] } } };
}

// The plan: write steps in order, then the readback queries. {{cases}} and {{defects}} stand for the data source ids
// that the two create-database results return.
export function buildNotionPlan({ projection, projectionPath, boardPath, runId, parentPageId }) {
  requireValue(projection?.protocol === 'qa-gui/notion-mcp/v1', 'BOARD_NOTION_PROJECTION_INVALID');
  const pageId = normalizeNotionId(parentPageId);
  const steps = [];
  for (const db of ['cases', 'defects']) {
    const d = projection.databases[db];
    steps.push({ tool: 'create-database', database: db, capture: db,
      input: { parent: { page_id: pageId, type: 'page_id' }, title: d.title, description: d.description, schema: d.schema } });
  }
  for (const db of ['cases', 'defects']) {
    for (const rows of chunks(projection.rows[db], PAGE_BATCH)) {
      steps.push({ tool: 'create-pages', database: db, external_ids: rows.map((r) => r.externalId),
        input: { parent: { data_source_id: `{{${db}}}`, type: 'data_source_id' }, allow_async: false, pages: rows.map((r) => ({ properties: r.properties })) } });
    }
  }
  const readback = [];
  for (const db of ['cases', 'defects']) {
    const pages = Math.max(1, Math.ceil(projection.rows[db].length / READ_PAGE));
    for (let page = 0; page < pages; page++) readback.push({ tool: 'read', database: db, page, input: readbackQuery(db, page) });
  }
  return { schema: NOTION_PLAN_SCHEMA, run_id: runId, parent: { page_id: pageId },
    board: { path: resolve(boardPath), sha256: sha256File(boardPath) }, projection: { path: resolve(projectionPath), sha256: sha256File(projectionPath) },
    provenance: projection.provenance, steps: steps.map((s, i) => ({ n: i + 1, ...s })), readback: readback.map((r, i) => ({ n: steps.length + i + 1, ...r })) };
}

export function resolvePlaceholders(value, captures) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(cases|defects)\}\}/g, (_m, db) => {
      requireValue(typeof captures?.[db] === 'string' && UUID.test(captures[db]), 'BOARD_NOTION_CAPTURE_MISSING', db);
      return captures[db];
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, captures));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePlaceholders(v, captures)]));
  return value;
}

// The text of an MCP tool result, as a hook or a transcript gives it.
export function resultText(output) {
  if (typeof output === 'string') return output;
  const blocks = Array.isArray(output) ? output : Array.isArray(output?.content) ? output.content : null;
  if (blocks) return blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  if (output && typeof output === 'object') return JSON.stringify(output);
  return '';
}
function parseResultJson(text) {
  let value = text;
  for (let i = 0; i < 3 && typeof value === 'string'; i++) { try { value = JSON.parse(value); } catch { return null; } }
  return value;
}

// notion-create-database returns Markdown with the data source in <data-source url="{{collection://<id>}}">.
export function parseCreateDatabase(text) {
  const parsed = parseResultJson(String(text || ''));
  const s = typeof parsed?.result === 'string' ? parsed.result : String(text || '');
  const ds = /collection:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s);
  const db = /<database url="\{?\{?(https:\/\/[^"}]+)\}?\}?"/.exec(s);
  return { dataSourceId: ds ? ds[1].toLowerCase() : null, databaseUrl: db ? db[1] : null };
}
export function parseCreatePages(text) {
  const value = parseResultJson(text);
  const pages = Array.isArray(value?.pages) ? value.pages : null;
  return { pages: pages ? pages.map((p) => ({ id: p?.id, url: p?.url })) : null };
}
export function parseQuery(text) {
  const value = parseResultJson(text);
  return { results: Array.isArray(value?.results) ? value.results : null, hasMore: value?.has_more === true };
}

// ---- results of planned calls -------------------------------------------------------------------------------------

// A hook record (registered run, any host): PostToolUse of a call whose input matches a planned call.
export function recordNotionResult({ runDir, toolName, toolUseId, toolInput, toolResponse, at = new Date().toISOString() }) {
  const dir = join(notionDir(runDir), 'results');
  const hash = inputHash(toolInput);
  const text = resultText(toolResponse);
  const isError = toolResponse?.isError === true || toolResponse?.is_error === true;
  mkdirSync(dir, { recursive: true });
  const safeId = String(toolUseId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
  const path = join(dir, `${hash}-${safeId}.json`);
  if (existsSync(path)) return path;
  writeFileSync(path, stableJson({ schema: NOTION_RESULT_SCHEMA, tool_name: toolName, tool_use_id: toolUseId ?? null, input_sha256: hash, is_error: isError, text, at }), { flag: 'wx' });
  return path;
}
function hookResults(runDir, hash) {
  const dir = join(notionDir(runDir), 'results');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(`${hash}-`) && f.endsWith('.json')).sort().map((f) => {
    const path = join(dir, f), r = readJson(path);
    return { source: { kind: 'hook', path, sha256: sha256File(path) }, toolName: r.tool_name, isError: r.is_error === true, text: r.text };
  });
}

// Calls with this input in a Claude Code root transcript (original file), with their results.
export function transcriptResults(transcriptPath, hash) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  const calls = new Map(), hits = [];
  scanOriginalSource(transcriptPath, (raw, index) => {
    if (!raw) return;
    let e;
    try { e = JSON.parse(raw); } catch { return; }
    const content = e?.message?.content;
    if (e?.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c?.type === 'tool_use' && typeof c.id === 'string' && notionToolKind(c.name)) calls.set(c.id, { e, raw, index });
      return;
    }
    if (e?.type !== 'user' || !Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type !== 'tool_result' || !calls.has(c.tool_use_id)) continue;
      const call = calls.get(c.tool_use_id), pair = claudeToolPair(call.e, e);
      if (pair.error || inputHash(pair.input) !== hash) continue;
      hits.push({ source: { kind: 'transcript', path: transcriptPath, call_line: call.index + 1, result_line: index + 1, call_sha256: sha256(call.raw), result_sha256: sha256(raw) },
        toolName: pair.name, isError: pair.output.isError === true, text: resultText(pair.output.content) });
    }
  });
  return hits;
}

export function plannedResults({ runDir, transcriptPath, input }) {
  const hash = inputHash(input);
  const fromHook = hookResults(runDir, hash);
  return fromHook.length ? fromHook : transcriptResults(transcriptPath, hash);
}

// ---- state ----------------------------------------------------------------------------------------------------------

export function readPlan(runDir) {
  const path = join(notionDir(runDir), 'plan.json');
  requireValue(existsSync(path), 'BOARD_NOTION_PLAN_MISSING', path);
  const plan = readJson(path);
  requireValue(plan.schema === NOTION_PLAN_SCHEMA, 'BOARD_NOTION_PLAN_INVALID');
  return plan;
}
export function readNext(runDir) {
  const path = join(notionDir(runDir), 'next.json');
  if (!existsSync(path)) return null;
  const next = readJson(path);
  return next?.schema === NOTION_STEP_SCHEMA ? next : null;
}
export function stepRecord({ runId, step, captures }) {
  const input = resolvePlaceholders(step.input, captures);
  return { schema: NOTION_STEP_SCHEMA, run_id: runId, n: step.n, tool: step.tool, database: step.database, input, input_sha256: inputHash(input) };
}

// The hook's admission of a Notion write in a registered run. Only the locked next call, unchanged, is admitted; a
// call whose step already has a successful result is refused (no second database or duplicate rows).
export function admitNotionWrite({ runDir, toolName, toolInput }) {
  const kind = notionToolKind(toolName);
  if (kind !== 'create-database' && kind !== 'create-pages') return { allowed: false, code: 'BOARD_WRITE_NOT_PLANNED' };
  const next = readNext(runDir);
  if (!next) return { allowed: false, code: 'BOARD_WRITE_NOT_PLANNED' };
  if (next.tool !== kind || inputHash(toolInput) !== next.input_sha256) return { allowed: false, code: 'BOARD_WRITE_NOT_PLANNED' };
  if (hookResults(runDir, next.input_sha256).some((r) => !r.isError)) return { allowed: false, code: 'BOARD_WRITE_ALREADY_DONE' };
  return { allowed: true, step: next.n, input_sha256: next.input_sha256 };
}

// Whether a Notion call (write or planned readback query) belongs to the run's plan, for the hook's PostToolUse record.
export function plannedCall({ runDir, toolInput }) {
  const next = readNext(runDir);
  const hash = inputHash(toolInput);
  if (next && next.input_sha256 === hash) return true;
  const dir = notionDir(runDir);
  if (!existsSync(join(dir, 'state.json'))) return false;
  const state = readJson(join(dir, 'state.json'));
  return (state.readback_hashes || []).includes(hash);
}

// ---- audit ----------------------------------------------------------------------------------------------------------

// Every board write in a Claude Code root transcript: Notion writes that match a step of one of the given plans are
// planned; every other Notion, Docs, Drive or Space write is nonconforming. Failed calls are not writes.
export function auditBoardWrites({ transcriptPath, plans = [] }) {
  const planned = new Set();
  for (const plan of plans) {
    const captures = plan.captures || {};
    for (const step of plan.steps || []) {
      try { planned.add(inputHash(resolvePlaceholders(step.input, captures))); } catch { /* a step not reached yet */ }
    }
  }
  const calls = new Map(), writes = [];
  scanOriginalSource(transcriptPath, (raw, index) => {
    if (!raw) return;
    let e;
    try { e = JSON.parse(raw); } catch { return; }
    const content = e?.message?.content;
    if (e?.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c?.type === 'tool_use' && boardWriteKind(c.name)) calls.set(c.id, { use: c, index });
      return;
    }
    if (e?.type !== 'user' || !Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type !== 'tool_result' || !calls.has(c.tool_use_id)) continue;
      const { use, index: callIndex } = calls.get(c.tool_use_id);
      if (c.is_error === true) continue;
      const kind = boardWriteKind(use.name);
      writes.push({ tool: use.name, kind, line: callIndex + 1, planned: kind.startsWith('notion-') && planned.has(inputHash(use.input)) });
    }
  });
  const nonconforming = writes.filter((w) => !w.planned);
  return { writes, planned: writes.length - nonconforming.length, nonconforming: nonconforming.length, status: nonconforming.length ? 'nonconforming' : 'conforming' };
}

export const notionPaths = (runDir) => {
  const dir = notionDir(runDir);
  return { dir, plan: join(dir, 'plan.json'), state: join(dir, 'state.json'), next: join(dir, 'next.json'), readback: join(dir, 'readback.json'), receipt: join(dir, 'receipt.json') };
};
export function readState(runDir) {
  const { state } = notionPaths(runDir);
  return existsSync(state) ? readJson(state) : null;
}
export function plansOf(runDir) {
  const { plan, state } = notionPaths(runDir);
  if (!existsSync(plan)) return [];
  const p = readJson(plan), s = existsSync(state) ? readJson(state) : {};
  return [{ ...p, captures: s.captures || {} }];
}
export const readText = (path) => readFileSync(path, 'utf8');
