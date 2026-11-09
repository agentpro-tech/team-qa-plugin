// Upgrade R3 (speed-ups), part 1: the approved-baseline store and vision by diff (the tier-0 decision).
// Synthetic PNG fixtures built in a temporary directory; never evidence of a product run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../scripts/visual-diff.mjs';
import {
  BASELINE_STORE_SCHEMA, approveBaseline, emptyStore, findApprovedBaseline, proposeBaseline, readStore, storeErrors, writeStore,
} from '../scripts/lib/baseline-store.mjs';
import {
  VISION_DIFF_MAX_PERCENT, domSweepClean, inheritedVisionAssertions, routeOf, visionDiffDecision,
} from '../scripts/lib/vision-by-diff.mjs';
import { SPEED_FLAGS, SPEED_MODES, minTier, speedMode, speedPolicyErrors } from '../scripts/lib/speed-flags.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(ROOT, 'scripts/qa-gui.mjs');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ALL_PASS = Object.fromEntries(['C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'].map((rule) => [rule, 'PASS']));
const KEY = { route: '/orders', state: 'orders-list', viewport: '1280x800', build: 'build-2' };
const T_PROPOSE = '2026-11-01T01:00:00.000Z', T_APPROVE = '2026-11-01T02:00:00.000Z', T_CAPTURE = '2026-11-04T03:00:00.000Z';

// A 320x200 "page": a header bar, list rows, a button and a 16x16 status icon, so a small change is a local change.
function page({ icon = [40, 160, 90], rows = 3, noise = [] } = {}) {
  const width = 320, height = 200, data = Buffer.alloc(width * height * 4);
  const fill = (x0, y0, w, h, rgb) => { for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) data.set([...rgb, 255], (y * width + x) * 4); };
  fill(0, 0, width, height, [250, 250, 250]);
  fill(0, 0, width, 24, [30, 30, 40]);
  for (let r = 0; r < rows; r += 1) fill(16, 40 + r * 30, 288, 20, [225, 228, 235]);
  fill(16, 150, 96, 32, [40, 110, 220]);
  fill(280, 160, 16, 16, icon);
  for (const [x, y] of noise) fill(x, y, 1, 1, [0, 0, 0]);
  return encodePng({ width, height, data });
}
const CLEAN = { uiSanity: { id: 'ui-sanity', verdict: 'PASS', evidence: JSON.stringify({ v: 'PASS', c: { high: 0, warn: 0 } }) },
  a11y: { id: 'a11y', verdict: 'PASS', evidence: JSON.stringify({ v: 'PASS' }) } };

