// Fix round 3 of the integrated upgrade: the third review's findings on the QA GUI side, each reproduced first.
//   F2  O2 counts a cycle only when the first element comes back after another one (date inputs, closed shadow hosts)
//   F3  route keys keep a hash route (#/...), as routeOf does
//   F4  a probe whose every trial Dragon's destructive gate refused is N/A, reported, not UNGRADED
//   F5  only the leg that measured another page is dropped; the page is read after every goto of the screen check
//   F8  a trial whose action target is not the state's main action is TRANSIENT_ACTION_MISMATCH (UNGRADED)
//   F9  the recipes pick packs or inline bodies, Dragon loops or written-out steps, from help; both paths grade the same
//   R3-10 (known limit, documented): the screen check's role is asserted by its sign-in instruction, not proven
// Recorded R1d streams and synthetic receipts; the in-page checks run in Chromium when Playwright is installed.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import {
  STREAM_HELPERS, detectorPromptSection, dragonOps, expandDoSteps, foldScreenChecks, helperDefinitions, keyboardWay, onScreenRoute, screenCheckFromOps,
  screenCheckPromptSection, screenRouteKey, transientProbeFromOps,
} from '../scripts/lib/stream-detectors.mjs';
import { OVERLAY_CHECK_SCHEMA, focusCycled } from '../scripts/lib/overlay-check.mjs';
import { transientProbeVerdict } from '../scripts/lib/transient-probe.mjs';
import { WIDTH_SWEEP_SCHEMA, sweepVerdict } from '../scripts/lib/width-sweep.mjs';
import { canaryAction } from './support/r1d-recorder.mjs';
import { trialCalls } from './support/recipe-calls.mjs';
import { dragonStandIn, followOverlays, followSweep } from './support/recipe-standin.mjs';
import { loadPlaywright, PLAYWRIGHT_SKIP } from './support/playwright.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const load = (s) => JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test/fixtures/r1d/recorded', `${s}.json.gz`))).toString('utf8'));
const playwright = await loadPlaywright();
const SKIP_PW = playwright ? false : PLAYWRIGHT_SKIP;
let browser = null;
const launch = async () => (browser ??= await playwright.chromium.launch());
after(async () => { if (browser) await browser.close(); });
const fixture = (name) => pathToFileURL(join(ROOT, 'test/fixtures/r1e', name)).href;
const valueOf = (op) => (typeof op.res?.value === 'string' ? JSON.parse(op.res.value) : op.res?.value);
// A read's value changed in place (what a page that redirected would have answered).
const withValue = (ops, as, change) => ops.map((op) => (op.kind === 'read' && op.step?.as === as ? { ...op, res: { ...op.res, value: change(valueOf(op)) } } : op));

// ── F2: the focus cycle ─────────────────────────────────────────────────────────────────────────────────────────
test('F2 (R3-2): a second Tab stop inside the first element is no cycle; a cycle is the first element back after another one', () => {
  assert.equal(focusCycled([1], 1), false, 'a date input or a closed shadow host keeps focus on its host');
  assert.equal(focusCycled([1, 1, 1], 1), false);
  assert.equal(focusCycled([1, 1, 2, 3], 1), true, 'back to the first element after another one');
  assert.equal(focusCycled([0, 1, 2], 1), true);
  assert.equal(focusCycled([1, 2, 3], 2), false);
  assert.equal(focusCycled([1, 2, 3], 0), false, 'the document alone is no cycle');
  assert.equal(focusCycled([1, 0], 1), false, 'nor the first element back after the document only');
  const samples = [1, 1, 1, 1, 2, 3, 4].map((id) => ({ active: id === 4 ? '#edit' : id === 1 ? 'input[type=date]' : `#c${id}`, id }));
  assert.deepEqual(keyboardWay(samples, { selector: '#edit' }), { presses: 7, reached: true, cycled: false });
  const round = [1, 2, 3, 1].map((id) => ({ active: `#c${id}`, id }));
  assert.deepEqual(keyboardWay(round, { selector: '#edit' }), { presses: 4, reached: false, cycled: true });
});

for (const [name, html] of [
  ['a date input first', '<input type="date" aria-label="From"><a href="#a">Help</a>'],
  ['a closed shadow host with two buttons first', `<x-pair></x-pair><a href="#a">Help</a>
    <script>customElements.define('x-pair', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<button>One</button><button>Two</button>'; } });</script>`],
]) {
  test(`F2 (R3-2): on a clean page with ${name}, the overlay helper's focus log reaches the trigger, no cycle`, { skip: SKIP_PW }, async () => {
    const page = await (await launch()).newPage();
    try {
      await page.setContent(`${html}<button id="edit" aria-haspopup="dialog">Edit</button><dialog id="d"><button>Close</button></dialog>`);
      const helper = (mode) => page.evaluate((code) => (0, eval)(code), `(${STREAM_HELPERS.overlay.body})(${JSON.stringify(mode)})`);
      await helper('log');
      for (let i = 0; i < 8; i += 1) await page.keyboard.press('Tab');
      const { samples } = await helper('keylog');
      assert.ok(samples[0].id === samples[1].id, `the first element takes two Tab stops: ${JSON.stringify(samples)}`);
      const way = keyboardWay(samples, { selector: '#edit' });
      assert.deepEqual([way.reached, way.cycled], [true, false], JSON.stringify(samples));
    } finally { await page.close(); }
  });
}

