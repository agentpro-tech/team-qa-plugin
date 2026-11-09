// Upgrade B0: a board reaches Notion only as the planned Notion MCP calls of `teamqa board publish`; every other board
// write of a registered run is refused, and a transcript audit lists the ones made outside a run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleQaHook } from '../scripts/hooks/qa-lifecycle.mjs';
import {
  admitNotionWrite, auditBoardWrites, boardWriteKind, buildNotionPlan, inputHash, normalizeNotionId, notionToolKind,
  parseCreateDatabase, parseCreatePages, parseQuery, plannedResults, recordNotionResult, resolvePlaceholders, stepRecord,
} from '../scripts/lib/board-notion.mjs';

const PARENT = '40ec145b-6537-812f-aefd-f4368df85f88';
const CASES_DS = 'e0e51563-035a-4129-9f20-e6905e3bd0f2';
const DEFECTS_DS = '9a1b2c3d-1111-4222-8333-944455556666';

// A projection as QA GUI's export-notion-mcp writes it (3 cases, 1 defect).
function projection() {
  const row = (id, order) => ({ externalId: id, order, properties: { Case: `Ca ${id}`, 'External ID': id, Order: order } });
  return { protocol: 'qa-gui/notion-mcp/v1', provenance: 'Team QA 1.16.0 \u00b7 run run-1 \u00b7 qa-board 0123456789ab \u00b7 rev 3',
    databases: { cases: { title: 'QA \u00b7 Cases', description: 'Team QA 1.16.0 \u00b7 run run-1', schema: 'CREATE TABLE ("Case" TITLE)' },
      defects: { title: 'QA \u00b7 Defects', description: 'Team QA 1.16.0 \u00b7 run run-1', schema: 'CREATE TABLE ("Defect" TITLE)' } },
    rows: { cases: [row('TC-01', 1), row('TC-02', 2), row('TC-03', 3)], defects: [{ externalId: 'DF-01', order: 1, properties: { Defect: 'L\u1ed7i', 'External ID': 'DF-01', Order: 1 } }] } };
}
function runWithPlan() {
  const runDir = join(mkdtempSync(join(tmpdir(), 'board-notion-')), 'runs', 'run-1');
  mkdirSync(runDir, { recursive: true });
  const board = join(runDir, 'qa-board.json'), proj = join(runDir, 'projection.json');
  writeFileSync(board, JSON.stringify({ boardId: 'b', rev: 3 }));
  writeFileSync(proj, JSON.stringify(projection()));
  const plan = buildNotionPlan({ projection: projection(), projectionPath: proj, boardPath: board, runId: 'run-1', parentPageId: `https://app.notion.com/p/${PARENT.replaceAll('-', '')}?pvs=4` });
  const dir = join(runDir, 'board-notion');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ captures: {}, readback_hashes: [] }));
  const lock = (step, captures = {}) => writeFileSync(join(dir, 'next.json'), JSON.stringify(stepRecord({ runId: 'run-1', step, captures })));
  return { runDir, plan, lock, dir };
}

// The text notion-create-database returned on a live workspace (04/11/2026), trimmed.
const CREATE_DATABASE_RESULT = JSON.stringify({ result: `Created database: <database url="{{https://app.notion.com/p/90e76faa3d1841f2b3dc80a2be9f4bfe}}" inline="false">\nThe title of this Database is: Probe board \u00b7 Cases\n<data-sources>\n<data-source url="{{collection://${CASES_DS}}}">\nThe title of this Data Source is: Probe board \u00b7 Cases\n</data-source>\n</data-sources>\n</database>` });

test('tool kinds: Notion under any server name, Claude Docs and Drive writes; reads and other tools are not board writes', () => {
  assert.equal(notionToolKind('mcp__claude_ai_Notion__notion-create-pages'), 'create-pages');
  assert.equal(notionToolKind('mcp__Notion__notion-create-database'), 'create-database');
  assert.equal(notionToolKind('mcp__notion__notion-fetch'), 'read');
  assert.equal(notionToolKind('mcp__notion__notion-query-data-sources'), 'read');
  assert.equal(notionToolKind('mcp__notion__notion-update-page'), 'write');
  assert.equal(notionToolKind('mcp__notion__notion-create-comment'), 'write');
  assert.equal(notionToolKind('mcp__codex_apps__notion_notion_create_pages'), 'create-pages');
  assert.equal(notionToolKind('mcp__codex_apps__notion__notion_update_page'), 'write');
  assert.equal(notionToolKind('mcp__notion__create_page'), 'write');
  assert.equal(notionToolKind('mcp__dragon__dragon_rpc'), null);
  assert.equal(boardWriteKind('mcp__Claude_Docs__batch'), 'docs-write');
  assert.equal(boardWriteKind('mcp__claude_ai_Claude_Docs__update'), 'docs-write');
  assert.equal(boardWriteKind('mcp__Google_Drive__create_file'), 'drive-write');
  assert.equal(boardWriteKind('mcp__Google_Drive__read_file_content'), null);
  assert.equal(boardWriteKind('mcp__Notion__notion-fetch'), null);
  assert.equal(boardWriteKind('Bash'), null);
});

