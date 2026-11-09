// Upgrade R1d: the probe around risky actions (when it is on, its window, kept frames, keyframes, receipt and grader),
// the gate wiring (`probes` kind `transient` on a state receipt) and the Dragon driver's call order. Synthetic streams in
// Dragon's R1a shapes; recorded Chromium streams are in transient-canary-r1d.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROBE_PLAN, PROBE_WATCH, TRANSIENT_PROBE_SCHEMA, addedMs, buildTransientProbeReceipt, carryOver, classifyAction, keepRanges,
  runTransientProbe, sampleRead, selectKeyframes, transientProbeVerdict, windowDecision,
} from '../scripts/lib/transient-probe.mjs';
import { nativeGuiPolicyErrors } from '../scripts/lib/native-gui-trajectory.mjs';
import { checkGuiReleaseTruthV2 } from '../scripts/lib/qa-gui-v2.mjs';
import { asReleaseTruthV2, conditions, r1dBoard, resetResult, sha } from './support/r1d-board.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GATE = join(ROOT, 'scripts/qa-gate.mjs');
const CLI = join(ROOT, 'scripts/qa-gui.mjs');
const M = 1_800_000_000_000;
const BTN = 'main>form#f>button#save';
const TOAST = 'body>div#toast.toast[role=status]';

test('the probe is on around risky actions only, chosen by action type and DOM', () => {
  const kinds = (action) => classifyAction(action).kinds;
  const click = (target, page) => ({ method: 'click', target, page });
  assert.deepEqual(kinds(click({ tag: 'button', type: 'submit', label: 'Continue', inForm: true })), ['submit']);
  assert.deepEqual(kinds(click({ tag: 'button', label: 'Save changes' }, { toastRegion: true })), ['save', 'toast']);
  assert.deepEqual(kinds(click({ tag: 'button', label: 'Delete', inList: true })), ['delete', 'list-remove']);
  assert.deepEqual(kinds(click({ tag: 'button', label: 'Copy link' })), ['toast']);
  assert.deepEqual(kinds(click({ tag: 'button', label: 'Add item', inList: true })), ['list-add']);
  assert.deepEqual(kinds(click({ tag: 'th', role: 'columnheader', label: 'Name' })), ['list-sort']);
  assert.deepEqual(kinds({ method: 'type', target: { tag: 'input', type: 'search' } }), ['list-filter']);
  assert.deepEqual(kinds({ method: 'select', target: { tag: 'select', label: 'Status filter', inToolbar: true } }), ['list-filter']);
  assert.deepEqual(kinds(click({ tag: 'a', href: '/orders/2', label: 'Order 2' })), ['route-change']);
  assert.deepEqual(kinds(click({ tag: 'button', label: 'Actions', ariaHaspopup: 'menu' })), ['overlay-open']);
  assert.deepEqual(kinds(click({ tag: 'button', label: 'Close', inDialog: true })), ['overlay-close']);
  assert.deepEqual(kinds({ method: 'key', key: 'Escape', target: { tag: 'div' } }), ['overlay-close']);
  assert.deepEqual(kinds(click({ tag: 'summary', label: 'Shipping' })), ['disclosure']);
  assert.deepEqual(kinds(click({ tag: 'button', role: 'tab', label: 'Billing', ariaSelected: false })), ['disclosure']);
  assert.deepEqual(kinds(click({ tag: 'button', label: 'Dark mode' })), ['theme-locale']);
  assert.deepEqual(kinds({ method: 'select', target: { tag: 'select', label: 'Ng\u00f4n ng\u1eef' } }), ['theme-locale']);
  assert.deepEqual(kinds({ method: 'drag', target: { tag: 'li' } }), ['drag-drop']);
  assert.deepEqual(kinds({ method: 'scroll', target: { tag: 'main' }, page: { infiniteScroll: true } }), ['scroll-load']);
  assert.deepEqual(kinds(click({ tag: 'button', label: 'Load more' })), ['scroll-load']);
  assert.equal(classifyAction({ method: 'type', target: { tag: 'input', type: 'text', label: 'Name' } }).risky, false);
  assert.equal(classifyAction(click({ tag: 'a', href: '#top', label: 'Top' })).risky, false);
});

