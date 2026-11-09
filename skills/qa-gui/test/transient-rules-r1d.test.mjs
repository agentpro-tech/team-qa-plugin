// Upgrade R1d: T1–T8 on synthetic streams in Dragon's R1a event shapes (docs/r1a-environment-and-sensors.md §4), and
// the confirmation rule (k of n real-speed repeats at the same mark). Recorded streams are in transient-canary-r1d.
import test from 'node:test';
import assert from 'node:assert/strict';

import { T_DEFAULTS, gradeTransientRules, gradeTrial, transientVerdict } from '../scripts/lib/transient-rules.mjs';

const M = 1_800_000_000_000; // the action mark (epoch ms)
const BTN = 'main>form#f>button#save';
const hello = (over = {}) => ({ k: 'hello', t: M - 2000, vw: 800, vh: 600, supported: { 'layout-shift': true }, v2: true, ...over });
const mut = (dt, over = {}) => ({ k: 'mutation', t: M + dt, added: 1, removed: 0, attrs: 0, text: 0, attrNames: [], targets: ['main>ul#list'], ...over });
const vis = (dt, target, over = {}) => ({ k: 'visibility', t: M + dt, target, ratio: 1, intersecting: true, visible: true, rect: { x: 20, y: 300, w: 100, h: 36 }, ...over });
const ls = (dt, sources, hadRecentInput = true) => ({ k: 'layout-shift', t: M + dt, value: 0.05, hadRecentInput, lastInputTime: M, sources });
const input = (dt, type = 'pointerdown', over = {}) => ({ k: 'input', t: M + dt, type, trusted: true, target: BTN, x: 70, y: 318, ...over });
function trial({ events = [], samples = [], network = [], frames = null, kinds = ['save'], conditions = null, to = M + 1000, held, selector = '#save' } = {}) {
  return { markT: M, window: { from: M - 100, to }, conditions, action: { kinds, selector }, events: [hello(), input(0), ...events],
    samples, network, frames, ...(held ? { held } : {}) };
}
const sample = (dt, over = {}) => ({ t: M + dt, vw: 800, vh: 600, sx: 0, sy: 0, overflowX: false, clipped: [], target: { found: true, disabled: true }, busy: 0, ...over });
const marks = (over = () => ({})) => T_DEFAULTS.sampleOffsetsMs.map((d) => sample(d, over(d)));
const rule = (trials, name, schedule) => gradeTransientRules(trials, { schedule })[name];
const three = (make) => [make(0), make(1), make(2)];

test('T1: a control pushed down 60 px after the click is a layout jump; reserved space is silent', () => {
  const jump = () => trial({ events: [mut(300), ls(310, [{ node: BTN, prev: { x: 20, y: 300, w: 100, h: 36 }, cur: { x: 20, y: 360, w: 100, h: 36 } }])] });
  const r = rule(three(jump), 'T1');
  assert.equal(r.verdict, 'FAIL'); assert.equal(r.k, 3); assert.equal(r.n, 3); assert.equal(r.mark, 310);
  assert.equal(rule(three(() => trial({ events: [mut(300)] })), 'T1').verdict, 'PASS');
  // A 2 px nudge, a shift off screen, and an expansion pushing what is below the click are not T1.
  assert.equal(rule(three(() => trial({ events: [mut(300), ls(310, [{ node: BTN, prev: { x: 20, y: 300, w: 100, h: 36 }, cur: { x: 20, y: 302, w: 100, h: 36 } }])] })), 'T1').verdict, 'PASS');
  assert.equal(rule(three(() => trial({ events: [mut(300), ls(310, [{ node: 'p#x', prev: { x: 20, y: 900, w: 100, h: 36 }, cur: { x: 20, y: 960, w: 100, h: 36 } }])] })), 'T1').verdict, 'PASS');
  const expand = () => trial({ kinds: ['disclosure'], events: [mut(50), ls(60, [{ node: 'section#faq>p', prev: { x: 20, y: 400, w: 300, h: 40 }, cur: { x: 20, y: 520, w: 300, h: 40 } }])] });
  assert.equal(rule(three(expand), 'T1').verdict, 'PASS');
  // Nothing changed after the action: the condition is absent, never PASS.
  assert.deepEqual([rule(three(() => trial()), 'T1').verdict, rule(three(() => trial()), 'T1').reason], ['UNGRADED', 'CONDITION_ABSENT']);
  const unsupported = () => ({ ...trial(), events: [hello({ supported: {} }), input(0), mut(10)] });
  assert.equal(rule(three(unsupported), 'T1').reason, 'LAYOUT_SHIFT_UNSUPPORTED');
});

