import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { handleQaHook } from '../scripts/hooks/qa-lifecycle.mjs';
import { inspectBoardWrite, SPACE_CREATE_PAGE_TOOL } from '../scripts/lib/board-write-admission.mjs';
import { boardWriteFixture } from './qa-board-teamwork/support/board-write-fixture.mjs';

const nativePageCreate = 'mcp__codex_apps__chatgpt_space__create_page';

function fixture() {
  const f = boardWriteFixture(join(mkdtempSync(join(tmpdir(), 'board-write-hook-')), 'runs', 'fixture-run'));
  const binding = { run_dir: f.runDir, run_id: 'fixture-run', session_id: 'root', browser_session_id: 'qa-own' };
  const deps = { lookup: ({ sessionId }) => sessionId === 'root' ? binding : null, ledger: async () => {},
    inspectWrite: args => inspectBoardWrite({ ...args, verifyDelivery: f.verifyDelivery }) };
  const event = (toolName, toolInput, id = 'write1') => ({ hook_event_name: 'PreToolUse', session_id: 'root', turn_id: 'turn1',
    tool_use_id: id, tool_name: toolName, tool_input: toolInput });
  return { ...f, binding, deps, event };
}

test('registered direct Page create is admitted only for the locked sealed request and recorded', async () => {
  const f = fixture();
  assert.deepEqual(await handleQaHook(f.event(SPACE_CREATE_PAGE_TOOL, f.toolInput), f.deps), {});
  const rows = readdirSync(join(f.runDir, 'hook-events')).map(name => JSON.parse(readFileSync(join(f.runDir, 'hook-events', name), 'utf8')));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'board-admission');
  assert.equal(rows[0].allowed, true);
  assert.equal(rows[0].toolName, SPACE_CREATE_PAGE_TOOL);
  assert.ok(rows[0].evidence.request.endsWith('board-write.json'));
});

test('native Page create uses the canonical sealed receipt while recording the actual tool name', async () => {
  const f = fixture();
  assert.deepEqual(await handleQaHook(f.event(nativePageCreate, f.toolInput), f.deps), {});
  const rows = readdirSync(join(f.runDir, 'hook-events')).map(name => JSON.parse(readFileSync(join(f.runDir, 'hook-events', name), 'utf8')));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].allowed, true);
  assert.equal(rows[0].toolName, nativePageCreate);
  assert.ok(rows[0].evidence.request.endsWith('board-write.json'));
});

test('native Page admission regression fails when its exact alias is removed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'board-native-alias-'));
  try {
    const hookUrl = new URL('../scripts/hooks/qa-lifecycle.mjs', import.meta.url);
    const original = readFileSync(hookUrl, 'utf8');
    const needle = 'name === SPACE_CREATE_PAGE_TOOL || name === NATIVE_SPACE_CREATE_PAGE_TOOL';
    assert.equal(original.split(needle).length - 1, 1);
    const mutant = original.replace(needle, 'name === SPACE_CREATE_PAGE_TOOL || false')
      .replace(/from '(\.\.\/lib\/[^']+)'/g, (_, relative) => `from '${new URL(relative, hookUrl).href}'`);
    const mutantUrl = pathToFileURL(join(directory, 'qa-lifecycle-mutant.mjs'));
    writeFileSync(mutantUrl, mutant);
    const check = moduleUrl => `import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { handleQaHook } from ${JSON.stringify(moduleUrl)};
const runDir=process.argv[1]; mkdirSync(runDir,{recursive:true});
const input={hook_event_name:'PreToolUse',session_id:'root',turn_id:'turn1',tool_use_id:'native',tool_name:${JSON.stringify(nativePageCreate)},tool_input:{title:'sealed'}};
await handleQaHook(input,{lookup:()=>({run_dir:runDir,run_id:'fixture',session_id:'root'}),inspectWrite:()=>({allowed:true,code:'BOARD_WRITE_SCOPED'})});
const rows=readdirSync(join(runDir,'hook-events')).filter(n=>n.endsWith('.event.json')).map(n=>JSON.parse(readFileSync(join(runDir,'hook-events',n))));
assert.equal(rows.length,1); assert.equal(rows[0].type,'board-admission'); assert.equal(rows[0].allowed,true);`;
    const run = (moduleUrl, suffix) => spawnSync(process.execPath, ['--input-type=module', '-e', check(moduleUrl), join(directory, suffix)], { encoding: 'utf8' });
    const control = run(hookUrl.href, 'control');
    assert.equal(control.status, 0, control.stderr);
    const changed = run(mutantUrl.href, 'mutant');
    assert.notEqual(changed.status, 0, 'dropping the native Page alias must make the admission check fail');
  } finally {
    renameSync(directory, `${directory}-archive`);
  }
});

test('registered direct writes with changed content or unsupported connector projection are denied', async () => {
  const f = fixture();
  const changed = structuredClone(f.toolInput); changed.title = 'changed after seal';
  const altered = await handleQaHook(f.event(SPACE_CREATE_PAGE_TOOL, changed), f.deps);
  assert.equal(altered.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(altered.hookSpecificOutput.permissionDecisionReason, 'BOARD_WRITE_TOOL_INPUT_MISMATCH');
  const nativeAltered = await handleQaHook(f.event(nativePageCreate, changed, 'native-altered'), f.deps);
  assert.equal(nativeAltered.hookSpecificOutput.permissionDecisionReason, 'BOARD_WRITE_TOOL_INPUT_MISMATCH');
  const unsupportedNames = [
    'mcp__codex_apps__notion_notion_create_pages',
    'mcp__codex_apps__notion__notion_create_pages',
    'mcp__codex_apps__notion_notion_update_page',
    'mcp__codex_apps__notion__notion_update_page',
    'mcp__codex_apps__chatgpt_space_create_page_visualization',
    'mcp__codex_apps__chatgpt_space__create_page_visualization',
    'mcp__codex_apps__chatgpt_space__update_page',
    'mcp__codex_apps__chatgpt_space__create_page_extra',
    'mcp__notion__create_page',
  ];
  for (const [index, name] of unsupportedNames.entries()) {
    const denied = await handleQaHook(f.event(name, { title: 'unreviewed' }, `unsupported${index}`), f.deps);
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny', name);
    assert.equal(denied.hookSpecificOutput.permissionDecisionReason, 'BOARD_CONNECTOR_UNSUPPORTED_PROJECTION', name);
  }
});

test('lookalike Page name is not treated as the approved create tool', async () => {
  const f = fixture();
  let inspected = false;
  const name = 'mcp__codex_apps__chatgpt_space___create_page';
  assert.deepEqual(await handleQaHook(f.event(name, f.toolInput), { ...f.deps, inspectWrite: () => { inspected = true; return { allowed: true }; } }), {});
  assert.equal(inspected, false);
  assert.deepEqual(readdirSync(join(f.runDir, 'hook-events')), []);
});

test('native readonly Notion fetch is unaffected by write admission', async () => {
  const f = fixture();
  assert.deepEqual(await handleQaHook(f.event('mcp__codex_apps__notion__fetch', { id: 'read-only' }), f.deps), {});
  assert.deepEqual(readdirSync(join(f.runDir, 'hook-events')), []);
});

test('unregistered direct connector calls remain outside this run admission hook', async () => {
  let inspected = false;
  const result = await handleQaHook({ hook_event_name: 'PreToolUse', session_id: 'unknown', tool_name: SPACE_CREATE_PAGE_TOOL, tool_input: {} }, {
    lookup: () => null, inspectWrite: () => { inspected = true; return { allowed: true }; },
  });
  assert.deepEqual(result, {});
  assert.equal(inspected, false);
});
