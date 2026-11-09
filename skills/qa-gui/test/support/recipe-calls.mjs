// Recorded Dragon calls as a Team QA GUI executor makes them when it follows QA GUI's detector recipes
// (scripts/lib/stream-detectors.mjs), for the stream-detector tests. Synthetic from recorded data, never a live run.
import { STREAM_HELPERS, entryTrialParams, transientTrialSteps, trialParams } from '../../scripts/lib/stream-detectors.mjs';

let clock = Date.parse('2026-11-04T03:00:00.000Z');
const call = (method, params, result, { ok = true, ms = 20 } = {}) => {
  const called_at = new Date(clock += 400).toISOString();
  const at = new Date(clock += ms).toISOString();
  return { method, params, result, ok, called_at, at };
};

/**
 * The calls of one probe from a recorded R1d variant (test/fixtures/r1d/recorded): the recipe's sensorsStart, then per
 * trial framesStart, the trial `do` (its reads answered with the recorded samples; the extension reads past the point
 * where the driver closed the window answered with later samples), sensorsRead with the trial's own events,
 * framesStop, getNetwork, envGet, and sensorsStop.
 */
export function transientCalls(variant, { tabId = 7, selector = '#go', drop = [] } = {}) {
  const calls = [];
  const first = variant.trials[0];
  if (!drop.includes('sensors.start')) calls.push(call('sensors.start', { tabId }, { ok: true, startedAt: first.sensors.startedAt, streams: first.sensors.streams, cursor: 0 }));
  const seen = new Set();
  let cursor = 0;
  for (const trial of variant.trials) {
    calls.push(call('frames.start', { tabId }, { ok: true, windowId: trial.frames.windowId, startedAt: trial.frames.startedAt, guardFrom: trial.frames.guardFrom }));
    const steps = transientTrialSteps({ step: { clickSelector: selector }, targetSelector: selector });
    const samples = trial.samples.slice();
    let extra = samples.at(-1);
    const results = steps.map((step) => {
      if (step.read) {
        let value = samples.shift();
        if (!value) { extra = { ...extra, t: extra.t + 250 }; value = extra; }
        return { step: 'read', as: step.as, value };
      }
      if (step.clickSelector) return { step: 'clickSelector', ok: true, receipt: { ts: trial.markT } };
      return { step: 'wait', ok: true, waited: step.wait };
    });
    calls.push(call('do', { tabId, steps }, { completed: true, results }, { ms: 1100 + 3000 }));
    const own = trial.events.filter((e) => !seen.has(e.seq));
    for (const e of own) seen.add(e.seq);
    cursor = Math.max(cursor, ...own.map((e) => e.seq));
    if (!drop.includes('sensors.read')) calls.push(call('sensors.read', { tabId, since: 0, max: 2000 }, { ok: true, events: own, cursor, more: false, gap: trial.sensors.gap, overflow: trial.sensors.overflow, pageDropped: trial.sensors.pageDropped }));
    if (!drop.includes('frames.stop')) {
      calls.push(call('frames.stop', { tabId, keep: 'all', edges: true, maxKeep: 24 }, { ok: true, windowId: trial.frames.windowId, startedAt: trial.frames.startedAt,
        guardFrom: trial.frames.guardFrom, stoppedAt: trial.frames.stoppedAt, marks: trial.frames.marks, counts: trial.frames.counts, index: trial.frames.index,
        dir: `/frames/${trial.frames.windowId}`, frames: trial.frames.kept.map((f) => ({ seq: f.seq, t: f.t, reason: f.reason, file: f.file ?? `f-${String(f.seq).padStart(5, '0')}.jpg`, sha256: f.sha256 ?? null })) }));
    }
    calls.push(call('getNetwork', { tabId, types: ['XHR', 'Fetch'] }, { requests: trial.network }));
    calls.push(call('env.get', { tabId, readback: false }, { ok: true, conditions: trial.conditions, held: trial.held }));
  }
  calls.push(call('sensors.stop', { tabId }, { ok: true }));
  return calls;
}