test('dogfood 05/11: the buttons beside a pressed Save sliding 4 px sideways (hadRecentInput) are not a layout jump; a vertical jump still is', () => {
  const GROUP = 'div#radix-:rd:.fixed.left-[50%][role=dialog]>div.shrink-0.border-t>div.flex.flex-col>div.flex.gap-2';
  const sideways = () => trial({ events: [mut(450), { ...ls(473, [{ node: GROUP, prev: { x: 300, y: 300, w: 220, h: 40 }, cur: { x: 304, y: 300, w: 220, h: 40 } }]), hadRecentInput: true, value: 0.0000173 }] });
  assert.equal(rule(three(sideways), 'T1').verdict, 'PASS', JSON.stringify(rule(three(sideways), 'T1')));
  const down = () => trial({ events: [mut(450), { ...ls(473, [{ node: GROUP, prev: { x: 300, y: 300, w: 220, h: 40 }, cur: { x: 300, y: 306, w: 220, h: 40 } }]), hadRecentInput: true, value: 0.0002 }] });
  assert.equal(rule(three(down), 'T1').verdict, 'FAIL');
  const noInput = () => trial({ events: [mut(450), ls(473, [{ node: GROUP, prev: { x: 300, y: 300, w: 220, h: 40 }, cur: { x: 304, y: 300, w: 220, h: 40 } }], false)] });
  assert.equal(rule(three(noInput), 'T1').verdict, 'FAIL', 'without recent input a sideways jump still counts');
});

test('T2: a toast over the Save button for 600 ms is a transient occlusion; a toast in the corner, or 200 ms, is not', () => {
  const TOAST = 'body>div#toast.toast[role=status]';
  const cover = (ms, rect = { x: 0, y: 290, w: 300, h: 60 }) => () => trial({ events: [vis(-1500, BTN), vis(-1500, TOAST, { intersecting: false, ratio: 0, rect: { x: 0, y: 0, w: 0, h: 0 } }),
    mut(300), vis(310, TOAST, { rect }), vis(420, BTN, { visible: overlapRect(rect) ? false : true }), vis(310 + ms, TOAST, { intersecting: false, ratio: 0 }), vis(320 + ms, BTN, { visible: true })], to: M + 1500 });
  const overlapRect = (r) => r.y < 336 && r.y + r.h > 300;
  const r = rule(three(cover(600)), 'T2');
  assert.equal(r.verdict, 'FAIL', JSON.stringify(r)); assert.ok(r.episode.durationMs >= 300);
  assert.equal(rule(three(cover(600, { x: 560, y: 10, w: 220, h: 50 })), 'T2').verdict, 'PASS');
  assert.equal(rule(three(cover(150)), 'T2').verdict, 'PASS', 'the button is hidden for 50 ms, under the 300 ms bound');
  assert.equal(rule(three(() => trial({ events: [vis(-1500, BTN), mut(100)] })), 'T2').reason, 'CONDITION_ABSENT');
  // The settled-state baseline sees only an occlusion still there when the window closes.
  assert.equal(rule(three(cover(600)), 'T2', 'stable').verdict, 'PASS');
  assert.equal(rule(three(cover(5000)), 'T2', 'stable').verdict, 'FAIL');
});

