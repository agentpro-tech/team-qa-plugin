// Upgrade R1f: correct and light evidence. Fixtures: the shipped 2560x1600 capture of qa-evidence/fixture-a and a
// trimmed real Dragon 1.6.6 recording (test/fixtures/r1f-evidence, see its events.json `_fixture`). Synthetic boards,
// never evidence of a product run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng } from '../scripts/visual-diff.mjs';
import {
  ACTION_AROUND_MS, EVIDENCE_CODES, MAX_EVIDENCE_WIDTH, RECORDING_MANIFEST_SCHEMA, buildRecordingManifest, fitPng, fitRgba,
  recordingActions, recordingSegmentIssues, stateImageIssues,
} from '../scripts/lib/evidence-quality.mjs';
import { checkGuiReleaseTruthV2 } from '../scripts/lib/qa-gui-v2.mjs';
import { validateCanonical } from '../scripts/teamwork/canonical.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GATE = join(ROOT, 'scripts/qa-gate.mjs');
const CLI = join(ROOT, 'scripts/qa-gui.mjs');
const CAPTURE = readFileSync(join(ROOT, 'qa-evidence/fixture-a/round-1/1280x800/after-load.png'));
const REC_DIR = join(ROOT, 'test/fixtures/r1f-evidence/recording');
const RECEIPTS = readFileSync(join(ROOT, 'test/fixtures/r1f-evidence/receipts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const RUN_UUID = '11111111-1111-4111-8111-111111111111';
const COMMIT = 'a'.repeat(40);
const URL_ = 'https://test.example/orders/1';
const BUILD = 'build-2026-11-04';
const DOM = 'b'.repeat(64);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const codes = (issues) => issues.map((item) => item.code);

function solidPng(width, height, rgb = [255, 255, 255]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([...rgb, 255], i * 4);
  return encodePng({ width, height, data });
}

function receiptFor({ capture = CAPTURE, png, fit, tabId = 'tab-1' } = {}) {
  return {
    schema: 'qa-gui/state-receipt/v1', caseId: 'TC-01', state: 'after-save', capturedAt: '2026-11-04T02:00:00.000Z',
    url: URL_, build: BUILD, viewport: '1280x800', domHash: DOM,
    dragon: { sessionId: 's-1', actionId: 'act-1', browserInstanceId: 'bi-1', tabId: 'tab-1', innerOk: true },
    screenshot: {
      path: 'evidence/TC-01-after-save.png', sha256: sha(png),
      capture: { tabId, url: URL_, build: BUILD, domHash: DOM, sha256: sha(capture), viewport: '1280x800', maskedRects: [] },
      ...(fit ? { fit } : {}),
    },
    target: { selector: '#save', rect: { x: 24, y: 247, width: 118, height: 36 } },
  };
}

const goodManifest = (video = Buffer.from('video')) => buildRecordingManifest({ dir: REC_DIR, video, receipts: RECEIPTS });

test('fit: at most 1280 px wide, same bytes every run, mask boxes stay black', () => {
  const first = fitPng(CAPTURE), second = fitPng(CAPTURE);
  assert.deepEqual(first.fit, { fromSha256: sha(CAPTURE), fromWidth: 2560, fromHeight: 1600, width: 1280, height: 800 });
  assert.ok(first.png.equals(second.png), 'fit is deterministic');
  assert.ok(first.png.length < CAPTURE.length, `${first.png.length} < ${CAPTURE.length}`);
  // A busy 2880x1800 frame (a 1440x900 viewport at DPR 2) with Dragon mask boxes at CSS rects that do not fall on the
  // 2.25 scale's pixel grid: the fitted boxes are black to their (outward-rounded) edges.
  const width = 2880, height = 1800, data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set([(x * 7 + y) & 255, (x * 3 + y * 5) & 255, (x ^ y) & 255, 255], (y * width + x) * 4);
  const masks = [{ kind: 'secret', x: 113, y: 223, w: 318, h: 48 }, { kind: 'pii', x: 71.5, y: 287.25, w: 319, h: 47 }];
  for (const rect of masks) {
    for (let y = Math.floor(rect.y * 2); y < Math.ceil((rect.y + rect.h) * 2); y += 1) {
      for (let x = Math.floor(rect.x * 2); x < Math.ceil((rect.x + rect.w) * 2); x += 1) data.set([0, 0, 0, 255], (y * width + x) * 4);
    }
  }
  const source = encodePng({ width, height, data });
  const fitted = fitPng(source, { masks, cssWidth: 1440 });
  const image = decodePng(fitted.png);
  assert.deepEqual([image.width, image.height], [MAX_EVIDENCE_WIDTH, 800]);
  const scale = 1280 / 1440;
  for (const rect of masks) {
    for (let y = Math.floor(rect.y * scale); y < Math.ceil((rect.y + rect.h) * scale); y += 1) {
      for (let x = Math.floor(rect.x * scale); x < Math.ceil((rect.x + rect.w) * scale); x += 1) {
        const q = (y * image.width + x) * 4;
        assert.deepEqual([...image.data.subarray(q, q + 3)], [0, 0, 0], `mask pixel ${x},${y}`);
      }
    }
  }
  // Without the rects, a pixel whose whole source span is mask black is still exactly black (box filter, integer sums).
  const plain = decodePng(fitPng(source).png);
  const q = (Math.round(247 * scale) * plain.width + Math.round(272 * scale)) * 4;
  assert.deepEqual([...plain.data.subarray(q, q + 3)], [0, 0, 0]);
  // A capture already within 1280 keeps its size.
  const small = fitRgba({ width: 1280, height: 800, data: Buffer.alloc(1280 * 800 * 4, 9) });
  assert.deepEqual([small.width, small.height], [1280, 800]);
});

test('image checks: good evidence passes; blank, wrong tab, target outside, too wide and an unbound capture are refused', () => {
  const { png, fit } = fitPng(CAPTURE);
  assert.deepEqual(stateImageIssues({ png, receipt: receiptFor({ png, fit }), caseId: 'TC-01', state: 'after-save' }), []);

  const white = solidPng(2560, 1600), blank = fitPng(white);
  const blankIssues = stateImageIssues({ png: blank.png, receipt: receiptFor({ capture: white, png: blank.png, fit: blank.fit }), caseId: 'TC-01', state: 'after-save' });
  assert.deepEqual(codes(blankIssues), ['EVIDENCE_IMAGE_BLANK']);
  assert.match(blankIssues[0].message, /^EVIDENCE_IMAGE_BLANK:TC-01:after-save:.* fix=re-capture$/);
  // White with black privacy boxes is still blank: the boxes are not content.
  const boxed = solidPng(1280, 800);
  const boxedImage = decodePng(boxed);
  for (let y = 224; y < 272; y += 1) for (let x = 114; x < 432; x += 1) boxedImage.data.set([0, 0, 0, 255], (y * 1280 + x) * 4);
  const boxedPng = encodePng(boxedImage);
  const boxedReceipt = receiptFor({ capture: boxedPng, png: boxedPng });
  boxedReceipt.screenshot.capture.maskedRects = [{ kind: 'secret', x: 114, y: 224, w: 318, h: 48 }];
  assert.deepEqual(codes(stateImageIssues({ png: boxedPng, receipt: boxedReceipt, caseId: 'TC-01', state: 's' })), ['EVIDENCE_IMAGE_BLANK']);

  assert.deepEqual(codes(stateImageIssues({ png, receipt: receiptFor({ png, fit, tabId: 'tab-2' }), caseId: 'TC-01', state: 's' })), ['EVIDENCE_IMAGE_BINDING']);
  const outside = receiptFor({ png, fit });
  outside.target.rect = { x: 1240, y: 760, width: 118, height: 36 };
  assert.deepEqual(codes(stateImageIssues({ png, receipt: outside, caseId: 'TC-01', state: 's' })), ['EVIDENCE_IMAGE_TARGET_OUTSIDE']);
  // The full-size capture used as evidence: too wide, and nothing binds it as its own fit.
  assert.deepEqual(codes(stateImageIssues({ png: CAPTURE, receipt: receiptFor({ png: CAPTURE }), caseId: 'TC-01', state: 's' })), ['EVIDENCE_IMAGE_TOO_WIDE']);
  const otherDom = receiptFor({ png, fit });
  otherDom.screenshot.capture.domHash = 'c'.repeat(64);
  delete otherDom.screenshot.capture.viewport;
  assert.deepEqual(codes(stateImageIssues({ png, receipt: otherDom, caseId: 'TC-01', state: 's' })), ['EVIDENCE_IMAGE_BINDING']);
  const portrait = receiptFor({ png, fit });
  portrait.viewport = '390x844'; portrait.screenshot.capture.viewport = '390x844';
  assert.ok(codes(stateImageIssues({ png, receipt: portrait, caseId: 'TC-01', state: 's' })).includes('EVIDENCE_IMAGE_BINDING'));
  const lyingFit = receiptFor({ png, fit: { ...fit, height: 801 } });
  assert.deepEqual(codes(stateImageIssues({ png, receipt: lyingFit, caseId: 'TC-01', state: 's' })), ['EVIDENCE_IMAGE_FIT']);
  assert.deepEqual(Object.values(EVIDENCE_CODES).sort().filter((v, i, a) => a.indexOf(v) === i), ['re-capture', 're-record']);
});

test('recording manifest from a real Dragon recording dir; receipts give the action times when the recording has no input events', () => {
  const video = Buffer.from('assembled video bytes');
  const manifest = goodManifest(video);
  const events = JSON.parse(readFileSync(join(REC_DIR, 'events.json'), 'utf8'));
  assert.equal(manifest.schema, RECORDING_MANIFEST_SCHEMA);
  assert.deepEqual([manifest.id, manifest.startedAt, manifest.frames.length, manifest.actionSource], [events.id, events.startedAt, 20, 'dragon-receipts']);
  assert.deepEqual(manifest.frames[0], { t: 70, file: 'f-000000.jpg', sha256: sha(readFileSync(join(REC_DIR, 'f-000000.jpg'))), bytes: readFileSync(join(REC_DIR, 'f-000000.jpg')).length });
  // openTab came before the recording started; reload and the two navigations fall inside it.
  assert.deepEqual(manifest.actions.map((a) => [a.t, a.kind]), [[1143, 'reloadTab'], [2187, 'navigate'], [3252, 'navigate']]);
  assert.deepEqual(manifest.video, { sha256: sha(video), bytes: video.length });
  assert.deepEqual(manifest.frameSize, { width: 320, height: 200 });
  assert.deepEqual(recordingSegmentIssues({ manifest, segment: { file: 'x.mp4', startMs: 0, endMs: 5006 }, videoSha256: sha(video), caseId: 'TC-01' }), []);
  // The recording's own events (same clock as the frames) win over receipts.
  assert.deepEqual(recordingActions({ events: [{ t: 10, kind: 'move' }, { t: 900, kind: 'down' }, { t: 950, kind: 'up' }, { t: 1500, kind: 'key' }], startedAt: 0, receipts: RECEIPTS }),
    { actionSource: 'recording-events', actions: [{ t: 900, kind: 'click', source: 'recording-event' }, { t: 1500, kind: 'key', source: 'recording-event' }] });
});

test('recording checks: no frame around the action, repeated frames, frames lost, no change and a manifest of another video are refused', () => {
  const video = Buffer.from('v');
  const segment = { file: 'x.mp4', startMs: 0, endMs: 9001 };
  const check = (mutate) => { const manifest = goodManifest(video); mutate(manifest); return recordingSegmentIssues({ manifest, segment, videoSha256: sha(video), caseId: 'TC-01' }); };
  const late = check((m) => m.actions.push({ t: 9000, kind: 'click', source: 'dragon-receipt' }));
  assert.deepEqual(codes(late), ['EVIDENCE_VIDEO_NO_ACTION_COVERAGE', 'EVIDENCE_VIDEO_NO_ACTION_COVERAGE']);
  assert.match(late[0].message, new RegExp(`no frame within ${ACTION_AROUND_MS} ms of the action at 9000 ms fix=re-record$`));
  const repeated = check((m) => { for (const frame of m.frames) frame.sha256 = 'e'.repeat(64); });
  assert.deepEqual(codes(repeated), ['EVIDENCE_VIDEO_NO_CHANGE', 'EVIDENCE_VIDEO_STALE']);
  assert.deepEqual(codes(check((m) => { m.delivery.persistedFrames = 19; })), ['EVIDENCE_VIDEO_FRAME_COUNT']);
  assert.deepEqual(codes(check((m) => { m.frames.pop(); })), ['EVIDENCE_VIDEO_FRAME_COUNT']);
  // The screen changes only before the actions and never after: no change, though the window is not one image.
  const still = check((m) => { for (const frame of m.frames) if (frame.t > 1000) frame.sha256 = m.frames[4].sha256; });
  assert.deepEqual(codes(still), ['EVIDENCE_VIDEO_NO_CHANGE']);
  assert.deepEqual(codes(check((m) => { m.actions = []; })), ['EVIDENCE_VIDEO_NO_ACTION_COVERAGE']);
  assert.deepEqual(codes(recordingSegmentIssues({ manifest: goodManifest(Buffer.from('other')), segment, videoSha256: sha(video), caseId: 'TC-01' })), ['EVIDENCE_VIDEO_MANIFEST']);
  assert.deepEqual(codes(recordingSegmentIssues({ manifest: { schema: 'x' }, segment, videoSha256: sha(video), caseId: 'TC-01' })), ['EVIDENCE_VIDEO_MANIFEST']);
});

test('the qa-gui CLI writes the fit and the recording manifest', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r1f-cli-')));
  writeFileSync(join(dir, 'capture.png'), CAPTURE);
  writeFileSync(join(dir, 'masks.json'), JSON.stringify([{ kind: 'pii', x: 10, y: 10, w: 20, h: 20 }]));
  let r = spawnSync(process.execPath, [CLI, 'evidence', 'fit', '--in', join(dir, 'capture.png'), '--out', join(dir, 'fit.png'), '--max-width', '1280', '--masks', join(dir, 'masks.json'), '--viewport', '1280x800'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const fit = JSON.parse(r.stdout);
  assert.deepEqual(fit.fit, { fromSha256: sha(CAPTURE), fromWidth: 2560, fromHeight: 1600, width: 1280, height: 800 });
  assert.equal(fit.sha256, sha(readFileSync(join(dir, 'fit.png'))));
  writeFileSync(join(dir, 'run.mp4'), Buffer.alloc(1024, 7));
  r = spawnSync(process.execPath, [CLI, 'recording-manifest', '--dir', REC_DIR, '--out', join(dir, 'm.json'), '--video', join(dir, 'run.mp4'),
    '--receipts', join(ROOT, 'test/fixtures/r1f-evidence/receipts.jsonl')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).actionSource, 'dragon-receipts');
  assert.equal(JSON.parse(readFileSync(join(dir, 'm.json'), 'utf8')).video.sha256, sha(readFileSync(join(dir, 'run.mp4'))));
  r = spawnSync(process.execPath, [CLI, 'evidence', 'fit', '--in', join(dir, 'capture.png'), '--out', join(dir, 'capture.png')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

// ── the gate, default mode, on a schema 6 board with one behavioral case ──────────────────────────────────────────
function board({ policy = true, capture = CAPTURE, receipt = () => {}, manifest = () => {}, segment = () => {}, honest = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r1f-gate-')));
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  const write = (rel, bytes) => { writeFileSync(join(dir, rel), bytes); return rel; };
  const { png, fit } = fitPng(capture);
  const shot = write('evidence/TC-01-after-save.png', png);
  const raw = write('evidence/TC-01-raw.json', '{"observed":"saved"}\n');
  const video = Buffer.alloc(60 * 1024); for (let i = 0; i < video.length; i += 1) video[i] = (i * 31) & 255;
  const mp4 = write('evidence/TC-01-run.mp4', video);
  const m = goodManifest(video); manifest(m);
  const man = write('evidence/TC-01-run.recording.json', `${JSON.stringify(m, null, 2)}\n`);
  const r = receiptFor({ capture, png, fit });
  const phase = (extra = {}) => ({ verdict: 'PASS', evidence_ref: raw, ...extra });
  Object.assign(r, {
    function: { verdict: 'PASS', assertions: [{ requirement_id: 'REQ-1', verdict: 'PASS', evidence_ref: raw }] },
    ui: { verdict: 'PASS', uiSanity: { id: 'ui-sanity', verdict: 'PASS', evidence: 'raw' }, a11y: { id: 'a11y', verdict: 'PASS', evidence: 'raw' },
      console: { id: 'console', verdict: 'PASS', evidence: 'raw' }, network: { id: 'network', verdict: 'PASS', evidence: 'raw' } },
    preflight: { id: 'preflight', verdict: 'PASS', evidence: 'raw' },
    network: [{ method: 'POST', url: 'https://test.example/api/orders', status: 201 }],
    readback: { value: { status: 'saved' }, evidence_ref: raw },
    lifecycle: { before: phase(), action: phase({ writes_data: true }), network: phase({ expect_net: true }), readback: phase(), refresh: phase(), postcondition: phase() },
  });
  receipt(r);
  const rec = write('evidence/TC-01-after-save.state.json', `${JSON.stringify(r, null, 2)}\n`);
  const seg = { file: mp4, startMs: 0, endMs: 5006, manifest: man }; segment(seg);
  const evidence = [shot, raw, rec, mp4, man];
  const data = {
    schemaVersion: 6, canonicalVersion: 'qa-board-teamwork/v2', boardKind: 'team-qa-board', rev: 1, boardId: 'r1f', title: 'R1f evidence policy fixture',
    boardCreated: '2026-11-04T01:00:00.000Z', language: 'en', deepCheck: 'available', app: 'r1f-fixture', envDb: 'TEST / fixture',
    viewport: '1280x800', runUuid: RUN_UUID, commit: COMMIT, build: BUILD, env: 'TEST', db: 'fixture', role: 'qa-agent', testProfile: 'r1f',
    ...(policy ? { evidencePolicy: { version: 1 } } : {}),
    evidenceManifest: evidence.map((path) => ({ path, sha256: sha(readFileSync(join(dir, path))) })),
    currentRound: 1,
    sourceItems: [{ id: 'SRC-1', kind: 'spec', sourceSystem: 'fixture', externalKey: 'REQ-1', title: 'Save an order', origin: 'upstream' }],
    cases: [{
      id: 'TC-01', title: 'Save an order', requirement: 'REQ-1', requirements: ['REQ-1'], sourceRefs: ['SRC-1'], steps: 'Fill the form and save.',
      expected: 'The order is saved.', status: 'PASS', priority: 'P1', assignee: 'qa-agent', functionVerdict: 'PASS', uiVerdict: 'PASS',
      humanSummary: { function: 'Saved.', ui: 'Clean.' }, machine: { rule: 'r1f', selector: '#save' }, kind: 'behavioral', states: ['after-save'],
      stateReceipts: [{ state: 'after-save', file: rec }], ...(policy ? { recordingSegments: [seg] } : {}),
      results: [{ round: 1, functionVerdict: 'PASS', uiVerdict: 'PASS', recordedAt: '2026-11-04T02:01:00.000Z', evidence }],
      evidence, comments: [], history: [],
    }],
    defects: [], rounds: [{ round: 1, startedAt: '2026-11-04T01:00:00.000Z', scope: 'R1f fixture' }],
    coverage: ['happy', 'boundary', 'empty', 'loading', 'error', 'auth-role', 'navigation', 'keyboard', 'responsive', 'dark-mode'].map((area) => ({ area, status: 'tick' })),
    untested: [], release: { verdict: 'GO', risks: [] },
  };
  // The board as an honest writer records it once the evidence is rejected: the case is not graded, the release no-go.
  if (honest) Object.assign(data.cases[0], { status: 'BLOCKED', functionVerdict: 'UNGRADED', uiVerdict: 'UNGRADED' }), data.release = { verdict: 'NO-GO', risks: ['TC-01 evidence rejected'] };
  const file = join(dir, 'board.json');
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { dir, file, data };
}
const gate = (file) => spawnSync(process.execPath, [GATE, file], { cwd: dirname(file), encoding: 'utf8' });

test('gate: good evidence under evidence policy v1 passes', () => {
  const { file, data } = board();
  assert.deepEqual(validateCanonical(data).errors, []);
  const r = gate(file);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /QA gate: PASS/);
});

test('gate: each rejected screenshot or recording keeps the case from PASS, with its code and fix hint', () => {
  const white = solidPng(2560, 1600);
  for (const [name, options, code, hint] of [
    ['blank image', { capture: white }, 'EVIDENCE_IMAGE_BLANK', 're-capture'],
    ['wrong-tab capture', { receipt: (r) => { r.screenshot.capture.tabId = 'tab-2'; } }, 'EVIDENCE_IMAGE_BINDING', 're-capture'],
    ['target outside the frame', { receipt: (r) => { r.target.rect.y = 790; } }, 'EVIDENCE_IMAGE_TARGET_OUTSIDE', 're-capture'],
    ['no frame around the action', { manifest: (m) => m.actions.push({ t: 9000, kind: 'click', source: 'dragon-receipt' }), segment: (s) => { s.endMs = 9001; } }, 'EVIDENCE_VIDEO_NO_ACTION_COVERAGE', 're-record'],
    ['repeated frames', { manifest: (m) => { for (const frame of m.frames) frame.sha256 = 'e'.repeat(64); } }, 'EVIDENCE_VIDEO_STALE', 're-record'],
    ['frame-count mismatch', { manifest: (m) => { m.delivery.extensionFrames = 21; } }, 'EVIDENCE_VIDEO_FRAME_COUNT', 're-record'],
    ['segment without manifest', { segment: (s) => { delete s.manifest; } }, 'EVIDENCE_VIDEO_MANIFEST', 're-record'],
  ]) {
    // A board that still claims PASS is FAIL (its verdict does not match the receipts); an honest board is UNGRADED.
    const claimed = gate(board(options).file);
    assert.equal(claimed.status, 1, `${name}: ${claimed.stdout}${claimed.stderr}`);
    assert.match(claimed.stderr, new RegExp(`UNGRADED ${code}:TC-01:[^\\n]* fix=${hint}`), name);
    assert.match(claimed.stderr, /board functionVerdict PASS does not match receipt-computed UNGRADED/, name);
    assert.doesNotMatch(claimed.stdout, /QA gate: PASS/, name);
    const honest = gate(board({ ...options, honest: true }).file);
    assert.equal(honest.status, 20, `${name} (honest board): ${honest.stdout}${honest.stderr}`);
    assert.match(honest.stdout, /QA gate: UNGRADED/, name);
  }
});

test('gate: without the policy the same board keeps today\'s checks (compatibility)', () => {
  const { file } = board({ policy: false, capture: solidPng(2560, 1600) });
  const r = gate(file);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // A Git board may carry recording segments only under the policy.
  const { data } = board({ policy: false });
  data.cases[0].recordingSegments = [{ file: 'evidence/TC-01-run.mp4', startMs: 0, endMs: 1 }];
  assert.ok(validateCanonical(data).errors.some((e) => e.path === 'cases[0].recordingSegments'));
});

test('release-truth v2: rejected evidence turns the case\'s atomic rows UNGRADED, so a case-scoped reader cannot see PASS', () => {
  const v2 = (options) => {
    const fixture = board(options);
    const types = { png: 'gui-screenshot', mp4: 'gui-recording', json: 'machine-receipt' };
    fixture.data.evidenceManifest = fixture.data.evidenceManifest.map((entry) => ({ ...entry,
      evidence_type: entry.path.endsWith('.recording.json') ? 'recording-manifest' : types[entry.path.split('.').pop()],
      metadata: { run_uuid: RUN_UUID, task_base: COMMIT, commit: COMMIT, case_id: 'TC-01', state: 'after-save', captured_at: '2026-11-04T02:00:00.000Z' } }));
    const receiptPath = join(fixture.dir, 'evidence/TC-01-after-save.state.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    receipt.function.assertions = [{ requirement_id: 'REQ-1', assertion_id: 'TC-01-A1', verdict: 'PASS', evidence_ref: receipt.screenshot.path, evidence_type: 'gui-screenshot' }];
    receipt.network_summary = { failed_requests: 0 };
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const entry = fixture.data.evidenceManifest.find((e) => e.path.endsWith('.state.json'));
    entry.sha256 = sha(readFileSync(receiptPath));
    writeFileSync(fixture.file, JSON.stringify(fixture.data));
    const requirement = { id: 'REQ-1', acceptance_ids: ['TC-01'], risk_dimensions: [], evidence_contract: { allowed_types: ['gui-screenshot', 'gui-recording'] } };
    const context = { kind: 'git', exactFinalSha: COMMIT, taskBase: COMMIT, activeGuiRequirements: [requirement], guiIds: ['REQ-1'],
      planById: new Map([['TC-01', { requirementId: 'REQ-1', data: {} }]]) };
    return checkGuiReleaseTruthV2({ data: fixture.data, boardPath: fixture.file, evidenceRoot: fixture.dir, context });
  };
  const good = v2();
  assert.deepEqual(good.issues.filter((i) => i.message.startsWith('EVIDENCE_')), []);
  assert.deepEqual(good.atomicCoverage.map((row) => row.result), ['PASS']);
  const bad = v2({ manifest: (m) => { m.delivery.persistedFrames = 3; } });
  assert.ok(bad.issues.some((i) => i.ungraded && i.message.startsWith('EVIDENCE_VIDEO_FRAME_COUNT:TC-01:segment-0')));
  assert.deepEqual(bad.atomicCoverage.map((row) => row.result), ['UNGRADED']);
  assert.equal(bad.computed.cases[0].assertions[0].result, 'UNGRADED');
});

test('teamwork init --evidence-policy 1 writes the switch; any other value is refused', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r1f-init-')));
  const tool = join(ROOT, 'scripts/teamwork/cli.mjs');
  let r = spawnSync(process.execPath, [tool, 'init', '--out', join(dir, 'b.json'), '--board-id', 'b', '--title', 'T', '--evidence-policy', '1'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const created = JSON.parse(readFileSync(join(dir, 'b.json'), 'utf8'));
  assert.deepEqual(created.evidencePolicy, { version: 1 });
  assert.deepEqual(validateCanonical(created).errors, []);
  assert.ok(validateCanonical({ ...created, evidencePolicy: { version: 2 } }).errors.some((e) => e.path === 'evidencePolicy.version'));
  r = spawnSync(process.execPath, [tool, 'init', '--out', join(dir, 'c.json'), '--board-id', 'b', '--title', 'T', '--evidence-policy', 'on'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  r = spawnSync(process.execPath, [tool, 'init', '--out', join(dir, 'd.json'), '--board-id', 'b', '--title', 'T'], { encoding: 'utf8' });
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(dir, 'd.json'), 'utf8')), 'evidencePolicy'), false);
});