test('parent ids from a URL, a dashed id or 32 hex; anything else is refused', () => {
  assert.equal(normalizeNotionId(`https://www.notion.so/Team-QA-${PARENT.replaceAll('-', '')}?pvs=4`), PARENT);
  assert.equal(normalizeNotionId(PARENT.toUpperCase()), PARENT);
  assert.equal(normalizeNotionId(PARENT.replaceAll('-', '')), PARENT);
  assert.throws(() => normalizeNotionId('not-a-page'), /BOARD_NOTION_PARENT_INVALID/);
});

test('plan: two databases, rows in batches, then one readback query per 100 rows of each database', () => {
  const { plan } = runWithPlan();
  assert.deepEqual(plan.steps.map((s) => [s.n, s.tool, s.database]), [[1, 'create-database', 'cases'], [2, 'create-database', 'defects'], [3, 'create-pages', 'cases'], [4, 'create-pages', 'defects']]);
  assert.deepEqual(plan.steps[0].input.parent, { page_id: PARENT, type: 'page_id' });
  assert.equal(plan.steps[0].input.description, 'Team QA 1.16.0 \u00b7 run run-1');
  assert.deepEqual(plan.steps[2].input.parent, { data_source_id: '{{cases}}', type: 'data_source_id' });
  assert.equal(plan.steps[2].input.allow_async, false);
  assert.deepEqual(plan.steps[2].external_ids, ['TC-01', 'TC-02', 'TC-03']);
  assert.deepEqual(plan.readback.map((r) => [r.n, r.database, r.page]), [[5, 'cases', 0], [6, 'defects', 0]]);
  const big = projection(); big.rows.cases = Array.from({ length: 120 }, (_, i) => ({ externalId: `TC-${i}`, order: i + 1, properties: {} }));
  const p2 = buildNotionPlan({ projection: big, projectionPath: runWithPlan().plan.projection.path, boardPath: runWithPlan().plan.board.path, runId: 'run-1', parentPageId: PARENT });
  assert.equal(p2.steps.filter((s) => s.tool === 'create-pages' && s.database === 'cases').length, 3);
  assert.equal(p2.readback.filter((r) => r.database === 'cases').length, 2);
});

test('placeholders resolve only to captured data source ids; tracking fields never change the input hash', () => {
  const { plan } = runWithPlan();
  assert.throws(() => resolvePlaceholders(plan.steps[2].input, {}), /BOARD_NOTION_CAPTURE_MISSING/);
  const input = resolvePlaceholders(plan.steps[2].input, { cases: CASES_DS });
  assert.equal(input.parent.data_source_id, CASES_DS);
  assert.equal(inputHash({ ...input, telemetry: { intent: 'x' }, skill: 'team-qa' }), inputHash(input));
  assert.notEqual(inputHash({ ...input, allow_async: true }), inputHash(input));
});

test('results: the data source of a created database, created pages, and query rows', () => {
  assert.deepEqual(parseCreateDatabase(CREATE_DATABASE_RESULT), { dataSourceId: CASES_DS, databaseUrl: 'https://app.notion.com/p/90e76faa3d1841f2b3dc80a2be9f4bfe' });
  assert.equal(parseCreateDatabase('no source here').dataSourceId, null);
  assert.equal(parseCreatePages(JSON.stringify({ pages: [{ id: 'a', url: 'u' }, { id: 'b', url: 'v' }] })).pages.length, 2);
  assert.equal(parseCreatePages('garbage').pages, null);
  const q = parseQuery(JSON.stringify({ results: [{ 'External ID': 'TC-01' }], has_more: false }));
  assert.equal(q.results.length, 1); assert.equal(q.hasMore, false);
});