// ── F3: hash routes ─────────────────────────────────────────────────────────────────────────────────────────────
test('F3 (R3-3): a route key keeps a hash route (#/...), as routeOf does; a plain anchor is still dropped', () => {
  assert.equal(screenRouteKey('https://app.test/#/orders'), '/#/orders');
  assert.equal(screenRouteKey('/#/orders'), '/#/orders');
  assert.equal(screenRouteKey('https://app.test/#/orders/'), '/#/orders');
  assert.equal(screenRouteKey('https://app.test/#/orders?tab=2'), '/#/orders');
  assert.equal(screenRouteKey('https://app.test/#/orders?tab=2', { query: true }), '/#/orders?tab=2');
  assert.equal(screenRouteKey('https://app.test/#/'), '/');
  assert.equal(screenRouteKey('https://t/orders/#list'), '/orders');
  assert.equal(onScreenRoute('https://app.test/#/login', { route: '/#/orders', url: 'https://app.test/#/orders' }), false, 'the sign-in page of a hash app is not the screen');
  assert.equal(onScreenRoute('https://app.test/#/orders', { route: '/#/orders', url: 'https://app.test/#/orders' }), true);
  const sweep = { schema: WIDTH_SWEEP_SCHEMA, bands: [], rows: [] }, overlay = { schema: OVERLAY_CHECK_SCHEMA, overlays: [] };
  const out = foldScreenChecks({ caseId: 'TC', states: [{ state: 'home', url: 'https://app.test/#/home' }, { state: 'list', url: 'https://app.test/#/orders' }],
    screens: [{ screenId: 'S1', route: '/#/orders', status: 'checked', result: { status: 'checked', sweep, overlay, verdict: 'PASS', issues: [] } }] });
  assert.deepEqual(out.states.get('list').probes.map((p) => p.kind), ['width-sweep', 'overlay-check'], 'the screen is folded into the state on its hash route');
  assert.deepEqual(out.notes, []);
});

// ── F5: one leg on another page ─────────────────────────────────────────────────────────────────────────────────
const SWEEP_FAIL = () => {
  const sweep = { schema: WIDTH_SWEEP_SCHEMA, marker: 'fail', bands: [{ id: 'W2|main', rule: 'W2', from: 741, to: 783, status: 'CONFIRMED', rows: ['desktop-768'] }], rows: [{ row: 'desktop-768', verified: true, failures: ['W2|main'] }] };
  assert.equal(sweepVerdict(sweep).verdict, 'FAIL');
  return sweep;
};
test('F5 (R3-5): an attempt whose overlay legs landed on another page still folds its sweep FAIL; only that leg is dropped', () => {
  const attempt = { status: 'checked', sweep: SWEEP_FAIL(), overlay: { schema: OVERLAY_CHECK_SCHEMA, overlays: [] }, verdict: 'FAIL', issues: ['SWEEP_BAND_FAIL:W2|main:741-783', 'SCREEN_ROUTE_MISMATCH:overlay:/login'] };
  const out = foldScreenChecks({ caseId: 'TC', states: [{ state: 's', url: 'https://t/orders' }], screens: [{ screenId: 'S1', route: '/orders', status: 'checked', attempts: [attempt] }] });
  assert.deepEqual(out.states.get('s').probes.map((p) => [p.kind, p.receipt.marker ?? null]), [['width-sweep', 'fail']]);
  assert.deepEqual(out.issues, ['SCREEN_CHECK_UNGRADED:S1'], 'the overlay check is still missing');
  // The same with the sweep on the other page: only the overlay check is folded.
  const other = { ...attempt, sweep: { ...attempt.sweep }, overlay: { schema: OVERLAY_CHECK_SCHEMA, overlays: [], marker: 'o' }, issues: ['SCREEN_ROUTE_UNKNOWN:sweep'] };
  const out2 = foldScreenChecks({ caseId: 'TC', states: [{ state: 's', url: 'https://t/orders' }], screens: [{ screenId: 'S1', route: '/orders', status: 'checked', attempts: [other] }] });
  assert.deepEqual(out2.states.get('s').probes.map((p) => p.kind), ['overlay-check']);
});

