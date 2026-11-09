// R1c — UX rules U1–U10: the graders that run in Node (references/ux-rules.md).
// PROVES: the rule registry, its conservative default levels and the pre-registration settings; the paint-order
// graders for U6 and U9 on paintSnapshot outputs recorded from Dragon's env-controller on the fixture screens
// (test/fixtures/ux-rules/recorded); folding rule results into the Gate-0 sweep so findings land in the UI verdict;
// the action rules U1 (sensors.read + env.get), U2 and U3 (env.get) on recordings of the same kind, paired with
// observations shaped like `__uxObserve`; UNGRADED whenever a rule's condition did not occur.
// DOES NOT PROVE: the in-page sweeps (test/ux-rules-dom.test.mjs runs them in Chromium); calibrated thresholds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { UX_RULES, UX_RULE_IDS, foldUx, gradeU1, gradeU2, gradeU3, gradeU6Paint, gradeU9Paint, uxSettings } from '../scripts/lib/ux-rules.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const recorded = (name) => JSON.parse(readFileSync(resolve(ROOT, 'test/fixtures/ux-rules/recorded', name), 'utf8'));

test('the registry lists U1–U10 with a name, a source, a level and thresholds', () => {
  assert.deepEqual(UX_RULE_IDS, ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10']);
  for (const id of UX_RULE_IDS) {
    const rule = UX_RULES[id];
    assert.match(rule.name, /^[a-z]+(-[a-z0-9]+)+$/, id);
    assert.ok(['machine', 'vision'].includes(rule.judge), id);
    assert.ok(['block', 'warn'].includes(rule.level), id);
    assert.equal(typeof rule.thresholds, 'object', id);
    assert.ok(Object.isFrozen(rule) && Object.isFrozen(rule.thresholds), `${id} is frozen`);
  }
  assert.deepEqual(UX_RULE_IDS.filter((id) => UX_RULES[id].judge === 'vision'), ['U7', 'U8', 'U10']);
});

test('conservative defaults: only U3 and U6 block; every other rule warns until pre-registration says otherwise', () => {
  assert.deepEqual(UX_RULE_IDS.filter((id) => UX_RULES[id].level === 'block'), ['U3', 'U6']);
});

test('uxSettings merges a pre-registration block and refuses anything it does not know', () => {
  const defaults = uxSettings();
  assert.equal(defaults.version, 1);
  assert.equal(defaults.levels.U9, 'warn');
  assert.deepEqual(defaults.thresholds.U9, { minCovered: 2 });
  assert.match(defaults.sha256, /^[a-f0-9]{64}$/);
  const prereg = uxSettings({ version: 1, levels: { U9: 'block' }, thresholds: { U9: { minCovered: 3 } } });
  assert.equal(prereg.levels.U9, 'block');
  assert.equal(prereg.thresholds.U9.minCovered, 3);
  assert.equal(prereg.levels.U1, UX_RULES.U1.level);
  assert.notEqual(prereg.sha256, defaults.sha256, 'the digest locks the exact settings');
  assert.equal(uxSettings({ levels: { U9: 'block' }, thresholds: { U9: { minCovered: 3 } } }).sha256, prereg.sha256);
  assert.throws(() => uxSettings({ levels: { U11: 'block' } }), /UX_SETTINGS_UNKNOWN_RULE:U11/);
  assert.throws(() => uxSettings({ levels: { U1: 'error' } }), /UX_SETTINGS_LEVEL:U1/);
  assert.throws(() => uxSettings({ thresholds: { U1: { progressMs: '1s' } } }), /UX_SETTINGS_THRESHOLD:U1\.progressMs/);
  assert.throws(() => uxSettings({ thresholds: { U1: { latencyMs: 5 } } }), /UX_SETTINGS_THRESHOLD:U1\.latencyMs/);
  assert.throws(() => uxSettings({ version: 2 }), /UX_SETTINGS_VERSION/);
  assert.throws(() => uxSettings({ levels: {}, colour: 'red' }), /UX_SETTINGS_UNKNOWN_FIELD:colour/);
});

test('U6 from a recorded paint snapshot: FAIL when all five points of the focused field are painted over', () => {
  const defect = gradeU6Paint(recorded('u6-defect.paint.json').result);
  assert.equal(defect.verdict, 'FAIL');
  assert.equal(defect.id, 'U6');
  assert.equal(defect.level, 'block');
  assert.equal(defect.source, 'paint');
  assert.equal(defect.coveredPoints, 5);
  assert.match(defect.findings[0].detail, /header/);
  const clean = gradeU6Paint(recorded('u6-clean.paint.json').result);
  assert.equal(clean.verdict, 'PASS');
  assert.equal(clean.findings.length, 0);
});

test('U6 from a paint snapshot is UNGRADED when nothing is focused, the read failed, or the element is not in view', () => {
  assert.equal(gradeU6Paint(null).reason, 'NO_SNAPSHOT');
  assert.equal(gradeU6Paint({ ok: false, code: 'PAINT_TARGET_NOT_FOUND' }).reason, 'PAINT_TARGET_NOT_FOUND');
  const snap = recorded('u6-defect.paint.json').result;
  const away = { ...snap, elements: [{ ...snap.elements[0], reasons: ['outside-viewport'], points: [], coveredPoints: undefined }] };
  assert.equal(gradeU6Paint(away).verdict, 'UNGRADED');
  assert.equal(gradeU6Paint(away).reason, 'FOCUS_NOT_IN_VIEW');
});

test('U9 from a recorded paint snapshot: the half-covered button FAILs, the clean twin is silent', () => {
  const defect = gradeU9Paint(recorded('u9-defect.paint.json').result);
  assert.equal(defect.verdict, 'FAIL');
  assert.equal(defect.findings.length, 1);
  assert.equal(defect.findings[0].sel, 'button#checkout');
  assert.match(defect.findings[0].detail, /^2\/5 points painted over by div\.promo/);
  const clean = gradeU9Paint(recorded('u9-clean.paint.json').result);
  assert.equal(clean.verdict, 'PASS');
  assert.equal(clean.checked, 1);
  assert.equal(gradeU9Paint({ ok: true, elements: [] }).reason, 'NO_CONTROLS_IN_VIEW');
  const stricter = gradeU9Paint(recorded('u9-defect.paint.json').result, uxSettings({ thresholds: { U9: { minCovered: 3 } } }));
  assert.equal(stricter.verdict, 'PASS', 'the threshold is a setting');
});

test('foldUx puts rule findings into the sweep it extends, with the level as the severity', () => {
  const sweep = { v: 'ui-sanity/2.0', state: 's', viewport: { w: 800, h: 600 }, scanned: 10, verdict: 'PASS', counts: { high: 0, warn: 0 }, issues: [] };
  const warnU9 = gradeU9Paint(recorded('u9-defect.paint.json').result);
  const folded = foldUx(sweep, [warnU9]);
  assert.equal(sweep.issues.length, 0, 'the input report is not changed');
  assert.equal(folded.verdict, 'PASS', 'a warn-level finding is listed but does not fail the state');
  assert.deepEqual(folded.counts, { high: 0, warn: 1 });
  assert.equal(folded.issues[0].id, 'U9');
  assert.equal(folded.ux.rules.U9.verdict, 'FAIL');
  const blockU6 = gradeU6Paint(recorded('u6-defect.paint.json').result);
  const failed = foldUx(folded, [blockU6]);
  assert.equal(failed.verdict, 'FAIL');
  assert.deepEqual(failed.counts, { high: 1, warn: 1 });
  assert.equal(failed.ux.rules.U9.verdict, 'FAIL', 'earlier folded rules are kept');
});

test('foldUx: a required rule that is UNGRADED or missing keeps the sweep from PASS', () => {
  const sweep = { v: 'a11y-b/1.0', viewport: { w: 800, h: 600 }, verdict: 'PASS', counts: { high: 0, warn: 0 }, issues: [] };
  const ungraded = gradeU6Paint(null);
  assert.equal(foldUx(sweep, [ungraded]).verdict, 'PASS');
  assert.equal(foldUx(sweep, [ungraded], { require: ['U6'] }).verdict, 'UNGRADED');
  assert.equal(foldUx(sweep, [], { require: ['U3'] }).verdict, 'UNGRADED', 'a required rule with no result is UNGRADED');
  assert.equal(foldUx({ ...sweep, verdict: 'FAIL', counts: { high: 1, warn: 0 }, issues: [{ sev: 'high', rule: 'contrast' }] }, [ungraded], { require: ['U6'] }).verdict, 'FAIL', 'FAIL wins');
  assert.throws(() => foldUx(null, []), /UX_FOLD_REPORT_REQUIRED/);
  assert.throws(() => foldUx(sweep, [{ id: 'U6', verdict: 'MAYBE' }]), /UX_FOLD_RESULT_INVALID/);
  assert.throws(() => foldUx(sweep, [], { require: ['U42'] }), /UX_FOLD_UNKNOWN_RULE:U42/);
});

test('the in-page sweep sources stay inside the native GUI read policy', () => {
  // scripts/lib/native-gui-trajectory.mjs refuses a declared read that clicks, dispatches events, fetches,
  // submits, navigates or touches storage; the Gate-0 files are inlined as reads, so they must never do that.
  const forbidden = /(?:\.click\s*\(|dispatchEvent\s*\(|fetch\s*\(|XMLHttpRequest|\.submit\s*\(|location\s*=|\blocalStorage\b|\bsessionStorage\b)/;
  for (const file of ['scripts/ui-sanity.js', 'scripts/a11y-gate0.js']) {
    const source = readFileSync(resolve(ROOT, file), 'utf8');
    assert.doesNotMatch(source, forbidden, file);
  }
});

// ---------- U1 / U2 / U3 on recorded Dragon reads ----------
const obs = (t, { digest = 'd0', forms = [], trigger, live = [], dialogs = [], url = 'http://127.0.0.1:8080/form' } = {}) => ({
  v: 'ux-observe/1', t, url, viewport: { w: 800, h: 600 }, digest: { doc: digest, view: digest, elements: 12 }, forms, trigger,
  busy: { ariaBusy: [], progress: [], spinners: [] }, dialogs, live, undo: [], focus: null,
});
const clickTime = (events) => events.find((e) => e.k === 'input' && e.type === 'click' && e.trusted).t;

test('U1 from recorded sensors: a save held 1.5 s with no change before its result FAILs; the clean twin is silent', () => {
  const defect = recorded('u1-slow-defect.sensors.json');
  const t0 = clickTime(defect.read.events);
  const writes = [{ method: 'POST', url: 'http://127.0.0.1:8080/api/save', status: 200, t: t0 }];
  const failed = gradeU1({ action: { t: t0 }, sensors: defect.read.events, env: defect.envAfterRelease, writes });
  assert.equal(failed.verdict, 'FAIL', JSON.stringify(failed));
  assert.equal(failed.reason, 'NO_PROGRESS_INDICATOR');
  assert.equal(failed.findings.length, 1, 'the late result still counts as feedback for the success check');
  assert.ok(failed.feedbackMs > 1000 && failed.feedbackMs < 2500, `first visible change at +${failed.feedbackMs} ms`);
  assert.ok(failed.pendingMs > 1000, 'the pending time comes from the env.get released:* entry');
  const clean = recorded('u1-clean.sensors.json');
  const c0 = clickTime(clean.read.events);
  const passed = gradeU1({ action: { t: c0 }, sensors: clean.read.events, env: clean.envAfterRelease, writes: [{ ...writes[0], t: c0 }] });
  assert.equal(passed.verdict, 'PASS', JSON.stringify(passed));
  assert.ok(passed.feedbackMs >= 0 && passed.feedbackMs < 100, `busy state at +${passed.feedbackMs} ms`);
});

test('U1 counts only visible mutations as feedback: a data-* attribute after a write is no feedback', () => {
  const t0 = 1_000_000;
  const events = [
    { seq: 1, t: t0, k: 'input', type: 'click', trusted: true, target: 'button#save' },
    { seq: 2, t: t0 + 40, k: 'mutation', added: 0, removed: 0, attrs: 1, text: 0, attrNames: ['data-last-save'], targets: ['body'] },
  ];
  const writes = [{ method: 'POST', url: 'http://127.0.0.1:8080/api/save', status: 200, t: t0 }];
  const result = gradeU1({ action: { t: t0 }, sensors: events, writes });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.reason, 'NO_VISIBLE_CHANGE');
  const shown = gradeU1({ action: { t: t0 }, sensors: [...events, { seq: 3, t: t0 + 60, k: 'mutation', added: 1, removed: 0, attrs: 0, text: 0, attrNames: [], targets: ['p#msg'] }], writes });
  assert.equal(shown.verdict, 'PASS');
});

test('U1 is UNGRADED without an action, without a write or a wait, or without evidence for the window it must judge', () => {
  const t0 = 2_000_000;
  const writes = [{ method: 'POST', url: 'http://127.0.0.1:8080/api/save', status: 201, t: t0 }];
  assert.equal(gradeU1({ writes }).reason, 'NO_ACTION');
  assert.equal(gradeU1({ action: { t: t0 }, before: obs(t0 - 5), after: obs(t0 + 500), writes: [{ ...writes[0], method: 'GET' }] }).reason, 'NO_WRITE_OR_WAIT');
  assert.equal(gradeU1({ action: { t: t0 }, before: obs(t0 - 5), writes }).reason, 'NO_AFTER_EVIDENCE');
  assert.equal(gradeU1({ action: { t: t0 }, before: obs(t0 - 5), after: obs(t0 + 3000, { digest: 'd1' }), pendingUntil: t0 + 2500, writes }).reason, 'NO_DURING_EVIDENCE');
  const late = gradeU1({ action: { t: t0 }, before: obs(t0 - 5), during: obs(t0 + 400), after: obs(t0 + 3000, { digest: 'd1' }), pendingUntil: t0 + 2500, writes });
  assert.equal(late.reason, 'NO_DURING_EVIDENCE', 'an observation before the progress mark cannot judge it');
  const ok = gradeU1({ action: { t: t0 }, before: obs(t0 - 5), during: obs(t0 + 1200, { digest: 'busy' }), after: obs(t0 + 3000, { digest: 'd1' }), pendingUntil: t0 + 2500, writes });
  assert.equal(ok.verdict, 'PASS');
  const navigated = gradeU1({ action: { t: t0 }, before: obs(t0 - 5), after: obs(t0 + 400, { url: 'http://127.0.0.1:8080/done' }), writes });
  assert.equal(navigated.verdict, 'PASS', 'a route change is feedback');
  const custom = uxSettings({ thresholds: { U1: { progressMs: 3000 } } });
  assert.equal(gradeU1({ action: { t: t0 }, before: obs(t0 - 5), after: obs(t0 + 3000, { digest: 'd1' }), pendingUntil: t0 + 2500, writes }, custom).verdict, 'PASS', 'progressMs is a setting');
});

const trigger = (over = {}) => ({ sel: 'button#submit', found: true, text: 'Place order', disabled: false, ariaDisabled: false, inert: false, pointerEventsNone: false, covered: false, visible: true, ariaBusy: false, spinner: false, formBusy: false, ...over });

test('U2 from recorded env.get: a second click that sends a second held order FAILs (DUPLICATE_REQUEST)', () => {
  const defect = recorded('u2-defect.env.json');
  const t0 = defect.heldAfterFirstClick.requests[0].t - 5;
  const before = obs(t0 - 50, { trigger: trigger() });
  const first = gradeU2({ action: { t: t0 }, before, during: obs(t0 + 300, { trigger: trigger() }), env: defect.heldAfterFirstClick, ruleId: 'orders' });
  assert.equal(first.verdict, 'FAIL');
  assert.equal(first.reason, 'STILL_ACTIONABLE');
  const second = gradeU2({ action: { t: t0 }, before, during: obs(t0 + 600, { trigger: trigger() }), env: defect.afterSecondClick, ruleId: 'orders' });
  assert.equal(second.reason, 'DUPLICATE_REQUEST');
  assert.equal(second.sent, 2);
  assert.match(second.findings[0].detail, /2 POST requests/);
});

test('U2 from recorded env.get: the clean twin (disabled, one request) is silent; the read alone never passes it', () => {
  const clean = recorded('u2-clean.env.json');
  const t0 = clean.afterSecondClick.requests[0].t - 5;
  const before = obs(t0 - 50, { trigger: trigger() });
  const busy = trigger({ disabled: true, ariaBusy: true, text: 'Placing order…' });
  const passed = gradeU2({ action: { t: t0 }, before, during: obs(t0 + 300, { trigger: busy }), env: clean.afterSecondClick, ruleId: 'orders' });
  assert.equal(passed.verdict, 'PASS', JSON.stringify(passed));
  assert.equal(passed.sent, 1);
  const relabelled = gradeU2({ action: { t: t0 }, before, during: obs(t0 + 300, { trigger: trigger({ text: 'Placing order…' }) }), env: clean.afterSecondClick, ruleId: 'orders' });
  assert.equal(relabelled.verdict, 'PASS', 'a busy label on the button is a busy state');
  const open = gradeU2({ action: { t: t0 }, before, during: obs(t0 + 300, { trigger: trigger() }), env: clean.afterSecondClick, ruleId: 'orders' });
  assert.equal(open.verdict, 'FAIL', 'one request so far proves nothing when the button is still open');
  assert.equal(gradeU2({ action: { t: t0 }, during: obs(t0 + 300, { trigger: trigger() }), env: { ...clean.afterSecondClick, held: [] }, ruleId: 'orders' }).reason, 'NO_PENDING_REQUEST');
  assert.equal(gradeU2({ action: { t: t0 }, during: obs(t0 + 300), env: clean.afterSecondClick }).reason, 'NO_OBSERVATION');
  assert.equal(gradeU2({ action: { t: t0 }, during: obs(t0 + 300, { trigger: { sel: '#nope', found: false } }), env: clean.afterSecondClick }).reason, 'TRIGGER_NOT_FOUND');
  assert.equal(gradeU2({ action: { t: t0 }, during: obs(t0 + 300, { trigger: trigger() }) }).reason, 'NO_ENV_READ');
});

const field = (key, filled, hash, sel = `input#${key}`) => ({ key, sel, type: 'text', filled, len: filled ? 4 : 0, hash: filled ? hash : '' });
const contactForm = (values) => [{ key: 'f', sel: 'form#f', fields: [field('name', !!values.name, values.name), field('email', !!values.email, values.email), field('message', !!values.message, values.message, 'textarea#message')] }];

test('U3 from recorded env.get: a forced 500 that empties the form FAILs and blocks by default', () => {
  const env = recorded('u3-defect.env.json').afterSubmit;
  const before = obs(1, { forms: contactForm({ name: 'aa11', email: 'bb22', message: 'cc33' }) });
  const result = gradeU3({ before, after: obs(2, { forms: contactForm({}) }), env });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.level, 'block');
  assert.equal(result.findings.length, 3);
  assert.match(result.errorSeen, /responded:500/);
  const folded = foldUx({ v: 'ui-sanity/2.0', verdict: 'PASS', counts: { high: 0, warn: 0 }, issues: [] }, [result], { require: ['U3'] });
  assert.equal(folded.verdict, 'FAIL');
  assert.equal(folded.counts.high, 3);
});

test('U3 from recorded env.get: kept values are silent; no error or no input is UNGRADED; a vanished form FAILs', () => {
  const env = recorded('u3-clean.env.json').afterSubmit;
  const typed = obs(1, { forms: contactForm({ name: 'aa11', email: 'bb22', message: 'cc33' }) });
  assert.equal(gradeU3({ before: typed, after: obs(2, { forms: contactForm({ name: 'aa11', email: 'bb22', message: 'cc33' }) }), env }).verdict, 'PASS');
  assert.equal(gradeU3({ before: typed, after: obs(2, { forms: [] }), env }).verdict, 'FAIL', 'a form that is gone lost its data');
  assert.equal(gradeU3({ before: typed, after: typed, env: recorded('u2-clean.env.json').afterSecondClick }).reason, 'NO_ERROR');
  assert.equal(gradeU3({ before: obs(1, { forms: contactForm({}) }), after: obs(2, { forms: contactForm({}) }), env }).reason, 'NO_INPUT');
  assert.equal(gradeU3({ before: typed, env }).reason, 'NO_OBSERVATION');
  const failedNetwork = { ok: true, held: [], requests: [{ t: 5, ruleId: 'c', action: 'fail', url: 'http://127.0.0.1:8080/api/contact', method: 'POST', outcome: 'failed:TimedOut' }] };
  assert.equal(gradeU3({ before: typed, after: obs(2, { forms: contactForm({}) }), env: failedNetwork }).verdict, 'FAIL', 'a failed request is an error too');
  assert.equal(gradeU3({ before: typed, after: obs(2, { forms: contactForm({}) }), writes: [{ method: 'POST', url: 'u', status: 503, t: 5 }] }).verdict, 'FAIL', 'a 5xx from the network log is an error');
});

// ---------- the executor's CLI ----------
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CLI = resolve(ROOT, 'scripts/ux-grade.mjs');
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('ux-grade grades one rule from a saved JSON input and folds it into the state sweep', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'ux-grade-'));
  const env = recorded('u3-defect.env.json').afterSubmit;
  const input = resolve(dir, 'u3.json');
  writeFileSync(input, JSON.stringify({ before: obs(1, { forms: contactForm({ name: 'aa11', email: 'bb22', message: 'cc33' }) }), after: obs(2, { forms: contactForm({}) }), env }));
  const graded = cli(['--rule', 'U3', '--input', input]);
  assert.equal(graded.status, 0, graded.stderr);
  assert.equal(JSON.parse(graded.stdout).verdict, 'FAIL');
  const sweep = resolve(dir, 'sweep.json');
  writeFileSync(sweep, JSON.stringify({ v: 'ui-sanity/2.0', verdict: 'PASS', counts: { high: 0, warn: 0 }, issues: [] }));
  const folded = cli(['--rule', 'U3', '--input', input, '--fold', sweep, '--require', 'U3']);
  assert.equal(folded.status, 0, folded.stderr);
  const report = JSON.parse(folded.stdout);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.ux.rules.U3.verdict, 'FAIL');
  const paint = resolve(dir, 'paint.json');
  writeFileSync(paint, JSON.stringify(recorded('u9-defect.paint.json').result));
  const settings = resolve(dir, 'prereg.json');
  writeFileSync(settings, JSON.stringify({ version: 1, levels: { U9: 'block' } }));
  const u9 = JSON.parse(cli(['--rule', 'U9', '--input', paint, '--settings', settings]).stdout);
  assert.equal(u9.level, 'block', 'the pre-registered level is applied');
});