test('admission: only the locked call, unchanged, and only until its step has a successful result', () => {
  const { runDir, plan, lock } = runWithPlan();
  const tool = 'mcp__claude_ai_Notion__notion-create-database';
  assert.equal(admitNotionWrite({ runDir, toolName: tool, toolInput: plan.steps[0].input }).code, 'BOARD_WRITE_NOT_PLANNED', 'no lock yet');
  lock(plan.steps[0]);
  assert.equal(admitNotionWrite({ runDir, toolName: tool, toolInput: plan.steps[0].input }).allowed, true);
  assert.equal(admitNotionWrite({ runDir, toolName: tool, toolInput: { ...plan.steps[0].input, telemetry: { intent: 'board' } } }).allowed, true);
  assert.equal(admitNotionWrite({ runDir, toolName: tool, toolInput: { ...plan.steps[0].input, title: 'My own board' } }).code, 'BOARD_WRITE_NOT_PLANNED');
  assert.equal(admitNotionWrite({ runDir, toolName: 'mcp__Notion__notion-create-pages', toolInput: plan.steps[0].input }).code, 'BOARD_WRITE_NOT_PLANNED');
  assert.equal(admitNotionWrite({ runDir, toolName: 'mcp__Notion__notion-update-page', toolInput: plan.steps[0].input }).code, 'BOARD_WRITE_NOT_PLANNED');
  recordNotionResult({ runDir, toolName: tool, toolUseId: 'call-1', toolInput: plan.steps[0].input, toolResponse: { isError: true, content: [{ type: 'text', text: 'rate limited' }] } });
  assert.equal(admitNotionWrite({ runDir, toolName: tool, toolInput: plan.steps[0].input }).allowed, true, 'a failed call may be made again');
  recordNotionResult({ runDir, toolName: tool, toolUseId: 'call-2', toolInput: plan.steps[0].input, toolResponse: [{ type: 'text', text: CREATE_DATABASE_RESULT }] });
  assert.equal(admitNotionWrite({ runDir, toolName: tool, toolInput: plan.steps[0].input }).code, 'BOARD_WRITE_ALREADY_DONE');
  const results = plannedResults({ runDir, input: plan.steps[0].input });
  assert.equal(results.length, 2);
  assert.equal(results.filter((r) => !r.isError).length, 1);
  assert.equal(parseCreateDatabase(results.find((r) => !r.isError).text).dataSourceId, CASES_DS);
});

function hookFixture() {
  const f = runWithPlan();
  const binding = { run_dir: f.runDir, run_id: 'run-1', session_id: 'root', browser_session_id: 'qa-own' };
  const deps = { lookup: ({ sessionId }) => (sessionId === 'root' ? binding : null), ledger: async () => {} };
  const event = (name, input, id, hook = 'PreToolUse', extra = {}) => ({ hook_event_name: hook, session_id: 'root', turn_id: 't1', tool_use_id: id, tool_name: name, tool_input: input, ...extra });
  return { ...f, deps, event };
}
const reason = (out) => out?.hookSpecificOutput?.permissionDecisionReason;

test('hook: hand-made Notion pages, Claude Docs and Drive files are refused in a registered run; the planned call passes and its result is recorded', async () => {
  const f = hookFixture();
  assert.equal(reason(await handleQaHook(f.event('mcp__claude_ai_Notion__notion-create-pages', { pages: [{ properties: { title: 'QA board' } }] }, 'w1'), f.deps)), 'BOARD_WRITE_NOT_PLANNED');
  assert.equal(reason(await handleQaHook(f.event('mcp__Claude_Docs__batch', { container: {} }, 'w2'), f.deps)), 'BOARD_WRITE_NOT_PLANNED');
  assert.equal(reason(await handleQaHook(f.event('mcp__Google_Drive__create_file', { title: 'board' }, 'w3'), f.deps)), 'BOARD_WRITE_NOT_PLANNED');
  assert.equal(reason(await handleQaHook(f.event('mcp__codex_apps__chatgpt_space__update_page', {}, 'w4'), f.deps)), 'BOARD_CONNECTOR_UNSUPPORTED_PROJECTION');
  assert.deepEqual(await handleQaHook(f.event('mcp__Notion__notion-fetch', { id: PARENT }, 'r1'), f.deps), {}, 'reads stay allowed');
  f.lock(f.plan.steps[0]);
  const tool = 'mcp__claude_ai_Notion__notion-create-database';
  assert.deepEqual(await handleQaHook(f.event(tool, f.plan.steps[0].input, 'w5'), f.deps), {});
  await handleQaHook(f.event(tool, f.plan.steps[0].input, 'w5', 'PostToolUse', { tool_response: [{ type: 'text', text: CREATE_DATABASE_RESULT }] }), f.deps);
  const recorded = readdirSync(join(f.dir, 'results'));
  assert.equal(recorded.length, 1);
  assert.match(recorded[0], new RegExp(`^${inputHash(f.plan.steps[0].input)}-w5\\.json$`));
  assert.equal(reason(await handleQaHook(f.event(tool, f.plan.steps[0].input, 'w6'), f.deps)), 'BOARD_WRITE_ALREADY_DONE', 'no second database');
  const admissions = readdirSync(join(f.runDir, 'hook-events')).map((n) => JSON.parse(readFileSync(join(f.runDir, 'hook-events', n), 'utf8'))).filter((e) => e.type === 'board-admission');
  assert.ok(admissions.some((e) => e.allowed === true && e.toolName === tool));
  assert.ok(admissions.filter((e) => e.allowed === false).length >= 4);
});

