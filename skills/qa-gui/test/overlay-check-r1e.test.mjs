// Upgrade R1e: the overlay inventory. Each screen lists the controls that open an overlay; each overlay is a cell checked
// for: opens by mouse and by keyboard (O1, O2), closes by Esc, backdrop and its close button (O3-O5), focus trapped then
// returned (O6, O7), background scroll locked (O8), two stacked overlays (O9). A check whose condition is absent is
// UNGRADED, never PASS. Fixture: test/fixtures/r1e/overlays.html (synthetic). Not evidence of a product run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { OVERLAY_CHECK_SCHEMA, checkOverlays, dragonOverlayDriver, gradeOverlay, overlayVerdict } from '../scripts/lib/overlay-check.mjs';
import { loadPlaywright, PLAYWRIGHT_SKIP } from './support/playwright.mjs';
import { playwrightOverlayDriver } from './support/playwright-readers.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GATE = join(ROOT, 'scripts/qa-gate.mjs');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const statuses = (checks) => Object.fromEntries(checks.map((check) => [check.rule, check.reason ? `${check.status}:${check.reason}` : check.status]));

// A well-behaved overlay, as probeOverlay records it.
const good = () => ({
  trigger: { selector: '#edit-trigger', label: 'Edit order' }, overlay: '#edit-dialog',
  mouse: { opened: true, overlay: '#edit-dialog', activeInside: true },
  trap: { presses: 6, inside: [true, true, true, true, true, true] },
  scroll: { scrollable: true, before: 0, after: 0 },
  stacked: { available: true, opened: true, openAfterEsc: ['#edit-dialog'] },
  esc: { closed: true, active: '#edit-trigger' },
  keyboard: { reachedTrigger: true, presses: 1, opened: true },
  backdrop: { available: true, closed: true, active: '#edit-trigger' },
  button: { available: true, closed: true, active: '#edit-trigger' },
});

test('grading: a well-behaved overlay passes every check; an absent condition is UNGRADED, never PASS', () => {
  assert.deepEqual(statuses(gradeOverlay(good()).checks), { O1: 'PASS', O2: 'PASS', O3: 'PASS', O4: 'PASS', O5: 'PASS', O6: 'PASS', O7: 'PASS', O8: 'PASS', O9: 'PASS' });
  const plain = good();
  plain.stacked = { available: false };
  plain.scroll = { scrollable: false };
  plain.backdrop = { available: false };
  assert.deepEqual(statuses(gradeOverlay(plain).checks), { O1: 'PASS', O2: 'PASS', O3: 'PASS', O4: 'UNGRADED:PRECONDITION_ABSENT', O5: 'PASS', O6: 'PASS',
    O7: 'PASS', O8: 'UNGRADED:PRECONDITION_ABSENT', O9: 'UNGRADED:PRECONDITION_ABSENT' });
  // Nothing opens: every later check lacks its condition.
  const dead = good();
  dead.mouse = { opened: false };
  dead.keyboard = { reachedTrigger: true, presses: 1, opened: false };
  const graded = statuses(gradeOverlay(dead).checks);
  assert.deepEqual([graded.O1, graded.O2, graded.O3, graded.O7], ['FAIL', 'FAIL', 'UNGRADED:PRECONDITION_ABSENT', 'UNGRADED:PRECONDITION_ABSENT']);
});

test('grading: missing Esc and missing focus return are caught; focus escaping, a scrolling page and a stack that closes at once fail', () => {
  const bad = good();
  bad.esc = { closed: false, active: '#delete-confirm' };
  bad.button = { available: true, closed: true, active: 'body' };
  bad.backdrop = { available: true, closed: true, active: 'body' };
  let graded = statuses(gradeOverlay(bad).checks);
  assert.deepEqual([graded.O3, graded.O7], ['FAIL', 'FAIL']);
  const leaky = good();
  leaky.trap.inside[3] = false;
  leaky.scroll.after = 400;
  leaky.stacked.openAfterEsc = [];
  leaky.keyboard = { reachedTrigger: false, presses: 40, cycled: true };
  graded = statuses(gradeOverlay(leaky).checks);
  assert.deepEqual([graded.O6, graded.O8, graded.O9, graded.O2], ['FAIL', 'FAIL', 'FAIL', 'FAIL:TRIGGER_NOT_REACHABLE']);
});

test('each overlay is a cell: the overlay is the route, each way in and out an action', () => {
  const { cells } = gradeOverlay(good());
  assert.deepEqual(cells.map((cell) => [cell.route, cell.action, cell.status]), [
    ['dialog:edit-dialog', 'open:mouse', 'PASS'], ['dialog:edit-dialog', 'open:keyboard', 'PASS'], ['dialog:edit-dialog', 'close:esc', 'PASS'],
    ['dialog:edit-dialog', 'close:backdrop', 'PASS'], ['dialog:edit-dialog', 'close:button', 'PASS'],
  ]);
});

