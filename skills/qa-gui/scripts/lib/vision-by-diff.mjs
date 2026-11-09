// Vision by diff (upgrade R3): the tier-0 decision for the C10–C16 vision check of one settled state.
//
// A state may inherit C10–C16 from an approved baseline, carrying that baseline's SHA-256, only when all of these hold:
//   1. the signed plan lets tier 0 settle the vision check (its minimum tier for `vision` is 0);
//   2. the approved-baseline store has an approved entry for the state's route, state and viewport (the exact build's
//      entry first, otherwise the latest approved one, marked same_build:false), approved before the state was captured,
//      whose PNG still has the approved hash;
//   3. the pixel diff after the approved mask is at most 0.5% of the compared pixels (VISION_DIFF_MAX_PERCENT), and no
//      32x32 tile has more than 5% of its pixels changed (VISION_TILE_MAX_PERCENT: a small concentrated change, such
//      as an icon turning red or one wrong glyph in a price, is a real visual change even under 0.5% of the image);
//   4. the state's DOM sweeps (Gate-0 ui-sanity and a11y) are clean: both PASS, no high or warn finding.
// Otherwise the decision is `vlm` (tier 2) with every reason that applied, and the VLM grades the state as before.
// The function is pure apart from reading the baseline PNG under `storeDir`; the gate runs it again to verify an
// inherited assertion, so a claim the executor or a board writer makes is never trusted.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { comparePngBuffers, decodePng } from '../visual-diff.mjs';
import { baselineApproverError } from '../teamwork/board-gates.mjs';
import { VISION_RULES, findApprovedBaseline, storeErrors } from './baseline-store.mjs';
import * as speedFlags from './speed-flags.mjs';

export const VISION_DIFF_MAX_PERCENT = 0.5;
export const VISION_TILE_PX = 32;
export const VISION_TILE_MAX_PERCENT = 5;
export const VISION_DECISION_SCHEMA = 'qa-gui/vision-diff-decision/v1';
export const VISION_INHERIT_SCHEMA = 'qa-gui/vision-inherit/v1';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const round6 = (value) => Number(value.toFixed(6));

// The route of a page URL as the store keys it: the path, plus a hash route (`#/…`) when the app routes by hash.
export function routeOf(url) {
  try {
    const u = new URL(url);
    return u.hash.startsWith('#/') ? `${u.pathname}${u.hash}` : u.pathname;
  } catch { return null; }
}

function parsedEvidence(raw) {
  if (typeof raw?.evidence !== 'string') return null;
  try { const value = JSON.parse(raw.evidence); return object(value) ? value : null; } catch { return null; }
}

// Clean DOM sweep: ui-sanity and a11y both PASS, and the raw result (when it is JSON) shows no high or warn finding.
export function domSweepClean({ uiSanity, a11y } = {}) {
  const reasons = [];
  for (const [name, raw] of [['ui-sanity', uiSanity], ['a11y', a11y]]) {
    if (!object(raw) || typeof raw.verdict !== 'string') { reasons.push(`${name}:missing`); continue; }
    if (raw.verdict !== 'PASS') { reasons.push(`${name}:${raw.verdict}`); continue; }
    const value = parsedEvidence(raw);
    const counts = object(value?.counts) ? value.counts : object(value?.c) ? value.c : null;
    if (counts && (Number(counts.high) > 0 || Number(counts.warn) > 0)) reasons.push(`${name}:findings`);
    else if (Array.isArray(value?.issues) && value.issues.length) reasons.push(`${name}:findings`);
  }
  return { clean: reasons.length === 0, reasons };
}

// Changed-pixel share of the busiest tile, with the same exact-RGBA rule and mask as visual-diff.mjs.
function maxTilePercent(baselinePng, actualPng, mask) {
  const a = decodePng(baselinePng), b = decodePng(actualPng);
  const { width, height } = a;
  const rects = (Array.isArray(mask) ? mask : []).map((r) => ({ x1: Math.max(0, Math.floor(r.x)), y1: Math.max(0, Math.floor(r.y)),
    x2: Math.min(width, Math.ceil(r.x + r.width)), y2: Math.min(height, Math.ceil(r.y + r.height)) }));
  const cols = Math.ceil(width / VISION_TILE_PX), rows = Math.ceil(height / VISION_TILE_PX);
  const changed = new Uint32Array(cols * rows), compared = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (rects.some((r) => x >= r.x1 && x < r.x2 && y >= r.y1 && y < r.y2)) continue;
    const tile = Math.floor(y / VISION_TILE_PX) * cols + Math.floor(x / VISION_TILE_PX);
    compared[tile] += 1;
    const i = (y * width + x) * 4;
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) changed[tile] += 1;
  }
  let max = 0;
  for (let t = 0; t < changed.length; t += 1) if (compared[t]) max = Math.max(max, (changed[t] / compared[t]) * 100);
  return round6(max);
}

