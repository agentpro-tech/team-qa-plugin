// R1c — UX rules U1–U10 on fixture screens in a real Chromium (references/ux-rules.md).
// PROVES: each rule FAILs on a fixture screen that has exactly its defect and stays silent (no finding of that rule)
// on the clean twin; a rule whose condition does not occur is UNGRADED, never PASS; the level of a rule is a setting.
// The in-page sweeps are the shipped files (scripts/ui-sanity.js, scripts/a11y-gate0.js), evaluated as a Dragon
// `read` step would evaluate them. Forced network states use Playwright request routing, the same CDP Fetch layer
// as Dragon `envSet` request rules; nothing is injected into the page.
// DOES NOT PROVE: thresholds (they are calibrated later on dev data); a vision model's judgement (U7, U8, U10 are
// graded here from structured outputs, see test/ux-rules.test.mjs).
// Skips (with the reason) when Playwright or a Chromium build is not available. Set QA_GUI_PLAYWRIGHT to a
// playwright(-core) module path and QA_GUI_CHROMIUM to a browser executable to point it at an install.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = resolve(import.meta.dirname, '..');
const FIX = resolve(ROOT, 'test/fixtures/ux-rules');
const UI = readFileSync(resolve(ROOT, 'scripts/ui-sanity.js'), 'utf8');
const A11Y = readFileSync(resolve(ROOT, 'scripts/a11y-gate0.js'), 'utf8');
const requireCjs = createRequire(import.meta.url);

function loadPlaywright() {
  const names = [process.env.QA_GUI_PLAYWRIGHT, 'playwright', 'playwright-core',
    resolve(ROOT, '.teamcode/browser-harness/node_modules/playwright-core')].filter(Boolean);
  for (const name of names) { try { return requireCjs(name); } catch { /* next */ } }
  return null;
}
const pw = loadPlaywright();
let browser = null, server = null, base = null, unavailable = pw ? null : 'Playwright is not installed';

async function ready() {
  if (browser || unavailable) return !unavailable;
  const opts = { headless: true };
  if (process.env.QA_GUI_CHROMIUM) opts.executablePath = process.env.QA_GUI_CHROMIUM;
  try { browser = await pw.chromium.launch(opts); }
  catch (first) {
    try { browser = await pw.chromium.launch({ ...opts, channel: 'chrome' }); }
    catch { unavailable = `no Chromium build could be launched (${String(first.message).split('\n')[0]})`; return false; }
  }
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"ok":true}'); });
      return;
    }
    const file = resolve(FIX, basename(url.pathname));
    if (!/^\/u\d+-[a-z-]+\.html$/.test(url.pathname) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
  return true;
}
after(async () => { try { await browser?.close(); } catch { /* closed */ } try { server?.close(); } catch { /* closed */ } });

async function open(t, fixture) {
  if (!(await ready())) { t.skip(unavailable); return null; }
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`${base}/${fixture}`);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const uiSanity = (page, label, opts) => page.evaluate(`${UI}\n;__uiSanity(${JSON.stringify(label)}, ${JSON.stringify(opts || {})})`);
const a11y = (page, opts) => page.evaluate(`${A11Y}\n;__a11yB(${JSON.stringify({ minTarget: 24, ...(opts || {}) })})`);
const ruleIssues = (report, id) => report.issues.filter((issue) => issue.id === id);

