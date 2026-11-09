// Integration: the R1d transient probe in a Team QA web-lane run. The executor sends the recipe's Dragon calls; the
// receipt QA GUI rebuilds from those calls must be the one its own driver builds: same trials, same windows, same
// verdict, on every recorded canary and clean twin (test/fixtures/r1d/recorded, real Dragon R1a streams).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { dragonOps, transientProbeFromOps, transientTrialSteps, SAMPLE_CALL } from '../scripts/lib/stream-detectors.mjs';
import { transientProbeVerdict } from '../scripts/lib/transient-probe.mjs';
import { CANARY_RULE, SCENARIOS, canaryAction } from './support/r1d-recorder.mjs';
import { transientCalls } from './support/recipe-calls.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const load = (s) => JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test/fixtures/r1d/recorded', `${s}.json.gz`))).toString('utf8'));
const recordings = Object.fromEntries(SCENARIOS.map((s) => [s, load(s)]));
const build = (s, v, extra = {}) => transientProbeFromOps(dragonOps(transientCalls(v, extra)), { caseId: 'TC-R1D', state: `${s}-${v.at}`, action: canaryAction(s) });

test('the recipe trial is the driver\'s: the samples at the same marks, then every extension step to +3 s', () => {
  const steps = transientTrialSteps({ step: { clickSelector: '#save' }, targetSelector: '#save' });
  assert.deepEqual(steps.filter((s) => s.read).map((s) => s.as), ['t:s-pre', 't:s16', 't:s50', 't:s100', 't:s250', 't:s500', 't:s1000', ...Array(8).fill('t:sx')]);
  assert.deepEqual(steps.filter((s) => s.wait).map((s) => s.wait), [100, 16, 34, 50, 150, 250, 500, ...Array(8).fill(250)]);
  assert.deepEqual(steps[2], { clickSelector: '#save', fast: false });
  assert.ok(steps[0].read.includes('window.__qaSample') && steps[4].read === SAMPLE_CALL);
});

test('every recorded canary and clean twin: the rebuilt trials are the driver\'s and the gate reaches the same verdict', () => {
  for (const s of SCENARIOS) {
    for (const v of recordings[s].variants) {
      const label = `${s}@${v.at}${v.clean ? ' clean' : ''}`;
      const { receipt, issues } = build(s, v);
      assert.deepEqual(issues, [], label);
      assert.equal(receipt.trials.length, v.trials.length, label);
      receipt.trials.forEach((t, i) => {
        const live = v.trials[i];
        assert.equal(t.markT, live.markT, `${label} trial ${i} mark`);
        assert.deepEqual(t.samples, live.samples, `${label} trial ${i} samples`);
        assert.deepEqual(t.events, live.events, `${label} trial ${i} events`);
        assert.deepEqual([t.window.from, t.window.extended, t.window.reason], [live.window.from, live.window.extended, live.window.reason], `${label} trial ${i} window`);
        assert.deepEqual(t.frames.kept.map((f) => f.seq), live.frames.kept.map((f) => f.seq), `${label} trial ${i} frames`);
        assert.deepEqual([t.network, t.conditions, t.held], [live.network, live.conditions, live.held], `${label} trial ${i}`);
      });
      const graded = transientProbeVerdict(JSON.parse(JSON.stringify(receipt)));
      const want = v.clean || CANARY_RULE[s][1] === 'WARN' ? 'PASS' : 'FAIL';
      assert.equal(graded.verdict, want, `${label}: ${graded.issues.join(',')}`);
      if (want === 'FAIL') assert.ok(graded.issues.some((code) => code.startsWith(`TRANSIENT_${CANARY_RULE[s][0]}:`)), `${label}: ${graded.issues.join(',')}`);
    }
  }
});

test('a recipe step left out never makes a PASS: no sensors, no sensor read or no frame window is UNGRADED', () => {
  const v = recordings.T1.variants.find((x) => x.clean);
  for (const [drop, code] of [[['sensors.start'], 'TRANSIENT_SENSORS_LATE'], [['sensors.read'], 'TRANSIENT_SENSORS_GAP']]) {
    const { receipt, issues } = build('T1', v, { drop });
    if (drop[0] === 'sensors.start') assert.deepEqual(issues, ['TRANSIENT_SENSORS_NOT_STARTED']);
    const graded = transientProbeVerdict(receipt);
    assert.equal(graded.verdict, 'UNGRADED', `${drop}: ${graded.issues}`);
    assert.ok(graded.issues.some((c) => c.startsWith(code)), `${drop}: ${graded.issues}`);
  }
  const { receipt } = build('T3', recordings.T3.variants.find((x) => !x.clean), { drop: ['frames.stop'] });
  assert.ok(receipt.trials.every((t) => t.frames.ok === false && t.frames.code === 'FRAMES_NOT_RECORDED'));
  assert.notEqual(transientProbeVerdict(receipt).verdict, 'PASS');
  // No probe in the calls: nothing to rebuild.
  assert.equal(transientProbeFromOps(dragonOps([]), { caseId: 'TC', state: 's' }), null);
});

test('kept frames can be renamed to their copies in the run, and the timing comes from the stream', () => {
  const v = recordings.T2.variants.find((x) => !x.clean);
  const { receipt } = transientProbeFromOps(dragonOps(transientCalls(v)), { caseId: 'TC-R1D', state: 's', action: canaryAction('T2'),
    frameRef: (stop, f) => `evidence/qa-gui/TC-R1D/frames/${stop.windowId}/${f.file}` });
  const kept = receipt.trials[0].frames.kept;
  assert.ok(kept.length > 0 && kept.every((f) => f.file.startsWith(`evidence/qa-gui/TC-R1D/frames/${v.trials[0].frames.windowId}/f-`)));
  assert.equal(receipt.trials[0].timing.source, 'stream');
  assert.ok(receipt.overhead.addedMs.every((ms) => Number.isFinite(ms) && ms >= 0));
});