test('ux-grade refuses an unknown rule, unreadable input or invalid settings with exit 2', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'ux-grade-'));
  const input = resolve(dir, 'in.json');
  writeFileSync(input, '{}');
  assert.equal(cli(['--rule', 'U42', '--input', input]).status, 2);
  assert.equal(cli(['--rule', 'U3', '--input', resolve(dir, 'missing.json')]).status, 2);
  const bad = resolve(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ levels: { U3: 'maybe' } }));
  const refused = cli(['--rule', 'U3', '--input', input, '--settings', bad]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /UX_SETTINGS_LEVEL:U3/);
  const ungraded = cli(['--rule', 'U3', '--input', input]);
  assert.equal(ungraded.status, 0);
  assert.equal(JSON.parse(ungraded.stdout).verdict, 'UNGRADED');
});

// ---------- U7 / U8 / U10: vision rules (prompt + structured output) ----------
// The outputs below are synthetic structured answers, written to exercise the grader; a vision model's judgement is
// not tested here (it is calibrated later on dev data).
import { UX_VISION_SCHEMA, gradeUxVision, uxDestructiveContext, uxVisionRequest } from '../scripts/lib/ux-vision.mjs';

const IMAGE = { path: 'qa-evidence/app/round-1/800x600/empty-orders.png', width: 800, height: 600 };
const answer = (rule, over = {}) => ({ rule, applies: true, verdict: 'PASS', confidence: 0.9, evidence: { region: { x: 20, y: 80, w: 560, h: 120 }, quote: '' }, reason: 'r', ...over });
const output = (...rules) => ({ schema: 'qa-gui/ux-vision/v1', rules });
const u7 = (over) => answer('U7', { explains: true, offersAction: true, ...over });
const u8 = (over) => answer('U8', { confirmation: true, undo: false, ...over });
const u10 = (over) => answer('U10', { clipped: false, ...over });

