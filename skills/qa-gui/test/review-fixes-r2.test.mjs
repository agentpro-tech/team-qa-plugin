// Fix round 2 of the integrated upgrade: the second review's findings on the QA GUI side, each reproduced first.
//   E1  the screen-check fold never loses a result (normalised routes, the first state, missing = not run, attempts)
//   E2  a screen check proves the page it measured (href in w:found and o:triggers), signed in as the screen's role
//   E3  a probe trial proves its action ran; QA GUI decides repeatability; failed trials are counted
//   E5  the overlay focus check follows element identity; tool limits are one cell's; clicks from their own open
//   E6  every R1a tool of a case section is behind the help check
//   E8  measure() needs its own vw and a failure list; helper bodies are ASCII; band capture problems are read
//   E9  the helpers come from a pack by path and hash; long legs are Dragon loops, rebuilt and checked by collect
// Recorded R1d streams and synthetic receipts; the in-page checks run in Chromium when Playwright is installed.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  HELPER_PACK_SCHEMA, HELPER_PACK_SHA256, OVERLAY_DEFAULTS, STREAM_HELPERS, detectorPromptSection, dragonOps, expandDoSteps, foldScreenChecks, helperCall, helperPack,
  helperPackText, keyboardWay, ranHash, recordedGeometryReader, screenCheckFromOps, screenCheckPromptSection, screenRouteKey, transientProbeFromOps, transientRepeatability,
} from '../scripts/lib/stream-detectors.mjs';
import { OVERLAY_CHECK_SCHEMA, focusCycled, gradeOverlay, overlayVerdict } from '../scripts/lib/overlay-check.mjs';
import { transientProbeVerdict } from '../scripts/lib/transient-probe.mjs';
import { WIDTH_SWEEP_SCHEMA, sweepVerdict } from '../scripts/lib/width-sweep.mjs';
import { canaryAction } from './support/r1d-recorder.mjs';
import { trialCalls } from './support/recipe-calls.mjs';
import { dragonStandIn, followOverlays, followSweep } from './support/recipe-standin.mjs';
import { loadPlaywright, PLAYWRIGHT_SKIP } from './support/playwright.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const load = (s) => JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test/fixtures/r1d/recorded', `${s}.json.gz`))).toString('utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const playwright = await loadPlaywright();
const SKIP_PW = playwright ? false : PLAYWRIGHT_SKIP;
let browser = null;
const launch = async () => (browser ??= await playwright.chromium.launch());
after(async () => { if (browser) await browser.close(); });
const fixture = (name) => pathToFileURL(join(ROOT, 'test/fixtures/r1e', name)).href;

// ── E5: the overlay focus check ──────────────────────────────────────────────────────────────────────────────────
test('E5 (QG2-1): a cycle is a return to the first element or to the document, by identity: equal selectors are not a cycle', () => {
  assert.equal(focusCycled([1, 2, 3], 4), false);
  assert.equal(focusCycled([1, 2, 3], 1), true, 'back to the first element');
  // Fix round 3 (F2): the document alone is no cycle; the first element must come back after another one.
  assert.equal(focusCycled([1, 2, 3], 0), false, 'back to the document only');
  assert.equal(focusCycled([1, 2, 3], 2), false, 'a later element again is not a cycle (focus may pass a control twice)');
  assert.equal(focusCycled([], 0), false);
  // Three controls in one shadow host share the selector: the old string check called press 2 a cycle.
  const samples = [{ active: 'my-links', id: 1 }, { active: 'my-links', id: 2 }, { active: 'my-links', id: 3 }, { active: '#edit', id: 4 }];
  assert.deepEqual(keyboardWay(samples, { selector: '#edit' }), { presses: 4, reached: true, cycled: false });
});

for (const [name, html] of [
  ['a custom element with three links in its shadow root', `<my-links></my-links><button id="edit" aria-haspopup="dialog">Edit</button><dialog id="d"><button>Close</button></dialog>
    <script>customElements.define('my-links', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<a href="#a">A</a> <a href="#b">B</a> <a href="#c">C</a>'; } });</script>`],
  ['three repeated cards deeper than four levels', `<main>${'<section><div><div><div><div><a href="#x">Open</a></div></div></div></div></section>'.repeat(3)}</main><button id="edit" aria-haspopup="dialog">Edit</button><dialog id="d"><button>Close</button></dialog>`],
]) {
  test(`E5 (QG2-1): on a clean page with ${name}, the overlay helper's focus log reaches the trigger at press 4, no cycle`, { skip: SKIP_PW }, async () => {
    const page = await (await launch()).newPage();
    try {
      await page.setContent(html);
      const helper = (mode) => page.evaluate((code) => (0, eval)(code), `(${STREAM_HELPERS.overlay.body})(${JSON.stringify(mode)})`);
      await helper('log');
      for (let i = 0; i < 6; i += 1) await page.keyboard.press('Tab');
      const { samples } = await helper('keylog');
      assert.equal(samples.length, 6);
      assert.ok(samples.every((x) => Number.isInteger(x.id)), JSON.stringify(samples));
      assert.equal(new Set(samples.slice(0, 3).map((x) => x.active)).size, 1, 'the three controls before the trigger share one selector');
      assert.deepEqual(keyboardWay(samples, { selector: '#edit' }), { presses: 4, reached: true, cycled: false });
    } finally { await page.close(); }
  });
}

const cleanDialog = (keyboard) => ({ trigger: { selector: '#edit', label: 'Edit' }, overlay: '#d', mouse: { opened: true, overlay: '#d', activeInside: true, modal: true },
  trap: { presses: 12, inside: Array(12).fill(true) }, scroll: { scrollable: false }, stacked: { available: false }, esc: { closed: true, active: '#edit' },
  backdrop: { available: false }, button: { available: true, closed: true, active: '#edit' }, keyboard });
test('E5 (QG2-1, QG2-12): samples lost to a frame and the 80-press limit leave O2 UNGRADED TOOL_LIMIT, the overlay check keeps its verdict', () => {
  assert.equal(OVERLAY_DEFAULTS.keyboardLimit, 80);
  for (const keyboard of [{ reachedTrigger: false, presses: 80, cycled: false, lost: 3 }, { reachedTrigger: false, presses: 80, cycled: false }]) {
    const graded = gradeOverlay(cleanDialog(keyboard));
    assert.deepEqual(graded.checks.find((c) => c.rule === 'O2'), { rule: 'O2', status: 'UNGRADED', reason: 'TOOL_LIMIT', detail: graded.checks.find((c) => c.rule === 'O2').detail });
    const verdict = overlayVerdict({ schema: OVERLAY_CHECK_SCHEMA, overlays: [{ observation: cleanDialog(keyboard) }] });
    assert.deepEqual(verdict, { verdict: 'PASS', issues: ['OVERLAY_O2_TOOL_LIMIT:dialog:d'] }, 'one cell, never the whole screen');
  }
  // A failure elsewhere still fails, and an unmeasured check is still UNGRADED.
  assert.equal(overlayVerdict({ schema: OVERLAY_CHECK_SCHEMA, overlays: [{ observation: { ...cleanDialog({ reachedTrigger: false, presses: 80, cycled: false }), esc: { closed: false, active: '#edit' } } }] }).verdict, 'FAIL');
});

test('E5 (QG2-14): the recipe clicks the backdrop and the close button from the open it checks them against', () => {
  const text = screenCheckPromptSection({ screenId: 'S1', url: 'https://t/orders', route: '/orders' });
  assert.match(text, /if o:k:backdrop-open has a backdropPoint/);
  assert.match(text, /if o:k:button-open has a closeButton/);
  assert.doesNotMatch(text, /o:k:first has a (backdropPoint|closeButton)/);
  assert.match(text, /"o:k:backdrop-open"\}\] and stop there/);
  assert.match(text, /"o:k:button-open"\}\] and stop there/);
});

