// Upgrade integration, end to end on fixtures: a Team QA web-lane run whose GUI executor ran QA GUI's detectors by
// recipe (fix round 1). Three cases on two screens: TC-A (behavioral: Submit sends the order) and TC-B (static: the
// list) on /orders, the one screen with a route; TC-C on the step 2 of a wizard, reached by clicks, with no route. The
// width sweep and the overlay check of /orders run once, in their own screen check dispatch (helper calls whose results
// prove QA GUI's helper by hash), `teamqa web collect-screen` grades it, and each case's collect folds it in. TC-A's
// executor stream carries the R1d probe as Dragon frames.trial calls (recorded trials of QA GUI's T5 canary and its
// clean twin), the U1/U2 held write and the case's env.reset. Three runs of the same plan: the planted defects (a W2
// band on /orders, found by the screen check and attributed to TC-A and TC-B; a transient flash on TC-A; the overlay's
// Esc and focus), their clean twin, and the run on a Dragon without R1a. QA GUI's gate grades each board; Team QA's
// report shows the cells, the adjudicator's shadow fields and the Speed section.
// Needs a QA GUI checkout (TEAMQA_WEB_TEST_QA_GUI_ROOT). Recorded or synthetic Dragon data only; nothing reaches a live
// Dragon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deflateSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { DRAFT_MARKER, qaGuiEvidenceTools, webCollect } from '../../scripts/lib/web-collect.mjs';
import { dispatchDetectorSection, qaGuiDetectorTools } from '../../scripts/lib/detector-dispatch.mjs';
import { SCREEN_DRAFT_MARKER, webCollectScreen } from '../../scripts/lib/screen-checks.mjs';
import { adjudicateCase } from '../../scripts/lib/adjudicator.mjs';
import { passiveHtmlParts } from '../../scripts/lib/tool-preflight.mjs';
import { fakeEngine } from '../adjudicator/fake-engine.mjs';
import { SEAT } from '../adjudicator/support.mjs';

const QA_GUI = process.env.TEAMQA_WEB_TEST_QA_GUI_ROOT;
const SKIP = QA_GUI ? false : 'set TEAMQA_WEB_TEST_QA_GUI_ROOT to a QA GUI checkout with the stream detectors';
const ROOT = new URL('../../', import.meta.url).pathname;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const qa = (rel) => import(pathToFileURL(join(QA_GUI, rel)).href);
const RUN_ID = 'det-run', RUN_UUID = '22222222-2222-4222-8222-222222222222', BUILD = 'index-DET1', TB = 'e'.repeat(64);
const ORIGIN = 'http://127.0.0.1:5401', URL_ = `${ORIGIN}/orders`, WIZARD = `${ORIGIN}/wizard`;
const S = { sessionId: 'exec-det', nonce: 'n-det', browserInstanceId: 'bi-det' };
const TOOLS = { 'env.set': 'envSet', 'env.get': 'envGet', 'env.release': 'envRelease', 'env.reset': 'envReset', 'sensors.start': 'sensorsStart', 'sensors.read': 'sensorsRead',
  'sensors.stop': 'sensorsStop', 'frames.start': 'framesStart', 'frames.stop': 'framesStop', 'frames.trial': 'framesTrial', 'helpers.define': 'helpersDefine', paintSnapshot: 'paintSnapshot' };
const CASES = ['TC-A', 'TC-B', 'TC-C'];

