// Integration: the R1e width sweep, overlay check and frontier exploration and the R1c action rules in a Team QA
// web-lane run. The executor sends the recipe's Dragon calls (no shell, no Node driver); QA GUI rebuilds each probe
// receipt from those calls with the detector's own engine and grader. A recipe step left out is never a PASS.
// Fixtures: synthetic calls, R1c's recorded Dragon env reads, and the R1e fixture pages in a real browser when
// Playwright is installed. Not evidence of a product run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXPLORE_CALL, EXPLORE_INSTALL_BODY, STREAM_HELPERS, SWEEP_CALLS, sweepInstallBody, detectorPromptSection, dragonOps, explorationFromOps, foldUxInto,
  overlayCheckFromOps, screenCheckPromptSection, uxActionResultsFromOps, uxUnavailableResults, widthSweepFromOps,
} from '../scripts/lib/stream-detectors.mjs';
import { sweepVerdict, sweepWidths } from '../scripts/lib/width-sweep.mjs';
import { checkOverlays, overlayVerdict } from '../scripts/lib/overlay-check.mjs';
import { EXPLORATION_POLICY_SCHEMA, explore } from '../scripts/lib/frontier-explorer.mjs';
import { gradeU2, uxSettings } from '../scripts/lib/ux-rules.mjs';
import { loadPlaywright, PLAYWRIGHT_SKIP } from './support/playwright.mjs';
import { playwrightGeometryReader, playwrightOverlayDriver } from './support/playwright-readers.mjs';
import { dragonStandIn, followOverlays, followSweep } from './support/recipe-standin.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ok = (method, params, result) => ({ method, params, result, ok: result?.ok !== false });
const doCall = (steps, values = {}) => ok('do', { steps }, { completed: true, results: steps.map((s) => (s.read !== undefined ? { step: 'read', as: s.as, value: values[s.as] } : { step: Object.keys(s)[0], ok: true })) });

// ── the width sweep ────────────────────────────────────────────────────────────────────────────────────────────
// A page whose main block sticks out between 741 and 783 px (W2), with its layout changing at 768 px.
const geometry = (w, mobile = false) => ({ width: w, vw: w, layout: w < 768 ? 'header / main' : 'header,main', failures: w >= 741 && w <= 783 && !mobile
  ? [{ rule: 'W2', selector: 'div.shell > main', target: 'div.shell > main', tag: 'main', detail: 'outside', rect: { x: 0, y: 70, width: w + 40, height: 80 } }] : [] });
function sweepCalls({ skip = [], restore = true } = {}) {
  const calls = [ok('do', { steps: [{ read: sweepInstallBody(), as: 'w:found' }] }, { completed: true, results: [{ step: 'read', as: 'w:found', value: { width: 1280, height: 800, dpr: 1, touch: false } }] })];
  const coarse = []; for (let w = 320; w < 1440; w += 20) coarse.push(w); coarse.push(1440);
  const measured = new Set(coarse);
  for (let w = 741; w < 760; w += 1) measured.add(w);
  for (let w = 761; w < 800; w += 1) if (w !== 780) measured.add(w);
  for (const w of [...measured].sort((a, b) => a - b)) {
    if (skip.includes(w)) continue;
    calls.push(doCall([{ viewport: { width: w, height: 800, deviceScaleFactor: 1, mobile: false } }, { wait: 150 }, { read: SWEEP_CALLS.measure, as: `w:${w}` }], { [`w:${w}`]: geometry(w) }));
  }
  calls.push(ok('setViewport', { width: 741, height: 800, deviceScaleFactor: 1, mobile: false }, { ok: true }));
  calls.push(ok('paintSnapshot', { selector: 'div.shell > main' }, { ok: true, elements: [{ found: true, shown: false, reasons: ['outside-viewport'] }] }));
  calls.push(ok('screenshot', { evidence: true, toFile: 'TC-01-sweep-741.jpg' }, { ok: true, sha256: 'c'.repeat(64), savedTo: '/x/TC-01-sweep-741.jpg' }));
  for (const [id, w] of [['desktop-767', 767], ['desktop-768', 768], ['desktop-769', 769]]) {
    calls.push(doCall([{ viewport: { width: w, height: 800, deviceScaleFactor: 1, mobile: false } }, { wait: 150 }, { read: 'emu', as: `w:row:${id}:emu` }, { read: SWEEP_CALLS.measure, as: `w:row:${id}:geo` }],
      { [`w:row:${id}:emu`]: { width: w, dpr: 1, touch: false }, [`w:row:${id}:geo`]: geometry(w) }));
  }
  if (restore) {
    calls.push(ok('setViewport', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, { ok: true }));
    calls.push(doCall([{ read: 'viewport', as: 'w:restored' }], { 'w:restored': { width: 1280, height: 800, dpr: 1, touch: false } }));
  }
  return calls;
}

