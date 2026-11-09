// Upgrade R3 acceptance on fixtures: vision by diff run both ways. The off path is today's: the VLM grades every state
// (its verdicts here are the fixture's labels: a state with a planted visual defect is graded FAIL on the rule it
// breaks). The on path lets a state inherit from its approved baseline when the tier-0 decision allows, and asks the
// VLM otherwise. No state the off path fails may pass on the on path. Synthetic 1280x800 PNGs; never product evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodePng } from '../scripts/visual-diff.mjs';
import { approveBaseline, emptyStore, proposeBaseline } from '../scripts/lib/baseline-store.mjs';
import { visionDiffDecision } from '../scripts/lib/vision-by-diff.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const RULES = ['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'];
const PASS = Object.fromEntries(RULES.map((rule) => [rule, 'PASS']));
const W = 1280, H = 800;

// A list screen: header, toolbar, 8 rows with a price column, a footer clock, an avatar image.
function screen(edit = () => {}) {
  const data = Buffer.alloc(W * H * 4);
  const fill = (x0, y0, w, h, rgb) => { for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) data.set([...rgb, 255], (y * W + x) * 4); };
  fill(0, 0, W, H, [248, 248, 250]);
  fill(0, 0, W, 56, [24, 28, 40]);
  fill(32, 72, 160, 36, [40, 110, 220]);
  for (let r = 0; r < 8; r += 1) {
    fill(32, 128 + r * 64, 1216, 48, [255, 255, 255]);
    fill(48, 144 + r * 64, 300, 14, [60, 60, 70]);
    for (let g = 0; g < 4; g += 1) fill(1100 + g * 12, 144 + r * 64, 8, 14, [60, 60, 70]); // price glyphs
  }
  fill(1180, 8, 40, 40, [200, 160, 120]);
  fill(1000, 770, 120, 16, [120, 120, 130]); // footer clock (masked in the baseline)
  edit(fill);
  return encodePng({ width: W, height: H, data });
}
const CLEAN = { uiSanity: { id: 'ui-sanity', verdict: 'PASS', evidence: '{"v":"PASS","c":{"high":0,"warn":0}}' }, a11y: { id: 'a11y', verdict: 'PASS', evidence: '{"v":"PASS"}' } };
const sweepWith = (ui, a11y = 'PASS') => ({ uiSanity: { id: 'ui-sanity', verdict: ui === 'warn' ? 'PASS' : ui, evidence: JSON.stringify({ v: ui === 'warn' ? 'PASS' : ui, c: { high: ui === 'FAIL' ? 1 : 0, warn: ui === 'warn' ? 1 : 0 } }) },
  a11y: { id: 'a11y', verdict: a11y, evidence: '{}' } });

// Each fixture: the screen now, its DOM sweep, and what the VLM (off path) reports.
const FIXTURES = [
  { name: 'identical', png: () => screen(), sweep: CLEAN, vlm: PASS },
  { name: 'caret-blink', png: () => screen((f) => f(60, 150, 1, 12, [0, 0, 0])), sweep: CLEAN, vlm: PASS },
  { name: 'clock-ticked', png: () => screen((f) => f(1000, 770, 120, 16, [90, 90, 100])), sweep: CLEAN, vlm: PASS },
  { name: 'row-overlap', png: () => screen((f) => f(32, 150, 1216, 48, [255, 255, 255])), sweep: CLEAN, vlm: { ...PASS, C10: 'FAIL' } },
  { name: 'button-off-theme', png: () => screen((f) => f(32, 72, 160, 36, [230, 40, 160])), sweep: CLEAN, vlm: { ...PASS, C12: 'FAIL' } },
  { name: 'status-icon-red', png: () => screen((f) => f(1180, 8, 16, 16, [220, 30, 30])), sweep: CLEAN, vlm: { ...PASS, C12: 'FAIL' } },
  { name: 'price-glyph-wrong', png: () => screen((f) => { f(1100, 144, 8, 14, [248, 248, 250]); f(1100, 146, 8, 3, [60, 60, 70]); f(1103, 144, 2, 14, [60, 60, 70]); }), sweep: CLEAN, vlm: { ...PASS, C16: 'FAIL' } },
  { name: 'label-clipped', png: () => screen((f) => f(300, 144, 48, 14, [255, 255, 255])), sweep: sweepWith('FAIL'), vlm: { ...PASS, C13: 'FAIL' } },
  { name: 'row-misaligned', png: () => screen((f) => { f(48, 144, 300, 14, [255, 255, 255]); f(51, 144, 300, 14, [60, 60, 70]); }), sweep: sweepWith('warn'), vlm: { ...PASS, C13: 'FAIL' } },
  { name: 'avatar-broken', png: () => screen((f) => f(1180, 8, 40, 40, [248, 248, 250])), sweep: CLEAN, vlm: { ...PASS, C11: 'FAIL' } },
  { name: 'new-state-no-baseline', state: 'orders-filtered', png: () => screen(), sweep: CLEAN, vlm: PASS },
  { name: 'contrast-low', png: () => screen(), sweep: sweepWith('PASS', 'FAIL'), vlm: { ...PASS, C16: 'FAIL' } },
];