test('uxVisionRequest builds one prompt and a closed output schema for the rules a state needs', () => {
  const request = uxVisionRequest({ rules: ['U7', 'U8'], state: 'empty-orders', image: IMAGE, viewport: { w: 800, h: 600 },
    context: { U7: { forcedEmpty: true }, U8: { action: { label: 'Delete', selector: 'button.delete' } } } });
  assert.equal(request.schema, 'qa-gui/ux-vision-request/v1');
  assert.deepEqual(request.rules, ['U7', 'U8']);
  assert.match(request.prompt, /U7 empty state/);
  assert.match(request.prompt, /U8 destructive action/);
  assert.doesNotMatch(request.prompt, /U10/);
  assert.match(request.prompt, /"Delete"/);
  assert.match(request.prompt, /forced an empty response/);
  assert.match(request.prompt, /JSON only/);
  assert.deepEqual(request.outputSchema, UX_VISION_SCHEMA);
  assert.equal(UX_VISION_SCHEMA.properties.rules.items.additionalProperties, false);
  assert.throws(() => uxVisionRequest({ rules: ['U9'], image: IMAGE }), /UX_VISION_RULE:U9/);
  assert.throws(() => uxVisionRequest({ rules: ['U7'], image: { path: 'x.png' } }), /UX_VISION_IMAGE/);
});

