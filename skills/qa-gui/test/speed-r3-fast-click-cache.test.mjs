// Upgrade R3 (speed-ups), part 3: fast-click and the action cache for the Experience Layer. Synthetic Dragon call
// fixtures; never evidence of a product run.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fastClickIssues, fastClickPlan, fastClickSummary, hoverOrDragCalls } from '../scripts/lib/fast-click.mjs';
import {
  ACTION_CACHE_SCHEMA, ACTION_CACHE_TTL_DAYS, actionCacheErrors, emptyActionCache, fingerprintOf, lookupActions, pruneActionCache,
  replayPlan, storeFromPassedRun,
} from '../scripts/lib/action-cache.mjs';

const doCall = (steps, extra = {}) => ({ method: 'do', params: { tabId: 7, steps, ...extra } });

test('fast-click: hover and drag-and-drop calls are found in do steps and in direct methods', () => {
  assert.equal(hoverOrDragCalls([doCall([{ click: 'Save' }])]).length, 0);
  assert.equal(hoverOrDragCalls([doCall([{ hover: '#menu' }])]).length, 1);
  assert.equal(hoverOrDragCalls([doCall([{ drag: { from: '#a', to: '#b' } }])]).length, 1);
  assert.equal(hoverOrDragCalls([{ method: 'trustedHover', params: { selector: '#m' } }, { method: 'dragDrop', params: {} }]).length, 2);
});

test('fast-click: off and shadow change nothing; on allows fast clicks except in a case that checks hover or drag-and-drop', () => {
  const fast = [doCall([{ click: 'Save', fast: true }, { read: 'x', as: 'g0' }])];
  const hoverFast = [doCall([{ hover: '#menu' }, { click: 'Delete', fast: true }])];
  for (const mode of ['off', 'shadow']) {
    assert.deepEqual(fastClickIssues({ calls: hoverFast, mode, caseChecksHoverOrDrag: true }), []);
    assert.equal(fastClickPlan({ mode, caseChecksHoverOrDrag: false }).fast, false);
  }
  assert.deepEqual(fastClickIssues({ calls: fast, mode: 'on', caseChecksHoverOrDrag: false }), []);
  assert.deepEqual(fastClickPlan({ mode: 'on', caseChecksHoverOrDrag: false }), { fast: true, reason: 'POLICY_ON' });
  // The plan declares the case checks hover or drag: no fast click is planned, and one in the stream is refused.
  assert.deepEqual(fastClickPlan({ mode: 'on', caseChecksHoverOrDrag: true }), { fast: false, reason: 'CASE_CHECKS_HOVER_OR_DRAG' });
  assert.deepEqual(fastClickIssues({ calls: fast, mode: 'on', caseChecksHoverOrDrag: true }), ['FAST_CLICK_ON_HOVER_OR_DRAG_CASE:1 fast click(s) in a case that checks hover or drag-and-drop']);
  // The stream shows hover or drag even though the plan did not say so: the same refusal.
  assert.deepEqual(fastClickIssues({ calls: hoverFast, mode: 'on', caseChecksHoverOrDrag: false }), ['FAST_CLICK_ON_HOVER_OR_DRAG_CASE:1 fast click(s) in a case that checks hover or drag-and-drop']);
  // A fast macro (do {fast:true}) counts for each of its click steps; a direct trustedClick too.
  assert.equal(fastClickSummary([doCall([{ click: 'A' }, { click: 'B' }], { fast: true }), { method: 'trustedClick', params: { selector: '#x', fast: true } }]).fast_clicks, 3);
  assert.deepEqual(fastClickSummary(hoverFast), { clicks: 1, fast_clicks: 1, hover_or_drag: 1 });
});

const SIGNALS = { app: 'shop', origin: 'https://app.test', route: '/orders', build: 'build-2', viewport: '1280x800', locale: 'en-US', role: 'clerk' };
const PASS_RUN = { run_id: 'r-1', case_id: 'TC-01', gate_verdict: 'PASS', function_verdict: 'PASS', ui_verdict: 'PASS', receipt_sha256: 'a'.repeat(64) };
const STEPS = [{ click: 'New order', fast: true }, { fill: { selector: '#qty', value: '5' } }, { read: 'return document.title', as: 'title' },
  { assert: { text: 'Saved' } }, { expectNet: { pattern: '/orders', status: 201 } }, { click: 'Save' }];
const NOW = '2026-11-04T03:00:00.000Z';
const day = 24 * 3600 * 1000;

