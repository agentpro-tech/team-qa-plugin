#!/usr/bin/env node
// Upgrade R3 flags-off fixture run: the same synthetic inputs every time through what R3 touches in Team QA (plan
// validation, web collect, the case dispatch start, the R0 time receipt and its report section), printed as one JSON
// document. `golden.json` beside this file is this run against the pre-R3 code (branch upgrade/full);
// test/speed/flags-off.test.mjs runs it against the current code and expects the same document. Only APIs present
// before R3 are used. Regenerate: node run-fixture.mjs <pre-R3 team-qa root> > golden.json
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? new URL('../../../../', import.meta.url).pathname);
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const { planErrors } = await load('scripts/lib/validators.mjs');
const { DRAFT_MARKER, webCollect } = await load('scripts/lib/web-collect.mjs');
const { startCaseDispatch } = await load('scripts/lib/run-contract.mjs');
const { runTiming, timingMarkdown } = await load('scripts/lib/timing.mjs');

const sha = (value) => createHash('sha256').update(value).digest('hex');
const work = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-r3-off-')));
process.chdir(work); // collect reports paths relative to the working directory
const norm = (value) => JSON.parse(JSON.stringify(value).split(work).join('<DIR>').split(basename(work)).join('<WORK>')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TS>'));
const out = {};

// 1. Plan validation, with lanes that say parallel_ok.
const plan = (lanes, extra = {}) => ({ run_id: 'r1', app: 'shop', plan_version: 1, lanes, tiers: { 'REQ-1': 'FULL', 'REQ-2': 'SMOKE' },
  exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 70 }, ...extra });
out.plan = {
  sequential: planErrors(plan([{ id: 'a', scope: ['REQ-1'], parallel_ok: false, vi_sao: '' }, { id: 'b', scope: ['REQ-2'], parallel_ok: false, vi_sao: '' }])),
  parallel: planErrors(plan([{ id: 'a', scope: ['REQ-1'], parallel_ok: true, vi_sao: 'own data' }, { id: 'b', scope: ['REQ-2'], parallel_ok: true, vi_sao: 'own data' }])),
  parallel_no_reason: planErrors(plan([{ id: 'a', scope: ['REQ-1'], parallel_ok: true, vi_sao: '' }])),
  unknown_root: planErrors(plan([{ id: 'a', scope: ['REQ-1'], parallel_ok: false, vi_sao: '' }], { turbo: true })),
};

// 2. web collect of one case-scoped draft (QA GUI's evidence tools stubbed), on a run whose signed plan has no speed block.
const runDir = join(work, 'runs', 'r1');
mkdirSync(join(runDir, 'board'), { recursive: true });
writeFileSync(join(runDir, 'test-plan.md'), `TEAMQA_PLAN_START\n${JSON.stringify(plan([{ id: 'gui', scope: ['REQ-1', 'REQ-2'], parallel_ok: false, vi_sao: '' }]))}\nTEAMQA_PLAN_END\n`);
const PNG = join(work, 'shot.png'); writeFileSync(PNG, 'state png bytes');
const MP4 = join(work, 'rec.mp4'); writeFileSync(MP4, 'mp4 bytes');
const ok = (result) => [{ type: 'text', text: JSON.stringify({ ok: true, result }) }];
const S = { sessionId: 'exec-s1', nonce: 'n1', browserInstanceId: 'bi-1' };
let t = Date.parse('2026-11-04T03:00:00Z');
const use = (id, method, params) => ({ type: 'assistant', timestamp: new Date(t += 1000).toISOString(), message: { content: [{ type: 'tool_use', id, name: 'mcp__Dragon_Browser__dragon_rpc', input: { method, params } }] } });
const res = (id, result) => ({ type: 'user', timestamp: new Date(t += 500).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: ok(result) }] } });
const draft = { case_id: 'TC-01', summary: { function: 'Saved.', ui: 'Clean.' }, lifecycle: { before: 'b', action: 'a', network: 'n', readback: 'r', refresh: 'f', postcondition: 'p' }, recording: true,
  states: [{ state: 'after-save', screenshot: 'after-save.png', gate0: 'g0', console: true, network: true, assertions: [{ assertion_id: 'TC-01-A1', verdict: 'PASS' }],
    vision: ['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'].map((rule) => ({ rule, verdict: rule === 'C12' ? 'FAIL' : 'PASS' })) }] };
