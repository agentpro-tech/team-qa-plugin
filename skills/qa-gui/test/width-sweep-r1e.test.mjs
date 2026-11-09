// Upgrade R1e: the width sweep. Read-only geometry from 320 to 1440 px in steps of 20-40 px, then bisection to the exact
// width where the layout or a failure changes; a failing element is confirmed by a paint-ordered snapshot, captured only
// at the narrowest width that still fails, and the verdict still comes from the responsive matrix rows whose emulation
// was verified. Fixtures: test/fixtures/r1e/width-band*.html (synthetic pages). Not evidence of a product run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  WIDTH_SWEEP_SCHEMA, confirmVisible, normalizeDomSnapshot, sweepVerdict, sweepWidths,
} from '../scripts/lib/width-sweep.mjs';
import { dragonGeometryReader } from '../scripts/lib/width-sweep-dragon.mjs';
import { loadPlaywright, PLAYWRIGHT_SKIP } from './support/playwright.mjs';
import { playwrightGeometryReader } from './support/playwright-readers.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GATE = join(ROOT, 'scripts/qa-gate.mjs');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rect = { x: 16, y: 40, width: 900, height: 30 };

// A scripted page: the toolbar sticks out between `from` and `to`; the nav moves above main below 768 px.
function scripted({ from = 741, to = 783, visible = true, rows = {} } = {}) {
  const probed = [];
  const captured = [];
  const page = (width) => ({
    width, layout: width < 768 ? 'header / nav / main' : 'header / nav,main',
    failures: width >= from && width <= to ? [{ rule: 'W2', selector: 'div.toolbar', tag: 'div', detail: `outside the viewport: 16..916 of ${width}`, rect }] : [],
  });
  const reader = {
    async measure(width) { probed.push(width); return page(width); },
    async snapshot(width) {
      return { nodes: [
        { index: 0, parent: -1, name: 'HTML', rect: { x: 0, y: 0, width, height: 800 }, paintOrder: 1, visible: true },
        { index: 1, parent: 0, name: 'DIV', rect, paintOrder: 5, visible },
      ] };
    },
    async capture(width) { captured.push(width); return { width, sha256: sha(String(width)) }; },
    async measureRow(row) {
      const measured = page(row.w);
      return { verified: rows[row.id] !== 'unverified', failures: rows[row.id] === 'clean' ? [] : measured.failures.map((f) => `${f.rule}|${f.selector}`) };
    },
  };
  return { reader, probed, captured };
}

test('the sweep reports exactly the width band where the failure lives, with the layout breakpoint, by bisection', async () => {
  const { reader, probed, captured } = scripted();
  const sweep = await sweepWidths({ reader });
  assert.equal(sweep.schema, WIDTH_SWEEP_SCHEMA);
  assert.deepEqual(sweep.bands.map((band) => [band.id, band.from, band.to]), [['W2|div.toolbar', 741, 783]]);
  assert.deepEqual(sweep.breakpoints.map((point) => point.width), [768]);
  // Coarse every 20 px by default (57 widths 320..1440), then a few bisection probes per edge; never a full pixel scan.
  assert.equal(sweep.step, 20);
  assert.equal(sweep.samples.length, 57);
  assert.ok(sweep.probes < 80, `probes ${sweep.probes}`);
  assert.equal(new Set(probed).size, probed.length, 'a width is measured once');
  // Confirmed by the paint-ordered snapshot; captured once, at the narrowest failing width.
  assert.equal(sweep.bands[0].status, 'CONFIRMED');
  assert.deepEqual(captured, [741]);
  assert.equal(sweep.bands[0].capture, 741);
  // The verdict comes from the matrix rows inside the band, whose emulation was verified.
  assert.deepEqual(sweep.bands[0].rows, ['desktop-767', 'desktop-768', 'desktop-769']);
  assert.deepEqual([sweep.bands[0].verdict, sweep.bands[0].reason], ['FAIL', null]);
});