test('F5 (R3-5): the first overlay read after every goto returns the page URL and is checked; a sweep FAIL on the screen stands', { skip: SKIP_PW }, async () => {
  const url = fixture('overlays.html'), route = new URL(url).pathname, login = 'file:///login';
  const tab = await dragonStandIn({ browser: await launch(), url });
  try {
    const swept = await followSweep({ rpc: tab.rpc, url, chain: true });
    await followOverlays({ rpc: tab.rpc, url, lead: swept.restore });
    const ops = dragonOps(tab.calls);
    // The first overlay read after each goto (a fresh document) says where the page was; a later read on the same page
    // leaves the href out (the answers stay small) unless the URL changed.
    const afterGoto = ops.flatMap((op, k) => (op.kind === 'goto' ? [ops.slice(k + 1).find((x) => x.kind === 'goto' || (x.kind === 'read' && /^[wo]:/.test(x.step.as)))] : []))
      .filter((x) => x?.kind === 'read' && x.step.as.startsWith('o:'));
    assert.ok(afterGoto.length >= 8 && afterGoto.every((op) => valueOf(op)?.href === url), 'the read after each goto says where the page was');
    assert.ok(ops.some((op) => op.kind === 'read' && op.step.as === 'o:0:first' && valueOf(op).href === undefined), 'a read on the same page does not repeat it');
    const right = await screenCheckFromOps(ops, { screenId: 'S1', route, url });
    assert.equal(right.issues.some((c) => c.startsWith('SCREEN_ROUTE_')), false, right.issues.join(', '));
    // A later goto of the overlay check that landed on the sign-in page (a session that ran out mid-check).
    const late = await screenCheckFromOps(withValue(ops, 'o:0:esc-open', (v) => ({ ...v, href: login })), { screenId: 'S1', route, url });
    assert.ok(late.issues.includes('SCREEN_ROUTE_MISMATCH:overlay:/login'), late.issues.join(', '));
    assert.equal(late.issues.some((c) => c.startsWith('SCREEN_ROUTE_MISMATCH:sweep')), false);
  } finally { await tab.close(); }
  // The width-band page FAILs its sweep; its overlay check landed elsewhere: the attempt's verdict is the sweep's FAIL.
  const band = fixture('width-band.html');
  const tab2 = await dragonStandIn({ browser: await launch(), url: band });
  try {
    const swept = await followSweep({ rpc: tab2.rpc, url: band, chain: true });
    await followOverlays({ rpc: tab2.rpc, url: band, lead: swept.restore });
    const ops = withValue(dragonOps(tab2.calls), 'o:triggers', (v) => ({ ...v, href: login }));
    const result = await screenCheckFromOps(ops, { screenId: 'S1', route: new URL(band).pathname, url: band });
    assert.equal(sweepVerdict(result.sweep).verdict, 'FAIL');
    assert.ok(result.issues.includes('SCREEN_ROUTE_MISMATCH:overlay:/login'), result.issues.join(', '));
    assert.equal(result.verdict, 'FAIL', 'the sweep measured the screen and failed');
    const out = foldScreenChecks({ caseId: 'TC', states: [{ state: 's', url: band }], screens: [{ screenId: 'S1', route: new URL(band).pathname, status: 'checked', attempts: [result] }] });
    assert.deepEqual(out.states.get('s').probes.map((p) => p.kind), ['width-sweep']);
  } finally { await tab2.close(); }
});

// ── F4 and F8: the probe's trials ───────────────────────────────────────────────────────────────────────────────
const T5 = () => load('T5').variants.find((v) => v.at === 300 && !v.clean);
const probe = (calls, opts = {}) => transientProbeFromOps(dragonOps(calls), { caseId: 'TC', state: 's', action: canaryAction('T5'), plan: { kinds: [], reset: true }, ...opts });
const refused = () => ({ ok: false, answer: { ok: false, code: 'DESTRUCTIVE_HANDOFF_REQUIRED', step: 0, completed: false, destructivePolicy: { mode: 'manual', risk: 'destructive', enforced: true } } });

test('F4 (R3-4): a probe whose every trial Dragon\'s destructive gate refused is N/A, reported; one refusal among good trials is still UNGRADED', () => {
  const all = probe(trialCalls(T5(), { state: 's', alter: () => refused() }));
  assert.deepEqual([all.receipt, all.na, all.issues], [null, 'DESTRUCTIVE_HANDOFF_REQUIRED', []]);
  const one = probe(trialCalls({ ...T5(), trials: T5().trials.slice(0, 1) }, { state: 's', alter: () => refused() }));
  assert.equal(one.na, 'DESTRUCTIVE_HANDOFF_REQUIRED', 'the executor stops after the first refusal');
  const mixed = probe(trialCalls(T5(), { state: 's', alter: (n) => (n === 1 ? refused() : null) }));
  assert.equal(mixed.na, undefined);
  assert.equal(transientProbeVerdict(mixed.receipt).verdict, 'UNGRADED');
  const text = detectorPromptSection({ caseId: 'TC', detectors: { transient: { trials: 3 } } });
  assert.match(text, /DESTRUCTIVE_HANDOFF_REQUIRED/);
  assert.match(text, /do not retry it or change its steps/);
});