test('the sweep from the recorded calls is the one sweepWidths makes over a live reader: the exact band, the matrix verdict', async () => {
  const live = await sweepWidths({ reader: { measure: async (w) => geometry(w), confirm: async () => ({ status: 'CONFIRMED', reason: null }),
    capture: async (w) => ({ width: w }), measureRow: async (row) => ({ verified: true, failures: geometry(row.w, row.profile === 'mobile').failures.map((f) => `${f.rule}|${f.selector}`) }) } });
  const { receipt, issues } = await widthSweepFromOps(dragonOps(sweepCalls()), { captureRef: (op) => ({ path: 'evidence/qa-gui/TC-01/sweep-741.jpg', sha256: op.result.sha256 }) });
  assert.deepEqual(issues, []);
  const strip = (b) => ({ id: b.id, from: b.from, to: b.to, status: b.status, rows: b.rows, verdict: b.verdict });
  assert.deepEqual(receipt.bands.map(strip), live.bands.map(strip));
  assert.deepEqual(receipt.bands.map((b) => [b.from, b.to, b.verdict]), [[741, 783, 'FAIL']]);
  assert.deepEqual(receipt.breakpoints, live.breakpoints);
  assert.deepEqual(receipt.captures, [{ width: 741, capture: { path: 'evidence/qa-gui/TC-01/sweep-741.jpg', sha256: 'c'.repeat(64) } }]);
  assert.deepEqual(receipt.viewport, { found: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, restored: { ok: true, viewport: { width: 1280, height: 800, dpr: 1, touch: false } } });
  assert.equal(sweepVerdict(receipt).verdict, 'FAIL');
});

test('a sweep with a width the recipe needs left out is no receipt, one not put back is UNGRADED, and no sweep is null', async () => {
  const gap = await widthSweepFromOps(dragonOps(sweepCalls({ skip: [745] })));
  assert.equal(gap.receipt, null);
  assert.deepEqual(gap.issues, ['SWEEP_WIDTH_NOT_RECORDED:745']);
  const kept = await widthSweepFromOps(dragonOps(sweepCalls({ restore: false })));
  assert.deepEqual(sweepVerdict(kept.receipt).issues.at(-1), 'SWEEP_VIEWPORT_NOT_RESTORED:NOT_RESTORED');
  assert.equal(await widthSweepFromOps(dragonOps([])), null);
});

// ── the action rules U1, U2, U3 ───────────────────────────────────────────────────────────────────────────────
const UX = join(ROOT, 'test/fixtures/ux-rules/recorded');
const obs = (trigger, extra = {}) => ({ v: 'ux-observe/1', t: 1, url: 'http://t/form', digest: { doc: 'a' }, live: [], dialogs: [], busy: {}, forms: [], trigger, ...extra });
test('U2 from the labelled reads and the env read after the held write equals the grader on the same data', () => {
  for (const name of ['u2-defect', 'u2-clean']) {
    const env = JSON.parse(readFileSync(join(UX, `${name}.env.json`), 'utf8')).heldAfterFirstClick;
    const trigger = name === 'u2-defect' ? { found: true, sel: 'button#save', disabled: false, text: 'Save' } : { found: true, sel: 'button#save', disabled: true, text: 'Saving' };
    const before = obs({ found: true, sel: 'button#save', disabled: false, text: 'Save' }), during = obs(trigger);
    const calls = [doCall([{ read: 'observe', as: 'u:hold:before' }, { clickSelector: '#save', fast: false }, { wait: 1200 }, { read: 'observe', as: 'u:hold:during' }],
      { 'u:hold:before': before, 'u:hold:during': during }), ok('env.get', { tabId: 7 }, env)];
    const [result] = uxActionResultsFromOps(dragonOps(calls), { rules: ['U2'] });
    assert.deepEqual(result, gradeU2({ action: null, before, during, env }, uxSettings()), name);
    assert.equal(result.verdict, name === 'u2-defect' ? 'FAIL' : 'PASS', JSON.stringify(result));
  }
  // A rule the executor did not set up has nothing to read: UNGRADED, and folded as required it keeps the state from PASS.
  const [u3] = uxActionResultsFromOps(dragonOps([]), { rules: ['U3'] });
  assert.equal(u3.verdict, 'UNGRADED');
  const folded = foldUxInto({ verdict: 'PASS', counts: { high: 0, warn: 0 }, issues: [] }, [u3], { require: ['U3'] });
  assert.equal(folded.verdict, 'UNGRADED');
  assert.equal(foldUxInto({ v: 'PASS' }, [u3]).verdict, 'PASS');
});