test('the gate grader recomputes from the observations and ignores stored statuses', () => {
  const bad = good();
  bad.esc = { closed: false, active: '#x' };
  const receipt = { schema: OVERLAY_CHECK_SCHEMA, route: '/orders', triggers: [], overlays: [{ id: 'dialog:edit-dialog', observation: bad, checks: [{ rule: 'O3', status: 'PASS' }] }] };
  const graded = overlayVerdict(receipt);
  assert.equal(graded.verdict, 'FAIL');
  assert.ok(graded.issues.includes('OVERLAY_O3_FAIL:dialog:edit-dialog'), graded.issues.join(', '));
  assert.deepEqual(overlayVerdict({ ...receipt, overlays: [{ id: 'dialog:edit-dialog', observation: good() }] }), { verdict: 'PASS', issues: [] });
  assert.equal(overlayVerdict({ schema: 'x' }).verdict, 'UNGRADED');
});

test('the Dragon driver: trusted clicks, keys, the trusted wheel and reads in `do` steps; a fresh page between checks', async () => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'do' && params.steps[0].read) return { completed: true, results: [{ step: 'read', as: 'v', value: JSON.stringify({ ok: 1 }) }] };
    return { ok: true };
  };
  const driver = dragonOverlayDriver({ rpc, binding: { sessionId: 's' }, tabId: 3 });
  await driver.click('#edit-trigger');
  await driver.clickAt(5, 5);
  await driver.press('Escape');
  assert.deepEqual(await driver.read('return 1;'), { ok: 1 });
  assert.deepEqual(await driver.scrollAttempt(), { attempted: true });
  await driver.reload();
  assert.deepEqual(calls.map(([method, params]) => [method, params.steps?.[0] ?? null]), [
    // Clicks carry fast:false (integration: the native route refuses a click without it; R3 fast-click may allow true).
    ['do', { clickSelector: '#edit-trigger', fast: false }], ['do', { clickXY: [5, 5], fast: false }], ['do', { key: 'Escape' }], ['do', { read: 'return 1;', as: 'v' }],
    ['do', { scroll: { delta: 400 } }], ['reloadTab', null], ['waitForState', null],
  ]);
  // With the page URL known, a fresh page is a `goto` step, which waits for the load.
  calls.length = 0;
  await dragonOverlayDriver({ rpc, tabId: 3, url: 'https://test.example/orders' }).reload();
  assert.deepEqual(calls.map(([method, params]) => [method, params.steps?.[0] ?? null]), [['do', { goto: 'https://test.example/orders' }]]);
  // A trusted scroll Dragon could not dispatch is no attempt, so O8 cannot pass on it.
  const refused = dragonOverlayDriver({ rpc: async () => ({ completed: true, results: [{ step: 'scroll', ok: false, code: 'SCROLL_CONTAINER_NOT_FOUND' }] }), tabId: 3 });
  assert.deepEqual(await refused.scrollAttempt(), { attempted: false, code: 'SCROLL_CONTAINER_NOT_FOUND' });
  const obs = good();
  obs.scroll = { scrollable: true, attempted: false, before: 0, after: 0 };
  assert.equal(statuses(gradeOverlay(obs).checks).O8, 'UNGRADED:UNMEASURED');
});

const playwright = await loadPlaywright();
const PAGE = pathToFileURL(join(ROOT, 'test/fixtures/r1e/overlays.html')).href;

test('acceptance: in a real browser the overlay missing Esc and focus return is caught, and the good one passes', { skip: playwright ? false : PLAYWRIGHT_SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const driver = await playwrightOverlayDriver({ browser, url: PAGE });
    const receipt = await checkOverlays({ driver, route: '/orders' });
    await driver.close();
    assert.equal(receipt.schema, OVERLAY_CHECK_SCHEMA);
    // The inventory lists the screen's overlay triggers (the nested picker opens only from inside the edit dialog).
    assert.deepEqual(receipt.triggers.map((trigger) => trigger.selector), ['#edit-trigger', '#delete-trigger']);
    const byId = Object.fromEntries(receipt.overlays.map((overlay) => [overlay.id, statuses(overlay.checks)]));
    assert.deepEqual(byId['dialog:edit-dialog'], { O1: 'PASS', O2: 'PASS', O3: 'PASS', O4: 'PASS', O5: 'PASS', O6: 'PASS', O7: 'PASS', O8: 'PASS', O9: 'PASS' });
    assert.deepEqual(byId['dialog:delete-dialog'], { O1: 'PASS', O2: 'PASS', O3: 'FAIL', O4: 'PASS', O5: 'PASS', O6: 'PASS', O7: 'FAIL', O8: 'PASS', O9: 'UNGRADED:PRECONDITION_ABSENT' });
    const graded = overlayVerdict(receipt);
    assert.equal(graded.verdict, 'FAIL');
    assert.deepEqual(graded.issues.sort(), ['OVERLAY_O3_FAIL:dialog:delete-dialog', 'OVERLAY_O7_FAIL:dialog:delete-dialog']);
  } finally { await browser.close(); }
});

