// Fix round 1 of the integrated upgrade: the wrong verdicts the reviews found, each reproduced first.
//   QG-1  a transient probe whose frame window closed before the action saw nothing: UNGRADED TRANSIENT_FRAMES_EARLY
//   QG-2  only dialog-type triggers are overlays; O6/O8 only for modal overlays; the Tab limit is a tool limit
//   QG-6  a sensor read that still had `more` is a gap, not the whole stream
//   QG-7  many U9 warnings cannot push a high finding out of the ui-sanity list (the cap bounds the list, not the verdict)
//   QG-8  under the evidence policy a state with function assertions and no target is UNGRADED
// Recorded R1d streams and synthetic receipts; the in-page checks run in Chromium when Playwright is installed.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, deflateSync } from 'node:zlib';

import { buildTransientProbeReceipt, transientProbeVerdict, PROBE_PLAN } from '../scripts/lib/transient-probe.mjs';
import { OVERLAY_STATE_BODY, gradeOverlay, overlayVerdict, OVERLAY_CHECK_SCHEMA } from '../scripts/lib/overlay-check.mjs';
import { dragonOps, transientProbeFromOps } from '../scripts/lib/stream-detectors.mjs';
import { stateImageIssues } from '../scripts/lib/evidence-quality.mjs';
import { canaryAction } from './support/r1d-recorder.mjs';
import { transientCalls } from './support/recipe-calls.mjs';
import { loadPlaywright, PLAYWRIGHT_SKIP } from './support/playwright.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const load = (s) => JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test/fixtures/r1d/recorded', `${s}.json.gz`))).toString('utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const playwright = await loadPlaywright();
let browser = null;
const page = async (html) => {
  browser ??= await playwright.chromium.launch();
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await p.setContent(html);
  return p;
};
after(async () => { if (browser) await browser.close(); });

test('QG-1: a trial whose frame window closed before the action is UNGRADED TRANSIENT_FRAMES_EARLY, never PASS', () => {
  const flash = load('T3theme').variants.find((v) => v.at === 300 && !v.clean);
  const ok = buildTransientProbeReceipt({ caseId: 'TC', state: 's', action: canaryAction('T3theme'), trials: flash.trials });
  assert.notEqual(transientProbeVerdict(ok).verdict, 'UNGRADED', 'the recorded trials cover their actions');
  // The race: framesStart answered, the model took more than maxMs to send the trial, Dragon closed the window first.
  const blind = clone(flash.trials).map((t) => ({ ...t, frames: { ...t.frames, stoppedAt: t.markT - 200, endReason: 'max-ms',
    index: t.frames.index.filter((f) => f.t < t.markT - 200), kept: t.frames.kept.filter((f) => f.t < t.markT - 200) } }));
  const graded = transientProbeVerdict(buildTransientProbeReceipt({ caseId: 'TC', state: 's', action: canaryAction('T3theme'), trials: blind }));
  assert.equal(graded.verdict, 'UNGRADED');
  assert.ok(graded.issues.some((c) => c.startsWith('TRANSIENT_FRAMES_EARLY:trial-0')), graded.issues.join(', '));
  // A window open over the mark but stopped before +1000 ms does not cover it either.
  const short = clone(flash.trials).map((t) => ({ ...t, frames: { ...t.frames, stoppedAt: t.markT + 500 } }));
  assert.ok(transientProbeVerdict(buildTransientProbeReceipt({ caseId: 'TC', state: 's', action: canaryAction('T3theme'), trials: short })).issues.some((c) => c.startsWith('TRANSIENT_FRAMES_EARLY')));
  assert.equal(PROBE_PLAN.frames.maxMs, 10000, 'the frame window may stay open as long as Dragon allows');
});

test('QG-6: a sensor read that still had more events is a gap: the probe is UNGRADED, not graded on part of the stream', () => {
  const v = load('T2').variants.find((x) => x.at === 300 && !x.clean);
  const calls = transientCalls(v, { tabId: 7, selector: '#go' }).map((c) => (c.method === 'sensors.read' ? { ...c, result: { ...c.result, more: true } } : c));
  const { receipt } = transientProbeFromOps(dragonOps(calls), { caseId: 'TC', state: 's', action: canaryAction('T2') });
  assert.equal(receipt.trials[0].sensors.gap, true);
  const graded = transientProbeVerdict(receipt);
  assert.equal(graded.verdict, 'UNGRADED');
  assert.ok(graded.issues.some((c) => c.startsWith('TRANSIENT_SENSORS_GAP')), graded.issues.join(', '));
});

const good = () => ({
  trigger: { selector: '#t', label: 'Edit' }, overlay: '#d', mouse: { opened: true, overlay: '#d', activeInside: true, modal: true },
  trap: { presses: 3, inside: [true, true, true] }, scroll: { scrollable: true, attempted: true, before: 0, after: 0 },
  stacked: { available: false }, esc: { closed: true, active: '#t' }, keyboard: { reachedTrigger: true, presses: 2, opened: true },
  backdrop: { available: false }, button: { available: true, closed: true, active: '#t' },
});
const statuses = (g) => Object.fromEntries(g.checks.map((c) => [c.rule, c.reason ? `${c.status}:${c.reason}` : c.status]));

test('QG-2: focus trap and scroll lock are checked only on modal overlays; a non-modal dialog or popover is not failed for them', () => {
  const popover = good();
  popover.mouse.modal = false;
  popover.trap.inside = [true, false, false];
  popover.scroll.after = 300;
  const g = statuses(gradeOverlay(popover));
  assert.equal(g.O6, 'UNGRADED:PRECONDITION_ABSENT');
  assert.equal(g.O8, 'UNGRADED:PRECONDITION_ABSENT');
  assert.equal(overlayVerdict({ schema: OVERLAY_CHECK_SCHEMA, overlays: [{ observation: popover }] }).verdict, 'PASS', 'an absent precondition keeps the verdict');
  const modal = good();
  modal.trap.inside = [true, false, false];
  assert.equal(statuses(gradeOverlay(modal)).O6, 'FAIL', 'a modal overlay that lets focus out still fails');
});

test('QG-2: a trigger past the Tab limit is UNGRADED TOOL_LIMIT; one focus went round the page without reaching FAILs', () => {
  const far = good();
  far.keyboard = { reachedTrigger: false, presses: 40 };
  assert.equal(statuses(gradeOverlay(far)).O2, 'UNGRADED:TOOL_LIMIT');
  const graded = overlayVerdict({ schema: OVERLAY_CHECK_SCHEMA, overlays: [{ observation: far }] });
  // Fix round 2 (E5): the tool limit is that one cell's (O2 UNGRADED), reported; the overlay check keeps its verdict.
  assert.equal(graded.verdict, 'PASS');
  assert.ok(graded.issues.some((c) => c.startsWith('OVERLAY_O2_TOOL_LIMIT')), graded.issues.join(', '));
  const unreachable = good();
  unreachable.keyboard = { reachedTrigger: false, presses: 9, cycled: true };
  assert.equal(statuses(gradeOverlay(unreachable)).O2, 'FAIL:TRIGGER_NOT_REACHABLE');
});

test('QG-2: menu, listbox and true popups are not overlay triggers; dialog-type ones are', { skip: playwright ? false : PLAYWRIGHT_SKIP }, async () => {
  const p = await page(`<main>
    <button id="menu" aria-haspopup="menu">Actions</button><button id="truthy" aria-haspopup="true">More</button>
    <input id="combo" role="combobox" aria-haspopup="listbox"><button id="dlg" aria-haspopup="dialog">Edit</button>
    <button id="pop" popovertarget="tip">Tip</button><div id="tip" popover>hello</div>
    <button id="ctl" aria-controls="sheet">Sheet</button><div id="sheet" role="dialog" hidden>sheet</div></main>`);
  const state = await p.evaluate((body) => (new Function(body))(), OVERLAY_STATE_BODY);
  assert.deepEqual(state.triggers.map((t) => t.selector).sort(), ['#ctl', '#dlg', '#pop']);
  await p.close();
});

test('QG-2: the state read says whether the top overlay is modal', { skip: playwright ? false : PLAYWRIGHT_SKIP }, async () => {
  const p = await page(`<dialog id="m"><button>OK</button></dialog><dialog id="n"><button>OK</button></dialog>
    <script>document.getElementById('m').showModal();</script>`);
  assert.equal((await p.evaluate((body) => (new Function(body))(), OVERLAY_STATE_BODY)).modal, true);
  await p.evaluate(() => { document.getElementById('m').close(); document.getElementById('n').show(); });
  const plain = await p.evaluate((body) => (new Function(body))(), OVERLAY_STATE_BODY);
  assert.equal(plain.open.length, 1);
  assert.equal(plain.modal, false);
  await p.close();
});

test('QG-7: thirty partly covered controls cannot push a page overflow out of the list: the state still FAILs', { skip: playwright ? false : PLAYWRIGHT_SKIP }, async () => {
  const ui = readFileSync(join(ROOT, 'scripts/ui-sanity.js'), 'utf8');
  // Each button's right half is covered by a strip that reaches past it (the U9 fixture's pattern): centre free, 2/5 covered.
  const cells = Array.from({ length: 30 }, (_, i) => { const x = (i % 6) * 150, y = Math.floor(i / 6) * 60;
    return `<button style="position:absolute;left:${x}px;top:${y}px;width:80px;height:40px">b${i}</button>`
      + `<div style="position:absolute;left:${x + 44}px;top:${y - 4}px;width:70px;height:48px;background:#eee"></div>`; }).join('');
  const p = await page(`<div style="position:relative;height:320px">${cells}</div><div style="width:3000px;height:20px;background:#ccc">wide</div>`);
  const report = await p.evaluate((src) => { (new Function(src))(); return window.__uiSanity('grid', {}); }, ui);
  const warns = report.issues.filter((i) => i.id === 'U9').length;
  assert.ok(warns >= 24, `U9 warnings fill the list first (${warns})`);
  assert.ok(report.counts.high >= 1, JSON.stringify(report.counts));
  assert.equal(report.verdict, 'FAIL');
  await p.close();
});

// A textured 64x40 PNG (the evidence policy refuses a flat frame).
function png(width = 64, height = 40) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw.set([(x * 9) & 255, (y * 7) & 255, ((x + y) * 5) & 255], y * (width * 3 + 1) + 1 + x * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('QG-8: under the evidence policy a state with function assertions and no target cannot back a verdict', async () => {
  const bytes = png();
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const receipt = { url: 'http://app/x', build: 'B1', domHash: 'a'.repeat(64), viewport: '64x40', dragon: { tabId: '7' },
    screenshot: { capture: { tabId: '7', url: 'http://app/x', build: 'B1', domHash: 'a'.repeat(64), sha256: sha, maskedRects: [] } },
    function: { verdict: 'PASS', assertions: [{ assertion_id: 'A1', verdict: 'PASS' }] } };
  const codes = (r) => stateImageIssues({ png: bytes, receipt: r, caseId: 'TC', state: 's' }).map((i) => i.code);
  assert.deepEqual(codes(receipt), ['EVIDENCE_IMAGE_TARGET_MISSING']);
  assert.deepEqual(codes({ ...receipt, target: { selector: '#save', rect: { x: 1, y: 1, width: 10, height: 10 } } }), []);
  assert.deepEqual(codes({ ...receipt, function: { verdict: 'UNGRADED', assertions: [] } }), [], 'a state with nothing to assert needs no target');
});