test('the window records sensors before the action and frames from just before it; the sample read is a declared read', () => {
  assert.deepEqual(PROBE_PLAN.sampleOffsetsMs, [-100, 16, 50, 100, 250, 500, 1000]);
  assert.deepEqual([PROBE_PLAN.windowBeforeMs, PROBE_PLAN.windowAfterMs, PROBE_PLAN.windowMaxMs], [100, 1000, 3000]);
  assert.ok(PROBE_WATCH.length <= 1000, 'Dragon watch selectors are at most 1000 characters');
  assert.ok(PROBE_WATCH.startsWith('button,a[href],input'), 'Dragon\'s default list first');
  const read = sampleRead({ targetSelector: '#save' });
  assert.doesNotThrow(() => new Function(`return ${read}`));
  // The native policy accepts it as a measurement-only read.
  const policy = { schema: 'qa-gui/native-policy/v1', allowed_tools: [{ namespace: '', name: 'mcp__dragon_browser__dragon_rpc' }],
    dragon: { version: '1.6.9-qa.f108af9', sessionId: 's', nonce: 'n', browserInstanceId: 'b', tabId: 1 }, target: { url: 'http://localhost:1', commit: 'a'.repeat(40) },
    capabilities: ['do'], max_calls: 5, helpers: [], commands: [], reads: [read, sampleRead()], behavioral: false };
  assert.deepEqual(nativeGuiPolicyErrors(policy), []);
});

const hello = { k: 'hello', t: M - 3000, vw: 800, vh: 600, supported: { 'layout-shift': true }, v2: true };
const base = (dt) => [hello, { k: 'visibility', t: M - 2900, target: BTN, ratio: 1, intersecting: true, visible: true, rect: { x: 20, y: 300, w: 100, h: 36 } },
  { k: 'visibility', t: M - 2900, target: TOAST, ratio: 0, intersecting: false, visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } },
  { k: 'input', t: M, type: 'pointerdown', trusted: true, target: BTN, x: 70, y: 318 }, ...(dt == null ? [{ k: 'mutation', t: M + 40, added: 1, removed: 0, attrs: 0, text: 0, attrNames: [], targets: ['main'] }] : [
    { k: 'mutation', t: M + dt, added: 1, removed: 0, attrs: 0, text: 0, attrNames: [], targets: ['body'] },
    { k: 'visibility', t: M + dt + 5, target: TOAST, ratio: 1, intersecting: true, visible: true, rect: { x: 0, y: 290, w: 300, h: 60 } },
    { k: 'visibility', t: M + dt + 110, target: BTN, ratio: 1, intersecting: true, visible: false, rect: { x: 20, y: 300, w: 100, h: 36 } },
    { k: 'visibility', t: M + dt + 700, target: TOAST, ratio: 0, intersecting: false, visible: false, rect: { x: 0, y: 290, w: 300, h: 60 } },
    { k: 'visibility', t: M + dt + 800, target: BTN, ratio: 1, intersecting: true, visible: true, rect: { x: 20, y: 300, w: 100, h: 36 } }])];