function board(probe) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r1e-overlay-gate-')));
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  const write = (rel, bytes) => { writeFileSync(join(dir, rel), bytes); return rel; };
  const png = readFileSync(join(ROOT, 'qa-evidence/fixture-a/round-1/1280x800/after-load.png'));
  const shot = write('evidence/TC-01-ideal.png', png);
  const raw = write('evidence/TC-01-raw.json', '{"observed":"dialogs"}\n');
  const file = write('evidence/TC-01-ideal.overlays.json', `${JSON.stringify(probe)}\n`);
  const okRaw = (id) => ({ id, verdict: 'PASS', evidence: 'raw' });
  const receipt = {
    schema: 'qa-gui/state-receipt/v1', caseId: 'TC-01', state: 'ideal', capturedAt: '2026-11-04T02:00:00.000Z', url: 'https://test.example/orders',
    build: 'build-r1e', viewport: '1280x800', domHash: 'f'.repeat(64),
    dragon: { sessionId: 's-1', actionId: 'act-1', browserInstanceId: 'bi-1', tabId: 'tab-1', innerOk: true },
    screenshot: { path: shot, sha256: sha(png) },
    function: { verdict: 'PASS', assertions: [{ requirement_id: 'REQ-1', verdict: 'PASS', evidence_ref: raw }] },
    ui: { verdict: 'PASS', uiSanity: okRaw('ui-sanity'), a11y: okRaw('a11y'), console: okRaw('console'), network: okRaw('network') },
    preflight: okRaw('preflight'),
    probes: [{ kind: 'overlay-check', path: file, sha256: sha(readFileSync(join(dir, file))) }],
  };
  const rec = write('evidence/TC-01-ideal.state.json', `${JSON.stringify(receipt, null, 2)}\n`);
  const evidence = [shot, raw, file, rec];
  const data = {
    schemaVersion: 6, canonicalVersion: 'qa-board-teamwork/v2', boardKind: 'team-qa-board', rev: 1, boardId: 'r1e-o', title: 'R1e overlay fixture',
    boardCreated: '2026-11-04T01:00:00.000Z', language: 'en', deepCheck: 'available', app: 'r1e-fixture', envDb: 'TEST / fixture',
    viewport: '1280x800', runUuid: '44444444-4444-4444-8444-444444444444', commit: 'c'.repeat(40), build: 'build-r1e', env: 'TEST', db: 'fixture',
    role: 'qa-agent', testProfile: 'r1e', evidenceManifest: evidence.map((path) => ({ path, sha256: sha(readFileSync(join(dir, path))) })),
    currentRound: 1,
    sourceItems: [{ id: 'SRC-1', kind: 'spec', sourceSystem: 'fixture', externalKey: 'REQ-1', title: 'Order dialogs', origin: 'upstream' }],
    cases: [{
      id: 'TC-01', title: 'Order dialogs', requirement: 'REQ-1', requirements: ['REQ-1'], sourceRefs: ['SRC-1'], steps: 'Open each dialog.',
      expected: 'Dialogs behave.', status: 'PASS', priority: 'P2', assignee: 'qa-agent', functionVerdict: 'PASS', uiVerdict: 'PASS',
      humanSummary: { function: 'Dialogs.', ui: 'Clean.' }, machine: { rule: 'r1e', selector: '#orders' }, kind: 'static', states: ['ideal'],
      stateReceipts: [{ state: 'ideal', file: rec }],
      results: [{ round: 1, functionVerdict: 'PASS', uiVerdict: 'PASS', recordedAt: '2026-11-04T02:01:00.000Z', evidence }],
      evidence, comments: [], history: [],
    }],
    defects: [], rounds: [{ round: 1, startedAt: '2026-11-04T01:00:00.000Z', scope: 'R1e fixture' }],
    coverage: ['happy', 'boundary', 'empty', 'loading', 'error', 'auth-role', 'navigation', 'keyboard', 'responsive', 'dark-mode'].map((area) => ({ area, status: 'tick' })),
    untested: [], release: { verdict: 'GO', risks: [] },
  };
  const path = join(dir, 'board.json');
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}
const gate = (file) => spawnSync(process.execPath, [GATE, file], { cwd: dirname(file), encoding: 'utf8' });

test('gate: a clean overlay check keeps PASS; an overlay without Esc keeps the state from UI PASS', () => {
  const clean = gate(board({ schema: OVERLAY_CHECK_SCHEMA, route: '/orders', triggers: [], overlays: [{ id: 'dialog:edit-dialog', observation: good() }] }));
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  const bad = good();
  bad.esc = { closed: false, active: '#x' };
  const failing = gate(board({ schema: OVERLAY_CHECK_SCHEMA, route: '/orders', triggers: [], overlays: [{ id: 'dialog:edit-dialog', observation: bad }] }));
  assert.notEqual(failing.status, 0, failing.stdout);
  assert.match(failing.stderr, /PROBE:TC-01:ideal:OVERLAY_O3_FAIL:dialog:edit-dialog/);
});