test('E5 (QG2-1): a focus log with fewer samples than Tab presses is O2 TOOL_LIMIT, not a missing leg', { skip: SKIP_PW }, async () => {
  const tab = await dragonStandIn({ browser: await launch(), url: fixture('overlays.html') });
  try {
    await followOverlays({ rpc: tab.rpc, url: fixture('overlays.html'), define: true });
    const ops = dragonOps(tab.calls).map((op) => (op.step?.as === 'o:0:kbd' ? { ...op, res: { ...op.res, value: { ...op.res.value, samples: op.res.value.samples.slice(0, 70) } } } : op));
    const overlay = (await import('../scripts/lib/stream-detectors.mjs')).overlayCheckFromOps(ops, { route: '/overlays', helpers: true });
    const first = overlay.receipt.overlays[0];
    assert.deepEqual(first.observation.keyboard, { reachedTrigger: false, presses: OVERLAY_DEFAULTS.keyboardLimit, cycled: false, lost: 10 });
    assert.equal(first.checks.find((c) => c.rule === 'O2').reason, 'TOOL_LIMIT');
    assert.ok(first.checks.filter((c) => c.rule !== 'O2').some((c) => c.status !== 'UNGRADED' || c.reason === 'PRECONDITION_ABSENT'), 'the other legs are graded');
  } finally { await tab.close(); }
});