test('T3: an empty state shown for 150 ms then replaced is a wrong-state flash; one that stays is a real state', () => {
  const EMPTY = 'main>ul#list>div.empty-state';
  const flash = (ms, removed = true) => () => trial({ events: [mut(300), vis(305, EMPTY, { rect: { x: 0, y: 100, w: 400, h: 60 } }), ...(removed ? [mut(305 + ms, { removed: 1, added: 3, targets: ['main>ul#list'] })] : [])], to: M + 1200 });
  const r = rule(three(flash(150)), 'T3');
  assert.equal(r.verdict, 'FAIL', JSON.stringify(r)); assert.equal(r.episode.sub, 'state-flash');
  assert.equal(rule(three(flash(600)), 'T3').verdict, 'PASS', 'shown 600 ms: a loading or empty state, not a flash');
  assert.equal(rule(three(flash(0, false)), 'T3').verdict, 'PASS');
  // A skeleton is a busy indicator, never a wrong state.
  assert.equal(rule(three(() => trial({ events: [mut(10), vis(20, 'main>ul#list>div.skeleton'), mut(200, { removed: 1 })] })), 'T3').verdict, 'PASS');
  // A theme flip-flop is a flash only when the frames show the screen return to the exact image before it.
  const index = (hashes) => ({ ok: true, keep: [], index: hashes.map(([dt, hash], i) => ({ seq: i + 1, t: M + dt, len: 1000, hash, dup: false, kept: false })) });
  const theme = (hashes) => () => trial({ events: [mut(200, { targets: ['html'], attrNames: ['class'], added: 0, attrs: 1 }), mut(320, { targets: ['html'], attrNames: ['class'], added: 0, attrs: 1 })],
    frames: index(hashes) });
  assert.equal(rule(three(theme([[-200, 'a'], [210, 'b'], [330, 'a']])), 'T3').verdict, 'FAIL');
  assert.equal(rule(three(theme([[-200, 'a'], [210, 'b'], [330, 'c']])), 'T3').verdict, 'PASS', 'a theme that changed and stayed');
});

test('T4: horizontal overflow in two consecutive samples between two stable states; static overflow is not T4', () => {
  const during = (from, to) => () => trial({ events: [mut(10)], samples: marks((d) => (d >= from && d <= to ? { overflowX: true } : {})) });
  assert.equal(rule(three(during(100, 500)), 'T4').verdict, 'FAIL');
  assert.equal(rule(three(during(250, 250)), 'T4').verdict, 'PASS', 'one sample only');
  assert.equal(rule(three(during(100, 1000)), 'T4').verdict, 'PASS', 'still there in the settled state: a static defect (A6), not T4');
  assert.equal(rule(three(() => trial({ events: [mut(10)], samples: marks((d) => (d === 250 || d === 500 ? { clipped: [{ sel: 'h2#title' }] } : {})) })), 'T4').verdict, 'FAIL');
  assert.equal(rule(three(() => trial({ events: [mut(10)] })), 'T4').reason, 'SAMPLES_MISSING');
});

test('T5: the submit button re-enabled while its POST is pending is a double-click window; disabled until the response is not', () => {
  const POST = (dt) => [{ t: M + dt, method: 'POST', url: 'http://127.0.0.1/api/save', status: 201 }];
  const early = () => trial({ events: [mut(5)], network: POST(900), samples: marks((d) => (d >= 250 ? { target: { found: true, disabled: false } } : {})) });
  const r = rule(three(early), 'T5');
  assert.equal(r.verdict, 'FAIL', JSON.stringify(r));
  const clean = () => trial({ events: [mut(5)], network: POST(900), samples: marks((d) => (d >= 1000 ? { target: { found: true, disabled: false } } : {})) });
  assert.equal(rule(three(clean), 'T5').verdict, 'PASS');
  const busy = () => trial({ events: [mut(5)], network: POST(900), samples: marks(() => ({ target: { found: true, disabled: false }, busy: 1 })) });
  assert.equal(rule(three(busy), 'T5').verdict, 'PASS', 'a busy indicator is shown');
  assert.equal(rule(three(() => trial({ events: [mut(5)], samples: marks() })), 'T5').reason, 'CONDITION_ABSENT', 'no write request');
  assert.equal(rule(three(() => trial({ kinds: ['disclosure'], network: POST(900), samples: marks() })), 'T5').reason, 'CONDITION_ABSENT', 'not a submit');
  assert.equal(rule(three(() => trial({ network: POST(900), samples: marks(() => ({ target: undefined })) })), 'T5').reason, 'TARGET_UNSAMPLED');
  // Dogfood 05/11 (a clean supplier form): the button re-enabled on the response, which Dragon recorded about 35 ms
  // later. A window shorter than t5MinOpenMs (100 ms) is that lag, not a double-click window; a longer one still FAILs.
  const lag = () => trial({ events: [mut(5)], network: POST(1035), to: M + 1100, samples: marks((d) => (d >= 1000 ? { target: { found: true, disabled: false } } : {})) });
  assert.equal(rule(three(lag), 'T5').verdict, 'PASS', JSON.stringify(rule(three(lag), 'T5')));
  const wide = () => trial({ events: [mut(5)], network: POST(1150), to: M + 1200, samples: marks((d) => (d >= 1000 ? { target: { found: true, disabled: false } } : {})) });
  assert.equal(rule(three(wide), 'T5').verdict, 'FAIL', JSON.stringify(rule(three(wide), 'T5')));
});

