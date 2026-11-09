// Integration fixes of the upgrade (R1c, R1d, R1e and R3 together):
// - every click step the R1e/R1d Dragon drivers send carries `fast:false`, unless the R3 fast-click plan allows a fast
//   click for that case (the native route refuses a click without it: NATIVE_GUI_NORMAL_INPUT_REQUIRED);
// - the width sweep puts the tab back at the viewport it found;
// - a key press is the Dragon `do` step `key` (there is no `pressKey` step), and the action cache keeps it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { dragonOverlayDriver } from '../scripts/lib/overlay-check.mjs';
import { dragonExploreDriver } from '../scripts/lib/frontier-explorer.mjs';
import { runTransientProbe } from '../scripts/lib/transient-probe.mjs';
import { fastClickAllowed, withClickSpeed } from '../scripts/lib/fast-click.mjs';
import { dragonGeometryReader } from '../scripts/lib/width-sweep-dragon.mjs';
import { sweepVerdict, sweepWidths } from '../scripts/lib/width-sweep.mjs';
import { lookupActions, storeFromPassedRun } from '../scripts/lib/action-cache.mjs';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const CLICK_KEYS = ['click', 'clickSelector', 'clickXY'];
const clickSteps = (calls) => calls.filter(([method]) => method === 'do').flatMap(([, params]) => params.steps)
  .filter((step) => CLICK_KEYS.some((key) => Object.hasOwn(step, key)));

test('a click step gets fast:false unless the fast-click plan allows it; other steps are left alone', () => {
  assert.deepEqual(withClickSpeed({ clickSelector: '#a' }), { clickSelector: '#a', fast: false });
  assert.deepEqual(withClickSpeed({ clickXY: [1, 2] }, true), { clickXY: [1, 2], fast: true });
  // An explicit fast:true is not honoured without the plan; an explicit fast:false always is.
  assert.deepEqual(withClickSpeed({ click: 'Save', fast: true }), { click: 'Save', fast: false });
  assert.deepEqual(withClickSpeed({ click: 'Save', fast: false }, true), { click: 'Save', fast: false });
  assert.deepEqual(withClickSpeed({ key: 'Escape' }, true), { key: 'Escape' });
  assert.deepEqual(withClickSpeed({ read: 'return 1', as: 'v' }), { read: 'return 1', as: 'v' });
  // The plan: only `fast_click: on`, and never in a case that checks hover or drag-and-drop.
  assert.equal(fastClickAllowed({ policy: null }), false);
  assert.equal(fastClickAllowed({ policy: { flags: { fast_click: 'shadow' } } }), false);
  assert.equal(fastClickAllowed({ policy: { flags: { fast_click: 'on' } } }), true);
  assert.equal(fastClickAllowed({ policy: { flags: { fast_click: 'on' } }, caseChecksHoverOrDrag: true }), false);
});

function recorder(read = () => ({ completed: true, results: [{ step: 'read', as: 'v', value: '{}' }] })) {
  const calls = [];
  const rpc = async (method, params) => { calls.push([method, params]); return method === 'do' && params.steps.some((s) => s.read) ? read(params) : { ok: true, completed: true, results: [] }; };
  return { calls, rpc };
}

test('the overlay driver: every click carries fast:false by default, fast:true only when the plan allows it', async () => {
  for (const [fast, expected] of [[undefined, false], [true, true]]) {
    const { calls, rpc } = recorder();
    const driver = dragonOverlayDriver({ rpc, tabId: 3, ...(fast === undefined ? {} : { fast }) });
    await driver.click('#open');
    await driver.clickAt(4, 5);
    await driver.press('Escape');
    assert.deepEqual(clickSteps(calls), [{ clickSelector: '#open', fast: expected }, { clickXY: [4, 5], fast: expected }]);
    assert.deepEqual(calls[2][1].steps, [{ key: 'Escape' }]);
  }
});

test('the explore driver clicks with fast:false by default', async () => {
  const { calls, rpc } = recorder();
  await dragonExploreDriver({ rpc, tabId: 4, url: 'https://test.example/' }).act({ selector: '#next' });
  assert.deepEqual(clickSteps(calls), [{ clickSelector: '#next', fast: false }]);
  const fast = recorder();
  await dragonExploreDriver({ rpc: fast.rpc, tabId: 4, url: 'https://test.example/', fast: true }).act({ selector: '#next' });
  assert.deepEqual(clickSteps(fast.calls), [{ clickSelector: '#next', fast: true }]);
});

test('the transient probe sends its action click with fast:false unless the plan allows a fast click', async () => {
  for (const [fast, expected] of [[undefined, false], [true, true]]) {
    const calls = [];
    let t = 1_800_000_000_000;
    const rpc = async (method, params) => {
      calls.push([method, params]);
      if (method === 'sensors.start') return { ok: true, startedAt: t - 500, cursor: 0 };
      if (method === 'sensors.read') return { ok: true, events: [], cursor: 0, more: false };
      if (method === 'waitForNetworkIdle') return { ok: true };
      if (method === 'frames.stop') return { ok: true, frames: [], index: [] };
      if (method === 'do') return { completed: true, results: params.steps.filter((s) => s.read).map((s) => ({ step: 'read', as: s.as, value: { t: (t += 10) } })) };
      return { ok: true };
    };
    await runTransientProbe({ rpc, tabId: 5, step: { clickSelector: '#save' }, action: { method: 'click', target: { tag: 'button', label: 'Save' } }, repeats: 1, ...(fast === undefined ? {} : { fast }) });
    assert.deepEqual(clickSteps(calls), [{ clickSelector: '#save', fast: expected }]);
  }
});

