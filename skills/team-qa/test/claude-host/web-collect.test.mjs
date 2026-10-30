import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { DRAFT_MARKER, buildCaseEvidence, draftIssues, evidenceDrafts, mergeCaseIntoBoard, streamCalls, webCollect } from '../../scripts/lib/web-collect.mjs';
import { mkdirSync } from 'node:fs';

// Upgrade U3: executor evidence drafts become state receipts and board cases from the attested stream alone. Synthetic
// stream-json fixtures (never evidence of a live run); files are written to a temporary directory.
const sha = (value) => createHash('sha256').update(value).digest('hex');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-web-collect-')));
const PNG = join(dir, 'tc02-after-save.png'), MP4 = join(dir, 'rec.mp4');
writeFileSync(PNG, Buffer.from('\x89PNG fixture'));
writeFileSync(MP4, Buffer.from('mp4 fixture'));
const ok = (result) => [{ type: 'text', text: JSON.stringify({ ok: true, result }) }];
let clock = Date.parse('2026-10-29T03:00:00Z');
const use = (id, name, input) => ({ type: 'assistant', timestamp: new Date(clock += 1000).toISOString(), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, extra = {}) => ({ type: 'user', timestamp: new Date(clock += 500).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });
const RPC = 'mcp__Dragon_Browser__dragon_rpc';
const S = { sessionId: 'exec-s1', nonce: 'n1', browserInstanceId: 'bi-1' };
const draft = {
  case_id: 'TC-02', summary: { function: 'Saves; stock is correct.', ui: 'The label is covered.' },
  lifecycle: { before: 'No order yet', action: 'Create an order', network: 'POST orders 201', readback: 'The list has the order', refresh: 'Unchanged', postcondition: 'Stock down by 5' },
  recording: { stop: 'toolu_stop', assemble: 'toolu_asm' },
  states: [{ state: 'tc02-after-save', screenshot: 'toolu_shot', gate0: { call: 'toolu_g0', as: 'g0' }, console: 'toolu_con', network: 'toolu_net',
    assertions: [{ assertion_id: 'TC-02-A1', verdict: 'PASS' }, { assertion_id: 'TC-02-A2', verdict: 'pass' }], vision: [{ rule: 'C11', verdict: 'FAIL' }] }],
};
const events = [
  { type: 'system', subtype: 'init', session_id: 'w1' },
  use('toolu_sess', RPC, { method: 'session.create', params: { sessionId: 'exec-s1' } }), result('toolu_sess', ok({ ...S })),
  use('toolu_tab', RPC, { method: 'openTab', params: { ...S, url: 'http://127.0.0.1:5401/orders' } }), result('toolu_tab', ok({ tabId: 7, sessionId: 'exec-s1' })),
  use('toolu_rec', RPC, { method: 'startRecording', params: { ...S, tabId: 7 } }), result('toolu_rec', ok({ id: 'rec-1' })),
  use('toolu_shot', 'mcp__Dragon_Browser__screenshot', { tabId: 7, toFile: 'tc02-after-save.png' }),
  result('toolu_shot', ok({ savedTo: PNG, sha256: sha(readFileSync(PNG)), domHash: 'd'.repeat(64), privacyMasked: true,
    dom: { url: 'http://127.0.0.1:5401/orders/1', viewport: '1440x757' }, evidence: { ref: 'observation:abc', ts: clock } })),
  use('toolu_g0', 'mcp__Dragon_Browser__do', { tabId: 7, steps: [{ read: { js: 'gate0()', as: 'g0' } }] }),
  result('toolu_g0', ok({ completed: true, results: [{ step: 'read', as: 'g0', value: JSON.stringify({ ui: { v: 'FAIL', c: { high: 1 } }, a11y: { v: 'PASS' } }) }] })),
  use('toolu_con', RPC, { method: 'getConsole', params: { ...S, tabId: 7 } }), result('toolu_con', ok({ count: 0, entries: [] })),
  use('toolu_net', RPC, { method: 'getNetwork', params: { ...S, tabId: 7 } }),
  result('toolu_net', ok({ count: 2, requests: [{ t: clock, method: 'POST', url: 'http://127.0.0.1:5411/rest/v1/orders', status: 201, type: 'Fetch' }, { t: clock, method: 'GET', url: 'http://127.0.0.1:5401/a.js', status: 200, type: 'Script' }] })),
  use('toolu_stop', RPC, { method: 'stopRecording', params: { ...S, tabId: 7, id: 'rec-1' } }), result('toolu_stop', ok({ durationMs: 41000 })),
  use('toolu_asm', RPC, { method: 'assembleRecording', params: { ...S, id: 'rec-1' } }), result('toolu_asm', ok({ video: MP4 })),
  use('toolu_bad', RPC, { method: 'getConsole', params: { ...S, tabId: 7 } }), result('toolu_bad', 'Error: tab closed', { is_error: true }),
  { type: 'assistant', message: { content: [{ type: 'text', text: `Case TC-02 done.\n\n${DRAFT_MARKER}\n\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\`\n` }] } },
  { type: 'result', subtype: 'success', is_error: false, session_id: 'w1' },
];
const stream = events.map((e) => JSON.stringify(e)).join('\n');
const binding = { run_uuid: '11111111-1111-4111-8111-111111111111', target_binding_sha256: 'b'.repeat(64), target: { frontend_build: { id: 'index-CJjkO35e' } } };
const planned = { id: 'TC-02', req_id: 'REQ-ORDER' };
const preflightRaw = { id: 'preflight', verdict: 'PASS', evidence: 'team-qa preflight.json sha256=…' };
const fileSha = (path) => sha(readFileSync(path));
const exists = (path) => { try { readFileSync(path); return true; } catch { return false; } };
const build = (d = draft, extra = {}) => buildCaseEvidence({ draft: d, calls: streamCalls(stream), binding, plannedCase: planned,
  boardCase: { id: 'TC-02', title: 'Create an order', kind: 'behavioral', status: 'TODO' }, viewport: '1440x757', preflightRaw, fileSha, exists, ...extra });

test('the stream gives each call by tool_use id, its method, result and timestamp; drafts are read from the text', () => {
  const calls = streamCalls(stream);
  assert.equal(calls.get('toolu_shot').method, 'screenshot');
  assert.equal(calls.get('toolu_g0').method, 'do');
  assert.equal(calls.get('toolu_net').method, 'getNetwork');
  assert.equal(calls.get('toolu_bad').error, true);
  assert.match(calls.get('toolu_shot').at, /^2026-10-29T03:00/);
  assert.deepEqual(evidenceDrafts(stream), [draft]);
  assert.deepEqual(draftIssues(draft, { caseIds: ['TC-01', 'TC-02'], caseId: 'TC-02' }), []);
  assert.deepEqual(draftIssues(draft, { caseIds: ['TC-01', 'TC-02'], caseId: 'TC-01' }), ['EVIDENCE_DRAFT_CASE_SCOPE:TC-02']);
  assert.deepEqual(draftIssues({ ...draft, states: [{ state: 'a' }, { state: 'a' }] }, { caseIds: ['TC-02'] }), ['EVIDENCE_DRAFT_STATE_INVALID:a']);
  assert.deepEqual(draftIssues({ invalid: true }, { caseIds: [] }), ['EVIDENCE_DRAFT_INVALID']);
});

test('a draft becomes the state receipt, files, manifest, vision and board case the gate reads, all from the stream', () => {
  const built = build();
  assert.deepEqual(built.issues, []);
  assert.deepEqual(built.files.map((f) => f.rel), ['evidence/qa-gui/TC-02/TC-02-run.mp4', 'evidence/qa-gui/TC-02/tc02-after-save.png']);
  const [{ rel, value: r }] = built.receipts;
  assert.equal(rel, 'evidence/qa-gui/TC-02/tc02-after-save.receipt.json');
  assert.equal(r.schema, 'qa-gui/state-receipt/v1');
  assert.deepEqual([r.url, r.viewport, r.domHash, r.build], ['http://127.0.0.1:5401/orders/1', '1440x757', 'd'.repeat(64), 'index-CJjkO35e']);
  assert.deepEqual(r.dragon, { sessionId: 'exec-s1', actionId: 'observation:abc', browserInstanceId: 'bi-1', tabId: '7', innerOk: true });
  assert.equal(r.screenshot.sha256, sha(readFileSync(PNG)));
  assert.deepEqual(r.function, { verdict: 'PASS', assertions: [
    { requirement_id: 'REQ-ORDER', assertion_id: 'TC-02-A1', verdict: 'PASS', evidence_ref: 'evidence/qa-gui/TC-02/tc02-after-save.png', evidence_type: 'gui-screenshot' },
    { requirement_id: 'REQ-ORDER', assertion_id: 'TC-02-A2', verdict: 'PASS', evidence_ref: 'evidence/qa-gui/TC-02/tc02-after-save.png', evidence_type: 'gui-screenshot' }] });
  // Raw outputs are the executor's own tool results, verbatim.
  assert.equal(r.ui.uiSanity.verdict, 'FAIL'); assert.equal(r.ui.a11y.verdict, 'PASS');
  assert.equal(r.ui.console.evidence, streamCalls(stream).get('toolu_con').text);
  assert.equal(r.ui.network.verdict, 'PASS');
  assert.deepEqual(r.network, [{ method: 'POST', url: 'http://127.0.0.1:5411/rest/v1/orders', status: 201, ts: r.network[0].ts }]);
  assert.equal(r.ui.verdict, 'FAIL');
  assert.deepEqual(r.readback.value.lifecycle, draft.lifecycle);
  assert.equal(r.targetBindingSha256, 'b'.repeat(64));
  assert.deepEqual(built.manifest.map((m) => [m.path, m.evidence_type, m.metadata.case_id, m.metadata.state]), [
    ['evidence/qa-gui/TC-02/TC-02-run.mp4', 'gui-recording', 'TC-02', 'tc02-after-save'],
    ['evidence/qa-gui/TC-02/tc02-after-save.png', 'gui-screenshot', 'TC-02', 'tc02-after-save'],
    ['evidence/qa-gui/TC-02/tc02-after-save.receipt.json', 'machine-receipt', 'TC-02', 'tc02-after-save']]);
  // Every rule C10–C16 on the state, the judged one with its verdict (QA GUI's gate needs all seven).
  assert.deepEqual(built.vision.map((v) => [v.rule, v.verdict]), [['C10', 'UNGRADED'], ['C11', 'FAIL'], ['C12', 'UNGRADED'], ['C13', 'UNGRADED'], ['C14', 'UNGRADED'], ['C15', 'UNGRADED'], ['C16', 'UNGRADED']]);
  const c = built.caseEntry;
  assert.deepEqual([c.status, c.functionVerdict, c.uiVerdict, c.title, c.kind], ['FAIL', 'PASS', 'FAIL', 'Create an order', 'behavioral']);
  assert.deepEqual(c.recordingSegments, [{ file: 'evidence/qa-gui/TC-02/TC-02-run.mp4', startMs: 0, endMs: 41000 }]);
  assert.deepEqual(c.stateReceipts, [{ state: 'tc02-after-save', file: rel }]);
  assert.equal(c.history.at(-1).from, 'TODO');
  // The case declares the tracked plan's requirement (a board made from a seed may carry only `requirement`).
  assert.deepEqual([c.requirement, c.requirements], ['REQ-ORDER', ['REQ-ORDER']]);
  assert.deepEqual(build(draft, { boardCase: { id: 'TC-02', status: 'TODO', requirement: 'REQ-ORDER', requirements: ['REQ-OTHER'] } }).caseEntry.requirements, ['REQ-OTHER', 'REQ-ORDER']);
});

test('what the stream does not hold is UNGRADED with its reason, never taken from the draft prose', () => {
  const s = draft.states[0];
  const missing = build({ ...draft, recording: undefined, states: [{ ...s, gate0: undefined, console: 'toolu_bad', network: 'toolu_shot' }] });
  const r = missing.receipts[0].value;
  assert.match(r.ui.uiSanity.evidence, /^not measurable: Gate-0 was not run/);
  assert.match(r.ui.console.evidence, /^not measurable: call toolu_bad did not succeed/);
  assert.match(r.ui.network.evidence, /^not measurable: call toolu_shot is screenshot, not getNetwork/);
  assert.equal(r.ui.verdict, 'UNGRADED');
  assert.equal(Object.hasOwn(missing.caseEntry, 'recordingSegments'), false);
  // A screenshot outside the stream, or whose file no longer matches the Dragon hash, gives no receipt.
  const gone = build({ ...draft, states: [{ ...s, screenshot: 'toolu_made_up' }] });
  assert.deepEqual([gone.receipts.length, gone.issues[0]], [0, 'SCREENSHOT_UNAVAILABLE:TC-02:tc02-after-save:not in the executor stream: toolu_made_up']);
  assert.equal(gone.caseEntry.status, 'BLOCKED');
  const drift = build(draft, { fileSha: (path) => path === PNG ? 'f'.repeat(64) : sha(readFileSync(path)) });
  assert.deepEqual(drift.issues, ['SCREENSHOT_FILE_DRIFT:TC-02:tc02-after-save']);
  // A screenshot taken with domHash:false has no page URL or DOM hash for the receipt: collected, and reported.
  const bare = streamCalls(stream);
  delete bare.get('toolu_shot').json.result.domHash; delete bare.get('toolu_shot').json.result.dom;
  assert.deepEqual(buildCaseEvidence({ draft, calls: bare, binding, plannedCase: planned, boardCase: { id: 'TC-02', status: 'TODO' }, viewport: '1440x757', preflightRaw, fileSha, exists }).issues,
    ['SCREENSHOT_DOM_MISSING:TC-02:tc02-after-save']);
  // A rule name outside C10–C16 is dropped and reported; the seven rules stay.
  const named = build({ ...draft, states: [{ ...s, vision: [{ rule: 'VND-format', verdict: 'FAIL' }, { rule: 'C16', verdict: 'PASS' }] }] });
  assert.deepEqual(named.issues, ['VISION_RULE_UNKNOWN:TC-02:tc02-after-save:VND-format']);
  assert.deepEqual(named.vision.map((v) => `${v.rule}:${v.verdict}`).filter((x) => !x.endsWith(':UNGRADED')), ['C16:PASS']);
  // An unknown verdict word is UNGRADED, and a blocked draft stays BLOCKED.
  const odd = build({ ...draft, blocked: true, states: [{ ...s, assertions: [{ assertion_id: 'TC-02-A1', verdict: 'maybe' }] }] });
  assert.equal(odd.receipts[0].value.function.verdict, 'UNGRADED');
  assert.equal(odd.caseEntry.status, 'BLOCKED');
});

test('merging replaces only that case, its manifest entries and its vision assertions', () => {
  const board = { cases: [{ id: 'TC-01', status: 'PASS' }, { id: 'TC-02', status: 'TODO' }],
    evidenceManifest: [{ path: 'a.png', metadata: { case_id: 'TC-01' } }, { path: 'old.png', metadata: { case_id: 'TC-02' } }],
    vision: { version: 2, assertions: [{ case_id: 'TC-01', rule: 'C10' }, { case_id: 'TC-02', rule: 'C99' }] } };
  const built = build();
  const next = mergeCaseIntoBoard(board, built);
  assert.deepEqual(next.cases[0], board.cases[0]);
  assert.equal(next.cases[1].status, 'FAIL');
  assert.deepEqual(next.evidenceManifest.map((e) => e.path), ['a.png', ...built.manifest.map((m) => m.path)]);
  assert.deepEqual(next.vision.assertions.map((v) => `${v.case_id}:${v.rule}`), ['TC-01:C10', ...['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'].map((r) => `TC-02:${r}`)]);
  assert.equal(board.cases[1].status, 'TODO');
  assert.throws(() => mergeCaseIntoBoard({ cases: [] }, built), /BOARD_CASE_UNKNOWN/);
});

// The Claude CLI does not show tool_use ids to the model: the executor names its calls
// by what it chose or can count on, and collect finds them in the stream by position.
test('a draft without tool_use ids: screenshots by toFile, the rest by position on the same tab, the recording last', () => {
  const A = join(dir, 'TC-03-s1.png'), B = join(dir, 'TC-03-s2.png'), V = join(dir, 'rec2.mp4');
  writeFileSync(A, Buffer.from('\x89PNG a')); writeFileSync(B, Buffer.from('\x89PNG b')); writeFileSync(V, Buffer.from('mp4 b'));
  const shotResult = (path) => ok({ savedTo: path, sha256: sha(readFileSync(path)), privacyMasked: true, domHash: 'e'.repeat(64), dom: { url: 'http://127.0.0.1:5401/x', viewport: '1440x757' } });
  const g0 = (v) => ok({ completed: true, results: [{ step: 'read', as: 'g0', value: JSON.stringify({ ui: { v }, a11y: { v: 'PASS' } }) }] });
  const net = (status) => ok({ count: 1, requests: [{ t: clock, method: 'POST', url: 'http://127.0.0.1:5411/rest/v1/items', status, type: 'Fetch' }] });
  const ev = [
    use('u1', RPC, { method: 'session.create', params: { sessionId: 'exec-s1' } }), result('u1', ok({ ...S })),
    use('u2', RPC, { method: 'openTab', params: { ...S, url: 'http://127.0.0.1:5401/x' } }), result('u2', ok({ tabId: 9, sessionId: 'exec-s1' })),
    use('u3', RPC, { method: 'getNetwork', params: { ...S, tabId: 9, summary: true } }), result('u3', ok({ summary: true, count: 1, origins: [] })),
    use('u4', RPC, { method: 'startRecording', params: { ...S, tabId: 9 } }), result('u4', ok({ id: 'rec-1' })),
    use('u5', 'mcp__Dragon_Browser__screenshot', { tabId: 9, toFile: 'TC-03-s1.png' }), result('u5', shotResult(A)),
    use('u6', 'mcp__Dragon_Browser__do', { tabId: 9, steps: [{ read: { js: 'gate0()', as: 'g0' } }] }), result('u6', g0('PASS')),
    use('u7', 'mcp__Dragon_Browser__getConsole', { tabId: 9 }), result('u7', ok({ count: 0, entries: [] })),
    use('u8', 'mcp__Dragon_Browser__getNetwork', { tabId: 9 }), result('u8', net(201)),
    // A screenshot of the same tab no state names does not end the first state's window; the second state's does.
    use('u9', 'mcp__Dragon_Browser__screenshot', { tabId: 9, toFile: 'scratch.png' }), result('u9', shotResult(A)),
    use('u10', 'mcp__Dragon_Browser__screenshot', { tabId: 9, toFile: 'TC-03-s2.png' }), result('u10', 'Error: busy', { is_error: true }),
    use('u11', 'mcp__Dragon_Browser__screenshot', { tabId: 9, toFile: 'TC-03-s2.png' }), result('u11', shotResult(B)),
    use('u12', 'mcp__Dragon_Browser__getConsole', { tabId: 9 }), result('u12', 'Error: tab busy', { is_error: true }),
    use('u13', 'mcp__Dragon_Browser__getConsole', { tabId: 9 }), result('u13', ok({ count: 1, entries: [{ level: 'error', text: 'boom' }] })),
    use('u14', 'mcp__Dragon_Browser__getNetwork', { tabId: 9, summary: true }), result('u14', ok({ summary: true, count: 1, origins: [] })),
    use('u15', 'mcp__Dragon_Browser__getNetwork', { tabId: 9 }), result('u15', net(500)),
    use('u16', RPC, { method: 'stopRecording', params: { ...S, tabId: 9, id: 'rec-1' } }), result('u16', ok({ durationMs: 9000 })),
    use('u17', RPC, { method: 'assembleRecording', params: { ...S, id: 'rec-1' } }), result('u17', ok({ video: V })),
  ];
  const calls = streamCalls(ev.map((e) => JSON.stringify(e)).join('\n'));
  const d = { case_id: 'TC-03', summary: { function: 'f', ui: 'u' }, lifecycle: {}, recording: true, states: [
    { state: 's1', screenshot: 'TC-03-s1.png', gate0: 'g0', console: true, network: true, assertions: [{ assertion_id: 'TC-03-A1', verdict: 'PASS' }] },
    { state: 's2', screenshot: 'TC-03-s2.png', gate0: true, console: true, network: true, assertions: [{ assertion_id: 'TC-03-A2', verdict: 'PASS' }] },
    { state: 's3', screenshot: 'TC-03-s9.png', console: true }] };
  const built = buildCaseEvidence({ draft: d, calls, binding, plannedCase: { id: 'TC-03', req_id: 'REQ-X' }, boardCase: { id: 'TC-03', status: 'TODO' },
    viewport: '1440x757', preflightRaw, fileSha, exists });
  assert.deepEqual(built.issues, ['SCREENSHOT_UNAVAILABLE:TC-03:s3:not in the executor stream: no screenshot with toFile TC-03-s9.png']);
  assert.deepEqual(built.files.map((f) => [f.from, f.rel]), [[V, 'evidence/qa-gui/TC-03/TC-03-run.mp4'], [A, 'evidence/qa-gui/TC-03/s1.png'], [B, 'evidence/qa-gui/TC-03/s2.png']]);
  const [r1, r2] = built.receipts.map((r) => r.value);
  assert.deepEqual([r1.ui.uiSanity.verdict, r1.ui.console.verdict, r1.ui.network.verdict, r1.ui.verdict], ['PASS', 'PASS', 'PASS', 'PASS']);
  assert.equal(r1.ui.console.evidence, calls.get('u7').text);
  // The second state: its own take of the screenshot that succeeded, the console call that succeeded, the full network list.
  assert.equal(r2.dragon.actionId, 'screenshot:u11');
  assert.equal(r2.ui.console.evidence, calls.get('u13').text); assert.equal(r2.ui.console.verdict, 'FAIL');
  assert.equal(r2.ui.network.evidence, calls.get('u15').text); assert.equal(r2.ui.network.verdict, 'FAIL');
  assert.match(r2.ui.uiSanity.evidence, /^not measurable: no do\/runFlow with a read step as "g0" on the screenshot's tab after it and before the next state's screenshot/);
  assert.deepEqual(built.caseEntry.recordingSegments, [{ file: 'evidence/qa-gui/TC-03/TC-03-run.mp4', startMs: 0, endMs: 9000 }]);
  assert.equal(built.caseEntry.status, 'FAIL');
  // An empty recording object (the executor had no ids to give) also takes the stream's last recording.
  assert.equal(buildCaseEvidence({ draft: { ...d, recording: {} }, calls, binding, plannedCase: { req_id: 'REQ-X' }, boardCase: null, viewport: null, preflightRaw, fileSha, exists })
    .caseEntry.recordingSegments.length, 1);
});

// A board made before `web bind` carries another runUuid; collect refuses it before writing anything, with the fix.
test('web collect refuses a board whose runUuid is not the binding\'s, and says how to make the right one', async () => {
  const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-collect-cli-')));
  mkdirSync(join(runDir, 'board'), { recursive: true });
  writeFileSync(join(runDir, 'stream.jsonl'), stream);
  writeFileSync(join(runDir, 'binding.json'), JSON.stringify(binding));
  writeFileSync(join(runDir, 'tracked-plan.json'), JSON.stringify({ cases: [planned] }));
  const boardFile = join(runDir, 'board', 'qa-board.json');
  writeFileSync(boardFile, JSON.stringify({ runUuid: '22222222-2222-4222-8222-222222222222', cases: [{ id: 'TC-02', status: 'TODO' }] }));
  const writes = [];
  const deps = {
    parseFlags: (args) => ({ run: args[1], attestation: args[3], board: args[5] }), readJson: (p) => JSON.parse(readFileSync(p, 'utf8')),
    writeConfirmed: async (p, value) => { writes.push(p); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, value); }, stableJson: (v) => JSON.stringify(v),
    fail: (exit, code, detail) => { throw Object.assign(new Error(`${code} ${detail}`), { code, detail }); },
    assertRoleAttestation: () => ({ source: { kind: 'claude-stream', path: 'stream.jsonl', sha256: sha(Buffer.from(stream, 'utf8')) }, dispatch_case_id: 'TC-02', roster_hash: 'r' }),
    runDirectory: () => runDir, safeRunId: (v) => v,
  };
  await assert.rejects(webCollect(['--run', 'r1', '--attestation', join(runDir, 'a.json'), '--board', boardFile], deps),
    (e) => e.code === 'WEB_COLLECT_BOARD_RUN_UUID' && e.detail.includes(`--run-uuid ${binding.run_uuid}`) && e.detail.includes(`--target-binding-sha256 ${binding.target_binding_sha256}`));
  assert.deepEqual(writes, []);
  // With the binding's runUuid the same board is collected.
  writeFileSync(boardFile, JSON.stringify({ runUuid: binding.run_uuid, viewport: '1440x900', cases: [{ id: 'TC-02', status: 'TODO' }] }));
  const done = await webCollect(['--run', 'r1', '--attestation', join(runDir, 'a.json'), '--board', boardFile], deps);
  assert.equal(done.cases[0].status, 'FAIL');
  assert.deepEqual(done.cases[0].issues, ['VIEWPORT_MISMATCH:TC-02:tc02-after-save:1440x757:board=1440x900']);
  assert.equal(done.relocked, null);
  // A docs lock that pins this board gets the new revision's hash (through Team QA's own lockRunDocuments).
  writeFileSync(boardFile, JSON.stringify({ runUuid: binding.run_uuid, viewport: '1440x757', cases: [{ id: 'TC-02', status: 'TODO' }] }));
  writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ artifacts: { plan: { path: 'plan.md', sha256: 'p'.repeat(64) }, board: { path: 'board/qa-board.json', sha256: 'old' } } }));
  const locked = [];
  for (const f of ['evidence']) mkdirSync(join(runDir, f), { recursive: true });
  const again = await webCollect(['--run', 'r1', '--attestation', join(runDir, 'a.json'), '--board', boardFile], { ...deps, lockRunDocuments: async (o) => { locked.push(o); } });
  assert.equal(again.relocked, 'board');
  assert.deepEqual(locked.map((o) => [o.runDir, o.artifacts.plan.sha256, o.artifacts.board.path, o.artifacts.board.sha256]),
    [[runDir, 'p'.repeat(64), 'board/qa-board.json', sha(readFileSync(boardFile))]]);
});