test('T6: focus dropped to the body after a modal closes, a scroll jump to the top, a size that oscillates', () => {
  const DLG = 'body>div#dlg[role=dialog]';
  const closeTo = (active) => () => trial({ kinds: ['overlay-close'], events: [vis(-1500, DLG, { rect: { x: 100, y: 100, w: 400, h: 300 } }), mut(300, { removed: 1 }), vis(310, DLG, { intersecting: false, ratio: 0 }),
    { k: 'focus', t: M + 305, type: 'lost', target: `${DLG}>button#close`, active, reason: 'removed' }] });
  assert.equal(rule(three(closeTo('html>body')), 'T6').verdict, 'FAIL');
  const back = () => ({ ...closeTo('html>body')(), events: [...closeTo('html>body')().events, { k: 'focus', t: M + 330, type: 'in', target: 'main>button#open', active: 'main>button#open' }] });
  assert.equal(rule(three(back), 'T6').verdict, 'PASS', 'focus returned to the trigger within 100 ms');
  // Chrome may report the removed focused button as a focusout to the body, with no IntersectionObserver report.
  const removed = (dt) => () => trial({ events: [mut(dt, { removed: 1, added: 0, targets: ['html>body'] }), { k: 'focus', t: M + dt - 1, type: 'out', target: 'button#close', active: 'html>body' }] });
  assert.equal(rule(three(removed(100)), 'T6').verdict, 'FAIL');
  const blur = () => trial({ events: [{ k: 'focus', t: M + 2, type: 'out', target: 'input#q', active: 'html>body' }, mut(5, { removed: 1 })] });
  assert.equal(rule(three(blur), 'T6').verdict, 'UNGRADED', 'a click on a non-focusable spot blurs at the click: no close, no condition');
  const scroll = (y) => () => trial({ kinds: ['list-filter'], events: [{ k: 'scroll', t: M - 800, type: 'scrollend', target: 'document', x: 0, y: 1400 }, mut(300, { removed: 20, added: 20 }), { k: 'scroll', t: M + 310, type: 'scroll', target: 'document', x: 0, y }] });
  assert.equal(rule(three(scroll(0)), 'T6').episode.sub, 'scroll-lost');
  assert.equal(rule(three(scroll(1380)), 'T6').verdict, 'PASS');
  const STATUS = 'main>p#status[role=status]';
  const sizes = (hs) => () => trial({ events: [{ k: 'resize', t: M - 900, target: STATUS, w: 80, h: 20 }, mut(100), ...hs.map((w, i) => ({ k: 'resize', t: M + 100 + i * 120, target: STATUS, w, h: 20 }))] });
  assert.equal(rule(three(sizes([120, 80, 120, 80])), 'T6').episode.sub, 'size-oscillation');
  assert.equal(rule(three(sizes([120, 110])), 'T6').verdict, 'PASS', 'Save -> Saving -> Saved changes once each way');
  assert.equal(rule(three(() => trial({ events: [] })), 'T6').reason, 'CONDITION_ABSENT');
});