test('F8 (R3-8): a trial whose action target is not the state\'s main action is TRANSIENT_ACTION_MISMATCH, UNGRADED', () => {
  const good = probe(trialCalls(T5(), { state: 's' }));
  assert.ok(good.receipt.attempts.every((a) => a.ok), good.issues.join(', '));
  // Every trial clicked another element than the one the state names.
  const other = probe(trialCalls(T5(), { state: 's', selector: '#other' }));
  assert.equal(other.receipt, null, 'no trial ran the main action');
  assert.deepEqual(other.issues, [0, 1, 2].map((n) => `TRANSIENT_ACTION_MISMATCH:trial-${n}`));
  // One trial on another element, or its sample on another element, with the state naming no action: the trials disagree.
  const stray = probe(trialCalls(T5(), { state: 's', alter: (n, params, answer) => (n === 2 ? { params: { ...params, steps: [{ clickSelector: '#other' }] }, answer } : null) }), { action: null });
  assert.deepEqual(stray.receipt.attempts.map((a) => a.code), [null, null, 'TRANSIENT_ACTION_MISMATCH']);
  assert.equal(transientProbeVerdict(stray.receipt).verdict, 'UNGRADED');
  const sampled = probe(trialCalls(T5(), { state: 's', alter: (n, params, answer) => (n === 0 ? { params: { ...params, sample: { ...params.sample, args: ['#other'] } }, answer } : null) }));
  assert.deepEqual(sampled.receipt.attempts.map((a) => a.code), ['TRANSIENT_ACTION_MISMATCH', null, null]);
});

// ── F9: packs or inline bodies, loops or written-out steps ──────────────────────────────────────────────────────
test('F9 (R3-9): the recipes pick the helper path and the loop path once from help, and fall back to inline bodies and written-out loops', () => {
  const screen = screenCheckPromptSection({ screenId: 'S1', url: 'https://t/orders', route: '/orders' });
  const kase = detectorPromptSection({ caseId: 'TC', detectors: { transient: { trials: 3 }, explore: { policy: {}, budget: 12 } } });
  for (const text of [screen, kase]) {
    // Dogfood 05/11: the r1a summary at the start of help picks the path; an older R1a build without one: the Grep.
    assert.match(text, /"packs" and "loops" pick the paths below/);
    assert.match(text, /No "r1a" summary \(an older R1a build\): Grep the file once for "packs"/);
    assert.match(text, /HELPER_PACK_FORBIDDEN/);
    assert.match(text, /helpersDefine \{"helpers": /);
    assert.doesNotMatch(text, /do not send the bodies yourself/);
  }
  assert.match(screen, /and once for "loops"/);
  assert.match(screen, /write each loop out/);
  assert.doesNotMatch(screen, /never unroll them\.$/m);
});

test('F9 (R3-9): a screen check with inline helper bodies and written-out loops is graded as the one with the pack and Dragon loops', { skip: SKIP_PW }, async () => {
  const url = fixture('width-band.html');
  const grade = async (inline) => {
    const tab = await dragonStandIn({ browser: await launch(), url });
    try {
      // An older R1a Dragon, or a pack outside Dragon's roots: the bodies go inline and every loop is written out.
      const rpc = !inline ? tab.rpc : (method, params = {}) => (method === 'helpers.define' && params.pack ? tab.rpc(method, { helpers: helperDefinitions(['sweep', 'overlay']) })
        : method === 'do' ? tab.rpc(method, { ...params, steps: expandDoSteps(params.steps).steps }) : tab.rpc(method, params));
      const swept = await followSweep({ rpc, url, chain: true });
      await followOverlays({ rpc, url, lead: swept.restore });
      if (inline) assert.equal(tab.calls.some((c) => c.method === 'do' && c.params.steps.some((s) => s?.forEach)), false);
      const result = await screenCheckFromOps(dragonOps(tab.calls), { screenId: 'S1', route: new URL(url).pathname, url });
      return { verdict: result.verdict, issues: result.issues, bands: result.sweep?.bands?.map((b) => [b.id, b.from, b.to]) };
    } finally { await tab.close(); }
  };
  const loops = await grade(false), typed = await grade(true);
  assert.equal(loops.verdict, 'FAIL');
  assert.deepEqual(typed, loops);
});
