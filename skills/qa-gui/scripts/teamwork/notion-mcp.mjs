// Notion projection for the hosted Notion MCP tools (notion-create-database, notion-create-pages,
// notion-query-data-sources). The canonical qa-board.json stays the only source of truth. Notion holds two databases,
// Cases and Defects, with one row per canonical case or defect and the columns a developer reads. Every value is a
// pure function of the canonical board, so the readback is compared against a fresh projection, never against the
// projection file an agent could have edited.
import { createHash } from 'node:crypto';
import { TEAMWORK_PRIORITIES, TEAMWORK_STATUSES, validateCanonical } from './canonical.mjs';
import { statusLabel } from './notion-sync.mjs';

export const NOTION_MCP_PROTOCOL = 'qa-gui/notion-mcp/v1';
export const NOTION_TEXT_LIMIT = 1900;
const VERDICTS = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'UNGRADED']);
const STATUS_COLORS = Object.freeze({
  PASS: 'green', VERIFIED: 'green', CLOSED: 'green', FAIL: 'red', REOPENED: 'red', BLOCKED: 'gray', DEFERRED: 'gray',
  REJECTED: 'gray', RETEST: 'yellow', FIXING: 'yellow', ASSIGNED: 'blue', DOING: 'blue', TODO: 'default',
});
const VERDICT_COLORS = Object.freeze({ PASS: 'green', FAIL: 'red', BLOCKED: 'gray', UNGRADED: 'default' });
const PRIORITY_COLORS = Object.freeze({ P1: 'red', P2: 'orange', P3: 'yellow', P4: 'gray' });

// [column, type, value(entry, context)]; column names are fixed English so a readback is machine-comparable.
const CASE_COLUMNS = Object.freeze([
  ['Case', 'TITLE', (e) => text(e.title)],
  ['External ID', 'RICH_TEXT', (e) => text(e.id)],
  ['Order', 'NUMBER', (_e, c) => c.order],
  ['Status', 'STATUS', (e, c) => statusLabel(e.status, c.language)],
  ['Function', 'VERDICT', (e) => e.functionVerdict],
  ['UI', 'VERDICT', (e) => e.uiVerdict],
  ['Priority', 'PRIORITY', (e) => e.priority],
  ['Requirement', 'RICH_TEXT', (e) => text((e.requirements?.length ? e.requirements : [e.requirement]).join(', '))],
  ['Steps', 'RICH_TEXT', (e) => text(e.steps)],
  ['Expected', 'RICH_TEXT', (e) => text(e.expected)],
  ['Function result', 'RICH_TEXT', (e) => text(e.humanSummary?.function)],
  ['UI result', 'RICH_TEXT', (e) => text(e.humanSummary?.ui)],
  ['Evidence', 'RICH_TEXT', (e) => text((e.evidence || []).map(portablePath).join('\n'))],
  ['Round', 'NUMBER', (e) => (Array.isArray(e.results) && e.results.length ? e.results.at(-1).round : null)],
  ['Assignee', 'RICH_TEXT', (e) => text(e.assignee)],
  ['Row SHA', 'RICH_TEXT', (e) => rowSha(e)],
]);
const DEFECT_COLUMNS = Object.freeze([
  ['Defect', 'TITLE', (e) => text(e.title)],
  ['External ID', 'RICH_TEXT', (e) => text(e.id)],
  ['Order', 'NUMBER', (_e, c) => c.order],
  ['Status', 'STATUS', (e, c) => statusLabel(e.status, c.language)],
  ['Priority', 'PRIORITY', (e) => e.priority],
  ['Case', 'RICH_TEXT', (e) => text(e.caseId)],
  ['Repro steps', 'RICH_TEXT', (e) => text(e.repro)],
  ['Expected', 'RICH_TEXT', (e) => text(e.expected)],
  ['Actual', 'RICH_TEXT', (e) => text(e.actual)],
  ['Retest case', 'RICH_TEXT', (e) => text(e.caseId)],
  ['Handoff', 'RICH_TEXT', (e) => text(e.handoff ? `${e.handoff.kind}: ${e.handoff.problem}\n${e.handoff.request}\n${e.handoff.expected}` : '')],
  ['Evidence', 'RICH_TEXT', (e) => text((e.evidence || []).map((item) => `${item.role || item.type || 'evidence'}: ${portablePath(item.path || '')}`).join('\n'))],
  ['Assignee', 'RICH_TEXT', (e) => text(e.assignee)],
  ['Row SHA', 'RICH_TEXT', (e) => rowSha(e)],
]);
export const NOTION_COLUMNS = Object.freeze({ cases: CASE_COLUMNS, defects: DEFECT_COLUMNS });

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function rowSha(entry) { return sha256(JSON.stringify(stable(entry))).slice(0, 16); }

// Notion rich text holds 2,000 characters per run; longer canonical prose is cut at a fixed length with a marker,
// the same way every time, and the full text stays in the canonical board.
export function text(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return s.length > NOTION_TEXT_LIMIT ? `${s.slice(0, NOTION_TEXT_LIMIT)}…` : s;
}

// Evidence paths on a shared board never carry a machine's absolute path (/Users/<name>/…): an absolute path keeps
// only its file name; a relative path stays as written.
export function portablePath(value) {
  const s = String(value || '');
  if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('~')) return s.split(/[\\/]/).filter(Boolean).at(-1) || '';
  return s;
}