test('T7: a long frame during an animation is jank, always a warning; no motion means no condition', () => {
  const anim = (dt) => ({ k: 'animation', t: M + dt, phase: 'started', type: 'CSSAnimation', name: 'slide', duration: 600, iterations: 1, tStart: M + dt, target: 'main>div#panel' });
  const jank = () => trial({ events: [mut(200), anim(200), { k: 'loaf', t: M + 350, duration: 160, blockingDuration: 110 }] });
  const r = rule(three(jank), 'T7');
  assert.deepEqual([r.verdict, r.level], ['WARN', 'warn']);
  assert.equal(transientVerdict({ T7: r }), 'PASS', 'a warning never changes the verdict');
  assert.equal(rule(three(() => trial({ events: [mut(200), anim(200), { k: 'loaf', t: M + 350, duration: 60 }] })), 'T7').verdict, 'PASS');
  assert.equal(rule(three(() => trial({ events: [mut(200), { k: 'loaf', t: M + 350, duration: 300 }] })), 'T7').reason, 'CONDITION_ABSENT');
});

test('T8: flashing more than 3 times a second FAILs; a long or layout-property animation only warns', () => {
  const blink = { k: 'animation', t: M + 300, phase: 'created', type: 'CSSAnimation', name: 'blink', duration: 200, iterations: 6, tStart: M + 300, target: 'main>div#banner.promo' };
  const flashing = () => trial({ events: [mut(300), blink], to: M + 1600,
    frames: { ok: true, keep: [], index: Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, t: M + 300 + i * 100, len: 900, hash: i % 2 ? 'b' : 'a', dup: false, kept: false })) } });
  const r = rule(three(flashing), 'T8');
  assert.equal(r.verdict, 'FAIL', JSON.stringify(r)); assert.equal(r.episode.sub, 'flash');
  const height = () => trial({ events: [mut(10), { k: 'animation', t: M + 20, phase: 'started', type: 'CSSTransition', name: 'height', duration: 600, tStart: M + 20, target: 'main>section#more' }],
    frames: { ok: true, keep: [], index: [] } });
  const lint = rule(three(height), 'T8');
  assert.deepEqual([lint.verdict, lint.reason], ['WARN', 'WARNING_ONLY']);
  assert.equal(rule(three(() => trial({ events: [mut(10)], frames: { ok: true, keep: [], index: [] } })), 'T8').reason, 'CONDITION_ABSENT');
  // A loading spinner may loop forever.
  const spin = () => trial({ events: [mut(10), { k: 'animation', t: M + 20, phase: 'created', type: 'CSSAnimation', name: 'spin', duration: 800, iterations: null, target: 'main>div.spinner' }], frames: { ok: true, keep: [], index: [] } });
  assert.equal(rule(three(spin), 'T8').verdict, 'PASS');
  // Without frames the flash cannot be shown: the rule is UNGRADED for the action, never PASS (curator decision 5).
  const blind = () => ({ ...flashing(), frames: null });
  assert.deepEqual([rule(three(blind), 'T8').verdict, rule(three(blind), 'T8').reason], ['UNGRADED', 'FRAMES_MISSING']);
});

test('confirmation: FAIL needs the anomaly again at the same mark in >= 2 of >= 3 real-speed repeats; k of n is reported', () => {
  const at = (dt) => trial({ events: [mut(dt - 10), ls(dt, [{ node: BTN, prev: { x: 20, y: 300, w: 100, h: 36 }, cur: { x: 20, y: 360, w: 100, h: 36 } }])] });
  const clean = () => trial({ events: [mut(300)] });
  assert.deepEqual(pick(rule([at(300)], 'T1')), ['UNGRADED', 'REPEATS_REQUIRED', 1, 1], 'seen once, not repeated');
  assert.deepEqual(pick(rule([at(300), at(310)], 'T1')), ['UNGRADED', 'REPEATS_REQUIRED', 2, 2]);
  assert.deepEqual(pick(rule([at(300), clean(), clean()], 'T1')), ['WARN', 'TRANSIENT_UNCONFIRMED', 1, 3]);
  assert.deepEqual(pick(rule([at(300), clean(), at(320)], 'T1')), ['FAIL', 'CONFIRMED', 2, 3]);
  assert.deepEqual(pick(rule([at(300), at(900), clean()], 'T1')), ['WARN', 'TRANSIENT_UNCONFIRMED', 1, 3], 'another mark is not the same anomaly');
  // A CPU-throttled repeat only shows where to look.
  const slow = (t) => ({ ...t, conditions: { cpu: { rate: 4 }, animation: null } });
  const r = rule([slow(at(300)), clean(), clean(), clean()], 'T1');
  assert.deepEqual([r.verdict, r.reason, r.slowed], ['WARN', 'SLOWED_ONLY', { k: 1, n: 1 }]);
  assert.equal(rule([slow(at(300)), slow(at(300)), slow(at(300))], 'T1').reason, 'REPEATS_REQUIRED');
});
const pick = (r) => [r.verdict, r.reason, r.k, r.n];

