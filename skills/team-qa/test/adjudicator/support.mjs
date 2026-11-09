// Fixtures of the adjudicator tests (upgrade R2a): one GUI case run by an executor that called it PASS, with the
// executor's stream, its narrative and evidence draft, the board record, the child verdict, a state receipt, and the
// raw evidence (a screenshot, a DOM snapshot, a recording). Every file is built here; nothing comes from an eval set.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const here = fileURLToPath(new URL('./', import.meta.url));
for (const stub of ['stub-adjudicator-claude.mjs', 'stub-adjudicator-codex.mjs']) chmodSync(join(here, stub), 0o755);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const write = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); return path; };

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
// A real, decodable PNG of the given size.
export function png(width, height, rgb = [240, 240, 240]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).fill(Buffer.from(rgb))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
// The marker segments of a baseline JPEG (SOI, APP0, SOF0, EOI): enough for its size to be read.
export function jpegHeader(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
const box = (type, payload) => { const size = Buffer.alloc(4); size.writeUInt32BE(8 + payload.length); return Buffer.concat([size, Buffer.from(type), payload]); };
// An MP4 with a movie header of the given duration (ftyp + moov/mvhd).
export function mp4(durationMs) {
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(durationMs, 16); mvhd.writeUInt32BE(0x00010000, 20);
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2', 'binary')), box('moov', box('mvhd', mvhd))]);
}

// The case's ledger record rewritten as an executed FAIL (for the PASS-only scope tests).
export function failRecord(f) {
  const record = { ...f.record, verdict: 'fail', function_verdict: 'fail', reason: 'FIXTURE_FAIL' };
  writeFileSync(join(f.runDir, 'board.jsonl'), `${JSON.stringify(record)}\n`);
  return record;
}

export const NARRATIVE = 'All three steps passed and the order was placed as expected.';
export const REASON = 'Executor judged every step as passing';
export const CHILD_NOTE = 'Cart total and confirmation matched the expected result';
export const SECRET = 'hunter22-secret';
const T0 = Date.parse('2026-11-04T02:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

export const SEAT = {
  role: 'adjudicator', mode: 'shadow', scope: 'pass_only', provider: 'anthropic', family: 'claude', model: 'claude-sonnet-5-5', effort: 'high', harness: 'claude',
  harness_version: '2.1.284', harness_bin: join(here, 'stub-adjudicator-claude.mjs'), caps: { timeout_ms: 30000, max_turns: 5 },
  reasoning_control: { kind: 'claude-effort', args: ['--effort', 'high'] }, executor_families: { executor_gui: 'gpt' },
};

function executorStream({ missingStep, narrativeInAction }) {
  const lines = [];
  let n = 0, s = 1;
  const call = (name, input, result) => {
    const id = `toolu_${String(++n).padStart(2, '0')}`;
    lines.push({ type: 'assistant', timestamp: at(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    lines.push({ type: 'user', timestamp: at(s + 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(result) }] }] } });
    s += 3;
  };
  const say = (text) => lines.push({ type: 'assistant', timestamp: at(s++), message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const rpc = 'mcp__Dragon_Browser__dragon_rpc', doTool = 'mcp__Dragon_Browser__do';
  say('I will open the catalog first, then add the first product and place the order.');
  call(rpc, { method: 'openTab', params: { sessionId: 'adj-s1', nonce: 'nonce-1234', url: 'http://127.0.0.1:4173/catalog' } }, { ok: true, result: { tabId: 7, url: 'http://127.0.0.1:4173/catalog' } });
  call(doTool, { sessionId: 'adj-s1', tabId: 7, steps: [{ action: 'type', selector: '#password', value: SECRET, reason: 'Logging in with the test account' }] }, { ok: true, result: { steps: [{ ok: true }] } });
  if (!missingStep) call(doTool, { sessionId: 'adj-s1', tabId: 7, steps: [{ action: 'click', selector: '[data-testid="add-to-cart"]', label: 'Add to cart' }] }, { ok: true, result: { steps: [{ ok: true }] } });
  if (narrativeInAction) call(doTool, { sessionId: 'adj-s1', tabId: 7, steps: [{ action: 'type', selector: '#feedback', value: NARRATIVE }] }, { ok: true, result: { steps: [{ ok: true }] } });
  call(doTool, { sessionId: 'adj-s1', tabId: 7, steps: [{ action: 'click', selector: '#place-order', label: 'Place order' }] }, { ok: true, result: { steps: [{ ok: true }] } });
  call(rpc, { method: 'getPageText', params: { sessionId: 'adj-s1', tabId: 7 } }, { ok: true, result: { text: 'Order placed. Thank you for shopping.' } });
  call(rpc, { method: 'screenshot', params: { sessionId: 'adj-s1', tabId: 7, toFile: 'TC-01-after-order.png' } }, { ok: true, result: { savedTo: '/dragon/out/TC-01-after-order.png' } });
  call('Read', { file_path: '/dragon/out/TC-01-after-order.png' }, 'image');
  const draft = { case_id: 'TC-01', summary: { function: NARRATIVE, ui: 'The layout looked right on the desktop width.' },
    states: [{ state: 'after-order', screenshot: 'TC-01-after-order.png', assertions: [{ assertion_id: 'TC-01-A1', verdict: 'PASS', note: 'The confirmation banner reads Order placed.' }] }] };
  const final = `${NARRATIVE}\n\nTEAMQA_EVIDENCE_DRAFT v1\n\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\``;
  say(final);
  lines.push({ type: 'result', subtype: 'success', result: final, session_id: 'exec-session-1' });
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

// One run with case TC-01. Options: missingStep drops the "Add to cart" action; narrativeInAction makes the executor
// type its own narrative into a page field; notesEvidence adds an executor-written text file as evidence.
// reportable: a run `teamqa report build` accepts as a historical diagnostic (a script-sourced PASS record with its
// screenshot as evidence, no password in the plan data), for the report tests.
export function fixtureRun({ missingStep = false, narrativeInAction = false, notesEvidence = false, reportable = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'tq-adjudicator-'));
  const runId = 'adj-run', runDir = join(base, 'runs', runId);
  const tracked = { schemaVersion: 2,
    sourceItems: [{ id: 'SRC-1', kind: 'story', sourceSystem: 'tracker', externalKey: 'SHOP-7', title: 'A shopper can order one product from the catalog', origin: 'upstream' }],
    cases: [{ id: 'TC-01', title: 'Order one product', req_id: 'REQ-ORDER', sourceRefs: ['SRC-1'], lane: 'gui',
      steps: ["Open the 'catalog' page", "Click 'Add to cart' on the first product", "Click 'Place order' in the cart"],
      expected: "The page shows 'Order placed'", data: reportable ? { product: 'Mug' } : { product: 'Mug', password: SECRET }, priority: 'P1', kind: 'behavioral',
      taxonomy: ['functional'], states: ['ideal'], viewports: ['desktop'] }] };
  write(join(runDir, 'tracked-plan.json'), `${JSON.stringify(tracked, null, 2)}\n`);
  write(join(runDir, 'test-plan.md'), `# Plan\n\nTEAMQA_PLAN_START\n${JSON.stringify({ run_id: runId, app: 'shop', plan_version: 1,
    lanes: [{ id: 'gui', scope: ['REQ-ORDER'], parallel_ok: false, vi_sao: '' }], tiers: { 'REQ-ORDER': 'FULL' },
    exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 0 } }, null, 2)}\nTEAMQA_PLAN_END\n`);
  write(join(runDir, 'inputs', 'accounts.json'), JSON.stringify({ email: 'shopper@example.test', password: SECRET }));
  const shot = png(320, 200), shotRel = 'evidence/TC-01/after-order.png';
  write(join(runDir, shotRel), shot);
  const domRel = 'evidence/TC-01/after-order.html';
  write(join(runDir, domRel), '<!doctype html><html><body><main><h1 class="title big">Order placed</h1><button id="place-order" class="btn primary" data-testid="place-order">Place order</button></main></body></html>\n');
  const videoRel = 'evidence/TC-01/recording.mp4';
  write(join(runDir, videoRel), mp4(5000));
  const receiptRel = 'evidence/TC-01/after-order.receipt.json';
  write(join(runDir, receiptRel), JSON.stringify({ schema: 'qa-gui/state-receipt/v1', caseId: 'TC-01', function: { verdict: 'PASS', assertions: [{ verdict: 'PASS', note: 'The confirmation banner reads Order placed.' }] } }));
  const childRel = 'evidence/TC-01-verdict.json';
  write(join(runDir, childRel), JSON.stringify({ schema: 'qa-gui/verdict/v3', case_id: 'TC-01', verdict: 'PASS', notes: CHILD_NOTE }));
  const notesRel = 'evidence/TC-01/executor-observations.txt';
  if (notesEvidence) write(join(runDir, notesRel), `${NARRATIVE}\nNothing else to report.\n`);
  const attemptId = '7b1d6f0e-3c2a-4b8e-9f10-2a3b4c5d6e7f';
  const streamPath = write(join(runDir, 'dispatch', 'executor_gui', attemptId, 'stdout.jsonl'), executorStream({ missingStep, narrativeInAction }));
  const attestation = write(join(runDir, 'attestations', 'executor_gui-TC-01.json'), JSON.stringify({ schema: 'team-qa/role-attestation/v1', run_id: runId, round: 1, role: 'executor_gui',
    session_id: attemptId, dispatch_case_id: 'TC-01', source: { kind: 'claude-stream', path: streamPath, sha256: sha(executorStream({ missingStep, narrativeInAction })) }, graded: true }));
  const record = { case_id: 'TC-01', lane: 'gui', verdict: 'pass', function_verdict: 'pass', ui_visual_verdict: 'pass', evidence: [childRel], source: 'qa-gui',
    run_id: runId, ts: at(60), attempt: 1, attempt_id: 'TC-01#1', started_at: at(0), ended_at: at(60), timeout_ms: 600000, reason: REASON,
    traceabilityVersion: 'team-qa/source-traceability/v1', sourceRefs: ['SRC-1'], child_verdict: { skill: 'qa-gui', verdict: 'pass', artifact: childRel, sha256: sha(Buffer.from(JSON.stringify({ schema: 'qa-gui/verdict/v3', case_id: 'TC-01', verdict: 'PASS', notes: CHILD_NOTE }))) } };
  if (reportable) { record.source = 'script'; record.evidence = [shotRel]; record.reason = 'FIXTURE_SCRIPT_PASS'; delete record.child_verdict; }
  write(join(runDir, 'board.jsonl'), `${JSON.stringify(record)}\n`);
  const manifest = [
    { path: shotRel, sha256: sha(shot), evidence_type: 'gui-screenshot', metadata: { case_id: 'TC-01', state: 'after-order' } },
    { path: receiptRel, sha256: null, evidence_type: 'machine-receipt', metadata: { case_id: 'TC-01', state: 'after-order' } },
    { path: videoRel, sha256: null, evidence_type: 'gui-recording', metadata: { case_id: 'TC-01', state: 'after-order' } },
    { path: 'evidence/TC-02/other.png', sha256: null, evidence_type: 'gui-screenshot', metadata: { case_id: 'TC-02', state: 'x' } },
  ];
  const qaBoard = write(join(runDir, 'qa-board.json'), JSON.stringify({ boardId: runId, rev: 4, cases: [{ id: 'TC-01', status: 'PASS' }], evidenceManifest: manifest }));
  return { base, runId, runDir, caseId: 'TC-01', attestation, streamPath, qaBoard, record, rel: { shot: shotRel, dom: domRel, video: videoRel, receipt: receiptRel, child: childRel, notes: notesRel } };
}