function trialAt(dt, { to = M + 1000 + (dt != null && dt >= 300 ? 600 : 0), index = 0 } = {}) {
  const frameTimes = [M - 400, M - 50, M + 20, ...(dt == null ? [M + 60] : [M + dt + 10, M + dt + 120, M + dt + 400, M + dt + 720])];
  const kept = frameTimes.map((t, i) => ({ seq: i + 1, t, reason: i === 1 ? 'edge' : 'range', file: `f-${i + 1}.jpg`, sha256: String(i).repeat(64).slice(0, 64) }));
  return {
    index, markT: M, conditions: conditions({ probes: { sensors: true, frames: true } }), window: { from: M - 100, to, extended: to - M > 1000, reason: to - M > 1000 ? 'anomaly-open' : null },
    sensors: { startedAt: M - 3000, gap: false, overflow: 0, pageDropped: 0 }, events: base(dt), network: [],
    samples: [-100, 16, 50, 100, 250, 500, 1000].map((d) => ({ t: M + d, overflowX: false, clipped: [], target: { found: true, disabled: true }, busy: 0 })),
    frames: { ok: true, startedAt: M - 600, guardFrom: M - 500, stoppedAt: to + 5, keep: [], counts: { privacyUnverified: 0, privacyDropped: 0 },
      index: kept.map((f) => ({ seq: f.seq, t: f.t, len: 1000, hash: `h${f.seq}`, dup: false, kept: true })), kept },
    timing: { sensorsStartMs: 12, framesStartMs: 40, framesStopMs: 30, sensorsReadMs: 5, samplesMs: 20, decisionsMs: 4 },
  };
}
const ACTION = { method: 'click', selector: '#save', target: { tag: 'button', label: 'Save', inForm: true } };

test('the window: never closed before +1000 ms nor kept past +3000 ms; extended while the network is busy or an anomaly is open', () => {
  const t = trialAt(300);
  assert.deepEqual(windowDecision({ trial: t, now: M + 800 }), { close: false, reason: null });
  assert.deepEqual(windowDecision({ trial: t, now: M + 1050, networkBusy: true }), { close: false, reason: 'network-busy' });
  assert.deepEqual(windowDecision({ trial: t, now: M + 1050 }), { close: false, reason: 'anomaly-open' }, 'the toast still covers the button');
  assert.deepEqual(windowDecision({ trial: t, now: M + 1250 }), { close: true, reason: null }, 'the toast left at +1000, the button is visible again');
  assert.deepEqual(windowDecision({ trial: t, now: M + 3000, networkBusy: true }), { close: true, reason: 'cap' });
  assert.deepEqual(windowDecision({ trial: trialAt(null), now: M + 1000 }), { close: true, reason: null });
  const overflowing = { ...trialAt(null), samples: [{ t: M + 1000, overflowX: true, clipped: [] }] };
  assert.equal(windowDecision({ trial: overflowing, now: M + 1010 }).reason, 'anomaly-open');
});

test('kept frames: around each anomaly, else around the first and last change; keyframes 3-6 plus the clean frame', () => {
  const t = trialAt(300, { to: M + 1600 });
  const ranges = keepRanges(t);
  assert.ok(ranges.length >= 1 && ranges.every((r) => r.to > r.from));
  assert.ok(ranges.some((r) => r.from <= M + 410 && r.to >= M + 410), JSON.stringify(ranges));
  assert.deepEqual(keepRanges(trialAt(null)), [{ from: M + 24, to: M + 160 }]);
  const k = selectKeyframes(t);
  assert.equal(k.clean.seq, 2, 'the edge frame at the mark');
  assert.ok(k.frames.length >= 3 && k.frames.length <= 6, JSON.stringify(k));
  assert.ok(k.frames.every((f) => f.t > M));
  const none = selectKeyframes(trialAt(null));
  assert.equal(none.frames.length, 2, 'only two frames after the mark exist');
  assert.equal(addedMs({ ...trialAt(null), window: { to: M + 1000 } }), 111 + Math.round(M + 1000 - (M + 40 + 100)));
});