// ── E6: the R1a rule in every case section with a detector ──────────────────────────────────────────────────────
test('E6 (QG2-2): an explore-only case section checks help before helpersDefine; without R1a the exploration is skipped and reported', () => {
  const text = detectorPromptSection({ caseId: 'TC', detectors: { transient: false, ux: [], explore: { policy: {}, budget: 12 } } });
  assert.ok(text.indexOf('Call help once before any R1a tool') >= 0 && text.indexOf('Call help once') < text.indexOf('helpersDefine {'), text);
  assert.match(text, /the exploration too: it is reported, not held against the case/);
  assert.doesNotMatch(text, /"unavailable"/, 'no transient or ux claim for a case that has none');
});

// ── E1: the screen-check fold ───────────────────────────────────────────────────────────────────────────────────
const SWEEP_FAIL = { schema: WIDTH_SWEEP_SCHEMA, bands: [], rows: [], marker: 'fail' };
const screenResult = (over = {}) => ({ schema: 'qa-gui/screen-check/v1', screenId: 'S1', route: '/orders', status: 'checked', sweep: { ...SWEEP_FAIL }, overlay: { schema: OVERLAY_CHECK_SCHEMA, overlays: [] }, verdict: 'FAIL', issues: ['SWEEP_BAND_FAIL:x'], ...over });
test('E1 (TQ2-1, QG2-3): a screen is matched by normalised route on both sides, else folded into the case\'s first state; nothing is lost', () => {
  const fold = (route, urls) => foldScreenChecks({ caseId: 'TC', states: urls.map((url, i) => ({ state: `s${i}`, url })), screens: [{ screenId: 'S1', route, status: 'checked', result: screenResult({ route }) }] });
  assert.equal(screenRouteKey('https://t/orders/#list'), '/orders');
  assert.equal(screenRouteKey('https://t/orders?tab=2#x', { query: true }), '/orders?tab=2');
  for (const [route, urls, into] of [['/orders', ['https://t/home', 'https://t/orders/'], 's1'], ['/orders', ['https://t/home', 'https://t/orders#list'], 's1'],
    ['/orders?tab=2', ['https://t/orders', 'https://t/orders?tab=2'], 's1'], ['/orders', ['https://t/orders/new'], 's0'], ['/orders', ['https://t/x', 'https://t/y'], 's0']]) {
    const out = fold(route, urls);
    assert.deepEqual(out.states.get(into).probes.map((p) => p.kind), ['width-sweep', 'overlay-check'], `${route} against ${urls}`);
    assert.deepEqual(out.issues, [], `${route} against ${urls}`);
  }
  // A planned check with no attested result is a detector not run, whether a state was on its route or not.
  for (const urls of [['https://t/orders'], ['https://t/elsewhere']]) {
    const out = foldScreenChecks({ caseId: 'TC', states: urls.map((url, i) => ({ state: `s${i}`, url })), screens: [{ screenId: 'S1', route: '/orders', status: 'missing' }] });
    assert.deepEqual(out.issues, ['DETECTOR_NOT_RUN:TC:screens:S1'], urls.join());
    assert.deepEqual(out.states.get('s0').issues, ['DETECTOR_NOT_RUN:TC:screens:S1']);
  }
});

