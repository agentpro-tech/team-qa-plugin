// Round G (Team QA dogfood 05/11): screens reached from an entry link (G4) and the probe of a screen's entry (G5).
// G5 canaries are synthetic event streams in Dragon's R1a shapes (docs/r1a-environment-and-sensors.md §4), as
// transient-rules-r1d.test.mjs builds them: a page whose content jumps 60 px down 300 ms after it loads, and its clean
// twin. A recorded canary needs a live Dragon extension and the canary page served to it; none runs here.
import test from 'node:test';
import assert from 'node:assert/strict';

import { STREAM_HELPERS, dragonOps, detectorPromptSection, entryProbeFromOps, entryReached, foldScreenChecks, isEntryTrial,
  screenCheckFromOps, screenCheckPromptSection, transientProbeFromOps } from '../scripts/lib/stream-detectors.mjs';
import { transientProbeVerdict } from '../scripts/lib/transient-probe.mjs';
import { PROBE_KINDS } from '../scripts/lib/probes.mjs';
import { entryTrialCalls } from './support/recipe-calls.mjs';

const SCREEN = 'http://127.0.0.1:5404/product-groups', ENTRY = 'http://127.0.0.1:5404/s/5f1c0a';
const MAIN = 'main>div.page>section#groups';
let clock = Date.parse('2026-11-10T03:00:00.000Z');
const call = (method, params, result, ok = true) => ({ method, params, result, ok, called_at: new Date(clock += 400).toISOString(), at: new Date(clock += 1500).toISOString() });
const entryCalls = ({ jump }) => entryTrialCalls({ url: SCREEN, screenId: 'S4', jump, main: MAIN });

test('G5 canary: content that jumps 60 px down 300 ms after the screen loads FAILs T1 in the entry probe; its clean twin does not', () => {
  const faulty = entryProbeFromOps(dragonOps(entryCalls({ jump: true })), { caseId: 'D-D05', state: 'ideal', url: SCREEN });
  assert.ok(faulty?.receipt, JSON.stringify(faulty?.issues));
  assert.deepEqual(faulty.issues, []);
  assert.equal(faulty.receipt.action.method, 'goto');
  assert.ok(faulty.receipt.action.kinds.includes('route-change'));
  assert.equal(faulty.receipt.rules.T1.verdict, 'FAIL', JSON.stringify(faulty.receipt.rules.T1));
  assert.equal(faulty.receipt.rules.T1.k, 3);
  const graded = transientProbeVerdict(faulty.receipt);
  assert.equal(graded.verdict, 'FAIL', JSON.stringify(graded));
  const clean = entryProbeFromOps(dragonOps(entryCalls({ jump: false })), { caseId: 'D-D05', state: 'ideal', url: SCREEN });
  assert.notEqual(clean.receipt.rules.T1.verdict, 'FAIL', JSON.stringify(clean.receipt.rules.T1));
  assert.notEqual(transientProbeVerdict(clean.receipt).verdict, 'FAIL');
  // The gate grades an `entry` probe with the transient grader.
  assert.equal(PROBE_KINDS.entry.grade, PROBE_KINDS.transient.grade);
});

test('G5: the entry probe takes only its own trials, and the main action\'s probe never takes them', () => {
  const ops = dragonOps(entryCalls({ jump: true }));
  assert.ok(ops.every((op) => op.kind !== 'rpc' || op.method !== 'frames.trial' || isEntryTrial(op)));
  assert.equal(entryProbeFromOps(dragonOps([]), { caseId: 'X', state: 'ideal' }), null);
  // A trial without a goto still needs its trusted-input mark.
  const click = dragonOps(entryCalls({ jump: true }).map((c) => ({ ...c, params: { ...c.params, steps: [{ clickSelector: '#menu-groups' }], sample: { ...c.params.sample, args: ['#menu-groups'] } } })));
  const r = entryProbeFromOps(click, { caseId: 'X', state: 'ideal' });
  assert.ok(r.issues.some((code) => code.startsWith('TRANSIENT_ACTION_NOT_RUN:no-trusted-mark')), r.issues.join(','));
  // transientProbeFromOps is the main action's: a navigation trial there is not run (no trusted mark).
  const main = transientProbeFromOps(ops, { caseId: 'X', state: 'ideal' });
  assert.ok(main.issues.some((code) => code.startsWith('TRANSIENT_ACTION_NOT_RUN')));
});

test('G5 recipe: one E part, three framesTrial of the screen URL from a blank page, labelled entry:<screen>; the section stays small', () => {
  const text = detectorPromptSection({ caseId: 'D-D05', detectors: { transient: { trials: 3, kinds: ['save'], reset: false, fresh: true }, ux: [], explore: null, entry: { screenId: 'S4', url: SCREEN } } });
  assert.match(text, /E \(entry probe, R1d\)/);
  assert.ok(text.includes('"correlationId":"entry:S4"'));
  assert.ok(text.includes(`"steps":[{"goto":"${SCREEN}"}]`));
  assert.ok(text.includes('"setup":[{"goto":"about:blank"}]'));
  assert.ok(Buffer.byteLength(text) < 8 * 1024, `section ${Buffer.byteLength(text)} bytes`);
  const only = detectorPromptSection({ caseId: 'D-C01', detectors: { transient: false, ux: [], explore: null, entry: { screenId: 'S6', url: null } } });
  assert.match(only, /Call help once before any R1a tool/);
  assert.match(only, /"entry": "DRAGON_R1A_UNAVAILABLE"/);
  assert.match(only, /<the screen URL>/);
});