const events = [
  use('u1', 'session.create', { sessionId: 'exec-s1' }), res('u1', { ...S }),
  use('u2', 'startRecording', { ...S, tabId: 7 }), res('u2', { id: 'rec-1', dir: join(work, 'rec-1') }),
  use('u3', 'do', { ...S, tabId: 7, steps: [{ click: 'Save', fast: false }] }), res('u3', { completed: true, results: [{ step: 'click', ok: true }] }),
  use('u4', 'screenshot', { ...S, tabId: 7, toFile: 'after-save.png' }),
  res('u4', { savedTo: PNG, sha256: sha(readFileSync(PNG)), domHash: 'd'.repeat(64), privacyMasked: true, dom: { url: 'https://app.test/orders/1', viewport: '1280x800' } }),
  use('u5', 'do', { ...S, tabId: 7, steps: [{ read: 'gate0()', as: 'g0' }] }), res('u5', { completed: true, results: [{ step: 'read', as: 'g0', value: { ui: { v: 'PASS' }, a11y: { v: 'PASS' } } }] }),
  use('u6', 'getConsole', { ...S, tabId: 7 }), res('u6', { count: 0, entries: [] }),
  use('u7', 'getNetwork', { ...S, tabId: 7 }), res('u7', { count: 1, requests: [{ t, method: 'POST', url: 'https://api.test/orders', status: 201, type: 'Fetch' }] }),
  use('u8', 'stopRecording', { ...S, tabId: 7, id: 'rec-1' }), res('u8', { id: 'rec-1', durationMs: 5000, dir: join(work, 'rec-1') }),
  use('u9', 'assembleRecording', { ...S, id: 'rec-1' }), res('u9', { video: MP4 }),
  { type: 'assistant', message: { content: [{ type: 'text', text: `${DRAFT_MARKER}\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\n` }] } },
];
const stream = events.map((e) => JSON.stringify(e)).join('\n');
writeFileSync(join(runDir, 'stream.jsonl'), stream);
const binding = { run_uuid: '44444444-4444-4444-8444-444444444444', target_binding_sha256: 'b'.repeat(64), target: { frontend_build: { id: 'build-5' } } };
writeFileSync(join(runDir, 'binding.json'), JSON.stringify(binding));
writeFileSync(join(runDir, 'tracked-plan.json'), JSON.stringify({ cases: [{ id: 'TC-01', req_id: 'REQ-1', title: 'Save an order', steps: ['Click Save'] }] }));
const boardFile = join(runDir, 'board', 'qa-board.json');
writeFileSync(boardFile, JSON.stringify({ runUuid: binding.run_uuid, viewport: '1280x800', cases: [{ id: 'TC-01', status: 'TODO', kind: 'behavioral' }] }));
const deps = {
  parseFlags: (args) => ({ run: args[1], attestation: args[3], board: args[5] }), readJson: (p) => JSON.parse(readFileSync(p, 'utf8')),
  writeConfirmed: async (p, value) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, value); }, stableJson: (v) => `${JSON.stringify(v, null, 2)}\n`,
  fail: (exit, code, detail) => { throw Object.assign(new Error(`${code} ${detail}`), { code, detail }); },
  assertRoleAttestation: () => ({ source: { kind: 'claude-stream', path: 'stream.jsonl', sha256: sha(Buffer.from(stream, 'utf8')) }, dispatch_case_id: 'TC-01', roster_hash: 'r' }),
  runDirectory: () => runDir, safeRunId: (v) => v,
  // The QA GUI stream detectors stay out of this fixture (test/claude-host/web-collect-detectors.test.mjs covers them).
  detectorTools: null,
  evidenceTools: { EVIDENCE_POLICY_VERSION: 1, MAX_EVIDENCE_WIDTH: 1280, fitPng: (bytes) => ({ png: bytes, sha256: sha(bytes), fit: { fromSha256: sha(bytes), width: 1280, height: 800 } }),
    buildRecordingManifest: () => ({ schema: 'qa-gui/recording-manifest/v1', id: 'rec-1', frames: [{ t: 0 }, { t: 5000 }], actions: [{ t: 1000 }] }), stateImageIssues: () => [], recordingSegmentIssues: () => [] },
};
const collected = await webCollect(['--run', 'r1', '--attestation', join(runDir, 'a.json'), '--board', boardFile], deps);
const files = [];
const walk = (dir) => { for (const name of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, name.name); if (name.isDirectory()) walk(p); else files.push(relative(runDir, p)); } };
walk(runDir);
out.collect = norm({ result: collected, board: JSON.parse(readFileSync(boardFile, 'utf8')), files: files.sort(),
  receipt: JSON.parse(readFileSync(join(runDir, 'evidence/qa-gui/TC-01/after-save.receipt.json'), 'utf8')) });