test('E1: every attested attempt is folded by kind: a FAIL in any attempt stands, else the latest; an attempt on another page gives nothing', () => {
  const failed = screenResult(), clean = screenResult({ sweep: { schema: WIDTH_SWEEP_SCHEMA, bands: [], rows: [], marker: 'clean' }, verdict: 'PASS', issues: [] });
  const banded = { ...failed, sweep: { schema: WIDTH_SWEEP_SCHEMA, rows: [], marker: 'fail', bands: [{ id: 'W2|main', rule: 'W2', from: 741, to: 783, status: 'CONFIRMED', rows: ['desktop-768'] }] } };
  banded.sweep.rows = [{ row: 'desktop-768', verified: true, failures: ['W2|main'] }];
  const run = (attempts) => foldScreenChecks({ caseId: 'TC', states: [{ state: 's', url: 'https://t/orders' }], screens: [{ screenId: 'S1', route: '/orders', status: 'checked', attempts }] }).states.get('s').probes;
  assert.equal(sweepVerdict(banded.sweep).verdict, 'FAIL', 'the planted band FAILs');
  assert.equal(run([banded, clean]).find((p) => p.kind === 'width-sweep').receipt.marker, 'fail', 'the earlier FAIL stands');
  assert.equal(run([clean, banded]).find((p) => p.kind === 'width-sweep').receipt.marker, 'fail');
  assert.equal(run([{ ...clean, sweep: { ...clean.sweep, marker: 'old' } }, clean]).find((p) => p.kind === 'width-sweep').receipt.marker, 'clean', 'else the latest');
  const elsewhere = { ...banded, verdict: 'UNGRADED', issues: ['SCREEN_ROUTE_MISMATCH:sweep:https://t/login'] };
  const out = foldScreenChecks({ caseId: 'TC', states: [{ state: 's', url: 'https://t/orders' }], screens: [{ screenId: 'S1', route: '/orders', status: 'checked', attempts: [elsewhere] }] });
  // Fix round 3 (F5): only the sweep measured another page; the overlay check of the same attempt still counts.
  assert.deepEqual([out.states.get('s').probes.map((p) => p.kind), out.issues], [['overlay-check'], ['SCREEN_CHECK_UNGRADED:S1']], 'a page that is not the screen is no finding of it');
});

test('E1 (TQ2 minor): a band capture whose copy does not hash to what Dragon reported backs nothing: SWEEP_CAPTURE_HASH_MISMATCH', () => {
  const receipt = { schema: WIDTH_SWEEP_SCHEMA, bands: [], rows: [], captures: [{ width: 741, capture: { sha256: 'a'.repeat(64), problem: 'SWEEP_CAPTURE_HASH_MISMATCH' } }] };
  assert.deepEqual(sweepVerdict(receipt), { verdict: 'UNGRADED', issues: ['SWEEP_CAPTURE_HASH_MISMATCH:741'] });
  assert.equal(sweepVerdict({ ...receipt, captures: [{ width: 741, capture: { path: 'x.jpg', sha256: 'a'.repeat(64) } }] }).verdict, 'PASS');
});