// ---------- U4 error tied to its field (a11y-gate0.js) ----------
test('U4 FAILs when the error text under a field is not referenced by it', async (t) => {
  const page = await open(t, 'u4-unlinked.html'); if (!page) return;
  try {
    const report = await a11y(page);
    assert.equal(report.ux.rules.U4.verdict, 'FAIL', JSON.stringify(report.ux.rules.U4));
    const found = ruleIssues(report, 'U4');
    assert.equal(found.length, 1);
    assert.equal(found[0].rule, 'error-not-tied-to-field');
    assert.equal(found[0].sel, 'input#email');
    assert.match(found[0].detail, /not referenced/);
    assert.equal(found[0].sev, 'warn', 'U4 is warn by default');
  } finally { await page.close(); }
});
test('U4 FAILs when the referenced error text is far from its field', async (t) => {
  const page = await open(t, 'u4-far.html'); if (!page) return;
  try {
    const report = await a11y(page);
    assert.equal(report.ux.rules.U4.verdict, 'FAIL');
    const found = ruleIssues(report, 'U4');
    assert.equal(found.length, 1);
    assert.match(found[0].detail, /far from the field/);
  } finally { await page.close(); }
});
test('U4 is silent on the clean twin and UNGRADED where no field is in error', async (t) => {
  const page = await open(t, 'u4-clean.html'); if (!page) return;
  try {
    const report = await a11y(page);
    assert.equal(report.ux.rules.U4.verdict, 'PASS');
    assert.equal(ruleIssues(report, 'U4').length, 0);
    await page.goto(`${base}/u9-clean.html`);
    const none = await a11y(page);
    assert.equal(none.ux.rules.U4.verdict, 'UNGRADED');
    assert.equal(none.ux.rules.U4.reason, 'NO_FIELD_ERROR');
  } finally { await page.close(); }
});

// ---------- U5 status message readable (a11y-gate0.js) ----------
test('U5 FAILs on a toast inserted outside any live region, and is UNGRADED before it shows', async (t) => {
  const page = await open(t, 'u5-defect.html'); if (!page) return;
  try {
    const before = await a11y(page);
    assert.equal(before.ux.rules.U5.verdict, 'UNGRADED');
    assert.equal(before.ux.rules.U5.reason, 'NO_STATUS_MESSAGE');
    await page.click('#save');
    await page.waitForSelector('.toast');
    const report = await a11y(page);
    assert.equal(report.ux.rules.U5.verdict, 'FAIL');
    const found = ruleIssues(report, 'U5');
    assert.equal(found.length, 1);
    assert.equal(found[0].rule, 'status-not-announced');
    assert.equal(found[0].text, 'Settings saved');
  } finally { await page.close(); }
});
test('U5 is silent on the clean twin (the toast lands in a role=status region)', async (t) => {
  const page = await open(t, 'u5-clean.html'); if (!page) return;
  try {
    await page.click('#save');
    await page.waitForSelector('.toast');
    const report = await a11y(page);
    assert.equal(report.ux.rules.U5.verdict, 'PASS', JSON.stringify(report.ux.rules.U5));
    assert.equal(ruleIssues(report, 'U5').length, 0);
  } finally { await page.close(); }
});

// ---------- U6 focus not fully obscured (a11y-gate0.js) ----------
test('U6 FAILs when the keyboard-focused field is fully under a fixed header, and it blocks by default', async (t) => {
  const page = await open(t, 'u6-defect.html'); if (!page) return;
  try {
    const noFocus = await a11y(page);
    assert.equal(noFocus.ux.rules.U6.verdict, 'UNGRADED');
    assert.equal(noFocus.ux.rules.U6.reason, 'NO_FOCUS');
    await page.keyboard.press('Tab');
    const report = await a11y(page);
    assert.equal(report.ux.rules.U6.verdict, 'FAIL', JSON.stringify(report.ux.rules.U6));
    assert.equal(report.ux.rules.U6.coveredPoints, 5);
    const found = ruleIssues(report, 'U6');
    assert.equal(found.length, 1);
    assert.equal(found[0].sel, 'input#search');
    assert.equal(found[0].sev, 'high');
    assert.equal(report.verdict, 'FAIL', 'a block-level U6 finding fails the a11y sweep');
  } finally { await page.close(); }
});
test('U6 is silent on the clean twin, and a warn level keeps the sweep verdict', async (t) => {
  const page = await open(t, 'u6-clean.html'); if (!page) return;
  try {
    await page.keyboard.press('Tab');
    const report = await a11y(page);
    assert.equal(report.ux.rules.U6.verdict, 'PASS');
    assert.equal(report.ux.rules.U6.coveredPoints, 0);
    assert.equal(ruleIssues(report, 'U6').length, 0);
    await page.goto(`${base}/u6-defect.html`);
    await page.keyboard.press('Tab');
    const warned = await a11y(page, { ux: { levels: { U6: 'warn' } } });
    assert.equal(warned.ux.rules.U6.verdict, 'FAIL');
    assert.equal(warned.ux.rules.U6.level, 'warn');
    assert.equal(ruleIssues(warned, 'U6')[0].sev, 'warn');
    assert.notEqual(warned.verdict, 'FAIL');
  } finally { await page.close(); }
});