test('the probe receipt: the gate re-runs the rules on its streams, never its stored verdict', () => {
  const fail = buildTransientProbeReceipt({ caseId: 'TC-01', state: 'after-save', action: ACTION, trials: [0, 1, 2].map((index) => trialAt(300, { index })) });
  assert.equal(fail.schema, TRANSIENT_PROBE_SCHEMA);
  assert.deepEqual(fail.action.kinds, ['submit', 'save']);
  assert.equal(fail.rules.T2.verdict, 'FAIL');
  assert.equal(fail.overhead.addedMs.length, 3);
  assert.ok(fail.keyframes.frames.length >= 3);
  const lied = { ...structuredClone(fail), verdict: 'PASS', rules: {} };
  const graded = transientProbeVerdict(lied);
  assert.equal(graded.verdict, 'FAIL');
  assert.ok(graded.issues.some((c) => /^TRANSIENT_T2:occlusion:3\/3@/.test(c)), graded.issues.join(','));
  const clean = buildTransientProbeReceipt({ caseId: 'TC-01', state: 'after-save', action: ACTION, trials: [0, 1, 2].map((index) => trialAt(null, { index })) });
  assert.deepEqual([transientProbeVerdict(clean).verdict, transientProbeVerdict(clean).issues], ['PASS', []]);
  const once = buildTransientProbeReceipt({ caseId: 'TC-01', state: 'after-save', action: ACTION, trials: [trialAt(300)] });
  assert.equal(once.action.repeatable, true, 'repeatable unless the receipt says otherwise');
  assert.equal(transientProbeVerdict(once).verdict, 'UNGRADED', 'seen once and not repeated');
  // No approved plan to repeat the action: the single sighting is a warning finding, the probe does not block a PASS.
  const single = buildTransientProbeReceipt({ caseId: 'TC-01', state: 'after-save', action: ACTION, trials: [trialAt(300)], repeatable: false });
  const graded1 = transientProbeVerdict(single);
  assert.deepEqual([graded1.verdict, graded1.issues], ['PASS', []]);
  assert.ok(graded1.warnings.some((c) => /^TRANSIENT_T2:occlusion:1\/1@\d+ms:UNCONFIRMED_SINGLE$/.test(c)), graded1.warnings.join(','));
  assert.equal(graded1.rules.T2.reason, 'UNCONFIRMED_SINGLE');
  assert.equal(transientProbeVerdict({ ...structuredClone(single), action: { ...single.action, repeatable: 'no' } }).issues[0], 'TRANSIENT_PROBE_INVALID');
  // Structural refusals.
  const mutate = (fn) => { const r = structuredClone(clean); fn(r); return transientProbeVerdict(r); };
  assert.ok(mutate((r) => { r.trials[0].window.to = M + 700; }).issues.some((c) => c.startsWith('TRANSIENT_WINDOW_SHORT')));
  assert.ok(mutate((r) => { r.trials[0].window.to = M + 5000; r.trials[0].window.reason = 'network-busy'; }).issues.some((c) => c.startsWith('TRANSIENT_WINDOW_LONG')));
  assert.ok(mutate((r) => { r.trials[0].window.to = M + 2000; r.trials[0].window.reason = null; }).issues.some((c) => c.startsWith('TRANSIENT_EXTENSION_UNEXPLAINED')));
  assert.ok(mutate((r) => { r.trials[0].sensors.startedAt = M - 20; }).issues.some((c) => c.startsWith('TRANSIENT_SENSORS_LATE')));
  assert.ok(mutate((r) => { r.trials[1].sensors.gap = true; }).issues.some((c) => c.startsWith('TRANSIENT_SENSORS_GAP')));
  assert.ok(mutate((r) => { r.trials[0].frames.guardFrom = M + 10; }).issues.some((c) => c.startsWith('TRANSIENT_FRAMES_LATE')));
  assert.ok(mutate((r) => { r.trials[0].conditions.role = 'evidence'; }).issues.some((c) => c.startsWith('TRANSIENT_EVIDENCE_TAB')));
  assert.ok(mutate((r) => { r.keyframes.frames.push({ seq: 99, t: M + 5 }); }).issues.includes('TRANSIENT_KEYFRAMES_INVALID'));
  assert.deepEqual(transientProbeVerdict({ schema: 'x' }).issues, ['TRANSIENT_PROBE_INVALID']);
  // The VLM grades meaning only (C10, C16) on the keyframes; its FAIL counts.
  assert.equal(mutate((r) => { r.vision = { verdict: 'FAIL', rule: 'C16', frames: [3], note: 'banner over the price' }; }).verdict, 'FAIL');
  assert.equal(mutate((r) => { r.vision = { verdict: 'FAIL', rule: 'T2' }; }).verdict, 'UNGRADED');
});