test('an action that cannot be repeated (no approved plan for repeats): seen once is a WARN UNCONFIRMED_SINGLE, k=1/1', () => {
  const at = (dt) => trial({ events: [mut(dt - 10), ls(dt, [{ node: BTN, prev: { x: 20, y: 300, w: 100, h: 36 }, cur: { x: 20, y: 360, w: 100, h: 36 } }])] });
  const once = gradeTransientRules([at(300)], { repeatable: false }).T1;
  assert.deepEqual(pick(once), ['WARN', 'UNCONFIRMED_SINGLE', 1, 1]);
  assert.equal(once.mark, 300);
  assert.equal(transientVerdict({ T1: once }), 'PASS', 'a warning: it reports what was seen and does not block a PASS');
  assert.deepEqual(pick(gradeTransientRules([trial({ events: [mut(300)] })], { repeatable: false }).T1), ['PASS', null, 0, 1]);
  // Repeatable actions keep the rule: an unrepeated sighting is UNGRADED, and three repeats still confirm or not.
  assert.deepEqual(pick(gradeTransientRules([at(300)]).T1), ['UNGRADED', 'REPEATS_REQUIRED', 1, 1]);
  assert.deepEqual(pick(gradeTransientRules([at(300), at(310), at(305)], { repeatable: false }).T1), ['FAIL', 'CONFIRMED', 3, 3]);
  // A frame rule without frames around the mark stays UNGRADED either way (curator decision 5).
  const gapped = { ...at(300), frames: { ok: false, index: [] } };
  assert.equal(gradeTransientRules([gapped], { repeatable: false }).T3.reason, 'PRIVACY_GAP');
});

test('a privacy gap around the mark makes the frame rules UNGRADED; the verdict joins FAIL, UNGRADED and PASS', () => {
  const gap = () => trial({ events: [mut(10)], frames: { ok: true, keep: [{ from: M - 100, to: M + 400 }], counts: { privacyUnverified: 1, privacyDropped: 0, truncated: 0 }, index: [{ seq: 1, t: M + 50, len: 1, hash: 'a', dup: false, kept: false }] } });
  // Frames over maxKeep are spread out (truncated), not a privacy drop.
  const spread = () => trial({ events: [mut(10)], frames: { ok: true, keep: [{ from: M - 100, to: M + 400 }], counts: { privacyUnverified: 0, privacyDropped: 0, truncated: 5 }, index: [{ seq: 1, t: M + 50, len: 1, hash: 'a', dup: false, kept: false }] } });
  assert.equal(rule(three(spread), 'T3').verdict, 'PASS');
  assert.deepEqual([rule(three(gap), 'T3').verdict, rule(three(gap), 'T3').reason], ['UNGRADED', 'PRIVACY_GAP']);
  assert.equal(rule(three(gap), 'T1').verdict, 'PASS', 'a sensor rule is not affected');
  const rules = gradeTransientRules(three(gap));
  assert.equal(transientVerdict(rules), 'UNGRADED');
  assert.equal(transientVerdict({ T1: { verdict: 'PASS' }, T2: { verdict: 'UNGRADED', reason: 'CONDITION_ABSENT' } }), 'PASS');
  assert.equal(transientVerdict({ T1: { verdict: 'FAIL' }, T2: { verdict: 'UNGRADED', reason: 'PRIVACY_GAP' } }), 'FAIL');
  assert.deepEqual(Object.keys(gradeTrial(gap())), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
});