function quoteOption(name) {
  if (name.includes("'")) throw new Error(`Notion option name cannot contain a single quote: ${name}`);
  return `'${name}'`;
}
function selectType(kind, language) {
  if (kind === 'STATUS') return `SELECT(${TEAMWORK_STATUSES.map((status) => `${quoteOption(statusLabel(status, language))}:${STATUS_COLORS[status] || 'default'}`).join(', ')})`;
  if (kind === 'VERDICT') return `SELECT(${VERDICTS.map((v) => `${quoteOption(v)}:${VERDICT_COLORS[v]}`).join(', ')})`;
  if (kind === 'PRIORITY') return `SELECT(${TEAMWORK_PRIORITIES.map((p) => `${quoteOption(p)}:${PRIORITY_COLORS[p]}`).join(', ')})`;
  return kind;
}
function schemaFor(columns, language) {
  return `CREATE TABLE (${columns.map(([name, kind]) => `"${name}" ${selectType(kind, language)}`).join(', ')})`;
}

export function provenanceLine({ version, runId, boardSha256, rev }) {
  return `Team QA ${version} · run ${runId} · qa-board ${String(boardSha256).slice(0, 12)} · rev ${rev}`;
}

function rowsFor(entries, columns, language) {
  return entries.map((entry, index) => {
    const context = { order: index + 1, language };
    const properties = Object.fromEntries(columns.map(([name, , value]) => [name, value(entry, context)]));
    return { externalId: entry.id, order: index + 1, properties };
  });
}

// The whole projection: database titles, descriptions, DDL schemas and one property map per row.
export function notionMcpProjection(data, { version, runId, boardSha256 } = {}) {
  const validation = validateCanonical(data);
  if (!validation.ok) throw new Error(`canonical gate failed before Notion projection\n${validation.errors.map((e) => `${e.path}: ${e.message}`).join('\n')}`);
  for (const [key, value] of Object.entries({ version, runId, boardSha256 })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Notion projection needs ${key}`);
  }
  if (!/^[a-f0-9]{64}$/.test(boardSha256)) throw new Error('Notion projection needs the board sha256');
  const language = data.language;
  const description = provenanceLine({ version, runId, boardSha256, rev: data.rev });
  return {
    protocol: NOTION_MCP_PROTOCOL,
    boardId: data.boardId,
    rev: data.rev,
    language,
    provenance: description,
    databases: {
      cases: { title: `${data.title} · Cases`, description, schema: schemaFor(CASE_COLUMNS, language) },
      defects: { title: `${data.title} · Defects`, description, schema: schemaFor(DEFECT_COLUMNS, language) },
    },
    rows: {
      cases: rowsFor(data.cases, CASE_COLUMNS, language),
      defects: rowsFor(data.defects, DEFECT_COLUMNS, language),
    },
  };
}

// Notion returns rich text in `rows` mode as Notion-flavored Markdown: line breaks become <br />, and Markdown
// punctuation is backslash-escaped ("1\\." for "1.", "\\<tag>" for "<tag>"). `sql` mode returns plain text and null
// for an empty value. Anything else stays as returned, so an unknown encoding shows up as a mismatch, never a match.
export function decodeNotionValue(value, mode) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return value;
  if (mode === 'sql') return value;
  return value.replace(/<br\s*\/?>/g, '\n').replace(/\\([\\`*_{}[\]()#+\-.!<>|~^"'$=:&%@,;?/])/g, '$1');
}

function compareCell(kind, expected, actual, mode) {
  if (kind === 'NUMBER') {
    const a = actual === undefined || actual === null || actual === '' ? null : Number(actual);
    return (expected === null ? a === null : a === expected);
  }
  return decodeNotionValue(actual, mode) === (expected ?? '');
}

// readback = { cases: { mode, results: [row, …] }, defects: { mode, results } } built from the planned queries.
export function compareNotionMcp(data, readback, options) {
  const projection = notionMcpProjection(data, options);
  const mismatches = [];
  let matchedFields = 0, totalFields = 0;
  for (const db of ['cases', 'defects']) {
    const columns = NOTION_COLUMNS[db];
    const mode = readback?.[db]?.mode === 'sql' ? 'sql' : 'rows';
    const results = Array.isArray(readback?.[db]?.results) ? readback[db].results : null;
    if (!results) { mismatches.push({ database: db, field: '<readback>', reason: 'missing readback' }); continue; }
    const byId = new Map();
    for (const row of results) {
      const id = decodeNotionValue(row?.['External ID'], mode);
      if (byId.has(id)) mismatches.push({ database: db, externalId: id, field: '<row>', reason: 'duplicate row' });
      byId.set(id, row);
    }
    for (const expected of projection.rows[db]) {
      const actual = byId.get(expected.externalId);
      if (!actual) { totalFields += columns.length; mismatches.push({ database: db, externalId: expected.externalId, field: '<row>', reason: 'missing row' }); continue; }
      byId.delete(expected.externalId);
      for (const [name, kind] of columns) {
        totalFields += 1;
        if (compareCell(kind, expected.properties[name], actual[name], mode)) matchedFields += 1;
        else mismatches.push({ database: db, externalId: expected.externalId, field: name, expected: expected.properties[name], actual: actual[name] ?? null });
      }
    }
    for (const id of byId.keys()) mismatches.push({ database: db, externalId: id, field: '<row>', reason: 'unexpected row' });
  }
  const matchPercent = totalFields === 0 ? (mismatches.length ? 0 : 100) : Number(((matchedFields / totalFields) * 100).toFixed(2));
  return { protocol: NOTION_MCP_PROTOCOL, ok: mismatches.length === 0 && matchPercent === 100, matchPercent, matchedFields, totalFields, mismatches,
    rows: { cases: projection.rows.cases.length, defects: projection.rows.defects.length }, provenance: projection.provenance };
}
