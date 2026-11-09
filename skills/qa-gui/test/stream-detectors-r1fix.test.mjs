// Fix round 1, D1-D3: the screen check once per screen in its own dispatch, page helpers defined once and proven by
// their sha-256, the transient probe as Dragon frames.trial calls (one atomic call per trial, after the recording).
// Fixtures: recorded R1d trials as frames.trial answers, synthetic calls, and the R1e fixture pages in Chromium when
// Playwright is installed (a Dragon stand-in that runs QA GUI's helper bodies as Dragon's {call} steps would).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import {
  DETECTOR_HELPER_MISMATCH, STREAM_HELPERS, detectorPromptSection, dragonOps, explorationFromOps, foldScreenChecks, helperCall, overlayCheckFromOps,
  overlayTriggerOrder, screenCheckFromOps, screenCheckPromptSection, transientProbeFromOps, widthSweepFromOps,
} from '../scripts/lib/stream-detectors.mjs';
import { transientProbeVerdict } from '../scripts/lib/transient-probe.mjs';
import { probeCells } from '../scripts/lib/probes.mjs';
import { OVERLAY_CHECK_SCHEMA } from '../scripts/lib/overlay-check.mjs';
import { CANARY_RULE, SCENARIOS, canaryAction } from './support/r1d-recorder.mjs';
import { trialCalls } from './support/recipe-calls.mjs';
import { loadPlaywright, PLAYWRIGHT_SKIP } from './support/playwright.mjs';
import { dragonStandIn, followOverlays, followSweep } from './support/recipe-standin.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const load = (s) => JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test/fixtures/r1d/recorded', `${s}.json.gz`))).toString('utf8'));
const ok = (method, params, result) => ({ method, params, result, ok: result?.ok !== false });
const doCall = (steps, values = {}, helpers = true) => ok('do', { steps }, { completed: true, results: steps.map((s) => (s.read !== undefined || s.call !== undefined
  ? { step: 'read', as: s.as, value: values[s.as], ...(s.call && helpers ? { helper: { name: s.call, sha256: Object.values(STREAM_HELPERS).find((h) => h.name === s.call)?.sha256 } } : {}) }
  : { step: Object.keys(s)[0], ok: true })) });

test('D3: the probe from frames.trial calls grades every recorded canary and clean twin as the driver does', () => {
  for (const s of SCENARIOS) {
    for (const v of load(s).variants) {
      const label = `${s}@${v.at}${v.clean ? ' clean' : ''}`;
      const { receipt, issues } = transientProbeFromOps(dragonOps(trialCalls(v)), { caseId: 'TC', state: label, action: canaryAction(s) });
      assert.deepEqual(issues, [], label);
      receipt.trials.forEach((t, i) => {
        assert.equal(t.markT, v.trials[i].markT, `${label} mark`);
        assert.deepEqual(t.events.map((e) => e.seq), v.trials[i].events.map((e) => e.seq), `${label} events`);
        assert.equal(t.timing.source, 'frames.trial');
      });
      const graded = transientProbeVerdict(JSON.parse(JSON.stringify(receipt)));
      const want = v.clean || CANARY_RULE[s][1] === 'WARN' ? 'PASS' : 'FAIL';
      assert.equal(graded.verdict, want, `${label}: ${graded.issues.join(',')}`);
    }
  }
});