// ── the executor's calls, as stream-json events ─────────────────────────────────────────────────────────────────
// A Dragon call goes to its direct tool (do, screenshot, help, the R1a tools) or dragon_rpc; `tool` is a host tool
// (Grep). `persisted`: Claude Code saved the result to a file (Dragon help is that large) and left a preview; the stream
// line keeps the original (`tool_use_result`).
function streamOf(calls, { marker, draft }) {
  let n = 0, clock = Date.parse('2026-11-04T05:00:00.000Z');
  const events = [];
  for (const c of calls) {
    const id = `toolu_${String(++n).padStart(3, '0')}`;
    const params = c.tool ? c.params : { ...S, tabId: 7, ...(c.params ?? {}) };
    const direct = ['do', 'screenshot', 'help'].includes(c.method) || TOOLS[c.method];
    const name = c.tool ?? `mcp__Dragon_Browser__${direct ? (TOOLS[c.method] ?? c.method) : 'dragon_rpc'}`;
    const input = c.tool || direct ? params : { method: c.method, params };
    const calledAt = c.called_at ?? new Date(clock += 300).toISOString(), at = c.at ?? new Date(clock += 200).toISOString();
    events.push({ type: 'assistant', timestamp: calledAt, message: { content: [{ type: 'tool_use', id, name, input }] } });
    const full = c.tool ? String(c.result) : JSON.stringify({ ok: c.ok !== false, result: c.result });
    const shown = c.persisted ? `<persisted-output>\nOutput too large (${Math.round(full.length / 1024)}KB). Full output saved to: /results/${id}.txt\n\nPreview (first 2KB):\n${full.slice(0, 2048)}\n...\n</persisted-output>` : full;
    events.push({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: shown }] }] },
      ...(c.persisted ? { tool_use_result: [{ type: 'text', text: full }] } : {}) });
  }
  events.push({ type: 'assistant', message: { content: [{ type: 'text', text: `${marker}\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`\n` }] } });
  return `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
}
// Dragon help, about as large as the real one; with R1a it names its environmentContract. The executor Greps the
// saved file for it (R1a rule of QA GUI's recipes).
function helpCalls({ r1a }) {
  const result = { version: r1a ? '1.16.0' : '1.15.1', rpcMethods: Array.from({ length: 700 }, (_, i) => `method${i}`), text: 'Dragon help. '.repeat(9000),
    ...(r1a ? { environmentContract: { version: 'r1a/1', methods: ['env.set', 'frames.trial', 'helpers.define'] } } : {}) };
  return [{ method: 'help', params: {}, result, persisted: true },
    { tool: 'Grep', params: { pattern: 'environmentContract', path: '/results/help.txt', output_mode: 'count' }, result: r1a ? '1' : '0' }];
}
// A do whose reads and helper calls answer `values`; a helper call's result names the helper Dragon ran (D2).
function doCall(SD, steps, values = {}, extra = {}) {
  const helperOf = (name) => Object.values(SD.STREAM_HELPERS).find((h) => h.name === name);
  return { method: 'do', params: { brief: true, steps }, result: { completed: true, brief: true, results: steps.map((s) => {
    if (s.call !== undefined) return { step: 'read', as: s.as, value: values[s.as], helper: { name: s.call, sha256: helperOf(s.call).sha256 } };
    if (s.read !== undefined) return { step: 'read', as: s.as, value: values[s.as] };
    return { step: Object.keys(s)[0], ok: true, ...(extra[Object.keys(s)[0]] ?? {}) };
  }) } };
}

// ── the screen check of /orders (S1) ─────────────────────────────────────────────────────────────────────────────
// The width sweep: the defect's main block sticks out between 741 and 783 px (W2). Every measure after its viewport
// and the settle wait (QG-9), as QA GUI's recipe sends them.
// `capture` (fix round 3, F6): the band screenshots Dragon saved, {work, content}: a file per band with that content.
function sweepCalls(defect, SD, url = URL_, href = url, capture = null) {
  const sw = (args, as) => SD.helperCall('sweep', args, as);
  const view = (w) => ({ viewport: { width: w, height: 800, deviceScaleFactor: 1, mobile: false } });
  const settle = { wait: SD.SETTLE_MS };
  const geometry = (w) => ({ width: w, vw: w, layout: w < 784 ? 'header / main' : 'header,main', failures: defect && w >= 741 && w <= 783
    ? [{ rule: 'W2', selector: 'div.shell > main', target: 'div.shell > main', tag: 'main', detail: 'outside the viewport', rect: { x: 0, y: 70, width: w + 40, height: 80 } }] : [] });
  const coarse = []; for (let w = 320; w < 1440; w += 20) coarse.push(w); coarse.push(1440);
  const refine = []; for (const [a, b] of [[740, 760], [780, 800]]) for (let w = a + 1; w < b; w += 1) refine.push(w);
  const measure = (w) => [view(w), settle, sw(['measure'], `w:${w}`)];
  const values = Object.fromEntries([...coarse, ...refine].map((w) => [`w:${w}`, geometry(w)]));
  const half = Math.ceil(coarse.length / 2);
  const bands = defect ? [{ id: 'W2|div.shell > main', rule: 'W2', from: 741, to: 783, target: 'div.shell > main', rows: ['desktop-767', 'desktop-768', 'desktop-769'] }] : [];
  const rows = defect ? [767, 768, 769].map((w) => ({ id: `desktop-${w}`, width: w, height: 800, deviceScaleFactor: 1, mobile: false })) : [];
  const calls = [
    doCall(SD, [{ goto: url }, sw(['found'], 'w:found'), ...coarse.slice(0, half).flatMap(measure)], { 'w:found': { width: 1280, height: 800, dpr: 1, touch: false, href }, ...values }),
    doCall(SD, [...coarse.slice(half).flatMap(measure), sw(['refine'], 'w:refine')], { ...values, 'w:refine': refine }),
    doCall(SD, refine.slice(0, 19).flatMap(measure), values),
    doCall(SD, [...refine.slice(19).flatMap(measure), sw(['bands'], 'w:bands')], { ...values, 'w:bands': { bands, rows } }),
  ];
  for (const band of bands) {
    calls.push(doCall(SD, [view(band.from), settle]));
    calls.push({ method: 'paintSnapshot', params: { selector: band.target }, result: { ok: true, elements: [{ found: true, shown: false, reasons: ['outside-viewport'] }] } });
    const saved = capture ? join(capture.work, `S1-sweep-${band.from}.jpg`) : null;
    if (saved) writeFileSync(saved, capture.content);
    calls.push({ method: 'screenshot', params: { evidence: true, toFile: `S1-sweep-${band.from}.jpg` }, result: saved ? { ok: true, savedTo: saved, sha256: sha(capture.content) } : { ok: true } });
  }
  const rowValues = Object.fromEntries(rows.flatMap((row) => [[`w:row:${row.id}:emu`, { width: row.width, dpr: 1, touch: false }], [`w:row:${row.id}:geo`, geometry(row.width)]]));
  calls.push(doCall(SD, [...rows.flatMap((row) => [view(row.width), settle, sw(['emu'], `w:row:${row.id}:emu`), sw(['measure'], `w:row:${row.id}:geo`)]), view(1280), settle, sw(['viewport'], 'w:restored')],
    { ...rowValues, 'w:restored': { width: 1280, height: 800, dpr: 1, touch: false } }));
  return calls;
}

// The overlay check of the screen's one dialog trigger: the defect's dialog ignores Esc and leaves focus in the page.
function overlayCalls(defect, SD, url = URL_, href = url) {
  const URL_ = url;
  const T = '#edit', D = '#edit-dialog', C = '#edit-dialog > button.close';
  const page = (over = {}) => ({ open: [], active: 'body', activeInsideTop: false, scrollY: 0, scrollable: false, closeButton: null, backdropPoint: null, innerTriggers: [], ...over });
  const dialog = (over = {}) => page({ open: [{ selector: D, id: 'edit-dialog' }], modal: true, active: `${D} > input`, activeInsideTop: true, closeButton: C, backdropPoint: { x: 8, y: 8 }, ...over });
  const closed = page({ active: defect ? 'body' : T });
  const ov = (as, args = null) => SD.helperCall('overlay', args, `o:0:${as}`);
  const click = (sel) => ({ clickSelector: sel, fast: false });
  const tabs = Array.from({ length: 12 }, (_, i) => [{ key: 'Tab' }, ov(`trap-${i + 1}`)]).flat();
  const trapValues = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`o:0:trap-${i + 1}`, dialog()]));
  // The focus log of 80 Tab presses from a fresh page (fix round 2, E5): three links in one shadow host and two
  // repeated cards share their selectors, so only the element identity (id) tells them apart; the trigger has focus at
  // the sixth press, and focus goes round the page (back to the first element) after nine.
  const order = ['app-links', 'app-links', 'app-links', 'main > div > div > div > a', 'main > div > div > div > a', T, 'a.help', 'input#q', 'button#submit'];
  const samples = Array.from({ length: 80 }, (_, i) => ({ active: order[i % order.length], id: (i % order.length) + 1, inside: false }));
  return [
    doCall(SD, [{ goto: URL_ }, SD.helperCall('overlay', ['triggers'], 'o:triggers')], { 'o:triggers': page({ triggers: [{ selector: T, label: 'Edit' }], href }) }),
    doCall(SD, [{ goto: URL_ }, ov('before'), click(T), { wait: 300 }, ov('first'), ...tabs, ov('scroll-from'), { scroll: { delta: 400 } }, ov('scroll-to'), ov('now')],
      { 'o:0:before': page(), 'o:0:first': dialog(), ...trapValues, 'o:0:scroll-from': dialog(), 'o:0:scroll-to': dialog(), 'o:0:now': dialog() }),
    doCall(SD, [{ goto: URL_ }, click(T), { wait: 300 }, ov('esc-open'), { key: 'Escape' }, ov('esc-after'),
      { goto: URL_ }, click(T), { wait: 300 }, ov('backdrop-open'), { clickXY: [8, 8], fast: false }, { wait: 300 }, ov('backdrop-after'),
      { goto: URL_ }, click(T), { wait: 300 }, ov('button-open'), click(C), { wait: 300 }, ov('button-after'),
      { goto: URL_ }, ov('kbd-0', ['log']), ...Array.from({ length: 80 }, () => ({ key: 'Tab' })), ov('kbd', ['keylog'])],
    { 'o:0:esc-open': dialog(), 'o:0:esc-after': defect ? dialog() : closed, 'o:0:backdrop-open': dialog(), 'o:0:backdrop-after': closed, 'o:0:button-open': dialog(), 'o:0:button-after': closed,
      'o:0:kbd-0': page(), 'o:0:kbd': { started: true, samples } }),
    doCall(SD, [{ goto: URL_ }, ...Array.from({ length: 6 }, () => ({ key: 'Tab' })), ov('kbd-reach'), { key: 'Enter' }, { wait: 300 }, ov('kbd-enter'), { goto: URL_ }],
      { 'o:0:kbd-reach': page({ active: T }), 'o:0:kbd-enter': dialog() }),
  ];
}

// One screen check dispatch's stream, as QA GUI's screen recipe makes it.
// `overlayHref` (fix round 3, F5): where the overlay check's page was, when it was not where the sweep's was.
function screenStream({ SD, defect, r1a = true, screenId = 'S1', url = URL_, href = url, overlayHref = href, capture = null }) {
  const calls = [{ method: 'session.create', params: { sessionId: S.sessionId }, result: { ...S } }, { method: 'openTab', params: { url }, result: { tabId: 7, sessionId: S.sessionId } },
    { method: 'getPageIdentity', params: {}, result: { build: BUILD } }, ...helpCalls({ r1a })];
  // E9: the helpers come from QA GUI's helper pack, named by path and hash.
  if (r1a) calls.push({ method: 'helpers.define', params: { pack: SD.helperPack() }, result: { ok: true, helpers: [SD.STREAM_HELPERS.sweep.name, SD.STREAM_HELPERS.overlay.name].map((name) => ({ name })) } },
    ...sweepCalls(defect, SD, url, href, capture), ...overlayCalls(defect, SD, url, overlayHref));
  return { calls, text: streamOf(calls, { marker: SCREEN_DRAFT_MARKER, draft: { screen_id: screenId, url, ...(r1a ? {} : { unavailable: 'DRAGON_R1A_UNAVAILABLE' }) } }) };
}

// ── the cases ────────────────────────────────────────────────────────────────────────────────────────────────────
// The held write (U1, U2): the defect's Submit stays enabled with nothing busy while its POST is held.
function heldWriteCalls(defect, t0, caseId) {
  const rule = { id: 'write', urlPattern: '*/api/orders*', action: 'hold', status: null, errorReason: null, matched: 1 };
  const conditions = { v: 1, caseId, role: 'test', network: null, cpu: null, timezone: null, locale: null, media: null, animation: null, requests: [rule],
    probes: { sensors: false, frames: false }, verified: true, setAt: t0 - 2000, expiresAt: t0 + 900000 };
  const trigger = (over = {}) => ({ sel: 'button#submit', found: true, text: 'Submit', disabled: false, ariaDisabled: false, inert: false, pointerEventsNone: false, covered: false,
    visible: true, ariaBusy: false, spinner: false, formBusy: false, ...over });
  const obs = (t, over = {}) => ({ v: 'ux-observe/1', t, url: URL_, digest: { doc: 'list' }, live: [], dialogs: [], busy: {}, forms: [], trigger: trigger(), ...over });
  const during = defect ? obs(t0 + 1200) : obs(t0 + 1200, { trigger: trigger({ disabled: true, text: 'Saving', ariaBusy: true }), busy: { spinners: ['form#order .spinner'] } });
  const after = obs(t0 + 1800, { digest: { doc: 'saved' }, live: [{ sel: 'div[role=status]', text: 'Order saved' }] });
  const held = { requestId: 'r1', ruleId: 'write', action: 'hold', url: `${ORIGIN}/api/orders`, method: 'POST', resourceType: 'Fetch', t: t0 + 5, until: t0 + 30005 };
  const log = [{ t: t0 + 5, ruleId: 'write', action: 'hold', url: `${ORIGIN}/api/orders`, method: 'POST', outcome: 'held' }];
  const plain = (steps, values, extra) => ({ method: 'do', params: { steps }, result: { completed: true, results: steps.map((s) => (s.read !== undefined ? { step: 'read', as: s.as, value: values[s.as] } : { step: Object.keys(s)[0], ok: true, ...(extra?.[Object.keys(s)[0]] ?? {}) })) } });
  return { conditions, calls: [
    { method: 'env.set', params: { caseId, requests: [{ id: 'write', urlPattern: '*/api/orders*', method: 'POST', action: 'hold' }] }, result: { ok: true, applied: ['requests'], conditions } },
    plain([{ read: '__uxObserve({trigger:"#submit"})', as: 'u:hold:before' }, { clickSelector: '#submit', fast: false }, { wait: 1200 }, { read: '__uxObserve({trigger:"#submit"})', as: 'u:hold:during' }],
      { 'u:hold:before': obs(t0 - 50), 'u:hold:during': during }, { clickSelector: { receipt: { ts: t0, env: { conditions } } } }),
    { method: 'env.get', params: {}, result: { ok: true, conditions, held: [held], requests: log } },
    { method: 'env.release', params: { ruleId: 'write' }, result: { ok: true, released: 1, held: [], conditions } },
    plain([{ waitFor: { text: 'Order saved' } }, { read: '__uxObserve()', as: 'u:hold:after' }], { 'u:hold:after': after }),
    { method: 'env.get', params: {}, result: { ok: true, conditions, held: [], requests: [...log, { t: t0 + 1500, ruleId: 'write', url: `${ORIGIN}/api/orders`, method: 'POST', outcome: 'released:201' }] } },
  ] };
}

// A decodable, textured PNG (QA GUI's evidence policy refuses a flat frame).
function texturedPng(width, height, seed) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw.set([(x * 3 + seed) & 255, (y * 2) & 255, ((x + y) >> 2) & 255], y * (width * 3 + 1) + 1 + x * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// The exploration of /orders (TC-B, the cell case that runs it): one sort, then nothing left. Its reads are calls of
// QA GUI's explore helper.
function exploreCalls(SD) {
  const ex = (as, args = null) => SD.helperCall('explore', args, as);
  const view = (hash, candidates) => ({ node: 'route:/orders', route: '/orders', domHash: hash.repeat(64), rows: 3, viewport: 'desktop-1280', candidates });
  return [
    { method: 'helpers.define', params: { helpers: SD.helperDefinitions(['explore']) }, result: { ok: true, defined: [SD.STREAM_HELPERS.explore.name] } },
    doCall(SD, [{ goto: URL_ }, ex('x:0')], { 'x:0': view('1', [{ target: 'button:Sort', selector: '#sort' }]) }),
    doCall(SD, [{ clickSelector: '#sort', fast: false }, { wait: 150 }, ex('x:1')], { 'x:1': view('2', []) }),
    doCall(SD, [ex('x:css', ['css'])], { 'x:css': [] }),
  ];
}

const allPass = ['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'].map((rule) => ({ rule, verdict: 'PASS', ...(rule === 'C15' ? { note: 'no dark mode' } : {}) }));
const gate0 = (state) => ({ ui: { v: 'ui-sanity/2.0', state, verdict: 'PASS', counts: { high: 0, warn: 0 }, issues: [], ux: { v: 'ux-rules/1', rules: {} } }, a11y: { verdict: 'PASS', issues: [] } });

// A state's screenshot (a textured PNG Dragon saved), and the Gate-0, console and network checks after it.
function stateCalls({ caseId, seed, work }) {
  const shot = (name) => { const file = join(work, `${caseId}-${name}.png`); writeFileSync(file, texturedPng(1280, 800, name.length + seed)); return file; };
  const shotCall = (state, file, url, conditions = undefined) => ({ method: 'screenshot', params: { toFile: `${caseId}-${state}.png` }, result: { savedTo: file, sha256: sha(readFileSync(file)),
    domHash: String(seed % 10).repeat(64), domStable: true, privacyMasked: true, maskedRects: [], dom: { url, viewport: '1280x800' }, ...(conditions ? { receipt: { ts: 1, env: { conditions } } } : {}) } });
  const checks = (state, t, api = `${ORIGIN}/api/orders`) => [
    // The Gate-0 read and the element under test (QG-8: a state with function assertions names its target).
    { method: 'do', params: { steps: [{ read: '<ui-sanity.js + a11y-gate0.js>; return {ui: __uiSanity(...), a11y: __a11yB(...)}', as: 'g0' }, { read: '(() => { const r = document.querySelector("main").getBoundingClientRect(); ... })()', as: 'target' }] },
      result: { completed: true, results: [{ step: 'read', as: 'g0', value: gate0(state) }, { step: 'read', as: 'target', value: { selector: 'main', rect: { x: 0, y: 70, width: 1280, height: 600 } } }] } },
    { method: 'getConsole', params: {}, result: { count: 0, entries: [] } },
    { method: 'getNetwork', params: {}, result: { count: 1, requests: [{ t, method: 'GET', url: api, status: 200, type: 'Fetch' }] } },
  ];
  return { shot, shotCall, checks };
}
const opening = [{ method: 'session.create', params: { sessionId: S.sessionId }, result: { ...S } }, { method: 'openTab', params: { url: URL_ }, result: { tabId: 7, sessionId: S.sessionId } },
  { method: 'getPageIdentity', params: {}, result: { build: BUILD } }];

// TC-A: the list, then Submit with the write held (U1/U2), then the probe of the Submit click as frames.trial calls
// after the recording, then env.reset. On a Dragon without R1a: help shows none, and the draft says so.
function caseA({ SD, defect, work, trialCalls, canaryAction, variant, r1a = true, missClick = false, sortClaim = false, entryTrialCalls = null }) {
  const { shot, shotCall, checks } = stateCalls({ caseId: 'TC-A', seed: defect ? 7 : 3, work });
  const list = shot('ideal'), after = shot('partial');
  const t0 = variant.trials[0].markT - 20000;
  const draft = { case_id: 'TC-A', summary: { function: 'The order list loads and Submit sends the order.', ui: 'Checked.' }, states: [
    { state: 'ideal', screenshot: 'TC-A-ideal.png', gate0: 'g0', target: 'target', console: true, network: true, assertions: [{ assertion_id: 'TC-A-A1', verdict: 'PASS' }], vision: allPass },
    { state: 'partial', screenshot: 'TC-A-partial.png', gate0: 'g0', target: 'target', console: true, network: true, assertions: [{ assertion_id: 'TC-A-A2', verdict: 'PASS' }], vision: allPass,
      ...(r1a ? { transient: sortClaim ? { action: { method: 'click', selector: '#go', target: { tag: 'button', label: 'Sort by date' } }, repeatable: false } : { action: canaryAction('T5') }, ux: ['U1', 'U2'] } : { detectors: { unavailable: { transient: 'DRAGON_R1A_UNAVAILABLE', ux: 'DRAGON_R1A_UNAVAILABLE' } } }) }] };
  if (!r1a) {
    const calls = [...opening, ...helpCalls({ r1a: false }), shotCall('ideal', list, URL_), ...checks('ideal', 1000),
      { method: 'do', params: { steps: [{ clickSelector: '#submit', fast: false }, { waitFor: { text: 'Order saved' } }] }, result: { completed: true, results: [{ step: 'clickSelector', ok: true, receipt: { ts: 2000 } }, { step: 'waitFor', ok: true }] } },
      shotCall('partial', after, URL_), ...checks('partial', 2100)];
    return { text: streamOf(calls, { marker: DRAFT_MARKER, draft }), draft };
  }
  const held = heldWriteCalls(defect, t0, 'TC-A');
  // The recorded trials, their kept frames as files Dragon wrote.
  // Fix round 2 (E3): every trial carries its setup and the state it belongs to; `missClick` makes the first trial's click miss.
  const alter = missClick ? (n, params, answer) => (n === 0 ? { answer: { ...answer, do: { completed: false, brief: true, results: [{ step: 'clickSelector', ok: false, code: 'CLICK_TARGET_NOT_FOUND' }] } } } : null) : null;
  const probe = trialCalls(variant, { tabId: 7, selector: '#go', state: 'partial', alter }).map((c) => {
    if (c.method !== 'frames.trial') return c;
    const frameDir = join(work, 'frames', `TC-A-${c.result.frames.windowId}`);
    mkdirSync(frameDir, { recursive: true });
    const frames = c.result.frames.frames.map((f) => { const file = `f-${String(f.seq).padStart(5, '0')}.jpg`; writeFileSync(join(frameDir, file), `TC-A frame ${f.seq}`); return { ...f, file, sha256: sha(`TC-A frame ${f.seq}`) }; });
    return { ...c, result: { ...c.result, frames: { ...c.result.frames, dir: frameDir, frames } } };
  });
  const calls = [...opening, ...helpCalls({ r1a: true }), shotCall('ideal', list, URL_), ...checks('ideal', t0 - 3000), ...held.calls,
    shotCall('partial', after, URL_, held.conditions), ...checks('partial', t0 + 1600),
    { method: 'helpers.define', params: { helpers: SD.helperDefinitions(['sample']) }, result: { ok: true, defined: [SD.STREAM_HELPERS.sample.name] } }, ...probe,
    { method: 'env.reset', params: {}, result: { ok: true, reason: 'reset', endedCase: 'TC-A', atDefault: true, restored: ['requests'], released: 0, sensors: null, frames: null, errors: [], mismatches: [],
      readback: { page: { onLine: true } }, conditions: { ...held.conditions, caseId: null, requests: [], verified: true } } },
    // Round G (G5): the entry probe of /orders (S1), after the case's envReset.
    ...(entryTrialCalls ? entryTrialCalls({ url: URL_, screenId: 'S1', tabId: 7 }) : [])];
  return { text: streamOf(calls, { marker: DRAFT_MARKER, draft }), draft };
}
// TC-B: the list of /orders (static), and the exploration of the screen when R1a is there.
function caseB({ SD, defect, work, r1a = true, caseId = 'TC-B', url = `${URL_}/`, entryTrialCalls = null, screenId = 'S1', screenUrl = URL_ }) {
  const { shot, shotCall, checks } = stateCalls({ caseId, seed: defect ? 5 : 2, work });
  const list = shot('ideal');
  // E1: TC-B's state is on /orders/ (a trailing slash), the screen's route is /orders. The exploration is TC-B's.
  const explores = r1a && caseId === 'TC-B';
  // E6: a cell case's section has the exploration, so the executor checks help before any R1a tool.
  const calls = [...opening, ...helpCalls({ r1a }), shotCall('ideal', list, url), ...checks('ideal', 1000), ...(explores ? exploreCalls(SD) : []),
    ...(r1a && entryTrialCalls ? entryTrialCalls({ url: screenUrl, screenId, tabId: 7 }) : [])];
  const draft = { case_id: caseId, summary: { function: 'The list shows the orders.', ui: 'Checked.' }, states: [
    { state: 'ideal', screenshot: `${caseId}-ideal.png`, gate0: 'g0', target: 'target', console: true, network: true, ...(explores ? { explore: true } : {}), assertions: [{ assertion_id: `${caseId}-A1`, verdict: 'PASS' }], vision: allPass }] };
  return { text: streamOf(calls, { marker: DRAFT_MARKER, draft }), draft };
}
// TC-C: step 2 of the wizard (its ideal state), reached by clicks (no route: its screen checks are N/A).
function caseC({ work }) {
  const { shot, shotCall, checks } = stateCalls({ caseId: 'TC-C', seed: 4, work });
  const step2 = shot('ideal');
  const calls = [...opening, { method: 'do', params: { steps: [{ goto: WIZARD }, { clickSelector: '#next', fast: false }] }, result: { completed: true, results: [{ step: 'goto', ok: true }, { step: 'clickSelector', ok: true }] } },
    shotCall('ideal', step2, WIZARD), ...checks('ideal', 1000, `${ORIGIN}/api/wizard`)];
  const draft = { case_id: 'TC-C', summary: { function: 'Step 2 shows the address form.', ui: 'Checked.' }, states: [
    { state: 'ideal', screenshot: 'TC-C-ideal.png', gate0: 'g0', target: 'target', console: true, network: true, assertions: [{ assertion_id: 'TC-C-A1', verdict: 'PASS' }], vision: allPass }] };
  return { text: streamOf(calls, { marker: DRAFT_MARKER, draft }), draft };
}

function board(cases) {
  return {
    schemaVersion: 6, canonicalVersion: 'qa-board-teamwork/v2', boardKind: 'team-qa-board', rev: 1, boardId: RUN_ID, title: 'Detector fixture', boardCreated: '2026-11-04T04:00:00.000Z',
    language: 'en', deepCheck: 'available', app: 'shop', envDb: 'TEST / fixture', viewport: '1280x800', runUuid: RUN_UUID, targetBindingSha256: TB, build: BUILD,
    env: 'test', db: 'fixture', role: 'qa-agent', testProfile: 'detectors', evidenceManifest: [], currentRound: 1,
    sourceItems: [{ id: 'SRC-1', kind: 'spec', sourceSystem: 'fixture', externalKey: 'REQ-1', title: 'Orders', origin: 'upstream' }],
    cases: cases.map((id) => ({ id, title: `Orders ${id}`, requirement: 'REQ-1', requirements: ['REQ-1'], sourceRefs: ['SRC-1'], steps: 'Open orders, submit.', expected: 'Saved.',
      status: 'TODO', priority: 'P1', assignee: 'qa-agent', machine: { rule: 'detectors', selector: '#submit' }, kind: 'static', states: [], evidence: [], results: [], comments: [], history: [] })),
    defects: [], rounds: [{ round: 1, startedAt: '2026-11-04T04:00:00.000Z', scope: 'detectors' }],
    coverage: ['happy', 'boundary', 'empty', 'loading', 'error', 'auth-role', 'navigation', 'keyboard', 'responsive', 'dark-mode'].map((area) => ({ area, status: 'tick' })),
    untested: [], release: { verdict: 'NO-GO', risks: ['fixture'] },
  };
}

// The run directory of a fixture run: tracked plan (coverage block; TC-A behavioral with U1/U2 forced by `data.ux`, TC-B
// static, both on /orders; TC-C without a route), signed plan, binding, board. `collectScreen(stream)` runs `teamqa web
// collect-screen` on the S1 screen check stream; `collect(caseId, stream)` runs `teamqa web collect` on one case.
function fixtureRun({ evidenceTools, detectorTools, cases = CASES, sortClaim = false, trackedCases = null }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-detectors-e2e-')));
  const runDir = join(base, 'runs', RUN_ID), work = join(base, 'dragon');
  mkdirSync(work, { recursive: true }); mkdirSync(runDir, { recursive: true });
  const write = (rel, text) => { mkdirSync(dirname(join(runDir, rel)), { recursive: true }); writeFileSync(join(runDir, rel), text); return join(runDir, rel); };
  const planned = (id, over) => ({ id, title: `Orders (${id})`, req_id: 'REQ-1', sourceRefs: ['SRC-1'], lane: 'gui', expected: "The page shows 'Order saved'", priority: 'P1', taxonomy: ['functional'],
    viewports: ['desktop'], ...over });
  const tracked = trackedCases ? { schemaVersion: 2, sourceItems: [{ id: 'SRC-1', kind: 'story', sourceSystem: 'tracker', externalKey: 'SHOP-9', title: 'Product groups', origin: 'upstream' }],
    cases: trackedCases.map((c) => planned(c.id, c)) } : { schemaVersion: 2, sourceItems: [{ id: 'SRC-1', kind: 'story', sourceSystem: 'tracker', externalKey: 'SHOP-9', title: 'Orders can be submitted once', origin: 'upstream' }],
    coverage: { version: 'team-qa/coverage-cells/v1', rows: [{ id: 'desktop-1280', size: '1280x800', classes: ['desktop'] }], dataScreens: ['/orders'] },
    cases: [planned('TC-A', { kind: 'behavioral', steps: ['Open the orders page', sortClaim ? "Click 'Sort by date'" : "Click 'Submit'"], data: { ux: ['U1', 'U2'], reset: ['Delete the order the trial created'] }, states: ['ideal', 'partial'], route: '/orders' }),
      planned('TC-B', { kind: 'static', steps: ['Open the orders page'], data: {}, states: ['ideal'], route: '/orders' }),
      planned('TC-C', { kind: 'static', steps: ['Open the wizard', "Click 'Next'"], data: {}, states: ['ideal'] }),
      ...(cases.includes('TC-Q') ? [planned('TC-Q', { kind: 'static', steps: ['Open the second tab of the orders'], data: {}, states: ['ideal'], route: '/orders?tab=2' })] : [])] };
  const trackedText = `${JSON.stringify(tracked, null, 2)}\n`;
  write('tracked-plan.json', trackedText);
  write('docs-lock.json', JSON.stringify({ artifacts: { tracked: { path: 'tracked-plan.json', sha256: sha(trackedText) } } }));
  write('test-plan.md', `# Plan\n\nTEAMQA_PLAN_START\n${JSON.stringify({ run_id: RUN_ID, app: 'shop', plan_version: 1, lanes: [{ id: 'gui', scope: ['REQ-1'], parallel_ok: false, vi_sao: '' }],
    tiers: { 'REQ-1': 'FULL' }, exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 0 } }, null, 2)}\nTEAMQA_PLAN_END\n`);
  const binding = { run_uuid: RUN_UUID, target_binding_sha256: TB, target: { frontend_build: { id: BUILD }, version: BUILD, environment: 'test', preview_url: URL_ } };
  write('binding.json', JSON.stringify(binding));
  write('preflight.json', '{}');
  const boardFile = write('board/qa-board.json', JSON.stringify(board(cases)));
  const common = {
    readJson: (p) => JSON.parse(readFileSync(p, 'utf8')), writeConfirmed: async (p, value) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, value); },
    stableJson: (v) => `${JSON.stringify(v, null, 2)}\n`, fail: (exit, code, detail) => { throw Object.assign(new Error(`${code} ${detail}`), { code }); },
    runDirectory: () => runDir, safeRunId: (v) => v, detectorTools };
  // Team QA's verifier stands in as "read the attestation file" (each dispatch's attestation is written below).
  const assertRoleAttestation = ({ attestationPath }) => JSON.parse(readFileSync(attestationPath, 'utf8'));
  let screenAttempts = 0;
  const collectScreen = (text, screenId = 'S1') => {
    const attempt = `screen-${screenId}-${++screenAttempts}`, rel = `dispatch/executor_gui/${attempt}/stdout.jsonl`;
    write(rel, text);
    const file = write(`attestations/${attempt}.json`, JSON.stringify({ role: 'executor_gui', session_id: attempt, dispatch_screen_id: screenId, source: { kind: 'claude-stream', path: rel, sha256: sha(Buffer.from(text, 'utf8')) } }));
    return webCollectScreen(['--run', RUN_ID, '--attestation', file], { ...common, parseFlags: (args) => ({ run: args[1], attestation: args[3] }), assertRoleAttestation });
  };
  const collect = (caseId, text) => {
    const rel = `dispatch/executor_gui/${caseId}/stdout.jsonl`;
    write(rel, text);
    const file = write(`attestations/case-${caseId}.json`, JSON.stringify({ role: 'executor_gui', source: { kind: 'claude-stream', path: rel, sha256: sha(Buffer.from(text, 'utf8')) }, dispatch_case_id: caseId, roster_hash: 'r' }));
    return webCollect(['--run', RUN_ID, '--attestation', file, '--board', boardFile], { ...common, evidenceTools,
      parseFlags: (args) => ({ run: args[1], attestation: args[3], board: args[5] }), assertRoleAttestation });
  };
  return { base, runDir, work, write, boardFile, binding, collect, collectScreen };
}
const gateContext = (cases, binding) => ({ kind: 'deployed-build', binding: { run_uuid: RUN_UUID }, targetBindingSha256: TB, target: binding.target, taskBase: null, exactFinalSha: null,
  activeGuiRequirements: [{ id: 'REQ-1', acceptance_ids: cases, risk_dimensions: [], evidence_contract: { allowed_types: ['gui-screenshot', 'gui-recording'] } }], guiIds: ['REQ-1'],
  planById: new Map(cases.map((id) => [id, { requirementId: 'REQ-1', data: {} }])) });