test('U7 FAILs on an empty state that neither explains nor offers an action; the clean twin is silent', () => {
  const request = uxVisionRequest({ rules: ['U7'], state: 'orders-empty', image: IMAGE, context: { U7: { forcedEmpty: true } } });
  const failed = gradeUxVision(output(u7({ verdict: 'FAIL', explains: false, offersAction: false })), request).U7;
  assert.equal(failed.verdict, 'FAIL');
  assert.equal(failed.source, 'vision');
  assert.deepEqual(failed.findings[0].region, { x: 20, y: 80, w: 560, h: 120 });
  assert.equal(gradeUxVision(output(u7()), request).U7.verdict, 'PASS');
  assert.equal(gradeUxVision(output(u7({ offersAction: false })), request).U7.verdict, 'PASS', 'an explanation alone passes by default');
  const strict = uxSettings({ thresholds: { U7: { requireAction: true } } });
  assert.equal(gradeUxVision(output(u7({ offersAction: false, verdict: 'FAIL' })), request, strict).U7.verdict, 'FAIL', 'requireAction is a setting');
});

test('U8 FAILs when the destructive action ran with no confirmation and no undo; the clean twin is silent', () => {
  const request = uxVisionRequest({ rules: ['U8'], state: 'after-delete', image: IMAGE, context: { U8: { action: { label: 'Delete' }, dialogOpened: false, undoOffered: false } } });
  assert.equal(gradeUxVision(output(u8({ verdict: 'FAIL', confirmation: false, undo: false })), request).U8.verdict, 'FAIL');
  assert.equal(gradeUxVision(output(u8()), request).U8.verdict, 'PASS');
  assert.equal(gradeUxVision(output(u8({ confirmation: false, undo: true })), request).U8.verdict, 'PASS', 'an undo is a guard');
});