// A fake Dragon tab whose viewport follows setViewport / clearViewport, with the geometry read of R1e.
function fakeTab({ natural = { width: 1280, height: 800, dpr: 2, touch: false }, failRead = null } = {}) {
  const calls = [];
  let current = { ...natural };
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'setViewport') { current = { width: params.width, height: params.height, dpr: params.deviceScaleFactor, touch: params.mobile === true }; return { ok: true }; }
    if (method === 'clearViewport') { current = { ...natural }; return { ok: true, cleared: true }; }
    if (method === 'do') {
      const results = params.steps.map((step) => {
        if (!step.read) return { step: 'other', ok: true };
        if (failRead && current.width === failRead) throw new Error('DRAGON_TIMEOUT');
        if (step.as === 'viewport') return { step: 'read', as: 'viewport', value: { width: current.width, height: current.height, dpr: current.dpr, touch: current.touch } };
        return { step: 'read', as: step.as, value: { width: current.width, layout: current.width < 700 ? 'stack' : 'row', failures: [] } };
      });
      return { completed: true, results };
    }
    return { ok: true };
  };
  return { calls, rpc, now: () => current };
}

test('the width sweep puts the tab back at the viewport it found and says so in its receipt', async () => {
  const tab = fakeTab();
  const sweep = await sweepWidths({ reader: dragonGeometryReader({ rpc: tab.rpc, tabId: 7 }), min: 600, max: 800, step: 40 });
  assert.deepEqual(tab.now(), { width: 1280, height: 800, dpr: 2, touch: false });
  assert.deepEqual(sweep.viewport, { found: { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false }, restored: { ok: true, viewport: { width: 1280, height: 800, dpr: 2, touch: false } } });
  assert.deepEqual(tab.calls.filter(([method]) => method === 'setViewport').at(-1)[1], { tabId: 7, width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  assert.equal(sweepVerdict(sweep).verdict, 'PASS');
});

test('the sweep restores the viewport also when a read fails half-way, and a caller can ask for clearViewport', async () => {
  const tab = fakeTab({ failRead: 640 });
  await assert.rejects(sweepWidths({ reader: dragonGeometryReader({ rpc: tab.rpc, tabId: 7 }), min: 600, max: 800, step: 40 }), /DRAGON_TIMEOUT/);
  assert.deepEqual(tab.now(), { width: 1280, height: 800, dpr: 2, touch: false });
  // A tab the case left without an override goes back to none.
  const clear = fakeTab();
  const sweep = await sweepWidths({ reader: dragonGeometryReader({ rpc: clear.rpc, tabId: 7, restore: 'clear' }), min: 600, max: 800, step: 40 });
  assert.equal(clear.calls.at(-2)[0], 'clearViewport');
  assert.equal(sweep.viewport.restored.ok, true);
});

test('a sweep that could not put the viewport back is UNGRADED', () => {
  const receipt = { schema: 'qa-gui/width-sweep/v1', bands: [], rows: [], viewport: { found: null, restored: { ok: false, reason: 'VIEWPORT_UNKNOWN' } } };
  assert.deepEqual(sweepVerdict(receipt), { verdict: 'UNGRADED', issues: ['SWEEP_VIEWPORT_NOT_RESTORED:VIEWPORT_UNKNOWN'] });
  // A receipt without the field (a reader that does not restore, e.g. the Playwright stand-in) is graded as before.
  assert.equal(sweepVerdict({ schema: 'qa-gui/width-sweep/v1', bands: [], rows: [] }).verdict, 'PASS');
});

test('a key press is the do step `key`, and the action cache keeps it with its modifiers', () => {
  const signals = { app: 'shop', origin: 'https://test.example', route: '/orders', build: 'b1', viewport: '1280x800', locale: 'en', role: 'user' };
  const run = { gate_verdict: 'PASS', function_verdict: 'PASS', ui_verdict: 'PASS', run_id: 'r', case_id: 'TC-01', receipt_sha256: 'a'.repeat(64) };
  const { cache } = storeFromPassedRun({ cache: null, signals, to: { state: 'dialog-open' }, run, now: '2026-11-04T00:00:00.000Z',
    steps: [{ clickSelector: '#open', fast: false }, { key: 'Tab', modifiers: ['Shift'] }, { read: 'return 1', as: 'v' }] });
  const { hit } = lookupActions({ cache, signals, to: { state: 'dialog-open' }, now: '2026-11-05T00:00:00.000Z' });
  assert.deepEqual(hit.steps.filter((step) => !step.waitFor), [{ clickSelector: '#open', fast: false }, { key: 'Tab', modifiers: ['Shift'] }]);
  // The executor docs name the `key` step, never a `pressKey` step.
  for (const file of ['SKILL.md', 'references/ux-rules.md']) {
    assert.doesNotMatch(readFileSync(new URL(file, ROOT), 'utf8'), /`pressKey Tab`/, file);
  }
});
