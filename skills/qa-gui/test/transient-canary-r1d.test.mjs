// Upgrade R1d acceptance on recorded streams: every T rule FAILs on its canary at +100, +300 and +1000 ms (T7 and the T8
// lint never go beyond a warning), is silent on the clean twin, the four observation schedules are compared, and the
// overhead is measured on a clean screen. The streams (test/fixtures/r1d/recorded) were recorded in Chromium through
// Dragon's own R1a controller over a Playwright CDP session with QA GUI's probe driver (test/support/record-r1d-canaries.mjs);
// these tests grade them on every run without a browser. A live run is added when Playwright and DRAGON_APP_DIR exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { SCHEDULES, T_RULES, gradeTransientRules, overheadSummary, scheduleMetrics } from '../scripts/lib/transient-rules.mjs';
import { buildTransientProbeReceipt, runTransientProbe, transientProbeVerdict } from '../scripts/lib/transient-probe.mjs';
import { CANARY_RULE, SCENARIOS, canaryAction, canaryServer, loadDragonController, loadPlaywrightAny, recordVariant } from './support/r1d-recorder.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RECORDED = join(ROOT, 'test/fixtures/r1d/recorded');
const load = (s) => JSON.parse(gunzipSync(readFileSync(join(RECORDED, `${s}.json.gz`))).toString('utf8'));
const recordings = Object.fromEntries(SCENARIOS.map((s) => [s, load(s)]));
const silent = (r) => r.verdict === 'PASS' || (r.verdict === 'UNGRADED' && r.reason === 'CONDITION_ABSENT');

test('the recordings are real Dragon R1a streams: three onsets and a clean twin per canary, three real-speed repeats each', () => {
  for (const s of SCENARIOS) {
    const doc = recordings[s];
    assert.equal(doc.schema, 'qa-gui/r1d-recording/v1');
    assert.match(doc.recordedWith.dragonController, /env-controller\.js/);
    assert.deepEqual(doc.variants.map((v) => `${v.at}${v.clean ? 'c' : ''}`).sort(), ['100', '1000', '1000c', '100c', '300', '300c']);
    for (const v of doc.variants) {
      assert.equal(v.trials.length, 3, `${s}@${v.at}`);
      assert.equal(v.reset.ok && v.reset.atDefault, true, 'env.reset verified after the case');
      for (const t of v.trials) {
        assert.ok(t.events.some((e) => e.k === 'hello') && t.events.some((e) => e.k === 'input' && e.trusted), `${s}@${v.at}: hello and the trusted input`);
        assert.ok(t.frames.ok && t.frames.index.length > 0 && t.samples.length >= 7, `${s}@${v.at}: frames and samples`);
        assert.ok(t.window.to - t.markT >= 1000 && t.window.to - t.markT <= 3300, `${s}@${v.at}: window ${t.window.to - t.markT}`);
        assert.equal(t.conditions.probes.sensors, true);
      }
    }
  }
});