test('action cache: stores only from a passed run, actions only, with a multi-signal fingerprint and a 14-day expiry', () => {
  assert.equal(ACTION_CACHE_TTL_DAYS, 14);
  const { cache, entry, stripped } = storeFromPassedRun({ cache: emptyActionCache(), signals: SIGNALS, to: { state: 'order-saved' }, steps: STEPS, run: PASS_RUN, now: NOW });
  assert.equal(cache.schema, ACTION_CACHE_SCHEMA);
  // Reads, assertions and network expectations are never stored: they always run for real.
  assert.equal(stripped, 3);
  assert.deepEqual(entry.steps.filter((s) => !s.waitFor), [{ click: 'New order', fast: true }, { fill: { selector: '#qty', value: '5' } }, { click: 'Save' }]);
  // Each selector the actions use is a guard the replay waits for first: a changed page stops the replay.
  assert.deepEqual(entry.steps.filter((s) => s.waitFor).map((s) => s.waitFor), [{ text: 'New order', timeoutMs: 5000 }, { selector: '#qty', timeoutMs: 5000 }, { text: 'Save', timeoutMs: 5000 }]);
  // No verdict is ever kept, only where the actions came from.
  assert.equal(JSON.stringify(entry).includes('"verdict"'), false);
  assert.deepEqual(Object.keys(entry.source).sort(), ['case_id', 'receipt_sha256', 'run_id']);
  assert.equal(entry.expires_at, new Date(Date.parse(NOW) + 14 * day).toISOString());
  assert.equal(entry.fingerprint_sha256, fingerprintOf(SIGNALS));
  assert.deepEqual(actionCacheErrors(cache), []);
  // A run that did not pass in every part stores nothing.
  for (const run of [{ ...PASS_RUN, gate_verdict: 'UNGRADED' }, { ...PASS_RUN, ui_verdict: 'FAIL' }, { ...PASS_RUN, function_verdict: 'PASS', gate_verdict: undefined }]) {
    assert.throws(() => storeFromPassedRun({ cache, signals: SIGNALS, to: { state: 'order-saved' }, steps: STEPS, run, now: NOW }), /ACTION_CACHE_SOURCE_NOT_PASS/);
  }
  // Every signal is required.
  assert.throws(() => fingerprintOf({ ...SIGNALS, role: '' }), /ACTION_CACHE_SIGNAL/);
  // A typed secret is never stored.
  assert.throws(() => storeFromPassedRun({ cache, signals: SIGNALS, to: { state: 's' }, steps: [{ fill: { selector: '#password', value: 'x' } }], run: PASS_RUN, now: NOW }), /ACTION_CACHE_SECRET/);
  assert.throws(() => storeFromPassedRun({ cache, signals: SIGNALS, to: { state: 's' }, steps: [{ type: 'hunter2', selector: '#code' }], run: PASS_RUN, now: NOW, secrets: ['hunter2'] }), /ACTION_CACHE_SECRET/);
});

test('action cache: a hit needs every signal equal and an unexpired entry; a replay always adds the sweeps and assertions', () => {
  const { cache } = storeFromPassedRun({ cache: emptyActionCache(), signals: SIGNALS, to: { state: 'order-saved' }, steps: STEPS, run: PASS_RUN, now: NOW });
  assert.equal(lookupActions({ cache, signals: SIGNALS, to: { state: 'order-saved' }, now: NOW }).reason, 'HIT');
  for (const signal of Object.keys(SIGNALS)) {
    const miss = lookupActions({ cache, signals: { ...SIGNALS, [signal]: `${SIGNALS[signal]}-other` }, to: { state: 'order-saved' }, now: NOW });
    assert.deepEqual([miss.hit, miss.reason], [null, 'MISS'], signal);
  }
  assert.equal(lookupActions({ cache, signals: SIGNALS, to: { state: 'other-state' }, now: NOW }).reason, 'MISS');
  const later = new Date(Date.parse(NOW) + 14 * day + 1000).toISOString();
  assert.deepEqual(lookupActions({ cache, signals: SIGNALS, to: { state: 'order-saved' }, now: later }).reason, 'EXPIRED');
  assert.equal(pruneActionCache(cache, later).entries.length, 0);
  const { hit } = lookupActions({ cache, signals: SIGNALS, to: { state: 'order-saved' }, now: NOW });
  const sweeps = [{ read: 'ui-sanity', as: 'g0' }];
  const assertions = [{ assert: { text: 'Saved' } }, { expectNet: { pattern: '/orders', status: 201 } }];
  const plan = replayPlan({ entry: hit, sweeps, assertions });
  assert.deepEqual(plan.steps.slice(-3), [...sweeps, ...assertions]);
  assert.equal(plan.cached_steps, hit.steps.length);
  // A replay without its own assertions or sweeps is refused: the cache never stands in for a check.
  assert.throws(() => replayPlan({ entry: hit, sweeps, assertions: [] }), /ACTION_CACHE_REPLAY_NEEDS_CHECKS/);
  assert.throws(() => replayPlan({ entry: hit, sweeps: [], assertions }), /ACTION_CACHE_REPLAY_NEEDS_CHECKS/);
  // A cache file that carries a verdict, a read or an assertion is refused as a whole.
  const tampered = structuredClone(cache);
  tampered.entries[0].verdict = 'PASS';
  assert.ok(actionCacheErrors(tampered).some((e) => e.startsWith('ACTION_CACHE_VERDICT')));
  const withRead = structuredClone(cache);
  withRead.entries[0].steps.push({ read: 'x', as: 'y' });
  assert.ok(actionCacheErrors(withRead).some((e) => e.startsWith('ACTION_CACHE_STEP')));
});