// ── G4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sweep = (args, as) => ({ call: STREAM_HELPERS.sweep.name, args, as });
const doCall = (steps, values) => call('do', { tabId: 7, brief: true, steps }, { completed: true, brief: true, results: steps.map((s) => (s.call
  ? { step: 'read', as: s.as, value: values[s.as], helper: { name: s.call, sha256: Object.values(STREAM_HELPERS).find((h) => h.name === s.call).sha256 } }
  : { step: Object.keys(s)[0], ok: true })) });
const foundAt = (href) => [doCall([sweep(['found'], 'w:found')], { 'w:found': { width: 1280, height: 800, dpr: 1, touch: false, href } })];

test('G4: an entry screen whose sweep landed on the screen is measured there; still at the entry link or a sign-in page it is UNGRADED SCREEN_ENTRY_NOT_REACHED', async () => {
  assert.equal(entryReached(SCREEN, ENTRY), true);
  assert.equal(entryReached(`${ENTRY}/`, ENTRY), false);
  assert.equal(entryReached('http://127.0.0.1:5404/login?next=/product-groups', ENTRY), false);
  assert.equal(entryReached('http://127.0.0.1:5404/#/dang-nhap', ENTRY), false);
  const reached = await screenCheckFromOps(dragonOps(foundAt(SCREEN)), { screenId: 'S4', route: null, url: ENTRY, entry: { url: ENTRY } });
  assert.equal(reached.route, null);
  assert.equal(reached.measuredRoute, '/product-groups');
  assert.equal(reached.entry, ENTRY);
  assert.ok(!reached.issues.some((c) => /SCREEN_ROUTE_MISMATCH|SCREEN_ENTRY_NOT_REACHED/.test(c)), reached.issues.join(','));
  for (const href of [ENTRY, 'http://127.0.0.1:5404/login']) {
    const r = await screenCheckFromOps(dragonOps(foundAt(href)), { screenId: 'S4', route: null, url: ENTRY, entry: { url: ENTRY } });
    assert.equal(r.verdict, 'UNGRADED');
    assert.match(r.issues[0], /^SCREEN_ENTRY_NOT_REACHED:/);
  }
});

test('G4: an entry screen folds into its own case by case id, on the state at the measured route', () => {
  const attempt = { schema: 'qa-gui/screen-check/v1', screenId: 'S4', route: null, measuredRoute: '/product-groups', status: 'checked', verdict: 'UNGRADED', issues: [], sweep: null, overlay: null };
  const states = [{ state: 'login', url: 'http://127.0.0.1:5404/login' }, { state: 'ideal', url: SCREEN }];
  const r = foldScreenChecks({ caseId: 'D-D05', states, screens: [{ screenId: 'S4', route: null, status: 'checked', attempts: [attempt] }] });
  assert.ok(r.states.get('ideal').issues.includes('SCREEN_CHECK_UNGRADED:S4'));
  assert.equal(r.states.get('login').issues.length, 0);
  assert.ok(!r.notes.some((n) => n.startsWith('SCREEN_FOLDED_INTO_FIRST_STATE')));
  const missing = foldScreenChecks({ caseId: 'D-D05', states, screens: [{ screenId: 'S4', route: null, status: 'missing' }] });
  assert.ok(missing.issues.includes('DETECTOR_NOT_RUN:D-D05:screens:S4'));
  const notReached = foldScreenChecks({ caseId: 'D-D05', states, screens: [{ screenId: 'S4', route: null, status: 'checked', attempts: [{ ...attempt, measuredRoute: null, issues: ['SCREEN_ENTRY_NOT_REACHED:/s/5f1c0a'] }] }] });
  assert.ok(notReached.issues.includes('SCREEN_ENTRY_NOT_REACHED:S4'));
});

test('G4 recipe: the case\'s steps up to its first write, opened once; no goto of the entry link after it; the recipe stays under its limit', () => {
  const steps = ['M\u1edf link chia s\u1ebb', '\u0110\u0103ng nh\u1eadp b\u1eb1ng t\u00e0i kho\u1ea3n qa-owner', 'V\u00e0o m\u00e0n h\u00ecnh Nh\u00f3m s\u1ea3n ph\u1ea9m'];
  const text = screenCheckPromptSection({ screenId: 'S4', url: ENTRY, route: null, entry: { url: ENTRY, steps, account: 'qa-owner', caseId: 'D-D05' } });
  assert.match(text, /Reach the screen from the entry link/);
  assert.ok(text.includes(JSON.stringify(steps)));
  assert.match(text, /never click a control that saves, deletes or submits/);
  assert.equal(text.split(`"goto":"${ENTRY}"`).length - 1, 0, 'the entry link is never a goto of the recipe');
  assert.ok(text.includes('{"goto":"<w:found.href>"}'));
  assert.ok(/"steps":\[\{"call"/.test(text), 'the sweep starts on the screen it reached, with no goto');
  const routed = screenCheckPromptSection({ screenId: 'S1', url: SCREEN, route: '/product-groups' });
  assert.ok(text.length < routed.length + 900, `the entry recipe adds ${text.length - routed.length} characters to the routed one (${routed.length})`);
});