// 3. The GUI case dispatch start (ledger), on a locked tracked plan.
const tracked = { schemaVersion: 2, sourceItems: [{ id: 'SRC-1', kind: 'brief', sourceSystem: 'brief', externalKey: 'K-1', title: 'One', origin: 'upstream' }],
  cases: ['TC-01', 'TC-02'].map((id) => ({ id, req_id: 'REQ-1', lane: 'gui', steps: ['Open the page'], expected: 'Shown', data: {}, priority: 'P1', kind: 'static', title: id,
    sourceRefs: ['SRC-1'], taxonomy: ['functional'], states: ['ideal'], viewports: ['desktop'] })) };
writeFileSync(join(runDir, 'tracked-plan.v2.json'), JSON.stringify(tracked));
writeFileSync(join(runDir, 'docs-lock.json'), JSON.stringify({ artifacts: { plan: { path: 'test-plan.md', sha256: sha(readFileSync(join(runDir, 'test-plan.md'))) },
  tracked: { path: 'tracked-plan.v2.json', sha256: sha(readFileSync(join(runDir, 'tracked-plan.v2.json'))) } } }));
const started = [];
for (const [caseId, attempt] of [['TC-01', 'attempt-off-1'], ['TC-02', 'attempt-off-2'], ['TC-01', 'attempt-off-3']]) started.push(await startCaseDispatch({ runDir, role: 'executor_gui', caseId, attempt }));
out.dispatch = norm({ started, ledger: readFileSync(join(runDir, 'dispatch/executor_gui/case-dispatches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) });

// 4. The R0 time receipt and its report section, from a worker transcript and its dispatch state.
const projects = join(work, 'projects');
const attempt = '5a5a5a5a-1b1b-4c4c-8d8d-000000000001';
mkdirSync(join(projects, '-runs-r1'), { recursive: true });
let c = Date.parse('2026-11-04T04:00:00Z');
const at = () => new Date(c).toISOString();
const tx = [{ type: 'user', timestamp: at(), message: { role: 'user', content: 'go' } }];
for (const [i, [name, input, ms]] of [['mcp__Dragon_Browser__dragon_rpc', { method: 'do' }, 900], ['Read', { file_path: '/out/s.png' }, 1000], ['Bash', { command: 'node qa-gate.mjs b.json' }, 4000]].entries()) {
  c += 2000; tx.push({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id: `x${i}`, name, input }] } });
  c += ms; tx.push({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `x${i}`, content: [{ type: 'text', text: 'ok' }] }] } });
}
writeFileSync(join(projects, '-runs-r1', `${attempt}.jsonl`), `${tx.map((e) => JSON.stringify(e)).join('\n')}\n`);
mkdirSync(join(runDir, 'dispatch', 'executor_gui', attempt), { recursive: true });
writeFileSync(join(runDir, 'dispatch', 'executor_gui', attempt, 'state.json'), JSON.stringify({ case_id: 'TC-01', status: 'done', started_at: '2026-11-04T04:00:00.000Z', ended_at: at() }));
const timing = runTiming({ runDir, runId: 'r1', projectsRoot: projects });
out.timing = norm({ timing, markdown: timingMarkdown(timing) });

process.chdir(tmpdir());
rmSync(work, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