// The tier-0 decision for one state. `png` is the state's evidence PNG (fitted like the baseline); `key` is
// {route, state, viewport, build}; `sweep` is {uiSanity, a11y} from the state receipt; `capturedAt` its capture time.
export function visionDiffDecision({ png, key, store, storeDir, sweep, capturedAt, minTier = 0 }) {
  const started = Date.now();
  const reasons = [];
  const out = { schema: VISION_DECISION_SCHEMA, key, decision: 'vlm', tier: 2, reasons, min_tier: minTier,
    png_sha256: Buffer.isBuffer(png) ? sha256(png) : null, baseline: null, diff: null, sweep: null, verdicts: null };
  if (minTier > 0) reasons.push('MIN_TIER');
  const found = findApprovedBaseline(store, key);
  if (!found) reasons.push('NO_APPROVED_BASELINE');
  else {
    const { entry, sameBuild } = found;
    out.baseline = { sha256: entry.sha256, key: entry.key, same_build: sameBuild, approved_by: entry.approved_by, approved_at: entry.approved_at };
    const captured = Date.parse(capturedAt), approved = Date.parse(entry.approved_at);
    if (!Number.isFinite(captured) || !Number.isFinite(approved) || approved > captured) reasons.push('BASELINE_APPROVED_AFTER_CAPTURE');
    let baselinePng = null;
    try { baselinePng = readFileSync(join(storeDir, 'png', `${entry.sha256}.png`)); } catch { baselinePng = null; }
    if (!baselinePng || sha256(baselinePng) !== entry.sha256) reasons.push('BASELINE_PNG_DRIFT');
    else if (VISION_RULES.some((rule) => entry.vision?.[rule] !== 'PASS')) reasons.push('BASELINE_VISION_NOT_PASS');
    else {
      let result = null;
      try {
        const actual = decodePng(png);
        if (actual.width !== entry.width || actual.height !== entry.height) reasons.push('SIZE_MISMATCH');
        else result = comparePngBuffers(baselinePng, png, { state: key.state, mask: entry.mask });
      } catch (error) {
        reasons.push(/mask covers/.test(String(error?.message)) ? 'MASK_TOO_LARGE' : 'DIFF_UNAVAILABLE');
      }
      if (result) {
        const tile = maxTilePercent(baselinePng, png, entry.mask);
        out.diff = { percent: result.diffPercent, max_tile_percent: tile, changed_pixels: result.changedPixels,
          compared_pixels: result.comparedPixels, masked_pixels: result.maskedPixels };
        if (result.diffPercent > VISION_DIFF_MAX_PERCENT) reasons.push('DIFF_OVER_LIMIT');
        if (tile > VISION_TILE_MAX_PERCENT) reasons.push('DIFF_LOCAL_OVER_LIMIT');
      }
    }
  }
  if (!object(sweep) || (!sweep.uiSanity && !sweep.a11y)) reasons.push('DOM_SWEEP_MISSING');
  else {
    out.sweep = domSweepClean(sweep);
    if (!out.sweep.clean) reasons.push('DOM_SWEEP_NOT_CLEAN');
  }
  if (!reasons.length) {
    out.decision = 'inherit';
    out.tier = 0;
    out.verdicts = Object.fromEntries(VISION_RULES.map((rule) => [rule, found.entry.vision[rule]]));
  }
  out.duration_ms = Date.now() - started;
  return out;
}

// The seven vision v2 assertions of an inherited state. Each carries the baseline it came from; the gate recomputes it.
export function inheritedVisionAssertions({ decision, caseId, state, evidenceRef }) {
  if (decision?.decision !== 'inherit') throw new Error('VISION_INHERIT_NOT_DECIDED');
  return VISION_RULES.map((rule) => ({
    assertion_id: `${caseId}-${state}-${rule}`, case_id: caseId, state, rule, verdict: decision.verdicts[rule],
    evidence_ref: evidenceRef, evidence_type: 'gui-screenshot',
    inherited: { schema: VISION_INHERIT_SCHEMA, baseline_sha256: decision.baseline.sha256, baseline_key: decision.baseline.key,
      diff_percent: decision.diff.percent, max_tile_percent: decision.diff.max_tile_percent },
  }));
}