test('without Dragon R1a a forced U rule says UNGRADED with the reason; folded where it was not required it keeps the verdict', () => {
  const results = uxUnavailableResults(['U1', 'U3'], 'DRAGON_R1A_UNAVAILABLE');
  assert.deepEqual(results.map((r) => [r.id, r.verdict, r.reason]), [['U1', 'UNGRADED', 'DRAGON_R1A_UNAVAILABLE'], ['U3', 'UNGRADED', 'DRAGON_R1A_UNAVAILABLE']]);
  const folded = foldUxInto({ verdict: 'PASS', counts: { high: 0, warn: 0 }, issues: [] }, results);
  assert.deepEqual([folded.verdict, folded.ux.rules.U1.reason, folded.ux.rules.U3.verdict], ['PASS', 'DRAGON_R1A_UNAVAILABLE', 'UNGRADED']);
  assert.equal(foldUxInto({ verdict: 'PASS', issues: [] }, results, { require: ['U1'] }).verdict, 'UNGRADED');
  assert.throws(() => uxUnavailableResults(['U4'], 'DRAGON_R1A_UNAVAILABLE'), /UX_UNAVAILABLE_RULE:U4/);
  assert.throws(() => uxUnavailableResults(['U1'], 'no r1a'), /UX_UNAVAILABLE_REASON/);
});

// ── frontier exploration ──────────────────────────────────────────────────────────────────────────────────────
const SCREENS = {
  'screen:orders-list': { route: '/orders', rows: 3, candidates: ['button:New Order', 'button:Delete', 'button:Sort'] },
  'screen:order-new': { route: '/orders/new', candidates: ['button:Save', 'button:Cancel'] },
  'dialog:delete-order': { route: '/orders', candidates: ['button:Delete order', 'button:Cancel'] },
  'screen:orders-sorted': { route: '/orders', rows: 3, candidates: ['button:New Order'] },
};
const MOVES = {
  'screen:orders-list': { 'button:New Order': 'screen:order-new', 'button:Delete': 'dialog:delete-order', 'button:Sort': 'screen:orders-sorted' },
  'screen:order-new': { 'button:Save': 'screen:orders-list', 'button:Cancel': 'screen:orders-list' },
  'dialog:delete-order': { 'button:Delete order': 'screen:orders-list', 'button:Cancel': 'screen:orders-list' },
  'screen:orders-sorted': { 'button:New Order': 'screen:order-new' },
};
const selectorOf = (node, target) => `#${node.split(':')[1]}-${target.split(':')[1].toLowerCase().replace(/\s+/g, '-')}`;
// The app as the executor sees it, and the calls the explore recipe makes while it acts as it chooses.
function recordingApp() {
  let at = 'screen:orders-list', n = 0;
  const calls = [];
  const view = () => ({ node: at, route: SCREENS[at].route, domHash: at.padEnd(64, '0').slice(0, 64), ...(SCREENS[at].rows ? { rows: SCREENS[at].rows } : {}),
    candidates: SCREENS[at].candidates.map((target) => ({ target, selector: selectorOf(at, target) })) });
  let cached = null;
  return {
    calls,
    async start() {
      at = 'screen:orders-list';
      if (n === 0) { cached = view(); calls.push(doCall([{ goto: 'https://t/orders' }, { read: EXPLORE_INSTALL_BODY, as: 'x:0' }], { 'x:0': cached })); n = 1; }
      else calls.push(doCall([{ goto: 'https://t/orders' }]));
      return { url: '/orders', ...view() };
    },
    async observe() { return cached; },
    async act(candidate) {
      at = MOVES[at][candidate.target];
      cached = view();
      calls.push(doCall([{ clickSelector: candidate.selector, fast: false }, { wait: 150 }, { read: EXPLORE_CALL, as: `x:${n}` }], { [`x:${n}`]: cached }));
      n += 1;
      return {};
    },
    async unmatchedCssRules() { calls.push(doCall([{ read: 'css', as: 'x:css' }], { 'x:css': ['.orders-empty'] })); return ['.orders-empty']; },
  };
}
const policy = { schema: EXPLORATION_POLICY_SCHEMA, requirementCells: [], highRisk: [], approvedDestructive: [] };