// ---------- U9 occlusion at five points (ui-sanity.js) ----------
test('U9 FAILs on a button whose right half is covered while its centre is free (A3 stays silent)', async (t) => {
  const page = await open(t, 'u9-defect.html'); if (!page) return;
  try {
    const report = await uiSanity(page, 'u9-defect');
    assert.equal(report.ux.rules.U9.verdict, 'FAIL', JSON.stringify(report.ux.rules.U9));
    const found = ruleIssues(report, 'U9');
    assert.equal(found.length, 1);
    assert.equal(found[0].rule, 'occluded-control-partial');
    assert.equal(found[0].sel, 'button#checkout');
    assert.match(found[0].detail, /^2\/5 points covered by .*div\.promo$/);
    assert.equal(found[0].sev, 'warn', 'U9 is warn by default');
    assert.equal(report.issues.filter((issue) => issue.rule === 'occluded-control').length, 0, 'A3 checks the centre only');
    const blocking = await uiSanity(page, 'u9-defect', { ux: { levels: { U9: 'block' } } });
    assert.equal(ruleIssues(blocking, 'U9')[0].sev, 'high');
    assert.equal(blocking.verdict, 'FAIL');
  } finally { await page.close(); }
});
test('U9 is silent on the clean twin', async (t) => {
  const page = await open(t, 'u9-clean.html'); if (!page) return;
  try {
    const report = await uiSanity(page, 'u9-clean');
    assert.equal(report.ux.rules.U9.verdict, 'PASS');
    assert.equal(ruleIssues(report, 'U9').length, 0);
    assert.equal(report.verdict, 'PASS');
  } finally { await page.close(); }
});

// ---------- settings, UNGRADED and the required-rule contract ----------
test('a required rule whose condition did not occur makes the sweep UNGRADED, never PASS', async (t) => {
  const page = await open(t, 'u9-clean.html'); if (!page) return;
  try {
    await page.setContent('<!doctype html><title>blank</title><p>Nothing to click</p>');
    const plain = await uiSanity(page, 'empty');
    assert.equal(plain.ux.rules.U9.verdict, 'UNGRADED');
    assert.equal(plain.ux.rules.U9.reason, 'NO_CONTROLS_IN_VIEW');
    assert.equal(plain.verdict, 'PASS', 'an UNGRADED rule the case did not require leaves the sweep verdict alone');
    const required = await uiSanity(page, 'empty', { ux: { require: ['U9'] } });
    assert.equal(required.verdict, 'UNGRADED');
    const a11yRequired = await a11y(page, { ux: { require: ['U5'] } });
    assert.equal(a11yRequired.verdict, 'UNGRADED');
  } finally { await page.close(); }
});
test('an invalid level or threshold makes that rule UNGRADED (SETTINGS_INVALID)', async (t) => {
  const page = await open(t, 'u6-defect.html'); if (!page) return;
  try {
    await page.keyboard.press('Tab');
    const report = await a11y(page, { ux: { levels: { U6: 'loud' }, thresholds: { U4: { maxGapPx: 'far' } } } });
    assert.equal(report.ux.rules.U6.verdict, 'UNGRADED');
    assert.equal(report.ux.rules.U6.reason, 'SETTINGS_INVALID');
    assert.equal(report.ux.rules.U4.reason, 'SETTINGS_INVALID');
    const sanity = await uiSanity(page, 'x', { ux: { thresholds: { U9: { minCovered: 9, extra: 1 } } } });
    assert.equal(sanity.ux.rules.U9.reason, 'SETTINGS_INVALID');
  } finally { await page.close(); }
});
test('each in-page rule reports the level and thresholds it used, equal to the registry defaults', async (t) => {
  const page = await open(t, 'u9-clean.html'); if (!page) return;
  try {
    const { UX_RULES } = await import('../scripts/lib/ux-rules.mjs');
    const sanity = await uiSanity(page, 'defaults');
    const access = await a11y(page);
    for (const [id, result] of Object.entries({ ...sanity.ux.rules, ...access.ux.rules })) {
      assert.equal(result.level, UX_RULES[id].level, id);
      assert.deepEqual(result.thresholds, UX_RULES[id].thresholds, id);
    }
    assert.deepEqual(Object.keys(sanity.ux.rules).sort(), ['U9']);
    assert.deepEqual(Object.keys(access.ux.rules).sort(), ['U4', 'U5', 'U6']);
  } finally { await page.close(); }
});