// The gate's check of one state's inherited vision assertions (upgrade R3). Returns issue messages
// `VISION_INHERIT_<CODE>:<case>:<state>:<detail>`, empty when the state has no inherited assertion or every one is
// recomputed exactly. All seven rules must come from the same decision; the policy must have vision_by_diff on; the
// store must be the one the policy pins, inside the evidence root; the decision is made again from the state receipt
// (route from its URL, its viewport, build, DOM sweeps and capture time) and the state's screenshot.
export function inheritedStateIssues({ assertions, policy, evidenceRoot, png, receipt, caseId, state, env = process.env, speed = speedFlags }) {
  const own = (Array.isArray(assertions) ? assertions : []).filter((a) => a?.case_id === caseId && a?.state === state && VISION_RULES.includes(a?.rule));
  const inherited = own.filter((a) => Object.hasOwn(a, 'inherited'));
  if (!inherited.length) return [];
  const at = `${caseId}:${state}`;
  const issues = [];
  if (inherited.length !== VISION_RULES.length || own.length !== VISION_RULES.length) issues.push(`VISION_INHERIT_PARTIAL:${at}:${inherited.length}/${VISION_RULES.length} rules inherited`);
  const policyErrors = speed.speedPolicyErrors(policy);
  if (policyErrors.length || speed.speedMode(policy, 'vision_by_diff') !== 'on') {
    issues.push(`VISION_INHERIT_FLAG_OFF:${at}:vision_by_diff is ${policyErrors.length ? 'not set by a valid speed policy' : speed.speedMode(policy, 'vision_by_diff')}`);
    return issues;
  }
  const pin = policy.baseline_store;
  let storeFile = null, storeBytes = null;
  try {
    const root = realpathSync(evidenceRoot);
    if (!pin) throw new Error('the policy pins no baseline store');
    const candidate = resolve(root, pin.path);
    if (lstatSync(candidate).isSymbolicLink()) throw new Error('the store is a symlink');
    storeFile = realpathSync(candidate);
    const rel = relative(root, storeFile);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('the store is outside the evidence root');
    storeBytes = readFileSync(storeFile);
    if (sha256(storeBytes) !== pin.sha256) throw new Error('the store is not the one the policy pins');
  } catch (error) {
    issues.push(`VISION_INHERIT_STORE_DRIFT:${at}:${String(error?.message ?? error)}`);
    return issues;
  }
  let store = null;
  try { store = JSON.parse(storeBytes.toString('utf8')); } catch { issues.push(`VISION_INHERIT_STORE_DRIFT:${at}:store JSON`); return issues; }
  const storeDir = dirname(storeFile);
  const storeProblems = storeErrors(store, { dir: storeDir });
  if (storeProblems.length) { issues.push(`VISION_INHERIT_STORE_DRIFT:${at}:${storeProblems.join(',')}`); return issues; }
  const key = { route: routeOf(receipt?.url), state, viewport: receipt?.viewport, build: receipt?.build };
  const decision = visionDiffDecision({ png, key, store, storeDir, sweep: receipt?.ui, capturedAt: receipt?.capturedAt, minTier: speed.minTier(policy, 'vision') });
  if (decision.decision !== 'inherit') { issues.push(`VISION_INHERIT_INVALID:${at}:${decision.reasons.join(',')}`); return issues; }
  const approverError = baselineApproverError(decision.baseline.approved_by, env);
  if (approverError) issues.push(`VISION_INHERIT_APPROVER:${at}:${approverError}`);
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 0.000001;
  for (const a of inherited) {
    const r = a.inherited;
    const ok = object(r) && r.schema === VISION_INHERIT_SCHEMA && r.baseline_sha256 === decision.baseline.sha256
      && JSON.stringify(r.baseline_key) === JSON.stringify(decision.baseline.key)
      && near(r.diff_percent, decision.diff.percent) && near(r.max_tile_percent, decision.diff.max_tile_percent)
      && a.verdict === decision.verdicts[a.rule];
    if (!ok) issues.push(`VISION_INHERIT_MISMATCH:${at}:${a.rule}`);
  }
  return issues;
}