test('a band no verified matrix row backs is not a verdict: UNGRADED with its reason', async () => {
  let sweep = await sweepWidths({ reader: scripted({ from: 587, to: 703 }).reader });
  assert.deepEqual(sweep.bands.map((band) => [band.from, band.to, band.verdict, band.reason]), [[587, 703, 'UNGRADED', 'SWEEP_BAND_OUTSIDE_MATRIX']]);
  sweep = await sweepWidths({ reader: scripted({ rows: { 'desktop-767': 'clean', 'desktop-768': 'clean', 'desktop-769': 'clean' } }).reader });
  assert.deepEqual([sweep.bands[0].verdict, sweep.bands[0].reason], ['UNGRADED', 'SWEEP_MATRIX_DISAGREES']);
  sweep = await sweepWidths({ reader: scripted({ rows: { 'desktop-767': 'unverified', 'desktop-768': 'unverified', 'desktop-769': 'unverified' } }).reader });
  assert.deepEqual([sweep.bands[0].verdict, sweep.bands[0].reason], ['UNGRADED', 'EMULATION_NOT_VERIFIED']);
});

test('a failure the paint-ordered snapshot shows is not painted is no finding; without a snapshot it stays unconfirmed', async () => {
  const hidden = scripted({ visible: false });
  let sweep = await sweepWidths({ reader: hidden.reader });
  assert.deepEqual([sweep.bands[0].status, sweep.bands[0].verdict], ['NOT_VISIBLE', null]);
  assert.deepEqual(hidden.captured, []);
  const { reader } = scripted();
  delete reader.snapshot;
  sweep = await sweepWidths({ reader });
  assert.deepEqual([sweep.bands[0].status, sweep.bands[0].confirmation.reason], ['UNCONFIRMED', 'SNAPSHOT_UNAVAILABLE']);
  // An unconfirmed band still takes its verdict from the matrix rows.
  assert.equal(sweep.bands[0].verdict, 'FAIL');
});

test('the step stays in 20-40 px, and the gate recomputes the verdicts instead of trusting the receipt', async () => {
  await assert.rejects(sweepWidths({ reader: scripted().reader, step: 10 }), /SWEEP_STEP_OUT_OF_RANGE/);
  await assert.rejects(sweepWidths({ reader: scripted().reader, step: 60 }), /SWEEP_STEP_OUT_OF_RANGE/);
  const sweep = await sweepWidths({ reader: scripted().reader, step: 40 });
  assert.equal(sweep.samples.length, 29);
  assert.deepEqual(sweep.bands.map((band) => [band.from, band.to]), [[741, 783]]);
  assert.deepEqual(sweepVerdict(sweep), { verdict: 'FAIL', issues: ['SWEEP_BAND_FAIL:W2|div.toolbar:741-783:desktop-767,desktop-768,desktop-769'] });
  const tampered = structuredClone(sweep);
  tampered.bands[0].verdict = 'PASS';
  assert.equal(sweepVerdict(tampered).verdict, 'FAIL');
  const clean = await sweepWidths({ reader: scripted({ from: 2000, to: 2001 }).reader });
  assert.deepEqual(sweepVerdict(clean), { verdict: 'PASS', issues: [] });
  assert.deepEqual(sweepVerdict({ schema: 'other' }).verdict, 'UNGRADED');
});

test('confirmVisible reads paint order: an element under an opaque sibling is not visible', () => {
  const snapshot = { nodes: [
    { index: 0, parent: -1, name: 'HTML', rect: { x: 0, y: 0, width: 800, height: 800 }, paintOrder: 1, visible: true },
    { index: 1, parent: 0, name: 'DIV', rect: { x: 10, y: 10, width: 100, height: 20 }, paintOrder: 2, visible: true },
    { index: 2, parent: 0, name: 'SECTION', rect: { x: 0, y: 0, width: 800, height: 400 }, paintOrder: 3, visible: true },
  ] };
  const failure = { tag: 'div', rect: { x: 10, y: 10, width: 100, height: 20 } };
  assert.deepEqual(confirmVisible(snapshot, failure, 800), { status: 'NOT_VISIBLE', reason: 'COVERED', by: 'SECTION' });
  snapshot.nodes[2].paintOrder = 0;
  assert.equal(confirmVisible(snapshot, failure, 800).status, 'CONFIRMED');
  assert.deepEqual(confirmVisible(snapshot, { tag: 'span', rect: failure.rect }, 800), { status: 'UNCONFIRMED', reason: 'NODE_NOT_IN_SNAPSHOT' });
});