test('D3: sensor events paged at 200 are read whole; a page still with more is a gap; the sample helper must be QA GUI\'s', () => {
  const v = load('T8lint').variants.find((x) => !x.clean);
  const paged = transientProbeFromOps(dragonOps(trialCalls(v, { pageAt: 30 })), { caseId: 'TC', state: 's', action: canaryAction('T8lint') });
  const whole = transientProbeFromOps(dragonOps(trialCalls(v)), { caseId: 'TC', state: 's', action: canaryAction('T8lint') });
  assert.deepEqual(paged.receipt.trials.map((t) => t.events.length), whole.receipt.trials.map((t) => t.events.length));
  assert.equal(paged.receipt.trials[0].sensors.gap, false);
  const all = trialCalls(v, { pageAt: 30 });
  const second = all.findIndex((c, i) => i > 0 && c.method === 'frames.trial');
  const cut = all.filter((c, i) => !(c.method === 'sensors.read' && i < second));
  assert.ok(cut.length < all.length, 'the first trial had pages');
  const short = transientProbeFromOps(dragonOps(cut), { caseId: 'TC', state: 's', action: canaryAction('T8lint') });
  assert.equal(short.receipt.trials[0].sensors.gap, true, 'unread pages are a gap');
  assert.equal(transientProbeVerdict(short.receipt).verdict, 'UNGRADED');
  const forged = transientProbeFromOps(dragonOps(trialCalls(v, { helper: { name: STREAM_HELPERS.sample.name, sha256: 'f'.repeat(64) } })), { caseId: 'TC', state: 's' });
  assert.deepEqual(forged, { receipt: null, issues: [`${DETECTOR_HELPER_MISMATCH}:transient`] });
});