// ── E2: which page a screen check measured ──────────────────────────────────────────────────────────────────────
test('E2 (QG2-4, TQ2-4): a screen check on another page (a redirect to sign-in) is UNGRADED SCREEN_ROUTE_MISMATCH; the recipe signs in as the role first', { skip: SKIP_PW }, async () => {
  const url = fixture('width-band-clean.html');
  const tab = await dragonStandIn({ browser: await launch(), url });
  try {
    const swept = await followSweep({ rpc: tab.rpc, url, chain: true });
    await followOverlays({ rpc: tab.rpc, url, lead: swept.restore });
    const ops = dragonOps(tab.calls);
    const right = await screenCheckFromOps(ops, { screenId: 'S1', route: new URL(url).pathname, url });
    assert.deepEqual([right.verdict, right.issues], ['PASS', []]);
    assert.equal(right.measured.sweep, url);
    const wrong = await screenCheckFromOps(ops, { screenId: 'S1', route: '/orders', url: 'file:///orders' });
    assert.equal(wrong.verdict, 'UNGRADED');
    assert.ok(wrong.issues.includes(`SCREEN_ROUTE_MISMATCH:sweep:${new URL(url).pathname}`) && wrong.issues.some((c) => c.startsWith('SCREEN_ROUTE_MISMATCH:overlay:')), wrong.issues.join(', '));
  } finally { await tab.close(); }
  const text = screenCheckPromptSection({ screenId: 'S2', url: 'https://t/admin', route: '/admin', role: 'admin', signIn: 'open /login, fill the admin account from the run secrets, submit' });
  assert.match(text, /Sign in as the role "admin" before anything else, exactly as a case of that role signs in: open \/login/);
});

// ── E3: the probe's trials ──────────────────────────────────────────────────────────────────────────────────────
const T5 = () => load('T5').variants.find((v) => v.at === 300 && !v.clean);
// The T5 canary's action is a Submit (a write): its plan gives a reset path, so it is repeatable.
const probe = (calls, opts = {}) => transientProbeFromOps(dragonOps(calls), { caseId: 'TC', state: 's', action: canaryAction('T5'), plan: { kinds: [], reset: true }, ...opts });
test('E3 (QG2-5, TQ2-5): a trial whose click missed, whose do did not complete, or that has no trusted mark is counted and UNGRADED TRANSIENT_ACTION_NOT_RUN', () => {
  const good = probe(trialCalls(T5(), { state: 's' }));
  assert.equal(good.receipt.attempts.length, 3);
  assert.notEqual(transientProbeVerdict(good.receipt).verdict, 'UNGRADED', good.issues.join(', '));
  for (const [what, alter] of [
    ['a click that found no target', (n, params, answer) => (n === 0 ? { answer: { ...answer, do: { completed: false, brief: true, results: [{ step: 'clickSelector', ok: false, code: 'CLICK_TARGET_NOT_FOUND' }] } } } : null)],
    ['no trusted-input mark', (n, params, answer) => (n === 1 ? { answer: { ...answer, mark: null } } : null)],
    ['no setup', (n, params, answer) => (n === 0 ? { params: { ...params, setup: undefined } } : null)],
    ['a Dragon refusal', (n, params, answer) => (n === 2 ? { ok: false, answer: { ok: false, code: 'TRIAL_SETUP_FAILED' } } : null)],
  ]) {
    const out = probe(trialCalls(T5(), { state: 's', alter }));
    assert.equal(out.receipt.attempts.length, 3, what);
    assert.equal(out.receipt.attempts.filter((a) => !a.ok).length, 1, what);
    const graded = transientProbeVerdict(out.receipt);
    assert.equal(graded.verdict, 'UNGRADED', what);
    assert.ok(graded.issues.some((c) => c.startsWith('TRANSIENT_ATTEMPT_NOT_RUN:')), `${what}: ${graded.issues.join(', ')}`);
  }
});