// ---------- U1 / U2 / U3: action rules graded in Node from `__uxObserve` observations ----------
// The executor's `do` chain reads `__uxObserve` before the action, while a forced request is pending and after the
// result; the network state is forced at the environment layer (here Playwright routing = Dragon envSet rules).
const observe = (page, opts) => page.evaluate(`${UI}\n;__uxObserve(${JSON.stringify(opts || {})})`);
const grader = () => import('../scripts/lib/ux-rules.mjs');
function hold(page, pattern) {
  const state = { requests: [], release: null };
  const gate = new Promise((done) => { state.release = done; });
  page.route(pattern, async (route) => {
    state.requests.push({ t: Date.now(), method: route.request().method(), url: route.request().url() });
    await gate;
    await route.continue().catch(() => {});
  });
  return state;
}
// The env.get shape (r1a-environment-and-sensors.md §3) for what the route held.
const envGet = (state, ruleId) => ({
  ok: true,
  held: state.requests.map((r, i) => ({ requestId: `job-${i}`, ruleId, action: 'hold', url: r.url, method: r.method, resourceType: 'Fetch', t: r.t, until: r.t + 30000 })),
  requests: state.requests.map((r) => ({ t: r.t, ruleId, action: 'hold', url: r.url, method: r.method, outcome: 'held' })),
});

test('U1 FAILs when a successful save changes nothing the user can see; silent on the clean twin', async (t) => {
  const { gradeU1 } = await grader();
  for (const [fixture, verdict] of [['u1-defect.html', 'FAIL'], ['u1-clean.html', 'PASS']]) {
    const page = await open(t, fixture); if (!page) return;
    try {
      await page.fill('#name', 'Lan');
      const before = await observe(page);
      const t0 = Date.now();
      const [response] = await Promise.all([page.waitForResponse('**/api/save'), page.click('#save')]);
      await page.waitForTimeout(250);
      const after = await observe(page);
      const result = gradeU1({ action: { t: t0 }, before, after, writes: [{ method: 'POST', url: response.url(), status: response.status(), t: t0 }] });
      assert.equal(result.verdict, verdict, `${fixture}: ${JSON.stringify(result)}`);
      if (verdict === 'FAIL') { assert.equal(result.reason, 'NO_VISIBLE_CHANGE'); assert.match(result.findings[0].detail, /POST 200/); }
      else assert.equal(result.findings.length, 0);
    } finally { await page.close(); }
  }
});

test('U1 FAILs when a write held past 1 s shows no progress indicator; silent on the clean twin', async (t) => {
  const { gradeU1 } = await grader();
  for (const [fixture, verdict] of [['u1-slow-defect.html', 'FAIL'], ['u1-clean.html', 'PASS']]) {
    const page = await open(t, fixture); if (!page) return;
    try {
      const held = hold(page, '**/api/save');
      await page.fill('#name', 'Lan');
      const before = await observe(page);
      const t0 = Date.now();
      await page.click('#save');
      await page.waitForTimeout(1200);
      const during = await observe(page);
      const releasedAt = Date.now();
      const responded = page.waitForResponse('**/api/save');
      held.release();
      const response = await responded;
      await page.waitForTimeout(250);
      const after = await observe(page);
      const result = gradeU1({ action: { t: t0 }, before, during, after, pendingUntil: releasedAt, writes: [{ method: 'POST', url: response.url(), status: response.status(), t: t0 }] });
      assert.equal(result.verdict, verdict, `${fixture}: ${JSON.stringify(result)}`);
      if (verdict === 'FAIL') assert.equal(result.reason, 'NO_PROGRESS_INDICATOR');
    } finally { await page.close(); }
  }
});