// One fixture run of the whole plan: the screen check, then the three cases, then QA GUI's gate on the board.
// Options (fix round 2): `screens` lists the S1 attempts in order ('login': the screen check landed on the sign-in page;
// 'ok'; fix round 3: 'overlay-login' only the overlay check landed there, 'no-r1a' an attempt on a Dragon without R1a,
// 'shot-a' / 'shot-b' attempts whose band screenshot Dragon saved under the same name with other bytes); `query` adds TC-Q on /orders?tab=2 with its own screen S2; `missClick` makes TC-A's first trial miss its target;
// `sortClaim` makes TC-A's action a sort the executor calls not repeatable.
async function runPlan({ defect, r1a = true, screens = ['ok'], query = false, missClick = false, sortClaim = false }) {
  const SD = await qa('scripts/lib/stream-detectors.mjs');
  const { checkGuiReleaseTruthV2 } = await qa('scripts/lib/qa-gui-v2.mjs');
  const { trialCalls, entryTrialCalls } = await qa('test/support/recipe-calls.mjs');
  const { canaryAction } = await qa('test/support/r1d-recorder.mjs');
  const recorded = JSON.parse(gunzipSync(readFileSync(join(QA_GUI, 'test/fixtures/r1d/recorded/T5.json.gz'))).toString('utf8'));
  const evidenceTools = await qaGuiEvidenceTools(QA_GUI);
  const detectorTools = await qaGuiDetectorTools(QA_GUI);
  assert.ok(evidenceTools && detectorTools, 'QA GUI evidence and stream detector tools');
  const cases = query ? [...CASES, 'TC-Q'] : CASES;
  const run = fixtureRun({ evidenceTools, detectorTools, cases, sortClaim });
  let screen = null, screenOut = null;
  const screenOuts = [];
  for (const kind of screens) {
    const over = { login: { href: `${ORIGIN}/login` }, 'overlay-login': { overlayHref: `${ORIGIN}/login` }, 'no-r1a': { r1a: false },
      'shot-a': { capture: { work: run.work, content: 'band capture, attempt A' } }, 'shot-b': { capture: { work: run.work, content: 'band capture, attempt B' } } }[kind] ?? {};
    screen = screenStream({ SD, defect, r1a, ...over });
    screenOuts.push(screenOut = await run.collectScreen(screen.text));
  }
  if (query) screenOuts.push(await run.collectScreen(screenStream({ SD, defect, r1a, screenId: 'S2', url: `${URL_}?tab=2` }).text, 'S2'));
  const variant = recorded.variants.find((v) => v.at === 300 && v.clean === !defect);
  const streams = { 'TC-A': caseA({ SD, defect, work: run.work, trialCalls, canaryAction, variant, r1a, missClick, sortClaim, entryTrialCalls }), 'TC-B': caseB({ SD, defect, work: run.work, r1a, entryTrialCalls }), 'TC-C': caseC({ work: run.work }),
    ...(query ? { 'TC-Q': caseB({ SD, defect, work: run.work, r1a, caseId: 'TC-Q', url: `${URL_}?tab=2#top`, entryTrialCalls, screenId: 'S2', screenUrl: `${URL_}?tab=2` }) } : {}) };
  const collected = {};
  for (const caseId of cases) {
    const out = await run.collect(caseId, streams[caseId].text);
    assert.equal(out.cases.length, 1);
    collected[caseId] = out.cases[0];
  }
  const boardData = JSON.parse(readFileSync(run.boardFile, 'utf8'));
  const gate = checkGuiReleaseTruthV2({ data: boardData, boardPath: run.boardFile, evidenceRoot: run.runDir, context: gateContext(cases, run.binding) });
  const receiptOf = (caseId, state) => JSON.parse(readFileSync(join(run.runDir, `evidence/qa-gui/${caseId}/${state}.receipt.json`), 'utf8'));
  return { ...run, SD, screen, screenOut, screenOuts, streams, collected, boardData, gate, messages: gate.issues.map((i) => i.message), receiptOf };
}
const of = (messages, caseId) => messages.filter((m) => m.includes(`${caseId}:`) || m.includes(`:${caseId}`));