test('carry-over: a repeat without a reload starts from the last known state of each target', () => {
  const events = [hello, { k: 'visibility', t: M - 10, target: BTN, visible: true, intersecting: true }, { k: 'visibility', t: M - 5, target: BTN, visible: false, intersecting: true },
    { k: 'mutation', t: M - 4 }, { k: 'focus', t: M - 3, type: 'in', target: BTN, active: BTN }];
  assert.deepEqual(carryOver(events, M).map((e) => [e.k, e.t]), [['hello', M - 3000], ['visibility', M - 5], ['focus', M - 3]]);
});

// ── the gate: a state receipt names the probe, its env block and the case's reset ─────────────────────────────────
const gate = (file) => spawnSync(process.execPath, [GATE, file], { cwd: dirname(file), encoding: 'utf8' });
const PROBE = 'evidence/TC-01-after-open.transient.json', RESET = 'evidence/TC-01-env-reset.json';
function probeBoard({ dt = 300, env = true, tamper = null, uiVerdict = 'PASS', status = 'PASS', release = 'GO' } = {}) {
  const probe = buildTransientProbeReceipt({ caseId: 'TC-01', state: 'after-open', action: ACTION, trials: [0, 1, 2].map((index) => trialAt(dt, { index })) });
  const bytes = `${JSON.stringify(probe)}\n`;
  return r1dBoard({
    files: { [PROBE]: bytes, [RESET]: resetResult() },
    receipt: (r) => {
      r.probes = [{ kind: 'transient', path: PROBE, sha256: tamper === 'hash' ? 'f'.repeat(64) : sha(bytes) }];
      if (env) r.env = { conditions: conditions({ probes: { sensors: true, frames: true } }), reset: { evidence_ref: RESET } };
      r.ui.verdict = uiVerdict;
    },
    data: (d) => { Object.assign(d.cases[0], { uiVerdict, status }); d.cases[0].results[0].uiVerdict = uiVerdict; d.release = { verdict: release, risks: release === 'GO' ? [] : ['T2'] }; },
  });
}

test('gate: a confirmed transient finding is a UI FAIL of the state; a clean probe passes; the probe is graded by the gate', () => {
  const ok = gate(probeBoard({ dt: null }).file);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /QA gate: PASS/);
  const claimed = gate(probeBoard().file);
  assert.notEqual(claimed.status, 0);
  assert.match(claimed.stderr, /PROBE:TC-01:after-open:TRANSIENT_T2:occlusion:3\/3@\d+ms/);
  assert.match(claimed.stderr, /ui\.verdict PASS does not match computed FAIL/);
  const honest = gate(probeBoard({ uiVerdict: 'FAIL', status: 'FAIL', release: 'NO-GO' }).file);
  assert.match(honest.stderr, /TRANSIENT_T2:occlusion/);
  assert.doesNotMatch(honest.stderr, /does not match computed/);
  const tampered = gate(probeBoard({ dt: null, tamper: 'hash' }).file);
  assert.match(tampered.stderr, /UNGRADED PROBE:TC-01:after-open:PROBE_HASH_MISMATCH/);
  const noEnv = gate(probeBoard({ dt: null, env: false }).file);
  assert.match(noEnv.stderr, /UNGRADED ENV_BLOCK_REQUIRED:TC-01:after-open/);
});

test('release-truth v2: the same probe verdict joins the state\'s UI verdict', () => {
  const fail = checkGuiReleaseTruthV2(asReleaseTruthV2(probeBoard({ uiVerdict: 'FAIL', status: 'FAIL', release: 'NO-GO' })));
  assert.ok(fail.issues.some((i) => !i.ungraded && /^PROBE:TC-01:after-open:TRANSIENT_T2:occlusion/.test(i.message)), JSON.stringify(fail.issues));
  assert.equal(fail.computed.uiVerdict, 'FAIL');
  const pass = checkGuiReleaseTruthV2(asReleaseTruthV2(probeBoard({ dt: null })));
  assert.deepEqual(pass.issues.filter((i) => /PROBE|TRANSIENT|ENV_/.test(i.message)), []);
  assert.equal(pass.computed.uiVerdict, 'PASS');
});