function approvedStore({ png = page(), key = KEY, mask = [], vision = ALL_PASS, approve = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r3-store-')));
  let { store } = proposeBaseline({ store: emptyStore(), dir, key, png, mask, vision, source: { run: 'r-1', case_id: 'TC-01' }, now: T_PROPOSE });
  if (approve) ({ store } = approveBaseline({ store, key, sha256: sha(png), by: 'Project Owner', now: T_APPROVE, env: {} }));
  const file = join(dir, 'approved-baselines.json');
  writeStore(file, store);
  return { dir, file, store };
}
const decide = (extra = {}) => {
  const { dir, store } = extra.fixture ?? approvedStore();
  return visionDiffDecision({ png: page(), key: KEY, store, storeDir: dir, sweep: CLEAN, capturedAt: T_CAPTURE, minTier: 0, ...extra });
};

test('speed flags: five named flags, each off unless a policy says shadow or on', () => {
  assert.deepEqual(SPEED_FLAGS, ['vision_by_diff', 'cost_ladder', 'parallel_gui_lanes', 'fast_click', 'action_cache']);
  assert.deepEqual(SPEED_MODES, ['off', 'shadow', 'on']);
  for (const flag of SPEED_FLAGS) {
    assert.equal(speedMode(undefined, flag), 'off');
    assert.equal(speedMode({ version: 1, flags: {} }, flag), 'off');
  }
  assert.equal(speedMode({ version: 1, flags: { vision_by_diff: 'shadow' } }, 'vision_by_diff'), 'shadow');
  assert.equal(minTier(undefined, 'vision'), 0);
  assert.equal(minTier({ version: 1, min_tier: { vision: 2 } }, 'vision'), 2);
  assert.deepEqual(speedPolicyErrors({ version: 1, source: { kind: 'team-qa/signed-plan', sha256: 'a'.repeat(64) }, flags: { vision_by_diff: 'on' }, min_tier: { vision: 0 } }), []);
  assert.ok(speedPolicyErrors({ version: 1, flags: { turbo: 'on' } }).some((e) => e.includes('turbo')));
  assert.ok(speedPolicyErrors({ version: 1, flags: { vision_by_diff: 'yes' } }).length);
  assert.ok(speedPolicyErrors({ version: 1, min_tier: { vision: 4 } }).length);
  assert.ok(speedPolicyErrors({ version: 2 }).length);
  // A policy without a source names nobody who set it: refused.
  assert.ok(speedPolicyErrors({ version: 1, flags: { vision_by_diff: 'on' } }).some((e) => e === 'SPEED_POLICY_SOURCE_REQUIRED'));
});

test('store: a baseline is proposed, then approved explicitly by exact key and SHA; entries are keyed by route, state, viewport and build', () => {
  const png = page();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r3-store-')));
  let { store, entry } = proposeBaseline({ store: emptyStore(), dir, key: KEY, png, vision: ALL_PASS, source: { run: 'r-1', case_id: 'TC-01' }, now: T_PROPOSE });
  assert.equal(store.schema, BASELINE_STORE_SCHEMA);
  assert.deepEqual(entry.key, KEY);
  assert.equal(entry.sha256, sha(png));
  assert.equal(entry.status, 'proposed');
  assert.deepEqual([entry.approved_by, entry.approved_at], ['', '']);
  assert.ok(readFileSync(join(dir, entry.png)).equals(png), 'the PNG is stored content-addressed beside the store');
  // A proposed baseline is never used.
  assert.equal(findApprovedBaseline(store, KEY), null);
  // Approval names the exact key and SHA; a wrong SHA, an unnamed or (with QA_GUI_BASELINE_APPROVER) another approver is refused.
  assert.throws(() => approveBaseline({ store, key: KEY, sha256: 'f'.repeat(64), by: 'Project Owner', now: T_APPROVE, env: {} }), /BASELINE_NOT_PROPOSED/);
  assert.throws(() => approveBaseline({ store, key: KEY, sha256: sha(png), by: '', now: T_APPROVE, env: {} }), /BASELINE_APPROVER/);
  assert.throws(() => approveBaseline({ store, key: KEY, sha256: sha(png), by: 'Someone', now: T_APPROVE, env: { QA_GUI_BASELINE_APPROVER: 'Project Owner' } }), /BASELINE_APPROVER/);
  ({ store, entry } = approveBaseline({ store, key: KEY, sha256: sha(png), by: 'Project Owner', now: T_APPROVE, env: {} }));
  assert.deepEqual([entry.status, entry.approved_by, entry.approved_at], ['approved', 'Project Owner', T_APPROVE]);
  assert.equal(findApprovedBaseline(store, KEY).entry.sha256, sha(png));
  assert.equal(findApprovedBaseline(store, KEY).sameBuild, true);
  // Only a state whose seven vision rules all passed can become a baseline to inherit from.
  assert.throws(() => proposeBaseline({ store, dir, key: { ...KEY, state: 's2' }, png, vision: { ...ALL_PASS, C12: 'FAIL' }, now: T_PROPOSE }), /BASELINE_VISION_NOT_PASS/);
  // A second approval for the same key supersedes the first; the store stays one approved entry per key.
  const png2 = page({ rows: 2 });
  ({ store } = proposeBaseline({ store, dir, key: KEY, png: png2, vision: ALL_PASS, now: T_PROPOSE }));
  ({ store } = approveBaseline({ store, key: KEY, sha256: sha(png2), by: 'Project Owner', now: T_APPROVE, env: {} }));
  assert.deepEqual(store.entries.map((e) => e.status), ['superseded', 'approved']);
  assert.equal(findApprovedBaseline(store, KEY).entry.sha256, sha(png2));
  // Another build: the exact build wins when it has one; otherwise the latest approved entry of route+state+viewport,
  // marked as from another build.
  assert.equal(findApprovedBaseline(store, { ...KEY, build: 'build-3' }).sameBuild, false);
  assert.equal(findApprovedBaseline(store, { ...KEY, viewport: '390x844' }), null);
  assert.equal(findApprovedBaseline(store, { ...KEY, route: '/customers' }), null);
  // Integrity: a store that names a PNG with another hash is refused.
  const file = join(dir, 'approved-baselines.json');
  writeStore(file, store);
  assert.deepEqual(storeErrors(readStore(file).store, { dir }), []);
  writeFileSync(join(dir, store.entries[1].png), page({ rows: 1 }));
  assert.ok(storeErrors(readStore(file).store, { dir }).some((e) => e.startsWith('BASELINE_PNG_DRIFT')));
});

test('route of a URL: the path, plus a hash route', () => {
  assert.equal(routeOf('https://app.test/orders?page=2'), '/orders');
  assert.equal(routeOf('https://app.test/#/orders/7'), '/#/orders/7');
  assert.equal(routeOf('not a url'), null);
});

test('DOM sweep clean: both Gate-0 sweeps PASS with no high or warn finding', () => {
  assert.deepEqual(domSweepClean(CLEAN), { clean: true, reasons: [] });
  assert.equal(domSweepClean({ ...CLEAN, uiSanity: { ...CLEAN.uiSanity, verdict: 'FAIL' } }).clean, false);
  assert.equal(domSweepClean({ ...CLEAN, a11y: { ...CLEAN.a11y, verdict: 'UNGRADED' } }).clean, false);
  assert.equal(domSweepClean({ ...CLEAN, uiSanity: { ...CLEAN.uiSanity, evidence: JSON.stringify({ verdict: 'PASS', counts: { high: 0, warn: 2 } }) } }).clean, false);
  assert.equal(domSweepClean({ ...CLEAN, uiSanity: { ...CLEAN.uiSanity, evidence: JSON.stringify({ v: 'PASS', issues: [{ sev: 'warn', rule: 'misaligned-row' }] }) } }).clean, false);
  assert.equal(domSweepClean({ uiSanity: CLEAN.uiSanity }).clean, false);
});

test('vision by diff: an approved baseline, a diff within 0.5% after the mask and a clean DOM sweep let C10–C16 inherit, with the baseline SHA', () => {
  assert.equal(VISION_DIFF_MAX_PERCENT, 0.5);
  const fixture = approvedStore();
  const d = decide({ fixture });
  assert.equal(d.decision, 'inherit', JSON.stringify(d.reasons));
  assert.equal(d.tier, 0);
  assert.deepEqual(d.reasons, []);
  assert.equal(d.baseline.sha256, sha(page()));
  assert.equal(d.baseline.same_build, true);
  assert.equal(d.diff.percent, 0);
  assert.deepEqual(d.verdicts, ALL_PASS);
  const assertions = inheritedVisionAssertions({ decision: d, caseId: 'TC-01', state: 'orders-list', evidenceRef: 'evidence/TC-01/orders-list.png' });
  assert.deepEqual(assertions.map((a) => [a.rule, a.verdict, a.inherited.baseline_sha256]), Object.keys(ALL_PASS).map((rule) => [rule, 'PASS', sha(page())]));
  assert.deepEqual(assertions[0].inherited.baseline_key, KEY);
  assert.equal(assertions[0].evidence_type, 'gui-screenshot');
  // A few scattered pixels (a caret, anti-aliasing) stay within both limits.
  assert.equal(decide({ fixture, png: page({ noise: [[300, 190], [5, 100], [150, 30]] }) }).decision, 'inherit');
});

test('vision by diff: anything else runs the VLM, with the reason', () => {
  const fixture = approvedStore();
  const reasons = (extra) => { const d = decide({ fixture, ...extra }); assert.equal(d.decision, 'vlm'); assert.equal(d.tier, 2); return d.reasons; };
  // No approved baseline: none at all, only proposed, or another viewport/route.
  assert.deepEqual(reasons({ fixture: approvedStore({ approve: false }) }), ['NO_APPROVED_BASELINE']);
  assert.deepEqual(reasons({ key: { ...KEY, route: '/customers' } }), ['NO_APPROVED_BASELINE']);
  // A diff over 0.5%: a fourth list row (9% of the image).
  assert.ok(reasons({ png: page({ rows: 4 }) }).includes('DIFF_OVER_LIMIT'));
  // A small but concentrated change under 0.5% (the status icon turns red, 0.4% of pixels): the local guard sends it to
  // the VLM, which a whole-image percentage alone would have skipped.
  const icon = decide({ fixture, png: page({ icon: [200, 40, 40] }) });
  assert.ok(icon.diff.percent <= VISION_DIFF_MAX_PERCENT, String(icon.diff.percent));
  assert.deepEqual(icon.reasons, ['DIFF_LOCAL_OVER_LIMIT']);
  // The DOM sweep is not clean.
  assert.deepEqual(reasons({ sweep: { ...CLEAN, uiSanity: { ...CLEAN.uiSanity, verdict: 'FAIL' } } }), ['DOM_SWEEP_NOT_CLEAN']);
  // The signed plan raised the vision check's minimum tier: tier 0 may not settle it.
  assert.deepEqual(reasons({ minTier: 2 }), ['MIN_TIER']);
  // A baseline approved after this state was captured cannot vouch for it.
  assert.deepEqual(reasons({ capturedAt: '2026-11-01T01:30:00.000Z' }), ['BASELINE_APPROVED_AFTER_CAPTURE']);
  // Another size: the screenshot was not fitted like the baseline.
  assert.deepEqual(reasons({ png: encodePng({ width: 160, height: 100, data: Buffer.alloc(160 * 100 * 4, 250) }) }), ['SIZE_MISMATCH']);
  // The baseline PNG no longer has the approved hash.
  writeFileSync(join(fixture.dir, fixture.store.entries[0].png), page({ rows: 1 }));
  assert.deepEqual(reasons({}), ['BASELINE_PNG_DRIFT']);
});

test('vision by diff: the approved mask covers dynamic areas; a mask over 40% disables nothing, it sends the state to the VLM', () => {
  const masked = approvedStore({ mask: [{ x: 280, y: 160, width: 16, height: 16 }] });
  const d = decide({ fixture: masked, png: page({ icon: [200, 40, 40] }) });
  assert.equal(d.decision, 'inherit', JSON.stringify(d));
  const wide = approvedStore({ mask: [{ x: 0, y: 0, width: 320, height: 120 }] });
  assert.deepEqual(decide({ fixture: wide }).reasons, ['MASK_TOO_LARGE']);
});

test('CLI: baseline propose, approve, list and vision decide', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-gui-r3-cli-')));
  const png = join(dir, 'state.png'); writeFileSync(png, page());
  const store = join(dir, 'store', 'approved-baselines.json');
  const visionFile = join(dir, 'vision.json'); writeFileSync(visionFile, JSON.stringify(ALL_PASS));
  const keyArgs = ['--route', KEY.route, '--state', KEY.state, '--viewport', KEY.viewport, '--build', KEY.build];
  const env = { ...process.env }; delete env.QA_GUI_BASELINE_APPROVER;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  let r = run('baseline', 'propose', '--store', store, '--png', png, ...keyArgs, '--vision', visionFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const proposed = JSON.parse(r.stdout);
  assert.equal(proposed.entry.status, 'proposed');
  r = run('vision', 'decide', '--store', store, '--png', png, ...keyArgs, '--captured-at', T_CAPTURE);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).reasons, ['NO_APPROVED_BASELINE', 'DOM_SWEEP_MISSING']);
  r = spawnSync(process.execPath, [CLI, 'baseline', 'approve', '--store', store, ...keyArgs, '--sha256', sha(page()), '--by', 'Project Owner'], { encoding: 'utf8', env: { ...process.env, QA_GUI_BASELINE_APPROVER: 'Project Owner' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run('baseline', 'list', '--store', store);
  assert.equal(JSON.parse(r.stdout).entries[0].status, 'approved');
  const sweep = join(dir, 'sweep.json'); writeFileSync(sweep, JSON.stringify(CLEAN));
  r = run('vision', 'decide', '--store', store, '--png', png, ...keyArgs, '--sweep', sweep, '--captured-at', new Date(Date.now() + 60000).toISOString());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).decision, 'inherit');
  r = run('baseline', 'approve', '--store', store, ...keyArgs, '--sha256', 'f'.repeat(64), '--by', 'Project Owner');
  assert.equal(r.status, 2);
});
