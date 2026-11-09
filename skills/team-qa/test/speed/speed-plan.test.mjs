// Upgrade R3 (speed-ups): the signed plan's `speed` block. Every flag is off unless the plan says shadow or on; the
// policy a run uses is read from the signed plan file, never from the executor. Synthetic plans in a temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planErrors } from '../../scripts/lib/validators.mjs';
import { LADDER_CHECKS, SPEED_FLAGS, SPEED_MODES, boardSpeedPolicy, planSpeedErrors, runSpeedPolicy, speedOf } from '../../scripts/lib/speed.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'scripts/teamqa.mjs');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const base = () => ({
  run_id: 'r3-run', app: 'shop', plan_version: 1,
  lanes: [{ id: 'lane-a', scope: ['REQ-A'], parallel_ok: false, vi_sao: '' }],
  tiers: { 'REQ-A': 'FULL' },
  exit_criteria: { p0_max: 0, p1_max: 0, p1_waivers: [], coverage_high_pct: 100, coverage_low_pct: 70 },
});
const STORE = { path: 'baselines/approved-baselines.json', sha256: 'a'.repeat(64) };

test('the speed block is optional; a plan without it validates exactly as before', () => {
  assert.deepEqual(planErrors(base()), []);
  assert.deepEqual(planErrors({ ...base(), speed: {} }), []);
  assert.deepEqual(SPEED_FLAGS, ['vision_by_diff', 'cost_ladder', 'parallel_gui_lanes', 'fast_click', 'action_cache']);
  assert.deepEqual(SPEED_MODES, ['off', 'shadow', 'on']);
  assert.deepEqual(LADDER_CHECKS, { gate0: 0, vision: 2, function: 2, verdict: 2 });
  const off = speedOf(base());
  assert.deepEqual(off.flags, { vision_by_diff: 'off', cost_ladder: 'off', parallel_gui_lanes: 'off', fast_click: 'off', action_cache: 'off' });
  assert.deepEqual(off.min_tier, {});
});

test('the speed block names known flags with off, shadow or on, minimum tiers 0-3 per known check, and pins its stores', () => {
  assert.deepEqual(planErrors({ ...base(), speed: { vision_by_diff: 'shadow', fast_click: 'on', min_tier: { vision: 0, verdict: 3 }, baseline_store: STORE } }), []);
  const codes = (speed) => planSpeedErrors(speed).map((e) => e.split(' ')[0]);
  assert.deepEqual(codes({ turbo: 'on' }), ['PLAN_SPEED_UNKNOWN_FIELD']);
  assert.deepEqual(codes({ fast_click: true }), ['PLAN_SPEED_MODE']);
  assert.deepEqual(codes({ min_tier: { vision: 5 } }), ['PLAN_SPEED_MIN_TIER']);
  assert.deepEqual(codes({ min_tier: { dark_mode: 0 } }), ['PLAN_SPEED_MIN_TIER']);
  // Vision by diff compares with a store whose hash the signed plan pins; the action cache likewise.
  assert.deepEqual(codes({ vision_by_diff: 'on' }), ['PLAN_SPEED_STORE_REQUIRED']);
  assert.deepEqual(codes({ vision_by_diff: 'shadow', baseline_store: { path: 'x.json' } }), ['PLAN_SPEED_STORE']);
  assert.deepEqual(codes({ action_cache: 'shadow' }), ['PLAN_SPEED_STORE_REQUIRED']);
  assert.deepEqual(codes({ action_cache: 'on', action_cache_store: STORE }), []);
  assert.deepEqual(codes({ baseline_store: { path: '/abs/path.json', sha256: 'a'.repeat(64) } }), ['PLAN_SPEED_STORE']);
  assert.ok(planErrors({ ...base(), speed: 'fast' }).includes('PLAN_TYPE speed'));
});

function runDir(speed) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'teamqa-r3-speed-')));
  const dir = join(project, 'runs', 'r3-run');
  mkdirSync(dir, { recursive: true });
  const text = `# Plan\n\nTEAMQA_PLAN_START\n${JSON.stringify({ ...base(), ...(speed ? { speed } : {}) }, null, 2)}\nTEAMQA_PLAN_END\n`;
  writeFileSync(join(dir, 'test-plan.md'), text);
  return { project, dir, text };
}

test('the run policy is read from the signed plan file and names its SHA-256; the board gets QA GUI\'s speedPolicy', () => {
  const { dir, text } = runDir({ vision_by_diff: 'on', min_tier: { vision: 0 }, baseline_store: STORE });
  const policy = runSpeedPolicy(dir);
  assert.deepEqual(policy.source, { kind: 'team-qa/signed-plan', sha256: sha(text), path: 'test-plan.md' });
  assert.equal(policy.flags.vision_by_diff, 'on');
  assert.equal(policy.flags.fast_click, 'off');
  const board = boardSpeedPolicy(policy, { storePath: 'evidence/qa-gui/speed/approved-baselines.json' });
  assert.deepEqual(board, { version: 1, source: { kind: 'team-qa/signed-plan', sha256: sha(text) }, flags: policy.flags, min_tier: { vision: 0 },
    baseline_store: { path: 'evidence/qa-gui/speed/approved-baselines.json', sha256: STORE.sha256 } });
  // A plan without a speed block: every flag off, and nothing for the board.
  const off = runSpeedPolicy(runDir().dir);
  assert.ok(Object.values(off.flags).every((mode) => mode === 'off'));
  assert.equal(boardSpeedPolicy(off), null);
});

test('teamqa speed show prints each flag, its mode and what it skips', () => {
  const { project } = runDir({ fast_click: 'shadow' });
  const r = spawnSync(process.execPath, [CLI, 'speed', 'show', '--run', 'r3-run'], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.flags.fast_click, 'shadow');
  assert.equal(out.flags.vision_by_diff, 'off');
  assert.ok(out.skips.fast_click.length > 0);
  assert.ok(out.always_runs.vision_by_diff.length > 0);
  assert.equal(out.source.sha256, sha(readFileSync(join(project, 'runs/r3-run/test-plan.md'))));
});