/**
 * The calls of one probe as the D3 recipe makes them: one Dragon frames.trial per trial (R1a: the window opens and
 * closes inside the call), its answer built from a recorded R1d trial: the trial's own events (`pageAt` splits them
 * into the answer and sensorsRead pages of that size), the samples at their offsets and the extension samples, the
 * frames Dragon kept, the requests, the conditions. `helper` overrides the sample helper Dragon reports.
 */
export function trialCalls(variant, { tabId = 7, selector = '#go', pageAt = 200, helper = null, setup = [{ goto: 'http://127.0.0.1:5401/orders' }], state = null, alter = null } = {}) {
  const calls = [];
  for (const [n, trial] of variant.trials.entries()) {
    const params = { tabId, ...(state ? { correlationId: `transient:${state}` } : {}), ...trialParams({ step: { clickSelector: selector }, targetSelector: selector, setup }) };
    const samples = trial.samples.map((value, i) => ({ at: i === 0 ? 'pre' : i <= params.sample.at.length ? params.sample.at[i - 1] : 'x', t: value.t, value }));
    const events = trial.events.slice();
    const first = events.slice(0, pageAt), rest = events.slice(pageAt);
    const seq = (e, i) => (Number.isFinite(e?.seq) ? e.seq : i + 1);
    const answer = { ok: true, markT: trial.markT, actedAt: trial.markT - 5, window: { from: trial.markT - 100, to: trial.window.to, reasons: trial.window.extended ? ['dom'] : [] },
      sensors: { startedAt: trial.sensors.startedAt, streams: trial.sensors.streams ?? null, events: first, cursor: first.length ? seq(first.at(-1), first.length - 1) : 0, more: rest.length > 0,
        gap: trial.sensors.gap, overflow: trial.sensors.overflow, pageDropped: trial.sensors.pageDropped },
      sample: { helper: helper ?? { name: STREAM_HELPERS.sample.name, sha256: STREAM_HELPERS.sample.sha256 }, at: params.sample.at }, samples,
      frames: { ok: true, windowId: trial.frames.windowId, startedAt: trial.frames.startedAt, guardFrom: trial.frames.guardFrom, stoppedAt: trial.frames.stoppedAt, marks: trial.frames.marks,
        counts: trial.frames.counts, index: trial.frames.index, dir: `/frames/${trial.frames.windowId}`,
        frames: trial.frames.kept.map((f) => ({ seq: f.seq, t: f.t, reason: f.reason, file: f.file ?? `f-${String(f.seq).padStart(5, '0')}.jpg`, sha256: f.sha256 ?? null })) },
      network: trial.network, conditions: trial.conditions, timing: { sensorsStartMs: 10, framesStartMs: 40, framesStopMs: 30 }, after: { atDefault: true },
      // Fix round 2 (E3): the brief answers of the setup and the action, and the trusted-input mark of the action.
      mark: { t: trial.markT, label: 'trusted:pointerdown' },
      do: { completed: true, brief: true, results: [{ step: 'clickSelector', ok: true, receipt: { v: 1, brief: true, ts: trial.markT } }] },
      ...(Array.isArray(params.setup) ? { setup: { completed: true, brief: true, results: params.setup.map((x) => ({ step: Object.keys(x)[0], ok: true })) } } : {}) };
    // `alter(n, params, answer)` changes one trial (a click that missed, a failed setup...) for a test.
    const changed = alter ? alter(n, params, answer) : null;
    calls.push(call('frames.trial', changed?.params ?? params, changed?.answer ?? answer, { ms: 1500, ok: changed?.ok ?? true }));
    let cursor = answer.sensors.cursor;
    for (let i = 0; i < rest.length; i += pageAt) {
      const page = rest.slice(i, i + pageAt);
      const next = seq(page.at(-1), pageAt + i + page.length - 1);
      calls.push(call('sensors.read', { tabId, since: cursor, max: 200 }, { ok: true, events: page, cursor: next, more: i + pageAt < rest.length, gap: false, overflow: 0, pageDropped: 0 }));
      cursor = next;
    }
  }
  return calls;
}