test('the Dragon driver: sensors before frames before the action; samples at the marks; kept frames by anomaly; repeats', async () => {
  let clock = M - 1000, clickAt = null;
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === 'sensors.start') return { ok: true, startedAt: clock, cursor: 0, streams: { 'layout-shift': 'cdp', animation: 'cdp' } };
    if (method === 'frames.start') { clock += 30; return { ok: true, windowId: 'fw-1', startedAt: clock - 30, guardFrom: clock }; }
    if (method === 'do') {
      const reads = {};
      const results = [];
      for (const step of params.steps) {
        if (step.wait) clock += step.wait;
        if (step.clickSelector) { clock += 10; clickAt = clock; results.push({ step: 'clickSelector', ok: true, receipt: { ts: clock } }); }
        if (step.read) { const v = { t: clock, overflowX: false, clipped: [], target: { found: true, disabled: true }, busy: 0 }; reads[step.as] = v; results.push({ step: 'read', as: step.as, value: v }); }
      }
      return { completed: true, results, reads };
    }
    if (method === 'sensors.read') return { ok: true, events: [{ ...hello, t: clickAt - 900 }, { k: 'input', t: clickAt, type: 'pointerdown', trusted: true, target: BTN, seq: 1 }], cursor: 1, more: false };
    if (method === 'waitForNetworkIdle') { clock += 20; return { ok: true, waitedMs: 0 }; }
    if (method === 'frames.stop') { assert.ok(Array.isArray(params.keep)); assert.equal(params.edges, true); return { ok: true, windowId: 'fw-1', startedAt: M - 300, guardFrom: M - 280, counts: {}, index: [], frames: [] }; }
    if (method === 'getNetwork') return { requests: [{ t: clickAt + 400, method: 'POST', url: 'http://x/api', status: 201 }] };
    if (method === 'env.get') return { ok: true, conditions: conditions({ probes: { sensors: true, frames: false } }), held: [] };
    if (method === 'sensors.stop') return { ok: true };
    throw new Error(method);
  };
  const realNow = () => clock;
  const { classification, trials } = await runTransientProbe({ rpc, tabId: 7, step: { clickSelector: '#save', fast: false }, targetSelector: '#save', action: ACTION, repeats: 3,
    restore: async () => { calls.push('restore'); }, now: realNow });
  assert.deepEqual(classification.kinds, ['submit', 'save']);
  assert.equal(trials.length, 3);
  const first = calls.indexOf.bind(calls);
  assert.ok(first('sensors.start') < first('frames.start') && first('frames.start') < first('do'));
  assert.equal(calls.filter((c) => c === 'restore').length, 2);
  assert.equal(calls.at(-1), 'sensors.stop');
  assert.equal(trials[0].samples.length, 7, 'the pre sample and six after the action');
  assert.equal(trials[2].markT, trials[2].events.find((e) => e.k === 'input').t, 'the trusted input event marks the action');
  assert.deepEqual(trials[2].network, [{ t: trials[2].markT + 400, method: 'POST', url: 'http://x/api', status: 201 }]);
  assert.equal(trials[0].window.extended, false);
  assert.ok(trials[0].window.to - trials[0].markT >= 1000);
});

test('the qa-gui CLI classifies an action and grades a probe receipt', () => {
  const fixture = probeBoard();
  const actionFile = join(fixture.dir, 'action.json');
  writeFileSync(actionFile, JSON.stringify(ACTION));
  let r = spawnSync(process.execPath, [CLI, 'probe', 'classify', '--in', actionFile], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).kinds, ['submit', 'save']);
  r = spawnSync(process.execPath, [CLI, 'probe', 'grade', '--in', join(fixture.dir, PROBE)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'FAIL');
  assert.equal(out.rules.T2.verdict, 'FAIL');
  assert.equal(JSON.parse(readFileSync(join(fixture.dir, PROBE), 'utf8')).schema, TRANSIENT_PROBE_SCHEMA);
});