test('E3 (QG2-7, QG2-11): QA GUI decides repeatability; "not repeatable" from the executor on a sort is reported and one good trial of three is UNGRADED', () => {
  // Dogfood 05/11: a save with no reset path gets its trials with fresh values; a delete with none still gets no trial.
  assert.deepEqual(transientRepeatability({ kinds: ['save'] }), { repeatable: true, trials: 3, writes: ['save'], reason: null, fresh: true });
  assert.deepEqual(transientRepeatability({ kinds: ['delete'] }), { repeatable: false, trials: 0, writes: ['delete'], reason: 'TRANSIENT_WRITE_NO_RESET' });
  assert.deepEqual(transientRepeatability({ kinds: ['delete', 'list-remove'], reset: true }).trials, 3);
  assert.deepEqual(transientRepeatability({ kinds: ['list-sort'] }).trials, 3);
  const one = trialCalls({ ...T5(), trials: T5().trials.slice(0, 1) }, { state: 's' });
  const sort = { method: 'click', selector: '#go', target: { tag: 'button', label: 'Sort by date' } };
  const out = probe(one, { action: sort, plan: { kinds: ['list-sort'], reset: false }, claimed: false });
  assert.ok(out.issues.includes('TRANSIENT_REPEATS_REQUIRED:the executor said not repeatable'), out.issues.join(', '));
  assert.equal(out.receipt.action.repeatable, true, 'the executor\'s word changes nothing');
  const graded = transientProbeVerdict(out.receipt);
  assert.equal(graded.verdict, 'UNGRADED');
  assert.ok(graded.issues.includes('TRANSIENT_REPEATS_REQUIRED:1/3'), graded.issues.join(', '));
  // Three trials with the executor still saying "not repeatable": the claim is kept and graded, UNGRADED.
  const three = probe(trialCalls(T5(), { state: 's' }), { action: sort, plan: { kinds: ['list-sort'], reset: false }, claimed: false });
  assert.equal(three.receipt.action.claimed, false);
  assert.ok(transientProbeVerdict(three.receipt).issues.includes('TRANSIENT_REPEATS_REQUIRED:claimed-not-repeatable'));
  // Two trials that did not run and one that did: never a PASS on one trial.
  const two = probe(trialCalls(T5(), { state: 's', alter: (n, params, answer) => (n > 0 ? { answer: { ...answer, mark: null } } : null) }), { action: sort });
  assert.deepEqual(two.receipt.attempts.map((a) => a.ok), [true, false, false]);
  assert.equal(transientProbeVerdict(two.receipt).verdict, 'UNGRADED');
});

test('E3 (TQ2 minor): a trial under a forced condition (a hold rule still active) is UNGRADED TRANSIENT_CONDITIONS_NOT_DEFAULT', () => {
  const held = (n, params, answer) => ({ answer: { ...answer, conditions: { ...answer.conditions, requests: [{ id: 'write', action: 'hold', urlPattern: '*/api/*' }] } } });
  const graded = transientProbeVerdict(probe(trialCalls(T5(), { state: 's', alter: held })).receipt);
  assert.equal(graded.verdict, 'UNGRADED');
  assert.ok(graded.issues.includes('TRANSIENT_CONDITIONS_NOT_DEFAULT:trial-0'), graded.issues.join(', '));
});