test('U8: a native confirm (invisible in screenshots) passes from the Dragon dialog record; machine and vision disagreeing is UNGRADED', () => {
  const native = uxVisionRequest({ rules: ['U8'], state: 'after-delete', image: IMAGE, context: { U8: { action: { label: 'Delete' }, nativeConfirm: true } } });
  const passed = gradeUxVision(null, native).U8;
  assert.equal(passed.verdict, 'PASS');
  assert.equal(passed.source, 'observe');
  const guarded = uxVisionRequest({ rules: ['U8'], state: 'after-delete', image: IMAGE, context: { U8: { action: { label: 'Delete' }, dialogOpened: true } } });
  const disputed = gradeUxVision(output(u8({ verdict: 'FAIL', confirmation: false })), guarded).U8;
  assert.equal(disputed.verdict, 'UNGRADED');
  assert.equal(disputed.reason, 'MACHINE_VISION_DISAGREE');
});

test('U10 FAILs on clipped diacritics; a machine-measured clip that vision calls clean is UNGRADED, never PASS', () => {
  const clipped = [{ sel: 'span#tag', text: 'DANG', rect: { x: 76, y: 92, w: 196, h: 16 }, fontPx: 20, lineHeightPx: 16, clipBy: 'self', overflowTopPx: 5, overflowBottomPx: 4, clipped: true }];
  const request = uxVisionRequest({ rules: ['U10'], state: 'customer', image: IMAGE, viewport: { w: 800, h: 600 }, context: { U10: { candidates: clipped } } });
  assert.deepEqual(request.regions.U10[0], { x: 76, y: 92, w: 196, h: 16, sel: 'span#tag', clipped: true });
  assert.match(request.prompt, /span#tag/);
  assert.equal(gradeUxVision(output(u10({ verdict: 'FAIL', clipped: true })), request).U10.verdict, 'FAIL');
  const disputed = gradeUxVision(output(u10()), request).U10;
  assert.equal(disputed.verdict, 'UNGRADED');
  assert.equal(disputed.reason, 'MACHINE_VISION_DISAGREE');
  const clean = uxVisionRequest({ rules: ['U10'], state: 'customer', image: IMAGE, context: { U10: { candidates: [{ ...clipped[0], overflowTopPx: -6, overflowBottomPx: -8, clipped: false }] } } });
  assert.equal(gradeUxVision(output(u10()), clean).U10.verdict, 'PASS');
  const none = uxVisionRequest({ rules: ['U10'], state: 'plain', image: IMAGE, context: { U10: { candidates: [] } } });
  assert.equal(gradeUxVision(null, none).U10.reason, 'NO_DIACRITIC_TEXT', 'no Vietnamese text: nothing to ask');
});

test('vision outputs fail closed: not applicable, low confidence, inconsistent, no evidence, unknown fields, two judges disagreeing', () => {
  const request = uxVisionRequest({ rules: ['U7'], state: 's', image: IMAGE });
  const reason = (out) => gradeUxVision(out, request).U7.reason;
  assert.equal(reason(output(u7({ applies: false, verdict: 'UNGRADED' }))), 'NOT_APPLICABLE');
  assert.equal(reason(output(u7({ confidence: 0.4 }))), 'LOW_CONFIDENCE');
  assert.equal(reason(output(u7({ verdict: 'FAIL' }))), 'INCONSISTENT_OUTPUT', 'the verdict must follow the answers');
  assert.equal(reason(output(u7({ verdict: 'FAIL', explains: false, offersAction: false, evidence: { region: { x: 700, y: 500, w: 400, h: 400 }, quote: '' } }))), 'NO_EVIDENCE');
  assert.equal(reason(output(u7({ mood: 'happy' }))), 'OUTPUT_INVALID');
  assert.equal(reason({ schema: 'other', rules: [] }), 'OUTPUT_INVALID');
  assert.equal(reason(output()), 'NO_VISION_OUTPUT');
  assert.equal(reason(null), 'NO_VISION_OUTPUT');
  assert.equal(reason([output(u7()), output(u7({ verdict: 'FAIL', explains: false, offersAction: false }))]), 'JUDGES_DISAGREE');
  assert.equal(gradeUxVision([output(u7()), output(u7())], request).U7.verdict, 'PASS', 'two agreeing judges');
});

test('uxDestructiveContext reads the guard a destructive action showed from two observations and the Dragon dialog record', () => {
  const before = obs(1, { dialogs: [] });
  const after = { ...obs(2, { dialogs: ['div.dialog'] }), undo: [] };
  assert.deepEqual(uxDestructiveContext({ before, after, action: { label: 'Delete' } }), { action: { label: 'Delete' }, dialogOpened: true, undoOffered: false, nativeConfirm: false });
  const undone = { ...obs(2), undo: [{ sel: 'button.undo', text: 'Undo' }] };
  assert.equal(uxDestructiveContext({ before, after: undone, action: { label: 'Delete' } }).undoOffered, true);
  assert.equal(uxDestructiveContext({ before, after: obs(2), action: { label: 'Delete' }, dialogHandled: { type: 'confirm', accepted: true } }).nativeConfirm, true);
});

test('ux-grade builds a vision request and grades a vision answer', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'ux-grade-'));
  const ctx = resolve(dir, 'ctx.json');
  writeFileSync(ctx, JSON.stringify({ rules: ['U7'], state: 'empty', image: IMAGE, context: { U7: { forcedEmpty: true } } }));
  const built = cli(['--vision-request', ctx]);
  assert.equal(built.status, 0, built.stderr);
  const request = JSON.parse(built.stdout);
  assert.match(request.prompt, /U7 empty state/);
  const input = resolve(dir, 'in.json');
  writeFileSync(input, JSON.stringify({ request, outputs: output(u7({ verdict: 'FAIL', explains: false, offersAction: false })) }));
  const graded = cli(['--rule', 'U7', '--input', input]);
  assert.equal(graded.status, 0, graded.stderr);
  assert.equal(JSON.parse(graded.stdout).verdict, 'FAIL');
});