test('end to end, planted defects: the screen check finds the band once and both cases on /orders carry it, the probe catches the flash, the case without a route is N/A; the report shows cells and adjudication, no ladder row with every flag off',
  { skip: SKIP }, async () => {
    const r = await runPlan({ defect: true });
    // 1. The screen check of /orders, collected once, graded by QA GUI from helper calls that prove its helpers.
    assert.deepEqual([r.screenOut.screen, r.screenOut.status, r.screenOut.verdict], ['S1', 'checked', 'FAIL']);
    const screenResult = JSON.parse(readFileSync(join(r.runDir, 'screens/S1/result.json'), 'utf8'));
    assert.deepEqual(screenResult.sweep.bands.map((b) => [b.id, b.from, b.to]), [['W2|div.shell > main', 741, 783]]);
    assert.ok(screenResult.issues.some((code) => /SWEEP_BAND_FAIL:W2\|div\.shell > main:741-783/.test(code)), screenResult.issues.join('\n'));
    // D8: the screen check is one dispatch of at most 25 calls.
    assert.ok(r.screen.calls.length <= 25, `screen check calls: ${r.screen.calls.length}`);
    // 2. What each case's collect reports.
    assert.deepEqual(r.collected['TC-A'].issues.filter((x) => !x.startsWith('PROBE:')), ['DETECTOR_NOT_RUN:TC-A:explore'], r.collected['TC-A'].issues.join('\n'));
    assert.deepEqual(r.collected['TC-B'].issues.filter((x) => !x.startsWith('PROBE:')), [], r.collected['TC-B'].issues.join('\n'));
    assert.deepEqual(r.collected['TC-C'].issues, ['SCREEN_NO_ROUTE:TC-C']);
    // 3. The screen's probes ride the first state of each case on /orders; the transient probe rides TC-A's partial state.
    const idealA = r.receiptOf('TC-A', 'ideal'), partialA = r.receiptOf('TC-A', 'partial'), listB = r.receiptOf('TC-B', 'ideal'), stepC = r.receiptOf('TC-C', 'ideal');
    assert.deepEqual(idealA.probes.map((p) => p.kind), ['width-sweep', 'overlay-check', 'entry']);
    assert.deepEqual(listB.probes.map((p) => p.kind), ['width-sweep', 'overlay-check', 'entry']);
    assert.deepEqual(partialA.probes.map((p) => p.kind), ['transient']);
    assert.equal(Object.hasOwn(stepC, 'probes'), false);
    for (const p of [...idealA.probes, ...partialA.probes, ...listB.probes]) {
      assert.equal(sha(readFileSync(join(r.runDir, p.path))), p.sha256, p.path);
      assert.equal(r.boardData.evidenceManifest.find((m) => m.path === p.path)?.sha256, p.sha256);
    }
    const probe = JSON.parse(readFileSync(join(r.runDir, partialA.probes[0].path), 'utf8'));
    assert.equal(probe.trials.length, 3);
    const kept = probe.trials.flatMap((t) => t.frames.kept);
    assert.ok(kept.length > 0 && kept.every((f) => existsSync(join(r.runDir, f.file)) && sha(readFileSync(join(r.runDir, f.file))) === f.sha256), 'kept frames copied hash for hash');
    assert.deepEqual(partialA.env.conditions.requests.map((x) => x.action), ['hold']);
    assert.equal(partialA.env.reset.evidence_ref, 'evidence/qa-gui/TC-A/env-reset.json');
    assert.deepEqual(JSON.parse(partialA.ui.uiSanity.evidence).issues.map((i) => [i.id, i.sev]), [['U1', 'warn'], ['U2', 'warn']]);
    // 4. QA GUI's gate: the band is a finding of TC-A and TC-B (one screen check), the flash of TC-A, nothing of TC-C.
    assert.deepEqual(r.messages.filter((m) => /VERDICT_MISMATCH/.test(m)), [], 'collect wrote the verdicts the gate computes');
    for (const finding of [/^PROBE:TC-A:ideal:SWEEP_BAND_FAIL:W2\|div\.shell > main:741-783:/, /^PROBE:TC-B:ideal:SWEEP_BAND_FAIL:W2\|div\.shell > main:741-783:/,
      /^PROBE:TC-A:partial:TRANSIENT_T5:/, /^PROBE:TC-A:ideal:OVERLAY_O3_FAIL:/, /^PROBE:TC-A:ideal:OVERLAY_O7_FAIL:/, /^PROBE:TC-B:ideal:OVERLAY_O3_FAIL:/]) {
      assert.ok(r.messages.some((m) => finding.test(m)), `${finding}: ${r.messages.join('\n')}`);
    }
    assert.ok(r.messages.includes('CASE_RECEIPT_SEMANTIC_FAIL:TC-A') && r.messages.includes('CASE_RECEIPT_SEMANTIC_FAIL:TC-B'));
    assert.deepEqual(of(r.messages, 'TC-C').filter((m) => /^PROBE:|SEMANTIC_FAIL|UNGRADED|ENV_|CELL_/.test(m)), [], 'the case without a route');
    const caseOf = (id) => r.boardData.cases.find((c) => c.id === id);
    assert.deepEqual(['TC-A', 'TC-B', 'TC-C'].map((id) => [caseOf(id).uiVerdict, caseOf(id).functionVerdict]), [['FAIL', 'PASS'], ['FAIL', 'PASS'], ['PASS', 'PASS']]);
    assert.equal(caseOf('TC-C').status, 'PASS');

    // 5. Team QA's report: the coverage cells (with the probes' sealed cells), the adjudicator's shadow fields, the Speed section.
    const states = { 'TC-A': ['ideal', 'partial'], 'TC-B': ['ideal'], 'TC-C': ['ideal'] };
    const records = CASES.map((caseId) => {
      const clean = caseId === 'TC-C';
      return { case_id: caseId, lane: 'gui', verdict: clean ? 'pass' : 'fail', function_verdict: 'pass', ui_visual_verdict: clean ? 'pass' : 'fail', evidence: states[caseId].map((s) => `evidence/qa-gui/${caseId}/${s}.receipt.json`),
        source: 'qa-gui', run_id: RUN_ID, ts: '2026-11-04T05:05:00.000Z', attempt: 1, attempt_id: `${caseId}#1`, started_at: '2026-11-04T05:00:00.000Z', ended_at: '2026-11-04T05:05:00.000Z', timeout_ms: 600000,
        reason: clean ? 'QA_GUI_PASS' : 'QA_GUI_FAIL', traceabilityVersion: 'team-qa/source-traceability/v1', sourceRefs: ['SRC-1'] };
    });
    r.write('board.jsonl', `${records.map((x) => JSON.stringify(x)).join('\n')}\n`);
    const attestation = r.write('attestations/executor_gui-TC-C.json', JSON.stringify({ schema: 'team-qa/role-attestation/v1', run_id: RUN_ID, round: 1, role: 'executor_gui', session_id: 'exec-det',
      dispatch_case_id: 'TC-C', source: { kind: 'claude-stream', path: join(r.runDir, 'dispatch/executor_gui/TC-C/stdout.jsonl'), sha256: sha(Buffer.from(r.streams['TC-C'].text, 'utf8')) }, graded: true }));
    const adjudicated = await adjudicateCase({ runDir: r.runDir, caseId: 'TC-C', seat: SEAT, engine: fakeEngine({ mode: 'honest' }), attestationPath: attestation, boardPath: r.boardFile, evidencePaths: [] });
    assert.ok(['CONFIRM', 'CONTEST', 'ABSTAIN'].includes(adjudicated.outcome));
    // The report of this fixture run is a historical diagnostic (no roster): the minimal binding web collect read is not
    // the signed web binding the report would verify, so it is set aside.
    copyFileSync(join(r.runDir, 'binding.json'), join(r.runDir, 'inputs-binding.fixture.json'));
    rmSync(join(r.runDir, 'binding.json'));
    const cli = (args) => spawnSync(process.execPath, [join(ROOT, 'scripts/teamqa.mjs'), ...args], { cwd: dirname(dirname(r.runDir)), encoding: 'utf8', env: { ...process.env, TEAMQA_QA_GUI_ROOT: QA_GUI } });
    for (const args of [['gate', 'approve', '--run', RUN_ID, '--plan', join(r.runDir, 'test-plan.md'), '--signed-by', 'owner', '--ts', '2026-11-04T04:30:00.000Z'],
      ['rtm', 'build', '--plan', join(r.runDir, 'test-plan.md'), '--tracked', join(r.runDir, 'tracked-plan.json'), '--out', join(r.runDir, 'rtm.md')],
      ['rtm', 'fill', '--rtm', join(r.runDir, 'rtm.md'), '--board', join(r.runDir, 'board.jsonl'), '--out', join(r.runDir, 'rtm.md')],
      ['report', 'build', '--run', RUN_ID]]) {
      const out = cli(args);
      // The run holds planted P1 defects, so the report's decision is NO_GO: `report build` writes it and exits 1.
      assert.equal(out.status, args[0] === 'report' ? 1 : 0, `${args.slice(0, 2).join(' ')}: ${out.stderr || out.stdout}`);
      if (args[0] === 'report') assert.match(out.stdout + out.stderr, /decision=NO_GO .*product_defects=2/);
    }
    const reportText = readFileSync(join(r.runDir, 'summary-report.md'), 'utf8');
    const report = JSON.parse(/TEAMQA_REPORT_START\s*([\s\S]*?)\s*TEAMQA_REPORT_END/.exec(reportText)[1]);
    assert.ok(report.coverage_cells && report.coverage_cells.coarse.cells > 0, JSON.stringify(report.coverage_cells));
    const map = JSON.parse(readFileSync(join(r.runDir, 'coverage-map.json'), 'utf8'));
    assert.ok(map.cells.some((cell) => cell.receipts?.some((x) => x.kind === 'probe')), 'the probes\' sealed cells are counted');
    assert.match(reportText, /## Adjudicator \(shadow\)/);
    assert.equal(report.adjudication.mode, 'shadow');
    assert.ok(report.adjudication.cases.some((c) => c.case_id === 'TC-C'));
    // D6 (fix round 2): with every speed flag off the adjudication writes no cost-ladder row, so the report has no Speed section.
    assert.doesNotMatch(reportText, /## Speed/);
    assert.equal(existsSync(join(r.runDir, 'decisions.jsonl')), false, 'no ladder row with the cost ladder off');
  });

test('end to end, the clean twin: the same plan on the fixed app has no finding on any case', { skip: SKIP }, async () => {
  const r = await runPlan({ defect: false });
  assert.deepEqual([r.screenOut.status, r.screenOut.verdict, r.screenOut.issues], ['checked', 'PASS', []]);
  assert.deepEqual(r.collected['TC-A'].issues.filter((x) => !x.startsWith('PROBE:')), ['DETECTOR_NOT_RUN:TC-A:explore']);
  assert.deepEqual(r.collected['TC-B'].issues, []);
  assert.deepEqual(r.collected['TC-C'].issues, ['SCREEN_NO_ROUTE:TC-C']);
  assert.deepEqual(r.messages.filter((m) => /^PROBE:|SEMANTIC_FAIL|UNGRADED|VERDICT_MISMATCH|ENV_|CELL_/.test(m)), [], r.messages.join('\n'));
  assert.deepEqual(r.boardData.cases.map((c) => [c.id, c.status, c.uiVerdict]), [['TC-A', 'PASS', 'PASS'], ['TC-B', 'PASS', 'PASS'], ['TC-C', 'PASS', 'PASS']]);
  assert.deepEqual(JSON.parse(r.receiptOf('TC-A', 'partial').ui.uiSanity.evidence).issues, []);
  assert.deepEqual(r.gate.computed.cells.filter((c) => c.case_id === 'TC-A').map((c) => [c.state, c.condition, c.verdict]), [['ideal', 'default', 'PASS'], ['partial', 'request=hold', 'PASS']]);
});

test('end to end on a Dragon without R1a: help (saved to a file) shows none, the screen check and the probe are reported, the gate grades everything 1.15.1 graded and nothing is UNGRADED',
  { skip: SKIP }, async () => {
    const r = await runPlan({ defect: false, r1a: false });
    const NO_R1A = 'DRAGON_R1A_UNAVAILABLE';
    assert.deepEqual([r.screenOut.status, r.screenOut.verdict], ['unavailable', null]);
    // E6: the exploration needs R1a (its helpers): skipped and reported, as the probe and the screen check are.
    // Round G (G5): the entry probe of S1 needs R1a too: reported, as the probe is.
    assert.deepEqual(r.collected['TC-A'].issues, [`DETECTOR_UNAVAILABLE:TC-A:partial:transient:${NO_R1A}`, `DETECTOR_UNAVAILABLE:TC-A:partial:ux:${NO_R1A}`, `SCREEN_CHECK_UNAVAILABLE:S1:${NO_R1A}`,
      `DETECTOR_UNAVAILABLE:TC-A:entry:${NO_R1A}`, `DETECTOR_UNAVAILABLE:TC-A:explore:${NO_R1A}`]);
    assert.deepEqual(r.collected['TC-B'].issues, [`SCREEN_CHECK_UNAVAILABLE:S1:${NO_R1A}`, `DETECTOR_UNAVAILABLE:TC-B:entry:${NO_R1A}`, `DETECTOR_UNAVAILABLE:TC-B:explore:${NO_R1A}`]);
    // E6 (QG2-2): TC-B's case section asks for help before helpersDefine, and says the exploration is skipped without R1a.
    const section = await dispatchDetectorSection({ runDir: r.runDir, caseId: 'TC-B', tools: await qaGuiDetectorTools(QA_GUI) });
    assert.ok(section.indexOf('Call help once') >= 0 && section.indexOf('Call help once') < section.indexOf('helpersDefine {'), section);
    assert.match(section, /the exploration too: it is reported/);
    assert.deepEqual(r.collected['TC-C'].issues, ['SCREEN_NO_ROUTE:TC-C']);
    const partial = r.receiptOf('TC-A', 'partial');
    assert.deepEqual([Object.hasOwn(partial, 'probes'), Object.hasOwn(partial, 'env'), Object.hasOwn(r.receiptOf('TC-A', 'ideal'), 'probes')], [false, false, false]);
    // QA GUI's own result shape: U1 and U2 UNGRADED with the reason, not required, so the state keeps its verdict.
    const folded = JSON.parse(partial.ui.uiSanity.evidence);
    assert.deepEqual(Object.entries(folded.ux.rules).map(([id, x]) => [id, x.verdict, x.reason]), [['U1', 'UNGRADED', NO_R1A], ['U2', 'UNGRADED', NO_R1A]]);
    assert.deepEqual([folded.verdict, partial.ui.verdict], ['PASS', 'PASS']);
    // QA GUI's gate grades the board as it would have on 1.15.1: every case PASS, nothing ungraded, the cells at their defaults.
    assert.deepEqual(r.boardData.cases.map((c) => [c.id, c.status, c.functionVerdict, c.uiVerdict]), [['TC-A', 'PASS', 'PASS', 'PASS'], ['TC-B', 'PASS', 'PASS', 'PASS'], ['TC-C', 'PASS', 'PASS', 'PASS']]);
    assert.deepEqual(r.messages.filter((m) => /^PROBE:|SEMANTIC_FAIL|UNGRADED|VERDICT_MISMATCH|ENV_|CELL_/.test(m)), [], r.messages.join('\n'));
    // The cells of the cell cases (TC-C has no route, so no cell).
    assert.deepEqual(r.gate.computed.cells.map((c) => [c.case_id, c.state, c.condition, c.verdict]),
      [['TC-A', 'ideal', 'default', 'PASS'], ['TC-A', 'partial', 'default', 'PASS'], ['TC-B', 'ideal', 'default', 'PASS']]);
  });

// ── fix round 2 ─────────────────────────────────────────────────────────────────────────────────────────────────
test('fix round 2, E1/E2: a screen check that landed on the sign-in page grades nothing and its cases are UNGRADED; a later attempt is kept beside it and folded',
  { skip: SKIP }, async () => {
    const lost = await runPlan({ defect: true, screens: ['login'] });
    assert.equal(lost.screenOut.verdict, 'UNGRADED');
    assert.ok(lost.screenOut.issues.includes('SCREEN_ROUTE_MISMATCH:sweep:/login'), lost.screenOut.issues.join(', '));
    for (const id of ['TC-A', 'TC-B']) {
      assert.ok(lost.collected[id].issues.includes('SCREEN_CHECK_UNGRADED:S1'), `${id}: ${lost.collected[id].issues.join(', ')}`);
      assert.equal(lost.boardData.cases.find((c) => c.id === id).uiVerdict !== 'PASS', true, id);
    }
    // Round G: only the case's own entry probe; the sign-in page is no finding of /orders.
    assert.deepEqual(lost.receiptOf('TC-B', 'ideal').probes.map((p) => p.kind), ['entry'], 'the sign-in page is no finding of /orders');
    const retried = await runPlan({ defect: true, screens: ['login', 'ok'] });
    assert.deepEqual(readdirSync(join(retried.runDir, 'screens/S1/attempts')).length, 2, 'both attempts are kept');
    assert.deepEqual(retried.receiptOf('TC-B', 'ideal').probes.map((p) => p.kind), ['width-sweep', 'overlay-check', 'entry'], 'TC-B on /orders/ carries the screen');
    assert.ok(retried.messages.some((m) => /^PROBE:TC-B:ideal:SWEEP_BAND_FAIL:/.test(m)), retried.messages.join('\n'));
  });

test('fix round 2, E1: a screen route with a query is folded into the case on that query (hash dropped)', { skip: SKIP }, async () => {
  const r = await runPlan({ defect: true, query: true });
  assert.deepEqual(r.screenOuts.map((o) => [o.screen, o.status]), [['S1', 'checked'], ['S2', 'checked']]);
  assert.deepEqual(r.receiptOf('TC-Q', 'ideal').probes.map((p) => p.kind), ['width-sweep', 'overlay-check', 'entry']);
  assert.ok(r.messages.some((m) => /^PROBE:TC-Q:ideal:SWEEP_BAND_FAIL:/.test(m)), r.messages.join('\n'));
  assert.equal(r.collected['TC-Q'].issues.some((c) => /SCREEN_NOT_VISITED|DETECTOR_NOT_RUN:TC-Q:screens/.test(c)), false, r.collected['TC-Q'].issues.join(', '));
});

test('fix round 2, E3: a probe whose first trial\'s click missed is UNGRADED, never a PASS on the trials that ran', { skip: SKIP }, async () => {
  const r = await runPlan({ defect: false, missClick: true });
  const probe = JSON.parse(readFileSync(join(r.runDir, r.receiptOf('TC-A', 'partial').probes[0].path), 'utf8'));
  assert.deepEqual(probe.attempts.map((a) => [a.ok, a.code]), [[false, 'TRANSIENT_ACTION_NOT_RUN'], [true, null], [true, null]]);
  assert.ok(r.messages.some((m) => /TRANSIENT_ATTEMPT_NOT_RUN:trial-0:TRANSIENT_ACTION_NOT_RUN/.test(m)), r.messages.join('\n'));
  assert.equal(r.boardData.cases.find((c) => c.id === 'TC-A').uiVerdict, 'UNGRADED');
  assert.deepEqual(r.messages.filter((m) => /VERDICT_MISMATCH/.test(m)), []);
});

test('fix round 2, E3: an executor that calls a sort not repeatable changes nothing: the probe is UNGRADED REPEATS_REQUIRED', { skip: SKIP }, async () => {
  const r = await runPlan({ defect: false, sortClaim: true });
  const probe = JSON.parse(readFileSync(join(r.runDir, r.receiptOf('TC-A', 'partial').probes[0].path), 'utf8'));
  assert.deepEqual([probe.action.repeatable, probe.action.claimed, probe.action.kinds.includes('list-sort')], [true, false, true]);
  assert.ok(r.messages.some((m) => /TRANSIENT_REPEATS_REQUIRED:claimed-not-repeatable/.test(m)), r.messages.join('\n'));
  assert.equal(r.boardData.cases.find((c) => c.id === 'TC-A').uiVerdict, 'UNGRADED');
});

// ── fix round 3 ─────────────────────────────────────────────────────────────────────────────────────────────────
test('fix round 3, F5: a screen check whose overlay legs landed on the sign-in page keeps its sweep FAIL on the screen; only the overlay check is UNGRADED',
  { skip: SKIP }, async () => {
    const r = await runPlan({ defect: true, screens: ['overlay-login'] });
    assert.equal(r.screenOut.verdict, 'FAIL');
    assert.ok(r.screenOut.issues.includes('SCREEN_ROUTE_MISMATCH:overlay:/login') && !r.screenOut.issues.some((c) => c.startsWith('SCREEN_ROUTE_MISMATCH:sweep')), r.screenOut.issues.join(', '));
    for (const id of ['TC-A', 'TC-B']) {
      assert.deepEqual(r.receiptOf(id, 'ideal').probes.map((p) => p.kind), ['width-sweep', 'entry'], id);
      assert.ok(r.collected[id].issues.includes('SCREEN_CHECK_UNGRADED:S1'), `${id}: ${r.collected[id].issues.join(', ')}`);
      assert.ok(r.messages.some((m) => new RegExp(`^PROBE:${id}:ideal:SWEEP_BAND_FAIL:`).test(m)), r.messages.join('\n'));
      assert.equal(r.boardData.cases.find((c) => c.id === id).uiVerdict, 'FAIL', id);
    }
  });

test('fix round 3, F6: each attempt keeps its own band captures, so a later attempt never makes an earlier one drift; a later attempt without R1a never hides an earlier FAIL',
  { skip: SKIP }, async () => {
    const r = await runPlan({ defect: true, screens: ['shot-a', 'shot-b'] });
    const attempts = readdirSync(join(r.runDir, 'screens/S1/attempts')).sort();
    assert.deepEqual(attempts, ['screen-S1-1', 'screen-S1-2']);
    assert.deepEqual(attempts.map((a) => readFileSync(join(r.runDir, 'screens/S1/attempts', a, 'S1-sweep-741.jpg'), 'utf8')), ['band capture, attempt A', 'band capture, attempt B']);
    for (const id of ['TC-A', 'TC-B']) assert.equal(r.collected[id].issues.some((c) => c.startsWith('SCREEN_ATTEMPT_REFUSED')), false, `${id}: ${r.collected[id].issues.join(', ')}`);
    assert.ok(r.messages.some((m) => /^PROBE:TC-B:ideal:SWEEP_BAND_FAIL:/.test(m)), r.messages.join('\n'));
    const hidden = await runPlan({ defect: true, screens: ['ok', 'no-r1a'] });
    assert.deepEqual(hidden.screenOuts.map((o) => o.status), ['checked', 'unavailable']);
    assert.deepEqual(hidden.receiptOf('TC-B', 'ideal').probes.map((p) => p.kind), ['width-sweep', 'overlay-check', 'entry']);
    assert.ok(hidden.messages.some((m) => /^PROBE:TC-B:ideal:SWEEP_BAND_FAIL:/.test(m)), hidden.messages.join('\n'));
    assert.equal(hidden.boardData.cases.find((c) => c.id === 'TC-B').uiVerdict, 'FAIL');
  });

// ── Round G: a run shaped like the 05/11 dogfood ────────────────────────────────────────────────────────────────
// The Designer's plan for an ordinary brief: three GUI cases with no route, each with a share link (it resets data, signs
// out and redirects to the app), an account and Vietnamese steps that open the link, sign in and go to the screen named in
// words. D-SAVE adds a product group (a save, no reset path: fresh-value trials), D-DEL deletes one (no reset path: its
// probe is N/A), D-CLEAN only reads the list. Each case's executor proves the build with openTab {proveIdentity}.
const SCREEN_URL = `${ORIGIN}/product-groups`;
const share = (hash) => `${ORIGIN}/s/${hash}`;
const DOGFOOD = [
  { id: 'D-SAVE', kind: 'behavioral', states: ['ideal', 'partial'], data: { entry_url: share('a1b2c3'), account: 'qa-owner' },
    steps: [`M\u1edf link chia s\u1ebb ${share('a1b2c3')}`, '\u0110\u0103ng nh\u1eadp b\u1eb1ng t\u00e0i kho\u1ea3n qa-owner', 'V\u00e0o m\u00e0n h\u00ecnh Nh\u00f3m s\u1ea3n ph\u1ea9m', "B\u1ea5m 'Th\u00eam m\u1edbi'", "Nh\u1eadp t\u00ean nh\u00f3m '\u0110\u1ed3 u\u1ed1ng'", "B\u1ea5m 'L\u01b0u'"] },
  { id: 'D-DEL', kind: 'behavioral', states: ['ideal', 'partial'], data: { case_url: share('d4e5f6'), account: 'qa-owner' },
    steps: [`M\u1edf link chia s\u1ebb ${share('d4e5f6')}`, '\u0110\u0103ng nh\u1eadp b\u1eb1ng t\u00e0i kho\u1ea3n qa-owner', 'V\u00e0o m\u00e0n h\u00ecnh Nh\u00f3m s\u1ea3n ph\u1ea9m', "B\u1ea5m 'X\u00f3a' \u1edf nh\u00f3m \u0110\u1ed3 u\u1ed1ng r\u1ed3i \u0111\u1ed3ng \u00fd trong h\u1ed9p tho\u1ea1i"] },
  { id: 'D-CLEAN', kind: 'static', states: ['ideal'], data: { account: 'qa-owner' },
    steps: [`M\u1edf link chia s\u1ebb ${share('0a9b8c')}`, '\u0110\u0103ng nh\u1eadp b\u1eb1ng t\u00e0i kho\u1ea3n qa-owner', 'V\u00e0o m\u00e0n h\u00ecnh Nh\u00f3m s\u1ea3n ph\u1ea9m'] },
];
const DOGFOOD_IDS = DOGFOOD.map((c) => c.id);
const VITE_ENTRY = 'index-CJjkO35e', PREVIEW_ID = { kind: 'vite', id: VITE_ENTRY };

// The executor's openTab of the preview URL with proveIdentity: Dragon's three reads inside the call (Dragon
// tests/qa-identity.test.mjs shapes), timed inside it.
function provedOpening(t0) {
  const tab = { ...S, tabId: 7 }, at = (ms) => new Date(t0 + ms).toISOString();
  const html = `<html><head><script type="module" crossorigin src="/assets/${VITE_ENTRY}.js"></script></head><body><div id="root"></div></body></html>`;
  const contentHash = `sha256:${sha(JSON.stringify(['string', html]))}`;
  const page = { v: 1, html_sha256: sha(html), html_length: html.length, html_bytes: Buffer.byteLength(html), complete: true, truncated: false, ...passiveHtmlParts(html), omitted: 0,
    evidence: { v: 1, kind: 'dom', ts: t0 + 100, correlationId: null, contentHash, ref: `observation:${contentHash.slice(7)}` }, telemetry: { durMs: 3, bytesOut: 400, terminalReason: 'complete', retryable: false, evidenceRef: `observation:${contentHash.slice(7)}` } };
  const network = { summary: true, count: 1, cursor: t0 + 50, truncated: false, omitted: 0, origins: [{ origin: ORIGIN, ok: 1, failed: 0, other: 0, last_ok_t: t0 + 50 }],
    evidence: { v: 1, kind: 'network', ts: t0 + 400, correlationId: null, contentHash: `sha256:${'b'.repeat(64)}`, ref: `observation:${'b'.repeat(64)}`, meta: { cursor: t0 + 50, truncated: false, omitted: 0 } } };
  const read = (method, params, result, from) => ({ method, params, result, called_at: at(from), answered_at: at(from + 100) });
  const identity = { ok: true, settle: { settled: true, waitedMs: 40 }, page: read('getPageIdentity', tab, page, 100), network: read('getNetwork', { ...tab, summary: true }, network, 250),
    tab: read('getTabInfo', tab, { tabId: 7, url: URL_, title: 'Shop' }, 400) };
  return [{ method: 'session.create', params: { sessionId: S.sessionId }, result: { ...S } },
    { method: 'openTab', params: { url: URL_, proveIdentity: true }, result: { tabId: 7, sessionId: S.sessionId, identity }, called_at: at(0), at: at(800) }];
}
// The case's own way to its screen: the share link, the sign-in, the menu item.
const reachCalls = (link) => [
  { method: 'do', params: { steps: [{ goto: link }, { fill: { selector: '#email', value: 'qa-owner' } }, { clickSelector: '#login', fast: false }] }, result: { completed: true, results: [{ step: 'goto', ok: true }, { step: 'fill', ok: true }, { step: 'clickSelector', ok: true, receipt: { ts: 1 } }] } },
  { method: 'do', params: { steps: [{ click: 'Nh\u00f3m s\u1ea3n ph\u1ea9m' }] }, result: { completed: true, results: [{ step: 'click', ok: true, receipt: { ts: 2 } }] } }];

// The screen check of an entry screen: the case's steps up to its first write, then the sweep and the overlay check
// where they landed (w:found's href), as QA GUI's entry recipe makes it.
function entryScreenStream({ SD, screenId, link, href = SCREEN_URL }) {
  const calls = [{ method: 'session.create', params: { sessionId: S.sessionId }, result: { ...S } }, ...helpCalls({ r1a: true }),
    { method: 'helpers.define', params: { pack: SD.helperPack() }, result: { ok: true, helpers: [SD.STREAM_HELPERS.sweep.name, SD.STREAM_HELPERS.overlay.name].map((name) => ({ name })) } },
    { method: 'openTab', params: { url: link }, result: { tabId: 7, sessionId: S.sessionId } }, ...reachCalls(link),
    ...sweepCalls(false, SD, href, href), ...overlayCalls(false, SD, href, href)];
  return { calls, text: streamOf(calls, { marker: SCREEN_DRAFT_MARKER, draft: { screen_id: screenId, url: link } }) };
}

function dogfoodCase({ SD, id, work, trialCalls, entryTrialCalls, variant, t0 }) {
  const { shot, shotCall, checks } = stateCalls({ caseId: id, seed: id.length, work });
  const link = DOGFOOD.find((c) => c.id === id).data.entry_url ?? DOGFOOD.find((c) => c.id === id).data.case_url ?? share('0a9b8c');
  const calls = [...provedOpening(t0), ...helpCalls({ r1a: true }), ...reachCalls(link), shotCall('ideal', shot('ideal'), SCREEN_URL), ...checks('ideal', 1000, `${ORIGIN}/api/groups`)];
  const states = [{ state: 'ideal', screenshot: `${id}-ideal.png`, gate0: 'g0', target: 'target', console: true, network: true, assertions: [{ assertion_id: `${id}-A1`, verdict: 'PASS' }], vision: allPass }];
  if (id !== 'D-CLEAN') {
    const act = id === 'D-SAVE' ? '#save' : '#confirm-delete';
    calls.push({ method: 'do', params: { steps: [{ clickSelector: act, fast: false }, { waitFor: { text: id === 'D-SAVE' ? '\u0110\u00e3 l\u01b0u' : '\u0110\u00e3 x\u00f3a' } }] }, result: { completed: true, results: [{ step: 'clickSelector', ok: true, receipt: { ts: 3 } }, { step: 'waitFor', ok: true }] } },
      shotCall('partial', shot('partial'), SCREEN_URL), ...checks('partial', 2000, `${ORIGIN}/api/groups`));
    states.push({ state: 'partial', screenshot: `${id}-partial.png`, gate0: 'g0', target: 'target', console: true, network: true, assertions: [{ assertion_id: `${id}-A2`, verdict: 'PASS' }], vision: allPass,
      ...(id === 'D-SAVE' ? { transient: { action: { method: 'click', selector: '#save', target: { tag: 'button', label: 'L\u01b0u', type: 'submit', inForm: true } } } } : {}) });
  }
  // D-SAVE: the save probed with fresh test values, each trial's setup opening the empty form and filling "-T<n>".
  if (id === 'D-SAVE') {
    calls.push({ method: 'helpers.define', params: { pack: SD.helperPack() }, result: { ok: true, helpers: [{ name: SD.STREAM_HELPERS.sample.name }] } });
    for (const [n, c] of trialCalls(variant, { tabId: 7, selector: '#save', state: 'partial' }).entries()) {
      if (c.method !== 'frames.trial') { calls.push(c); continue; }
      const setup = [{ click: 'Th\u00eam m\u1edbi' }, { fill: { selector: '#name', value: `\u0110\u1ed3 u\u1ed1ng-T${n + 1}` } }];
      const frameDir = join(work, 'frames', `${id}-${c.result.frames.windowId}`);
      mkdirSync(frameDir, { recursive: true });
      const frames = c.result.frames.frames.map((f) => { const file = `f-${String(f.seq).padStart(5, '0')}.jpg`; writeFileSync(join(frameDir, file), `${id} frame ${f.seq}`); return { ...f, file, sha256: sha(`${id} frame ${f.seq}`) }; });
      calls.push({ ...c, params: { ...c.params, setup }, result: { ...c.result, setup: { completed: true, brief: true, results: setup.map((x) => ({ step: Object.keys(x)[0], ok: true })) }, frames: { ...c.result.frames, dir: frameDir, frames } } });
    }
    // A probed case ends with a verified envReset (QA GUI's T recipe asks for it when no U rule did).
    calls.push({ method: 'env.reset', params: {}, result: { ok: true, reason: 'reset', endedCase: id, atDefault: true, restored: [], released: 0, sensors: null, frames: null, errors: [], mismatches: [],
      readback: { page: { onLine: true } }, conditions: { v: 1, caseId: null, role: 'test', network: null, cpu: null, timezone: null, locale: null, media: null, animation: null, requests: [],
        probes: { sensors: false, frames: false }, verified: true, setAt: 1, expiresAt: 900001 } } });
  }
  const screenId = { 'D-SAVE': 'S1', 'D-DEL': 'S2', 'D-CLEAN': 'S3' }[id];
  const entry = entryTrialCalls({ url: SCREEN_URL, screenId, tabId: 7 });
  calls.push(...entry);
  const draft = { case_id: id, summary: { function: 'Checked.', ui: 'Checked.' }, states };
  return { text: streamOf(calls, { marker: DRAFT_MARKER, draft }), draft, entryCalls: entry.length };
}

test('round G: a run shaped like the dogfood (share links, no routes): three entry screens planned and folded, the entry probe on every case, the save probed with fresh values, the delete N/A, identity proven inside openTab',
  { skip: SKIP }, async () => {
    const SD = await qa('scripts/lib/stream-detectors.mjs');
    const { trialCalls, entryTrialCalls } = await qa('test/support/recipe-calls.mjs');
    const recorded = JSON.parse(gunzipSync(readFileSync(join(QA_GUI, 'test/fixtures/r1d/recorded/T5.json.gz'))).toString('utf8'));
    const variant = recorded.variants.find((v) => v.at === 300 && v.clean);
    const evidenceTools = await qaGuiEvidenceTools(QA_GUI), detectorTools = await qaGuiDetectorTools(QA_GUI);
    const run = fixtureRun({ evidenceTools, detectorTools, cases: DOGFOOD_IDS, trackedCases: DOGFOOD });
    const { screenPlan, runScreenPlan } = await import('../../scripts/lib/screen-checks.mjs');
    const { caseDetectorPlan, dispatchScreenSection } = await import('../../scripts/lib/detector-dispatch.mjs');
    const { executorIdentity } = await import('../../scripts/lib/executor-identity.mjs');
    // G4: one entry screen per case, in plan order, with the steps up to the first write.
    const plan = runScreenPlan(run.runDir);
    assert.deepEqual(plan.noRoute, []);
    assert.deepEqual(plan.screens.map((x) => [x.id, x.route, x.entry, x.cases]), [['S1', null, share('a1b2c3'), ['D-SAVE']], ['S2', null, share('d4e5f6'), ['D-DEL']], ['S3', null, share('0a9b8c'), ['D-CLEAN']]]);
    assert.deepEqual(plan.screens[0].steps, DOGFOOD[0].steps.slice(0, 3), 'up to (not including) the first write: "Th\u00eam m\u1edbi"');
    assert.deepEqual(plan.screens[1].steps, DOGFOOD[1].steps.slice(0, 3));
    assert.deepEqual(screenPlan({ cases: [{ id: 'X', lane: 'gui', steps: ['Open the wizard'] }] }).noRoute, ['X'], 'no route and no entry link: N/A as before');
    const recipe = await dispatchScreenSection({ runDir: run.runDir, screenId: 'S1', tools: detectorTools });
    assert.match(recipe, /Reach the screen from the entry link/);
    assert.ok(recipe.includes(JSON.stringify(plan.screens[0].steps)) && recipe.includes('"qa-owner"'));
    // G4: each screen check reaches the screen by the case's steps; collect-screen grades it where it landed.
    const screenCalls = [];
    for (const [i, c] of DOGFOOD.entries()) {
      const screen = entryScreenStream({ SD, screenId: `S${i + 1}`, link: plan.screens[i].entry });
      screenCalls.push(screen.calls.length);
      const out = await run.collectScreen(screen.text, `S${i + 1}`);
      assert.deepEqual([out.status, out.verdict, out.measuredRoute, out.entry], ['checked', 'PASS', '/product-groups', plan.screens[i].entry], `${c.id}: ${JSON.stringify(out)}`);
    }
    // A check still on the share link (or a sign-in page) did not reach the screen.
    const lost = await run.collectScreen(entryScreenStream({ SD, screenId: 'S3', link: share('0a9b8c'), href: `${ORIGIN}/login` }).text, 'S3');
    assert.deepEqual([lost.verdict, lost.issues[0]], ['UNGRADED', 'SCREEN_ENTRY_NOT_REACHED:/login']);
    await run.collectScreen(entryScreenStream({ SD, screenId: 'S3', link: share('0a9b8c') }).text, 'S3');
    // G5: every case plans the entry probe of its screen; its URL is where the screen check measured it.
    const tracked = JSON.parse(readFileSync(join(run.runDir, 'tracked-plan.json'), 'utf8'));
    const plans = Object.fromEntries(DOGFOOD.map((c) => [c.id, caseDetectorPlan({ plannedCase: tracked.cases.find((x) => x.id === c.id), tracked, classify: detectorTools.classifyAction,
      repeatability: detectorTools.transientRepeatability, screens: plan })]));
    assert.deepEqual(Object.values(plans).map((p) => p.entry?.screenId), ['S1', 'S2', 'S3']);
    assert.deepEqual([plans['D-SAVE'].transient.fresh, plans['D-SAVE'].transient.trials], [true, 3], 'the save: fresh-value trials');
    assert.deepEqual([plans['D-DEL'].transient, plans['D-DEL'].transientNa], [false, 'TRANSIENT_WRITE_NO_RESET'], 'the delete: N/A');
    assert.equal(plans['D-CLEAN'].transient, false);
    const sections = {};
    for (const id of DOGFOOD_IDS) sections[id] = await dispatchDetectorSection({ runDir: run.runDir, caseId: id, tools: detectorTools });
    assert.match(sections['D-SAVE'], /fresh test values/);
    assert.match(sections['D-SAVE'], /After the last trial: envReset/);
    for (const id of DOGFOOD_IDS) {
      assert.ok(sections[id].includes(`"steps":[{"goto":"${SCREEN_URL}"}]`) && sections[id].includes('"correlationId":"entry:'), `${id}: ${sections[id]}`);
      assert.ok(Buffer.byteLength(sections[id]) < 8 * 1024, `${id} section ${Buffer.byteLength(sections[id])} bytes`);
    }
    // The cases.
    const streams = {}, collected = {};
    for (const [n, id] of DOGFOOD_IDS.entries()) {
      streams[id] = dogfoodCase({ SD, id, work: run.work, trialCalls, entryTrialCalls, variant, t0: Date.parse('2026-11-04T05:00:00.300Z') + n });
      const out = await run.collect(id, streams[id].text);
      collected[id] = out.cases[0];
    }
    // G3: the executor's identity, proven by the triple Dragon made inside openTab {proveIdentity}.
    const target = { preview_url: URL_, backend_origin: ORIGIN, frontend_build: PREVIEW_ID,
      asset_manifest_sha256: sha(JSON.stringify({ kind: 'vite-html-assets/v1', entry: `${ORIGIN}/assets/${VITE_ENTRY}.js` })) };
    const proved = executorIdentity({ stream: streams['D-SAVE'].text, target });
    assert.equal(proved.calls.page.endsWith('#identity.page'), true);
    assert.deepEqual(proved.observation.frontend_build, PREVIEW_ID);
    // The folds: each screen's checks and the case's entry probe on its first state on /product-groups.
    const receiptOf = (id, state) => JSON.parse(readFileSync(join(run.runDir, `evidence/qa-gui/${id}/${state}.receipt.json`), 'utf8'));
    for (const id of DOGFOOD_IDS) assert.deepEqual(receiptOf(id, 'ideal').probes.map((p) => p.kind), ['width-sweep', 'overlay-check', 'entry'], id);
    assert.deepEqual(receiptOf('D-SAVE', 'partial').probes.map((p) => p.kind), ['transient']);
    assert.deepEqual(receiptOf('D-SAVE', 'partial').env, { conditions: null, reset: { evidence_ref: 'evidence/qa-gui/D-SAVE/env-reset.json' } }, 'the probed state names the verified reset');
    assert.equal(Object.hasOwn(receiptOf('D-DEL', 'partial'), 'probes'), false);
    const saveProbe = JSON.parse(readFileSync(join(run.runDir, receiptOf('D-SAVE', 'partial').probes[0].path), 'utf8'));
    assert.equal(saveProbe.trials.length, 3);
    assert.ok(collected['D-DEL'].issues.includes('DETECTOR_NA:D-DEL:transient:TRANSIENT_WRITE_NO_RESET'), collected['D-DEL'].issues.join('\n'));
    for (const id of DOGFOOD_IDS) assert.deepEqual(collected[id].issues.filter((x) => /DETECTOR_NOT_RUN|SCREEN_NO_ROUTE|SCREEN_CHECK_UNGRADED|ENTRY_NOT_REACHED|ENV_|PROBE:/.test(x)), [], `${id}: ${collected[id].issues.join('\n')}`);
    // QA GUI's gate on the board: the verdicts collect wrote, no env or probe finding on the clean app.
    const { checkGuiReleaseTruthV2 } = await qa('scripts/lib/qa-gui-v2.mjs');
    const gate = checkGuiReleaseTruthV2({ data: JSON.parse(readFileSync(run.boardFile, 'utf8')), boardPath: run.boardFile, evidenceRoot: run.runDir, context: gateContext(DOGFOOD_IDS, run.binding) });
    const messages = gate.issues.map((i) => i.message);
    assert.deepEqual(messages.filter((m) => /^PROBE:|VERDICT_MISMATCH|ENV_|UNGRADED/.test(m)), [], messages.join('\n'));
    // Budgets: an entry screen check in at most 30 calls; the entry probe adds at most 4 calls to a case dispatch.
    assert.ok(Math.max(...screenCalls) <= 30, `entry screen check calls: ${screenCalls.join(', ')}`);
    for (const id of DOGFOOD_IDS) assert.ok(streams[id].entryCalls <= 4, `${id}: ${streams[id].entryCalls}`);
    console.log(`# round G: entry screen check calls ${screenCalls.join('/')}; entry probe calls ${DOGFOOD_IDS.map((id) => streams[id].entryCalls).join('/')}; screen recipe ${recipe.length} chars; detector sections ${DOGFOOD_IDS.map((id) => Buffer.byteLength(sections[id])).join('/')} bytes`);
  });