test('E3: the case section asks for setup in every trial, after envReset, labelled with the state, as often as QA GUI decided', () => {
  const text = detectorPromptSection({ caseId: 'TC', detectors: { transient: { trials: 3, reset: true } } });
  assert.match(text, /For each of the 3 trials: framesTrial \{"tabId":"<tab>","correlationId":"transient:<state>","setup":\["<steps>"\]/);
  assert.match(text, /in every trial, the first too/);
  assert.match(text, /AFTER the case's envReset/);
  assert.doesNotMatch(text, /"repeatable"/, 'the executor is not asked whether it may repeat');
});

// ── E8 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
test('E8 (QG2-9): a w:<width> read counts only with its own vw and a failure list', async () => {
  const doOf = (value) => dragonOps([{ method: 'do', params: { steps: [{ viewport: { width: 400, height: 800, deviceScaleFactor: 1, mobile: false } }, { wait: 150 }, helperCall('sweep', ['measure'], 'w:400')] },
    result: { completed: true, results: [{ step: 'viewport', ok: true }, { step: 'wait', ok: true }, { step: 'read', as: 'w:400', value, helper: { name: STREAM_HELPERS.sweep.name, sha256: STREAM_HELPERS.sweep.sha256 } }] } }]);
  assert.deepEqual(await recordedGeometryReader(doOf({ vw: 400, layout: 'a', failures: [] })).measure(400), { vw: 400, layout: 'a', failures: [] });
  for (const value of [{ layout: 'a', failures: [] }, { vw: 401, layout: 'a', failures: [] }, { vw: 400, layout: 'a' }, { vw: 400, layout: 'a', failures: 'none' }]) {
    await assert.rejects(recordedGeometryReader(doOf(value)).measure(400), /SWEEP_WIDTH_NOT_RECORDED:400/, JSON.stringify(value));
  }
});

test('E8 (QG2-10): every helper body is plain ASCII, so no re-encoding changes its SHA-256', () => {
  for (const helper of Object.values(STREAM_HELPERS)) assert.match(helper.body, /^[\x20-\x7e\n]*$/, helper.key);
});

// ── E9: helper pack and loops ───────────────────────────────────────────────────────────────────────────────────
test('E9 (TQ2-6, QG2-13): the helper pack ships with QA GUI and the recipes name it by path and hash, never a body', () => {
  const { path, sha256 } = helperPack();
  const text = readFileSync(path, 'utf8');
  assert.equal(text, helperPackText(), 'the shipped pack is what scripts/stream-helper-pack.mjs writes');
  assert.equal(createHash('sha256').update(text).digest('hex'), sha256);
  assert.equal(sha256, HELPER_PACK_SHA256);
  const pack = JSON.parse(text);
  assert.equal(pack.schema, HELPER_PACK_SCHEMA);
  assert.deepEqual(Object.keys(pack.helpers), Object.values(STREAM_HELPERS).map((h) => h.name));
  assert.equal(helperPack('/opt/skills/qa-gui').path, '/opt/skills/qa-gui/scripts/lib/stream-helpers.pack.json');
  const screen = screenCheckPromptSection({ screenId: 'S1', url: 'https://t/orders', route: '/orders', pack: { path: '/opt/qa-gui/pack.json', sha256 } });
  assert.ok(screen.includes(`helpersDefine {"pack":{"path":"/opt/qa-gui/pack.json","sha256":"${sha256}"}}`));
  for (const helper of Object.values(STREAM_HELPERS)) assert.ok(!screen.includes(helper.body.slice(0, 60)), helper.key);
  assert.ok(screen.length < 7000, `screen recipe ${screen.length} chars`);
});

test('E9: a do with Dragon loops is rebuilt step by step and counts only where Dragon names the same step (ran or ranHash) at the same place', () => {
  const steps = [{ goto: 'https://t/x' }, { forEach: { name: 'w', range: [320, 360, 20] }, steps: [{ viewport: { width: '$w', height: 800, deviceScaleFactor: 1, mobile: false } }, helperCall('sweep', ['measure'], 'w:$w')] }];
  const { steps: flat, origin } = expandDoSteps(steps);
  assert.deepEqual(flat.map((s) => s.as ?? s.viewport?.width ?? s.goto), ['https://t/x', 320, 'w:320', 340, 'w:340', 360, 'w:360']);
  const results = flat.map((s, i) => ({ step: s.call ? 'read' : Object.keys(s)[0], ok: true, ...(s.call ? { as: s.as, value: { vw: 1 } } : {}), ...(origin[i] ? { ranHash: ranHash(s), each: origin[i] } : {}) }));
  const ops = dragonOps([{ method: 'do', params: { brief: true, steps }, result: { completed: true, results } }]);
  assert.deepEqual(ops.map((op) => [op.kind, op.ok]), [['goto', true], ['viewport', true], ['read', true], ['viewport', true], ['read', true], ['viewport', true], ['read', true]]);
  assert.equal(ops[2].step.as, 'w:320');
  // A result that names another step (Dragon expanded something else) or another place does not count.
  const forged = results.map((r, i) => (i === 4 ? { ...r, ranHash: ranHash({ call: 'x' }) } : i === 6 ? { ...r, each: { step: 1, n: 0, sub: 1 } } : r));
  const bad = dragonOps([{ method: 'do', params: { brief: true, steps }, result: { completed: true, results: forged } }]);
  assert.deepEqual(bad.map((op) => op.ok), [true, true, true, true, false, true, false]);
  // A full answer echoes the step instead.
  const full = dragonOps([{ method: 'do', params: { steps }, result: { completed: true, results: results.map(({ ranHash: _h, ...r }, i) => (origin[i] ? { ...r, ran: flat[i] } : r)) } }]);
  assert.ok(full.every((op) => op.ok));
});

test('E9 numbers: a screen check on the fixture pages types little and no do over 30 steps', { skip: SKIP_PW }, async () => {
  for (const name of ['width-band.html', 'overlays.html']) {
    const tab = await dragonStandIn({ browser: await launch(), url: fixture(name) });
    try {
      const swept = await followSweep({ rpc: tab.rpc, url: fixture(name), chain: true });
      await followOverlays({ rpc: tab.rpc, url: fixture(name), lead: swept.restore });
      const typed = tab.calls.map((c) => JSON.stringify(c.params).length);
      const stepsTyped = (list) => list.reduce((n, s) => n + 1 + (Array.isArray(s?.steps) ? s.steps.length : 0), 0);
      const longest = Math.max(...tab.calls.filter((c) => c.method === 'do').map((c) => stepsTyped(c.params.steps)));
      console.log(`# E9 screen check ${name}: ${tab.calls.length + 7} calls, typed ${typed.reduce((a, b) => a + b, 0)} chars in tool inputs, longest typed do ${longest} steps`);
      assert.ok(longest <= 30, `${name}: a do of ${longest} typed steps`);
      assert.ok(typed.reduce((a, b) => a + b, 0) < 9000, name);
    } finally { await tab.close(); }
  }
});

test('E9: frames.trial loops and helper results come back as Dragon gives them; a probe with a forged trial helper is a mismatch', () => {
  const calls = trialCalls(T5(), { state: 's', helper: { name: STREAM_HELPERS.sample.name, sha256: 'f'.repeat(64) } });
  assert.deepEqual(probe(calls).issues, ['DETECTOR_HELPER_MISMATCH:transient']);
  assert.equal(clone(calls)[0].params.correlationId, 'transient:s');
});

// ── Dogfood 05/11: a save with no reset path is probed with fresh test values ─────────────────────────────────────
test('dogfood 05/11 (BA R1d example): a write that saves gets 3 fresh-value trials and is graded; a delete with no reset path stays N/A', () => {
  // The T5 canary's action is a Submit; with no reset path its trials fill fresh values, a different setup each time.
  const fresh = (n, params) => ({ params: { ...params, setup: [...(params.setup ?? []), { fill: { selector: '#name', value: `QA_R1_NSP_001-T${n + 1}` } }] } });
  const out = probe(trialCalls(T5(), { state: 's', alter: fresh }), { plan: { kinds: ['submit'], reset: false } });
  assert.equal(out.receipt.attempts.filter((a) => a.ok).length, 3, out.issues.join(', '));
  assert.ok(!out.issues.some((c) => c.startsWith('TRANSIENT_WRITE_NO_RESET')), out.issues.join(', '));
  assert.notEqual(transientProbeVerdict(out.receipt).verdict, 'UNGRADED', out.issues.join(', '));
  const removed = probe(trialCalls(T5(), { state: 's' }), { plan: { kinds: ['delete'], reset: false } });
  assert.ok(removed.issues.includes('TRANSIENT_WRITE_NO_RESET:trials-run-3'), removed.issues.join(', '));
  const text = detectorPromptSection({ caseId: 'TC', detectors: { transient: { trials: 3, kinds: ['save'], reset: false, fresh: true } } });
  assert.match(text, /fills it with fresh test values, the case's own values with "-T1", "-T2" or "-T3" appended/);
  assert.doesNotMatch(detectorPromptSection({ caseId: 'TC', detectors: { transient: { trials: 3, reset: true } } }), /fresh test values/);
});

test('dogfood 05/11: a forced held write of a case whose write has no reset path fills fresh values too', () => {
  const text = detectorPromptSection({ caseId: 'TC', detectors: { transient: false, fresh: true, ux: ['U1', 'U2'] } });
  assert.match(text, /U1\/U2 \(a write held\), on the state after the write \(the form filled again with fresh test values/);
  assert.doesNotMatch(detectorPromptSection({ caseId: 'TC', detectors: { transient: false, ux: ['U1', 'U2'] } }), /fresh test values/);
});