test('the exploration replayed from the executor\'s calls gives the explorer\'s own log, map and stop reason', async () => {
  const app = recordingApp();
  const live = await explore({ driver: app, policy, budget: 50 });
  const replay = await explorationFromOps(dragonOps(app.calls), { policy, budget: 50 });
  const noDecide = (log) => log.filter((e) => e.action !== 'decide').map(({ step, ...rest }) => rest);
  assert.deepEqual(noDecide(replay.log), noDecide(live.log));
  assert.deepEqual([replay.map.stop, replay.map.frontier, replay.map.nodes.map((x) => x.id).sort()], [live.map.stop, live.map.frontier, live.map.nodes.map((x) => x.id).sort()]);
  assert.ok(replay.log.filter((e) => e.action === 'decide').every((e) => e.by === 'executor'));
  assert.equal(replay.map.stop.reason, 'FRONTIER_EMPTY');
});

test('a click on a destructive candidate the plan does not approve stops the exploration BLOCKED; an early end is BUDGET_EXHAUSTED', async () => {
  const delCalls = [
    doCall([{ goto: 'https://t/orders' }, { read: EXPLORE_INSTALL_BODY, as: 'x:0' }], { 'x:0': { node: 'screen:orders-list', route: '/orders', domHash: 'a'.repeat(64),
      candidates: [{ target: 'button:Delete', selector: '#del' }] } }),
    doCall([{ clickSelector: '#del', fast: false }, { read: EXPLORE_CALL, as: 'x:1' }], { 'x:1': { node: 'dialog:delete-order', route: '/orders', domHash: 'b'.repeat(64),
      candidates: [{ target: 'button:Delete order', selector: '#confirm' }] } }),
    doCall([{ clickSelector: '#confirm', fast: false }, { read: EXPLORE_CALL, as: 'x:2' }], { 'x:2': { node: 'screen:orders-list', route: '/orders', domHash: 'c'.repeat(64), candidates: [] } }),
  ];
  const blocked = await explorationFromOps(dragonOps(delCalls), { policy });
  assert.deepEqual([blocked.map.stop.reason, blocked.map.stop.code], ['BLOCKED', 'TOOL_LIMIT']);
  assert.match(blocked.map.stop.detail, /#confirm/);
  assert.ok(blocked.map.frontier.some((entry) => entry.reason === 'NEEDS_APPROVAL'));
  const early = await explorationFromOps(dragonOps(delCalls.slice(0, 1)), { policy });
  assert.equal(early.map.stop.reason, 'BUDGET_EXHAUSTED');
  assert.equal(await explorationFromOps(dragonOps([])), null);
});

// ── what the executor is told ─────────────────────────────────────────────────────────────────────────────────
test('the case section: the probe as frames.trial calls after the recording, the U states, the exploration with its helper; no screen checks', () => {
  const text = detectorPromptSection({ caseId: 'TC-01', detectors: { transient: true, ux: ['U2', 'U3'], explore: { policy, budget: 6 } } });
  for (const label of ['framesTrial', 'stopRecording', 'u:hold:before', 'u:hold:during', 'u:hold:after', 'u:error:before', 'u:error:after', 'x:0', 'x:css', STREAM_HELPERS.sample.name, STREAM_HELPERS.explore.name]) assert.ok(text.includes(label), label);
  assert.doesNotMatch(text.replace('never framesStart/framesStop for this', ''), /framesStart|w:found|o:triggers|pressKey|setViewport/);
  assert.match(text, /"fast":false/);
  assert.match(text, /envReset/);
  // Dogfood 05/11: the preview of help's saved file decides (Dragon 1.7.0 begins with an r1a summary); Grep only without one.
  assert.match(text, /help once.*begins \{"r1a": R1a is here.*call no R1a tool.*No preview: Grep the file for "environmentContract"/s);
  assert.match(text, /With R1a: Run every step of this section before you print the draft/);
  assert.doesNotMatch(text, /refused as unknown/);
  assert.match(text, /DRAGON_R1A_UNAVAILABLE/);
  assert.match(detectorPromptSection({ caseId: 'TC-01', detectors: { transient: true }, fast: true }), /"fast":true/);
  assert.doesNotMatch(detectorPromptSection({ caseId: 'TC-01', detectors: {} }), /envReset|helpersDefine|Exploration|help once/);
  for (const h of Object.values(STREAM_HELPERS)) assert.doesNotThrow(() => new Function(`return (${h.body})`), h.key);
});

test('the screen check recipe: help first, the helpers once, every read a call, a settle wait after each viewport, no setViewport tool', () => {
  const text = screenCheckPromptSection({ screenId: 'S1', url: 'https://t/orders', route: '/orders', planned: ['#edit'] });
  // Fix round 2 (E9): the per-width, per-row and per-press labels are written once, inside Dragon loops ($w, $r.id, $n).
  for (const label of ['w:found', 'w:refine', 'w:bands', 'w:restored', 'w:$w', 'w:row:$r.id:emu', 'o:triggers', 'o:k:before', 'o:k:trap-$n', 'o:k:esc-open', 'o:k:backdrop-after', 'o:k:kbd-0', 'o:k:kbd', 'o:k:kbd-enter',
    'TEAMQA_SCREEN_DRAFT v1', STREAM_HELPERS.sweep.name, STREAM_HELPERS.overlay.name, '["#edit"]']) assert.ok(text.includes(label), label);
  assert.match(text, /"wait":150/);
  assert.doesNotMatch(text, /setViewport|refused as unknown/);
  assert.match(text, /help once.*environmentContract/s);
});

// ── in a real browser: the page helpers and the recipe give the detectors' own results ────────────────────────
const playwright = await loadPlaywright();
const page = (name) => pathToFileURL(join(ROOT, 'test/fixtures/r1e', name)).href;
test('in a real browser the sweep recipe finds exactly the 741-783 px band the live sweep finds, and the clean page has none', { skip: playwright ? false : PLAYWRIGHT_SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    for (const [name, want] of [['width-band.html', [[741, 783]]], ['width-band-clean.html', []]]) {
      const tab = await dragonStandIn({ browser, url: page(name) });
      await followSweep({ rpc: tab.rpc });
      const { receipt, issues } = await widthSweepFromOps(dragonOps(tab.calls), { helpers: true });
      await tab.close();
      assert.deepEqual(issues, [], name);
      const live = playwrightGeometryReader({ browser, url: page(name) });
      const reader = await live;
      const direct = await sweepWidths({ reader });
      await reader.close();
      assert.deepEqual([...new Set(receipt.bands.map((b) => `${b.from}-${b.to}`))], want.map(([a, b]) => `${a}-${b}`), name);
      assert.deepEqual(receipt.bands.map((b) => [b.id, b.from, b.to]), direct.bands.map((b) => [b.id, b.from, b.to]), name);
      assert.equal(receipt.viewport.restored.ok, true, name);
      assert.equal(sweepVerdict(receipt).verdict, want.length ? 'FAIL' : 'PASS', name);
    }
  } finally { await browser.close(); }
});

test('in a real browser the overlay recipe gives the checks the live overlay driver gives: missing Esc and focus return are caught', { skip: playwright ? false : PLAYWRIGHT_SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    const tab = await dragonStandIn({ browser, url: page('overlays.html') });
    await followOverlays({ rpc: tab.rpc, url: page('overlays.html'), define: true });
    const { receipt, issues } = overlayCheckFromOps(dragonOps(tab.calls), { route: '/overlays', helpers: true });
    await tab.close();
    assert.deepEqual(issues, []);
    const driver = await playwrightOverlayDriver({ browser, url: page('overlays.html') });
    const live = await checkOverlays({ driver, route: '/overlays' });
    await driver.close?.();
    const statuses = (r) => r.overlays.map((o) => [o.id, ...o.checks.map((c) => `${c.rule}:${c.status}`)]);
    assert.deepEqual(statuses(receipt), statuses(live));
    assert.equal(overlayVerdict(receipt).verdict, 'FAIL');
    assert.ok(overlayVerdict(receipt).issues.some((code) => /^OVERLAY_O3_FAIL:/.test(code)), overlayVerdict(receipt).issues.join(','));
    // A leg left out is unmeasured, never a PASS.
    const cut = dragonOps(tab.calls).filter((op) => op.step?.as !== 'o:0:esc-open');
    const partial = overlayCheckFromOps(cut, { route: '/overlays', helpers: true });
    assert.ok(partial.issues.some((x) => x.startsWith('OVERLAY_LEG_NOT_RECORDED:esc')), partial.issues.join(','));
    assert.ok(partial.receipt.overlays[0].checks.every((c) => c.status === 'UNGRADED'));
  } finally { await browser.close(); }
});