test('normalizeDomSnapshot reads the CDP DOMSnapshot shape (nodes, layout, paint orders, styles)', () => {
  const cdp = {
    strings: ['HTML', 'DIV', 'visible', 'hidden', '1', 'block'],
    documents: [{
      nodes: { parentIndex: [-1, 0, 0], nodeName: [0, 1, 1] },
      layout: { nodeIndex: [0, 1, 2], bounds: [[0, 0, 800, 600], [10, 10, 50, 20], [10, 40, 50, 20]], paintOrders: [0, 1, 2], styles: [[2, 4, 5], [2, 4, 5], [3, 4, 5]] },
    }],
  };
  assert.deepEqual(normalizeDomSnapshot(cdp, ['visibility', 'opacity', 'display']).nodes.map((n) => [n.index, n.name, n.paintOrder, n.visible]),
    [[0, 'HTML', 0, true], [1, 'DIV', 1, true], [2, 'DIV', 2, false]]);
});

// A fake Dragon bridge with R1a's paintSnapshot read (docs/r1a-environment-and-sensors.md §3).
function fakeDragon({ paint = () => ({ ok: true, elements: [{ found: true, shown: true, reasons: [] }] }), failures = [] } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'setViewport') return { ok: true, viewport: { width: params.width, height: params.height } };
    if (method === 'do') return { completed: true, results: [{ step: 'read', as: 'geometry', value: JSON.stringify({ width: 760, layout: 'a', failures: failures.filter((f) => params.steps && f) }) }] };
    if (method === 'paintSnapshot') return paint(params);
    if (method === 'captureTab') return { ok: true, sha256: 'a'.repeat(64) };
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls };
}

test('the Dragon reader: setViewport then a read step; captureTab as light evidence', async () => {
  const { rpc, calls } = fakeDragon();
  const reader = dragonGeometryReader({ rpc, binding: { sessionId: 's', nonce: 'n', browserInstanceId: 'b' }, tabId: 7 });
  assert.deepEqual(await reader.measure(760), { width: 760, layout: 'a', failures: [] });
  assert.deepEqual(calls.map(([method]) => method), ['setViewport', 'do']);
  assert.deepEqual([calls[0][1].width, calls[0][1].mobile, calls[0][1].deviceScaleFactor], [760, false, 1]);
  assert.equal(calls[1][1].steps[0].as, 'geometry');
  await reader.capture(760);
  const [, capture] = calls.at(-1);
  assert.deepEqual([capture.tabId, capture.evidence, Object.hasOwn(capture, 'width')], [7, true, false]);
});