test('U1 is UNGRADED when the action wrote nothing and nothing waited', async (t) => {
  const { gradeU1 } = await grader();
  const page = await open(t, 'u1-defect.html'); if (!page) return;
  try {
    const before = await observe(page);
    const t0 = Date.now();
    await page.click('h1');
    const after = await observe(page);
    const result = gradeU1({ action: { t: t0 }, before, after, writes: [] });
    assert.equal(result.verdict, 'UNGRADED');
    assert.equal(result.reason, 'NO_WRITE_OR_WAIT');
  } finally { await page.close(); }
});

test('U2 FAILs when the submit button stays clickable while the order is held; a second click sends a second order', async (t) => {
  const { gradeU2 } = await grader();
  const page = await open(t, 'u2-defect.html'); if (!page) return;
  try {
    const held = hold(page, '**/api/orders');
    await page.fill('#item', 'Desk lamp');
    const before = await observe(page, { trigger: '#submit' });
    const t0 = Date.now();
    await page.click('#submit');
    await page.waitForTimeout(300);
    const during = await observe(page, { trigger: '#submit' });
    assert.equal(during.trigger.disabled, false);
    const first = gradeU2({ action: { t: t0 }, before, during, env: envGet(held, 'orders'), ruleId: 'orders' });
    assert.equal(first.verdict, 'FAIL', JSON.stringify(first));
    assert.equal(first.reason, 'STILL_ACTIONABLE');
    await page.click('#submit');
    await page.waitForTimeout(300);
    const second = gradeU2({ action: { t: t0 }, before, during: await observe(page, { trigger: '#submit' }), env: envGet(held, 'orders'), ruleId: 'orders' });
    assert.equal(second.verdict, 'FAIL');
    assert.equal(second.reason, 'DUPLICATE_REQUEST');
    held.release();
  } finally { await page.close(); }
});

test('U2 is silent on the clean twin: the button is disabled and busy while the order is held', async (t) => {
  const { gradeU2 } = await grader();
  const page = await open(t, 'u2-clean.html'); if (!page) return;
  try {
    const held = hold(page, '**/api/orders');
    await page.fill('#item', 'Desk lamp');
    const before = await observe(page, { trigger: '#submit' });
    const t0 = Date.now();
    await page.click('#submit');
    await page.waitForTimeout(300);
    const during = await observe(page, { trigger: '#submit' });
    assert.equal(during.trigger.disabled, true);
    assert.equal(during.trigger.ariaBusy, true);
    const box = await page.locator('#submit').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const result = gradeU2({ action: { t: t0 }, before, during, env: envGet(held, 'orders'), ruleId: 'orders' });
    assert.equal(result.verdict, 'PASS', JSON.stringify(result));
    assert.equal(held.requests.length, 1, 'the second click sent nothing');
    held.release();
    const free = gradeU2({ action: { t: t0 }, before, during, env: { ok: true, held: [], requests: [] }, ruleId: 'orders' });
    assert.equal(free.verdict, 'UNGRADED', 'without a pending request the rule has nothing to judge');
    assert.equal(free.reason, 'NO_PENDING_REQUEST');
  } finally { await page.close(); }
});