test('D3: the case section asks for framesTrial after stopRecording and sends the sample helper once', () => {
  const text = detectorPromptSection({ caseId: 'TC', detectors: { transient: true } });
  // Fix round 3 (F9): once, by the pack or (a Dragon without "packs", or a refused pack) by the same bodies inline.
  assert.equal((text.match(/helpersDefine \{"pack"/g) || []).length, 1);
  assert.equal((text.match(/helpersDefine \{"helpers"/g) || []).length, 1);
  // Fix round 2 (E9): the bodies come from QA GUI's helper pack (path and hash); the model never types one.
  assert.equal(text.split(STREAM_HELPERS.sample.body.slice(0, 40)).length - 1, 0, 'no helper body in the section');
  assert.match(text, /helpersDefine \{"pack":\{"path":"[^"]+stream-helpers\.pack\.json","sha256":"[0-9a-f]{64}"\}\}/);
  assert.match(text, /AFTER stopRecording/);
  assert.ok(text.length <= 8192, `the transient section is ${text.length} bytes`);
});

// ── D2: helper identity ───────────────────────────────────────────────────────────────────────────────────────
const geometry = (w) => ({ width: w, vw: w, layout: 'header,main', failures: [] });
function sweepCalls({ raw = false, wait = true, helperSha = null } = {}) {
  const coarse = []; for (let w = 320; w < 1440; w += 20) coarse.push(w); coarse.push(1440);
  const m = (w) => (raw ? { read: '__qaSweep.measure()', as: `w:${w}` } : helperCall('sweep', ['measure'], `w:${w}`));
  const steps = [helperCall('sweep', ['found'], 'w:found'), ...coarse.flatMap((w) => [{ viewport: { width: w, height: 800, deviceScaleFactor: 1, mobile: false } }, ...(wait ? [{ wait: 150 }] : []), m(w)]),
    helperCall('sweep', ['bands'], 'w:bands'), { viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false } }, { wait: 150 }, helperCall('sweep', ['viewport'], 'w:restored')];
  const values = { 'w:found': { width: 1280, height: 800, dpr: 1, touch: false }, 'w:bands': { bands: [], rows: [] }, 'w:restored': { width: 1280, height: 800, dpr: 1, touch: false },
    ...Object.fromEntries(coarse.map((w) => [`w:${w}`, geometry(w)])) };
  const call = doCall(steps, values);
  if (helperSha) for (const r of call.result.results) if (r.helper) r.helper.sha256 = helperSha;
  return [call];
}

test('D2 / TQ-6: a sweep whose reads do not prove QA GUI\'s helper is UNGRADED DETECTOR_HELPER_MISMATCH, never a PASS', async () => {
  const good = await widthSweepFromOps(dragonOps(sweepCalls()), { helpers: true });
  assert.deepEqual(good.issues, []);
  assert.equal(good.receipt.bands.length, 0);
  for (const bad of [{ raw: true }, { helperSha: 'e'.repeat(64) }]) {
    const r = await widthSweepFromOps(dragonOps(sweepCalls(bad)), { helpers: true });
    assert.deepEqual(r, { receipt: null, issues: [`${DETECTOR_HELPER_MISMATCH}:width-sweep`] }, JSON.stringify(bad));
  }
  const overlay = overlayCheckFromOps(dragonOps([doCall([{ goto: 'https://t/x' }, { read: 'state()', as: 'o:triggers' }], { 'o:triggers': { triggers: [] } })]), { helpers: true });
  assert.deepEqual(overlay, { receipt: null, issues: [`${DETECTOR_HELPER_MISMATCH}:overlay-check`] });
  const explored = await explorationFromOps(dragonOps([doCall([{ goto: 'https://t/x' }, { read: 'observe()', as: 'x:0' }], { 'x:0': { node: 'route:/x', route: '/x', domHash: 'a'.repeat(64), candidates: [] } })]), { helpers: true });
  assert.deepEqual(explored.issues, [`${DETECTOR_HELPER_MISMATCH}:explore`]);
});

test('QG-9: a width measured without the settle wait after its viewport does not count', async () => {
  const r = await widthSweepFromOps(dragonOps(sweepCalls({ wait: false })), { helpers: true });
  assert.equal(r.receipt, null);
  assert.match(r.issues[0], /^SWEEP_WIDTH_NOT_RECORDED:/);
});

// ── D1: the screen check and its fold ─────────────────────────────────────────────────────────────────────────
test('D1: overlay triggers by priority, at most 3; the rest are NOT_CHECKED cells, reported, not graded', () => {
  const triggers = ['#a', '#b', '#c', '#d', '#e'].map((selector) => ({ selector, label: selector.slice(1) }));
  const { checked, notChecked } = overlayTriggerOrder(triggers, { planned: ['#d'] });
  assert.deepEqual(checked.map((t) => t.selector), ['#d', '#a', '#b']);
  assert.deepEqual(notChecked.map((t) => t.selector), ['#c', '#e']);
  const receipt = { schema: OVERLAY_CHECK_SCHEMA, route: '/x', triggers, overlays: [], notChecked: notChecked.map((trigger) => ({ trigger, reason: 'TRIGGER_CAP' })) };
  const cells = probeCells({ receipt: { url: 'https://t/x', viewport: '1280x800', state: 's' }, caseId: 'TC', state: 's', kind: 'overlay-check', probe: receipt, probeSha256: 'a'.repeat(64) }).cells;
  assert.equal(cells.length, 10);
  assert.ok(cells.every((c) => c.status === 'NOT_CHECKED' && c.reason === 'BUDGET'));
});

test('D1: the fold attaches a screen\'s checks to the first state on its route; ungraded, missing, unavailable and no-route screens', () => {
  const states = [{ state: 'list', url: 'https://t/orders' }, { state: 'detail', url: 'https://t/orders/7' }, { state: 'list2', url: 'https://t/orders?x=1' }];
  const result = { schema: 'qa-gui/screen-check/v1', screenId: 'S1', route: '/orders', status: 'checked', sweep: { schema: 'qa-gui/width-sweep/v1' }, overlay: { schema: OVERLAY_CHECK_SCHEMA }, verdict: 'FAIL', issues: ['SWEEP_BAND_FAIL:x'] };
  const fold = foldScreenChecks({ caseId: 'TC', states, screens: [{ screenId: 'S1', route: '/orders', status: 'checked', result }] });
  assert.deepEqual(fold.states.get('list').probes.map((p) => p.kind), ['width-sweep', 'overlay-check']);
  assert.deepEqual(fold.states.get('list2').probes, [], 'once per case');
  assert.deepEqual(fold.issues, []);
  const ungraded = foldScreenChecks({ caseId: 'TC', states, screens: [{ screenId: 'S1', route: '/orders', status: 'checked', result: { ...result, sweep: null, verdict: 'UNGRADED', issues: ['SWEEP_NOT_RECORDED'] } }] });
  assert.deepEqual(ungraded.issues, ['SCREEN_CHECK_UNGRADED:S1']);
  assert.deepEqual(foldScreenChecks({ caseId: 'TC', states, screens: [{ screenId: 'S1', route: '/orders', status: 'missing' }] }).issues, ['DETECTOR_NOT_RUN:TC:screens:S1']);
  const notes = foldScreenChecks({ caseId: 'TC', states, screens: [{ screenId: 'S2', route: null, status: 'no-route' }, { screenId: 'S3', route: '/orders', status: 'unavailable' }] });
  assert.deepEqual([notes.issues, notes.notes], [[], ['SCREEN_NO_ROUTE:TC', 'SCREEN_CHECK_UNAVAILABLE:S3:DRAGON_R1A_UNAVAILABLE']]);
});

const playwright = await loadPlaywright();
const page = (name) => pathToFileURL(join(ROOT, 'test/fixtures/r1e', name)).href;
// D8: the screen check budget on the fixture pages, measured on the reference executor that follows the recipe: the
// calls of the dispatch (5 to open the tab and prove the build, help and its Grep, helpersDefine, then the recipe).
test('D1/D8: a screen check on the fixture pages finds the band and the overlay defects in at most 25 calls, every answer small', { skip: playwright ? false : PLAYWRIGHT_SKIP }, async () => {
  const browser = await playwright.chromium.launch();
  try {
    for (const [name, want] of [['width-band.html', 'FAIL'], ['overlays.html', 'FAIL'], ['width-band-clean.html', 'PASS']]) {
      const tab = await dragonStandIn({ browser, url: page(name) });
      const swept = await followSweep({ rpc: tab.rpc, url: page(name), chain: true });
      await followOverlays({ rpc: tab.rpc, url: page(name), lead: swept.restore });
      const ops = dragonOps(tab.calls);
      const result = await screenCheckFromOps(ops, { screenId: 'S1', route: new URL(page(name)).pathname, url: page(name) });
      await tab.close();
      assert.equal(result.verdict, want, `${name}: ${result.issues.join(', ')}`);
      const calls = 5 + 2 + tab.calls.length;
      assert.ok(calls <= 25, `${name}: ${calls} calls`);
      // A brief Dragon receipt per read and input step (what Dragon adds to each answer), on top of the stand-in's own.
      // Fix round 2: an answer the recipe reads a value from stays small enough to show inline; a long one (the sweep's
      // widths, the 80 Tab presses) holds nothing the model needs (only w:found, at its start) and may be saved to a file,
      // which Team QA's collect reads.
      const READ = /^(w:refine|w:bands|o:triggers|o:\d+:(kbd|now|backdrop-open|button-open))$/;
      const size = (c) => JSON.stringify(c.result).length + 260 * (c.method === 'do' ? c.result.results.filter((r) => r.step !== 'viewport' && r.step !== 'wait').length : 0);
      const sized = tab.calls.filter((c) => c.method !== 'do' || c.result.results.some((r) => READ.test(String(r.as ?? '')))).map(size);
      assert.ok(Math.max(...sized) <= 24000, `${name}: largest answer read ${Math.max(...sized)} chars`);
      const found = tab.calls.find((c) => c.result?.results?.some((r) => r.as === 'w:found'));
      assert.ok(JSON.stringify(found.result).indexOf('"w:found"') < 1500, 'w:found near the start of its answer');
      console.log(`# D8 screen check ${name}: ${calls} calls, largest answer ~${Math.max(...sized)} chars`);
    }
    const prompt = screenCheckPromptSection({ screenId: 'S1', url: 'https://t/x', route: '/x' });
    console.log(`# D8 screen check prompt: ${prompt.length} chars`);
  } finally { await browser.close(); }
});