test('the Dragon reader confirms a band with R1a paintSnapshot at the band width', async () => {
  const failure = { rule: 'W2', selector: 'div.shell > main', target: 'div.shell > main', tag: 'main', rect: { x: 0, y: 70, width: 916, height: 85 } };
  let dragon = fakeDragon();
  let reader = dragonGeometryReader({ rpc: dragon.rpc, binding: { sessionId: 's' }, tabId: 7 });
  assert.deepEqual(await reader.confirm(741, failure), { status: 'CONFIRMED', reason: null });
  const [, viewport] = dragon.calls.find(([method]) => method === 'setViewport');
  const [, paint] = dragon.calls.find(([method]) => method === 'paintSnapshot');
  assert.deepEqual([viewport.width, paint.tabId, paint.selector], [741, 7, 'div.shell > main']);
  // A W1 page overflow has no element: the scroll width confirms it, no snapshot is read.
  dragon = fakeDragon();
  reader = dragonGeometryReader({ rpc: dragon.rpc, tabId: 7 });
  assert.deepEqual(await reader.confirm(741, { rule: 'W1', selector: 'html' }), { status: 'CONFIRMED', reason: 'SCROLL_WIDTH' });
  assert.ok(!dragon.calls.some(([method]) => method === 'paintSnapshot'));
  // Covered, hidden or missing elements.
  for (const [paintResult, expected] of [
    [{ ok: true, elements: [{ found: true, shown: false, reasons: ['covered'] }] }, { status: 'NOT_VISIBLE', reason: 'COVERED' }],
    [{ ok: true, elements: [{ found: true, shown: false, reasons: ['visibility-hidden'] }] }, { status: 'NOT_VISIBLE', reason: 'VISIBILITY_HIDDEN' }],
    // Sticking out of the viewport is the W2 failure itself, not a reason to doubt it.
    [{ ok: true, elements: [{ found: true, shown: false, reasons: ['outside-viewport'] }] }, { status: 'CONFIRMED', reason: null }],
    [{ ok: false, code: 'PAINT_TARGET_NOT_FOUND' }, { status: 'UNCONFIRMED', reason: 'PAINT_TARGET_NOT_FOUND' }],
    [{ ok: true, elements: [{ found: false, shown: false, reasons: ['not-in-snapshot'] }] }, { status: 'UNCONFIRMED', reason: 'NOT_IN_SNAPSHOT' }],
  ]) {
    reader = dragonGeometryReader({ rpc: fakeDragon({ paint: () => paintResult }).rpc, tabId: 7 });
    assert.deepEqual(await reader.confirm(741, failure), expected, JSON.stringify(paintResult));
  }
  // The engine uses the reader's confirm when it has one.
  const { reader: page } = scripted();
  delete page.snapshot;
  page.confirm = async () => ({ status: 'NOT_VISIBLE', reason: 'COVERED' });
  const sweep = await sweepWidths({ reader: page });
  assert.deepEqual([sweep.bands[0].status, sweep.bands[0].confirmation.reason, sweep.bands[0].verdict], ['NOT_VISIBLE', 'COVERED', null]);
});

const playwright = await loadPlaywright();
const PAGE = pathToFileURL(join(ROOT, 'test/fixtures/r1e/width-band.html')).href;
const CLEAN = pathToFileURL(join(ROOT, 'test/fixtures/r1e/width-band-clean.html')).href;

test('acceptance: a page broken only between 741 and 783 px gives exactly that band in a real browser', { skip: playwright ? false : PLAYWRIGHT_SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const reader = await playwrightGeometryReader({ browser, url: PAGE });
    const sweep = await sweepWidths({ reader });
    assert.deepEqual([...new Set(sweep.bands.map((band) => `${band.from}-${band.to}`))], ['741-783']);
    assert.ok(sweep.bands.some((band) => band.id === 'W1|html'), JSON.stringify(sweep.bands));
    const element = sweep.bands.find((band) => band.rule === 'W2');
    assert.equal(element.status, 'CONFIRMED');
    assert.deepEqual(reader.captured, [741]);
    assert.deepEqual(element.rows, ['desktop-767', 'desktop-768', 'desktop-769']);
    assert.equal(element.verdict, 'FAIL');
    // The over-wide toolbar also wraps the layout up to 783 px, so the side-by-side layout starts at 784.
    assert.deepEqual(sweep.breakpoints.map((point) => point.width), [784]);
    await reader.close();
    const clean = await playwrightGeometryReader({ browser, url: CLEAN });
    const twin = await sweepWidths({ reader: clean });
    assert.deepEqual(twin.bands, []);
    assert.deepEqual(clean.captured, []);
    // The clean twin's only layout change is its own media query.
    assert.deepEqual(twin.breakpoints.map((point) => point.width), [768]);
    await clean.close();
  } finally { await browser.close(); }
});