test('U3 FAILs when a forced 500 clears what the user typed; silent on the clean twin; UNGRADED without an error', async (t) => {
  const { gradeU3 } = await grader();
  for (const [fixture, status, verdict] of [['u3-defect.html', 500, 'FAIL'], ['u3-clean.html', 500, 'PASS'], ['u3-defect.html', 200, 'UNGRADED']]) {
    const page = await open(t, fixture); if (!page) return;
    try {
      const log = [];
      await page.route('**/api/contact', async (route) => {
        log.push({ t: Date.now(), ruleId: 'contact', action: 'respond', url: route.request().url(), method: route.request().method(), outcome: `responded:${status}` });
        await route.fulfill({ status, contentType: 'application/json', body: status === 200 ? '{"ok":true}' : '{"error":"forced"}' });
      });
      await page.fill('#name', 'Lan');
      await page.fill('#email', 'lan@example.test');
      await page.fill('#message', 'Please call me back.');
      const before = await observe(page);
      await Promise.all([page.waitForResponse('**/api/contact'), page.click('#send')]);
      await page.waitForTimeout(250);
      const after = await observe(page);
      const result = gradeU3({ before, after, env: { ok: true, held: [], requests: log } });
      assert.equal(result.verdict, verdict, `${fixture} ${status}: ${JSON.stringify(result)}`);
      if (verdict === 'FAIL') {
        assert.equal(result.level, 'block');
        assert.deepEqual(result.findings.map((f) => f.sel).sort(), ['input#email', 'input#name', 'textarea#message']);
      }
      if (verdict === 'UNGRADED') assert.equal(result.reason, 'NO_ERROR');
    } finally { await page.close(); }
  }
});

test('__uxObserve never returns typed values: only lengths and hashes', async (t) => {
  const page = await open(t, 'u3-defect.html'); if (!page) return;
  try {
    await page.fill('#message', 'secret words here');
    const seen = await observe(page);
    assert.doesNotMatch(JSON.stringify(seen), /secret words/);
    const field = seen.forms[0].fields.find((f) => f.key === 'message');
    assert.equal(field.len, 17);
    assert.match(field.hash, /^[0-9a-f]{8}$/);
    assert.equal(seen.v, 'ux-observe/1');
  } finally { await page.close(); }
});

// ---------- U7 / U8 / U10: vision rules, with the machine facts measured on the fixture screens ----------
// The executor answers the request in the same vision pass as C10–C16, on the same canonical PNG. The answers below
// are synthetic structured outputs that match what the fixture PNGs show; the machine facts are real measurements.
const vision = () => import('../scripts/lib/ux-vision.mjs');
const shot = async (page) => { const png = await page.screenshot(); return { path: 'state.png', width: png.readUInt32BE(16), height: png.readUInt32BE(20) }; };
const out = (rule) => ({ schema: 'qa-gui/ux-vision/v1', rules: [rule] });

test('U10 pre-screen: the clipped chip is measured as clipped by its own box; the clean twin is not', async (t) => {
  for (const [fixture, clipped] of [['u10-defect.html', true], ['u10-clean.html', false]]) {
    const page = await open(t, fixture); if (!page) return;
    try {
      const seen = await observe(page);
      const tag = seen.diacritics.find((c) => c.sel === 'span#tag');
      assert.ok(tag, `${fixture}: the chip is a candidate (${JSON.stringify(seen.diacritics)})`);
      assert.equal(tag.clipped, clipped, `${fixture}: ${JSON.stringify(tag)}`);
      if (clipped) { assert.equal(tag.clipBy, 'self'); assert.ok(tag.overflowTopPx > 1 && tag.overflowBottomPx > 1, JSON.stringify(tag)); }
      assert.ok(seen.diacritics.filter((c) => c.sel !== 'span#tag').every((c) => c.clipped === false), 'the heading and label are not clipped');
    } finally { await page.close(); }
  }
});

test('U10 graded on the fixtures: FAIL on the defect, silent on the clean twin, UNGRADED on a screen with no Vietnamese text', async (t) => {
  const { gradeUxVision, uxVisionRequest } = await vision();
  for (const [fixture, verdict] of [['u10-defect.html', 'FAIL'], ['u10-clean.html', 'PASS'], ['u9-clean.html', 'UNGRADED']]) {
    const page = await open(t, fixture); if (!page) return;
    try {
      const seen = await observe(page);
      const image = await shot(page);
      const request = uxVisionRequest({ rules: ['U10'], state: 'customer', image, viewport: seen.viewport, context: { U10: { candidates: seen.diacritics } } });
      const region = request.regions.U10.find((r) => r.sel === 'span#tag') ?? { x: 0, y: 0, w: 10, h: 10 };
      const answer = verdict === 'FAIL'
        ? { rule: 'U10', applies: true, verdict: 'FAIL', confidence: 0.9, clipped: true, evidence: { region: { x: region.x, y: region.y, w: region.w, h: region.h }, quote: 'DANG VU ONG AM' }, reason: 'the marks above the capitals and the dots below are cut by the chip' }
        : { rule: 'U10', applies: true, verdict: 'PASS', confidence: 0.9, clipped: false, evidence: { region: { x: region.x, y: region.y, w: region.w, h: region.h }, quote: '' }, reason: 'all marks are whole' };
      const result = gradeUxVision(verdict === 'UNGRADED' ? null : out(answer), request).U10;
      assert.equal(result.verdict, verdict, `${fixture}: ${JSON.stringify(result)}`);
      if (verdict === 'UNGRADED') assert.equal(result.reason, 'NO_DIACRITIC_TEXT');
    } finally { await page.close(); }
  }
});