test('hook: an unregistered session is not affected (the audit covers it instead)', async () => {
  const f = hookFixture();
  const out = await handleQaHook({ ...f.event('mcp__Notion__notion-create-pages', {}, 'x1'), session_id: 'someone-else' }, f.deps);
  assert.deepEqual(out, {});
});

// A Claude Code root transcript with one planned create-database call and one hand-made Notion page.
function transcript(dir, plannedInput) {
  const lines = [];
  let uuid = 0;
  const call = (id, name, input) => { const u = `a${++uuid}`; lines.push(JSON.stringify({ type: 'assistant', uuid: u, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })); return u; };
  const result = (id, text, parent, isError) => lines.push(JSON.stringify({ type: 'user', sourceToolAssistantUUID: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) }] } }));
  result('p1', CREATE_DATABASE_RESULT, call('p1', 'mcp__claude_ai_Notion__notion-create-database', { ...plannedInput, telemetry: { intent: 'board' } }));
  result('h1', JSON.stringify({ pages: [{ id: 'x' }] }), call('h1', 'mcp__claude_ai_Notion__notion-create-pages', { pages: [{ properties: { title: 'QA board (hand-made)' } }] }));
  result('h2', 'denied', call('h2', 'mcp__claude_ai_Notion__notion-create-pages', { pages: [] }), true);
  result('d1', '{}', call('d1', 'mcp__Claude_Docs__batch', { container: {} }));
  result('f1', 'page', call('f1', 'mcp__claude_ai_Notion__notion-fetch', { id: PARENT }));
  const path = join(dir, 'root.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

test('transcript: the planned call is found by its input (tracking fields ignored); the audit names the hand-made writes', () => {
  const f = runWithPlan();
  const path = transcript(f.runDir, f.plan.steps[0].input);
  const found = plannedResults({ runDir: f.runDir, transcriptPath: path, input: f.plan.steps[0].input });
  assert.equal(found.length, 1);
  assert.equal(found[0].source.kind, 'transcript');
  assert.equal(parseCreateDatabase(found[0].text).dataSourceId, CASES_DS);
  const audit = auditBoardWrites({ transcriptPath: path, plans: [{ ...f.plan, captures: {} }] });
  assert.equal(audit.planned, 1);
  assert.equal(audit.nonconforming, 2, 'the hand-made page and the Doc; the refused call and the read are not writes');
  assert.equal(audit.status, 'nonconforming');
  assert.deepEqual(audit.writes.filter((w) => !w.planned).map((w) => w.kind).sort(), ['docs-write', 'notion-create-pages']);
  const none = auditBoardWrites({ transcriptPath: path, plans: [] });
  assert.equal(none.nonconforming, 3, 'without the plan even the planned call is not conforming');
});

test('readback queries: one per page of rows, resolved to the captured data sources', () => {
  const { plan } = runWithPlan();
  const q = resolvePlaceholders(plan.readback[0].input, { cases: CASES_DS, defects: DEFECTS_DS });
  assert.equal(q.data.data_source_url, `collection://${CASES_DS}`);
  assert.equal(q.data.mode, 'rows');
  assert.equal(q.data.filter.filters[0].value.value, 0);
  assert.deepEqual(q.data.sort, [{ property: 'Order', direction: 'ascending' }]);
});