// The gate: a state receipt names its sweep in `probes`; a failing band keeps the state from UI PASS.
function board(sweep) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r1e-sweep-gate-')));
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  const write = (rel, bytes) => { writeFileSync(join(dir, rel), bytes); return rel; };
  const png = readFileSync(join(ROOT, 'qa-evidence/fixture-a/round-1/1280x800/after-load.png'));
  const shot = write('evidence/TC-01-ideal.png', png);
  const raw = write('evidence/TC-01-raw.json', '{"observed":"three orders"}\n');
  const sweepFile = write('evidence/TC-01-ideal.width-sweep.json', `${JSON.stringify(sweep)}\n`);
  const okRaw = (id) => ({ id, verdict: 'PASS', evidence: 'raw' });
  const receipt = {
    schema: 'qa-gui/state-receipt/v1', caseId: 'TC-01', state: 'ideal', capturedAt: '2026-11-04T02:00:00.000Z', url: 'https://test.example/orders',
    build: 'build-r1e', viewport: '1280x800', domHash: 'e'.repeat(64),
    dragon: { sessionId: 's-1', actionId: 'act-1', browserInstanceId: 'bi-1', tabId: 'tab-1', innerOk: true },
    screenshot: { path: shot, sha256: sha(png) },
    function: { verdict: 'PASS', assertions: [{ requirement_id: 'REQ-1', verdict: 'PASS', evidence_ref: raw }] },
    ui: { verdict: 'PASS', uiSanity: okRaw('ui-sanity'), a11y: okRaw('a11y'), console: okRaw('console'), network: okRaw('network') },
    preflight: okRaw('preflight'),
    probes: [{ kind: 'width-sweep', path: sweepFile, sha256: sha(readFileSync(join(dir, sweepFile))) }],
  };
  const rec = write('evidence/TC-01-ideal.state.json', `${JSON.stringify(receipt, null, 2)}\n`);
  const evidence = [shot, raw, sweepFile, rec];
  const data = {
    schemaVersion: 6, canonicalVersion: 'qa-board-teamwork/v2', boardKind: 'team-qa-board', rev: 1, boardId: 'r1e', title: 'R1e sweep fixture',
    boardCreated: '2026-11-04T01:00:00.000Z', language: 'en', deepCheck: 'available', app: 'r1e-fixture', envDb: 'TEST / fixture',
    viewport: '1280x800', runUuid: '33333333-3333-4333-8333-333333333333', commit: 'c'.repeat(40), build: 'build-r1e', env: 'TEST', db: 'fixture',
    role: 'qa-agent', testProfile: 'r1e', evidenceManifest: evidence.map((path) => ({ path, sha256: sha(readFileSync(join(dir, path))) })),
    currentRound: 1,
    sourceItems: [{ id: 'SRC-1', kind: 'spec', sourceSystem: 'fixture', externalKey: 'REQ-1', title: 'Order list', origin: 'upstream' }],
    cases: [{
      id: 'TC-01', title: 'Order list', requirement: 'REQ-1', requirements: ['REQ-1'], sourceRefs: ['SRC-1'], steps: 'Open the list.',
      expected: 'The list fits every width.', status: 'PASS', priority: 'P2', assignee: 'qa-agent', functionVerdict: 'PASS', uiVerdict: 'PASS',
      humanSummary: { function: 'Lists.', ui: 'Clean.' }, machine: { rule: 'r1e', selector: '#orders' }, kind: 'static', states: ['ideal'],
      stateReceipts: [{ state: 'ideal', file: rec }],
      results: [{ round: 1, functionVerdict: 'PASS', uiVerdict: 'PASS', recordedAt: '2026-11-04T02:01:00.000Z', evidence }],
      evidence, comments: [], history: [],
    }],
    defects: [], rounds: [{ round: 1, startedAt: '2026-11-04T01:00:00.000Z', scope: 'R1e fixture' }],
    coverage: ['happy', 'boundary', 'empty', 'loading', 'error', 'auth-role', 'navigation', 'keyboard', 'responsive', 'dark-mode'].map((area) => ({ area, status: 'tick' })),
    untested: [], release: { verdict: 'GO', risks: [] },
  };
  const file = join(dir, 'board.json');
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return { file };
}
const gate = (file) => spawnSync(process.execPath, [GATE, file], { cwd: dirname(file), encoding: 'utf8' });

test('gate: a clean sweep keeps PASS; a failing band keeps the state from UI PASS', async () => {
  const clean = gate(board(await sweepWidths({ reader: scripted({ from: 2000, to: 2001 }).reader })).file);
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  const failing = gate(board(await sweepWidths({ reader: scripted().reader })).file);
  assert.notEqual(failing.status, 0, failing.stdout);
  assert.match(failing.stderr, /SWEEP_BAND_FAIL:W2\|div\.toolbar:741-783/);
  assert.match(failing.stderr, /ui\.verdict PASS does not match computed FAIL|uiVerdict PASS does not match receipt-computed FAIL/);
});