/**
 * Round G (G5): the calls of one entry probe as the E recipe makes them: three frames.trial labelled `entry:<screenId>`,
 * each a blank page then the goto of `url`, answered with a synthetic stream in Dragon's R1a shapes: the new
 * document's hello and first paint, and (`jump`) a block inserted 290 ms after load that pushes `main` 60 px down at
 * +300 ms. `t0`: the first trial's navigation time.
 */
export function entryTrialCalls({ url, screenId = 'S1', tabId = 7, jump = false, main = 'main', t0 = 1_800_000_000_000, frameDir = null } = {}) {
  const calls = [];
  for (const n of [0, 1, 2]) {
    const M = t0 + n * 10_000;
    const events = [{ k: 'hello', t: M + 40, vw: 1280, vh: 800, supported: { 'layout-shift': true }, v2: true, doc: `d${n}` },
      { k: 'mutation', t: M + 80, added: 12, removed: 0, attrs: 0, text: 4, attrNames: [], targets: [main] }];
    if (jump) events.push({ k: 'mutation', t: M + 290, added: 1, removed: 0, attrs: 0, text: 1, attrNames: [], targets: [`${main}>div.banner`] },
      { k: 'layout-shift', t: M + 300, value: 0.08, hadRecentInput: false, sources: [{ node: main, prev: { x: 0, y: 120, w: 1280, h: 500 }, cur: { x: 0, y: 180, w: 1280, h: 500 } }] });
    events.forEach((e, i) => { e.seq = i + 1; });
    const params = { tabId, correlationId: `entry:${screenId}`, ...entryTrialParams({ url }) };
    const value = (t) => ({ t, vw: 1280, vh: 800, sx: 0, sy: 0, overflowX: false, clipped: [], target: { found: true }, busy: 0 });
    const samples = [{ at: 'pre', t: M - 100, value: value(M - 100) }, ...params.sample.at.map((d) => ({ at: d, t: M + d, value: value(M + d) }))];
    const answer = { ok: true, markT: M, actedAt: M, mark: null, window: { from: M - 100, to: M + 1000, reasons: [] },
      sensors: { startedAt: M - 400, streams: { 'layout-shift': 'cdp' }, events, cursor: events.length, more: false, gap: false, overflow: 0, pageDropped: 0 },
      sample: { helper: { name: STREAM_HELPERS.sample.name, sha256: STREAM_HELPERS.sample.sha256 }, at: params.sample.at }, samples,
      frames: { ok: true, windowId: `entry-${screenId}-${n}`, startedAt: M - 300, guardFrom: M - 200, stoppedAt: M + 1050, marks: [], counts: { kept: 0 },
        index: [{ seq: 1, t: M - 120 }, { seq: 2, t: M + 320 }], ...(frameDir ? { dir: frameDir } : {}), frames: [] },
      network: [{ t: M + 20, method: 'GET', url, status: 200 }],
      conditions: { v: 1, caseId: null, role: 'test', network: null, cpu: null, timezone: null, locale: null, media: null, animation: null, requests: [], probes: { sensors: true, frames: false },
        verified: null, setAt: M - 5000, expiresAt: M + 900000 },
      timing: { sensorsStartMs: 10, framesStartMs: 40, framesStopMs: 30 }, after: { atDefault: true },
      do: { completed: true, brief: true, results: [{ step: 'goto', ok: true, receipt: { v: 1, brief: true, ts: M } }] },
      setup: { completed: true, brief: true, results: [{ step: 'goto', ok: true }] } };
    calls.push(call('frames.trial', params, answer, { ms: 1500 }));
  }
  return calls;
}