test('U8 graded on the fixtures: deleting with no guard FAILs; the confirmation dialog of the clean twin is seen by both machine and vision', async (t) => {
  const { gradeUxVision, uxDestructiveContext, uxVisionRequest } = await vision();
  for (const [fixture, verdict] of [['u8-defect.html', 'FAIL'], ['u8-clean.html', 'PASS']]) {
    const page = await open(t, fixture); if (!page) return;
    try {
      const before = await observe(page);
      await page.click('li[data-id="12"] button.delete');
      await page.waitForTimeout(100);
      const after = await observe(page);
      const context = uxDestructiveContext({ before, after, action: { label: 'Delete', selector: 'li[data-id="12"] button.delete' } });
      assert.equal(context.dialogOpened, verdict === 'PASS', JSON.stringify(after.dialogs));
      assert.equal(context.undoOffered, false);
      const request = uxVisionRequest({ rules: ['U8'], state: 'after-delete', image: await shot(page), viewport: after.viewport, context: { U8: context } });
      const answer = verdict === 'FAIL'
        ? { rule: 'U8', applies: true, verdict: 'FAIL', confidence: 0.9, confirmation: false, undo: false, evidence: { region: { x: 24, y: 120, w: 480, h: 60 }, quote: 'Invoice 13' }, reason: 'Invoice 12 is gone; nothing asked and nothing offers an undo' }
        : { rule: 'U8', applies: true, verdict: 'PASS', confidence: 0.9, confirmation: true, undo: false, evidence: { region: { x: 116, y: 88, w: 408, h: 184 }, quote: 'Delete Invoice 12?' }, reason: 'a dialog asks first' };
      const result = gradeUxVision(out(answer), request).U8;
      assert.equal(result.verdict, verdict, `${fixture}: ${JSON.stringify(result)}`);
    } finally { await page.close(); }
  }
});

test('U7 graded on the fixtures: the bare empty table FAILs, the explained empty state with an action is silent', async (t) => {
  const { gradeUxVision, uxVisionRequest } = await vision();
  for (const [fixture, verdict] of [['u7-defect.html', 'FAIL'], ['u7-clean.html', 'PASS']]) {
    const page = await open(t, fixture); if (!page) return;
    try {
      const request = uxVisionRequest({ rules: ['U7'], state: 'orders-empty', image: await shot(page), context: { U7: { forcedEmpty: true, listSelector: '#orders tbody', itemCount: await page.locator('#orders tbody tr').count() } } });
      assert.match(request.prompt, /0 items/);
      const answer = verdict === 'FAIL'
        ? { rule: 'U7', applies: true, verdict: 'FAIL', confidence: 0.9, explains: false, offersAction: false, evidence: { region: { x: 24, y: 120, w: 560, h: 160 }, quote: '' }, reason: 'a header row and nothing else' }
        : { rule: 'U7', applies: true, verdict: 'PASS', confidence: 0.9, explains: true, offersAction: true, evidence: { region: { x: 24, y: 150, w: 560, h: 110 }, quote: 'No orders yet. Orders you create will appear here.' }, reason: 'explains and offers Create order' };
      const result = gradeUxVision(out(answer), request).U7;
      assert.equal(result.verdict, verdict, `${fixture}: ${JSON.stringify(result)}`);
    } finally { await page.close(); }
  }
});