test('shadow both ways: vision by diff misses no state the VLM path fails, and skips the VLM on the clean repeat states', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r3-shadow-')));
  const key = { route: '/orders', state: 'orders-list', viewport: '1280x800', build: 'build-9' };
  const baseline = screen();
  let { store } = proposeBaseline({ store: emptyStore(), dir, key, png: baseline, mask: [{ x: 1000, y: 770, width: 120, height: 16 }], vision: PASS, now: '2026-11-01T00:00:00.000Z' });
  ({ store } = approveBaseline({ store, key, sha256: sha(baseline), by: 'Project Owner', now: '2026-11-01T01:00:00.000Z', env: {} }));
  const rows = [];
  for (const f of FIXTURES) {
    const decision = visionDiffDecision({ png: f.png(), key: { ...key, state: f.state ?? key.state }, store, storeDir: dir, sweep: f.sweep, capturedAt: '2026-11-04T00:00:00.000Z' });
    const off = f.vlm;
    const on = decision.decision === 'inherit' ? decision.verdicts : f.vlm;
    const fails = (v) => RULES.filter((rule) => v[rule] === 'FAIL');
    rows.push({ name: f.name, decision: decision.decision, reasons: decision.reasons, diff: decision.diff?.percent ?? null, tile: decision.diff?.max_tile_percent ?? null,
      ms: decision.duration_ms, offFails: fails(off), onFails: fails(on) });
  }
  const missed = rows.filter((r) => r.offFails.length && !r.offFails.every((rule) => r.onFails.includes(rule)));
  assert.deepEqual(missed.map((r) => `${r.name} ${JSON.stringify(r)}`), [], 'no state the off path fails passes on the on path');
  // The repeat states that did not change (or changed only inside the approved mask, or by a caret) skip the VLM.
  assert.deepEqual(rows.filter((r) => r.decision === 'inherit').map((r) => r.name), ['identical', 'caret-blink', 'clock-ticked']);
  // Each defect reaches the VLM for its own reason.
  const why = Object.fromEntries(rows.map((r) => [r.name, r.reasons]));
  assert.ok(why['row-overlap'].includes('DIFF_OVER_LIMIT'));
  assert.ok(why['button-off-theme'].includes('DIFF_OVER_LIMIT'));
  assert.deepEqual(why['status-icon-red'], ['DIFF_LOCAL_OVER_LIMIT']);
  assert.deepEqual(why['price-glyph-wrong'], ['DIFF_LOCAL_OVER_LIMIT']);
  assert.ok(why['label-clipped'].includes('DOM_SWEEP_NOT_CLEAN'));
  assert.ok(why['row-misaligned'].includes('DOM_SWEEP_NOT_CLEAN'));
  assert.deepEqual(why['new-state-no-baseline'], ['NO_APPROVED_BASELINE']);
  assert.deepEqual(why['contrast-low'], ['DOM_SWEEP_NOT_CLEAN']);
  // The machine decision is cheap next to a VLM pass: report its cost on a 1280x800 state.
  const slowest = Math.max(...rows.map((r) => r.ms));
  t.diagnostic(`tier-0 decision on 1280x800: max ${slowest} ms per state; VLM skipped on ${rows.filter((r) => r.decision === 'inherit').length}/${rows.length} states`);
  assert.ok(slowest < 5000, `${slowest} ms`);
});