// ---------- the documentation states the registry ----------
test('SKILL.md Layer U and references/ux-rules.md state every rule with its registry level and thresholds', () => {
  const skill = readFileSync(resolve(ROOT, 'SKILL.md'), 'utf8');
  const reference = readFileSync(resolve(ROOT, 'references/ux-rules.md'), 'utf8');
  assert.match(skill, /^## Layer U — UX rules U1–U10/m);
  for (const id of UX_RULE_IDS) {
    const { name, level, thresholds } = UX_RULES[id];
    const row = skill.split('\n').find((line) => line.startsWith(`| ${id} | \`${name}\` |`));
    assert.ok(row, `SKILL.md has a Layer U row for ${id}`);
    assert.match(row, new RegExp(`\\| ${level} \\|`), `${id} row states the default level ${level}`);
    const section = reference.split(/^### /m).find((part) => part.startsWith(`${id} \`${name}\``));
    assert.ok(section, `references/ux-rules.md has a section for ${id}`);
    for (const label of ['Signal', 'Condition', 'Threshold', 'UNGRADED', 'Default level']) assert.match(section, new RegExp(`\\*\\*${label}\\*\\*`), `${id}: ${label}`);
    assert.match(section, new RegExp(`\\*\\*Default level\\*\\*: \`${level}\``), `${id} default level`);
    for (const [key, value] of Object.entries(thresholds)) assert.match(section, new RegExp(`\`${key}\` = \`${value}\``), `${id} threshold ${key}`);
  }
});