test('each T rule FAILs on its canary at +100, +300 and +1000 ms (T7 and the T8 lint warn), confirmed at the same mark', () => {
  const failed = new Set();
  for (const s of SCENARIOS) {
    const [rule, want] = CANARY_RULE[s];
    for (const v of recordings[s].variants.filter((x) => !x.clean)) {
      const r = gradeTransientRules(v.trials)[rule];
      assert.equal(r.verdict, want, `${s}@${v.at}: ${JSON.stringify(r)}`);
      assert.ok(r.n === 3 && r.k >= (want === 'FAIL' ? 2 : 1), `${s}@${v.at}: ${r.k}/${r.n}`);
      if (want === 'FAIL') {
        assert.equal(r.reason, 'CONFIRMED');
        assert.ok(r.mark >= v.at - 30 && r.mark <= v.at + 700, `${s}@${v.at}: the anomaly is at +${r.mark} ms`);
        failed.add(rule);
      }
    }
  }
  assert.deepEqual([...failed].sort(), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T8'], 'every blocking rule has a canary it FAILs on; T7 is warn-only');
});

test('each T rule is silent on the clean twin (no FAIL, no warning, no ungradable rule)', () => {
  for (const s of SCENARIOS) {
    for (const v of recordings[s].variants.filter((x) => x.clean)) {
      const rules = gradeTransientRules(v.trials);
      for (const rule of T_RULES) assert.ok(silent(rules[rule]), `${s}@${v.at} clean: ${rule} ${JSON.stringify(rules[rule])}`);
      assert.equal(rules[CANARY_RULE[s][0]].verdict, 'PASS', `${s}@${v.at} clean: the canary's own rule saw its condition and found nothing`);
    }
  }
});

test('the probe receipt of a recorded canary passes the gate\'s checks; the VLM gets 3-6 keyframes and the clean frame', () => {
  for (const s of SCENARIOS) {
    for (const v of recordings[s].variants) {
      const receipt = buildTransientProbeReceipt({ caseId: 'TC-R1D', state: `${s}-${v.at}${v.clean ? '-clean' : ''}`, action: canaryAction(s), trials: v.trials });
      const graded = transientProbeVerdict(JSON.parse(JSON.stringify(receipt)));
      const want = v.clean || CANARY_RULE[s][1] === 'WARN' ? 'PASS' : 'FAIL';
      assert.equal(graded.verdict, want, `${s}@${v.at}${v.clean ? ' clean' : ''}: ${graded.issues.join(',')}`);
      if (v.clean) assert.deepEqual(graded.warnings, [], `${s}@${v.at} clean`);
      if (!v.clean) {
        assert.ok(receipt.keyframes.clean && receipt.keyframes.clean.t <= v.trials[receipt.keyframes.trial].markT, `${s}@${v.at}: clean frame`);
        assert.ok(receipt.keyframes.frames.length >= 1 && receipt.keyframes.frames.length <= 6, `${s}@${v.at}: ${receipt.keyframes.frames.length} keyframes`);
      }
      assert.ok(receipt.overhead.addedMs.every((ms) => Number.isFinite(ms) && ms >= 0));
    }
  }
});

test('observation schedules on the fixtures: caught, frames per action, ms added and false alarms (the eval picks on dev data)', () => {
  const defects = SCENARIOS.flatMap((s) => recordings[s].variants.filter((v) => !v.clean).map((v) => ({ rule: CANARY_RULE[s][0], trials: v.trials })));
  const cleans = SCENARIOS.flatMap((s) => recordings[s].variants.filter((v) => v.clean).map((v) => ({ trials: v.trials })));
  const table = scheduleMetrics({ defects, cleans });
  const overhead = overheadSummary(JSON.parse(readFileSync(join(RECORDED, 'overhead.json'), 'utf8')));
  const rows = SCHEDULES.map((s) => ({ schedule: s, caught: `${table[s].caught}/${table[s].defects}`, caughtAdditionally: table.caughtAdditionally[s],
    framesPerAction: table[s].framesPerAction, msAddedPerAction: overhead[s].addedMs, falseAlarms: `${table[s].falseAlarms} on ${table[s].cleanScreens} clean screens` }));
  console.log(JSON.stringify(rows));
  assert.equal(table.events.caught, defects.length, 'the probe (marks plus event frames) catches every canary');
  assert.equal(table.all.caught, table.events.caught, 'every frame adds no machine catch over the event frames');
  assert.ok(table.stable.caught <= table.fixed7.caught && table.fixed7.caught < table.events.caught);
  assert.equal(table.events.falseAlarms, 0);
  assert.ok(table.fixed7.framesPerAction <= table.events.framesPerAction && table.events.framesPerAction <= table.all.framesPerAction);
  assert.ok(overhead.events.addedMs > 0 && overhead.all.addedMs >= overhead.events.addedMs - 50);
});

test('overhead is measured on a clean screen: the action without a probe, then each schedule\'s probe', () => {
  const raw = JSON.parse(readFileSync(join(RECORDED, 'overhead.json'), 'utf8'));
  assert.equal(raw.schema, 'qa-gui/r1d-overhead/v1');
  assert.equal(raw.page, 'canary.html?s=none');
  assert.equal(raw.baselineMs.length, 5);
  for (const s of ['fixed7', 'events', 'all']) {
    assert.equal(raw.schedules[s].length, 5, s);
    for (const t of raw.schedules[s]) assert.ok(t.windowMs >= 1000 && t.windowMs < 3300, `${s}: ${t.windowMs}`);
  }
  const summary = overheadSummary(raw);
  assert.ok(summary.baselineMs > 0 && summary.baselineMs < 1000);
  assert.ok(summary.events.addedMs < 3500, 'the probe never adds more than its 3 s cap and its RPCs');
});

const pw = await loadPlaywrightAny();
const controller = loadDragonController();
test('live: a canary and its twin through Dragon R1a in Chromium (needs Playwright and DRAGON_APP_DIR)', { skip: pw && controller ? false : 'needs Playwright and DRAGON_APP_DIR (a Dragon checkout with R1a)' }, async () => {
  const server = await canaryServer();
  const browser = await pw.chromium.launch();
  try {
    for (const [scenario, at] of [['T2', 300], ['T5', 1000]]) {
      const defect = await recordVariant({ browser, controller, base: server.base, scenario, at, clean: false, repeats: 3, runTransientProbe });
      assert.equal(gradeTransientRules(defect.trials)[CANARY_RULE[scenario][0]].verdict, 'FAIL', scenario);
      const clean = await recordVariant({ browser, controller, base: server.base, scenario, at, clean: true, repeats: 3, runTransientProbe });
      assert.ok(Object.values(gradeTransientRules(clean.trials)).every(silent), `${scenario} clean`);
      assert.equal(clean.reset.atDefault, true);
    }
  } finally { await browser.close(); await server.close(); }
});
