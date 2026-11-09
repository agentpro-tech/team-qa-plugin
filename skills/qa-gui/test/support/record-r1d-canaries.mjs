#!/usr/bin/env node
// Upgrade R1d: record the transient canaries (test/fixtures/r1d/canary.html) through Dragon's own R1a controller over a
// Playwright CDP session, with QA GUI's probe driver, into test/fixtures/r1d/recorded/. The tests then grade these
// recorded streams on every run (no browser needed). Refresh them when the probe, the canaries or Dragon R1a change:
//   DRAGON_APP_DIR=<Dragon checkout>/apps/dragon-browser node test/support/record-r1d-canaries.mjs [--only T2,T5] [--repeats 3]
// Needs Playwright (this checkout, QA_GUI_PLAYWRIGHT_MODULE, or the Node module path) and Chromium.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { runTransientProbe, sampleRead } from '../../scripts/lib/transient-probe.mjs';
import { SCENARIOS, baselineAction, canaryServer, loadDragonController, loadPlaywrightAny, recordVariant } from './r1d-recorder.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, 'test/fixtures/r1d/recorded');
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const only = flag('--only', null)?.split(',') ?? SCENARIOS;
const repeats = Number(flag('--repeats', 3));
const ONSETS = [100, 300, 1000];

const pw = await loadPlaywrightAny();
const controller = loadDragonController();
if (!pw || !controller) { console.error('needs Playwright and DRAGON_APP_DIR (a Dragon checkout with R1a: apps/dragon-browser)'); process.exit(2); }
const dragonVersion = JSON.parse(readFileSync(join(process.env.DRAGON_APP_DIR, 'package.json'), 'utf8')).version;
const server = await canaryServer();
const browser = await pw.chromium.launch();
const recordedWith = { chromium: browser.version(), dragonController: `apps/dragon-browser/extension/env-controller.js (Dragon ${dragonVersion}, R1a)`, transport: 'Playwright CDP session',
  privacy: 'stub mask provider (the canary page has no secret or PII field)', recordedAt: new Date().toISOString().slice(0, 10) };
mkdirSync(OUT, { recursive: true });
try {
  for (const scenario of only.filter((s) => s !== 'overhead')) {
    const variants = [];
    for (const at of ONSETS) for (const clean of [false, true]) {
      const v = await recordVariant({ browser, controller, base: server.base, scenario, at, clean, repeats, runTransientProbe });
      variants.push({ at, clean, classification: v.classification, trials: v.trials, reset: v.reset });
      process.stdout.write(`${scenario}@${at}${clean ? ' clean' : ''} `);
    }
    const doc = { schema: 'qa-gui/r1d-recording/v1', recordedWith, scenario, page: `canary.html?s=${scenario}&at=<ms>[&clean=1]`, variants };
    writeFileSync(join(OUT, `${scenario}.json.gz`), gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 }));
    process.stdout.write('\n');
  }
  if (only === SCENARIOS || only.includes('overhead')) {
    // Overhead on the clean screen: the action without the probe, then each schedule's probe (5 repeats each).
    const baseline = await baselineAction({ browser, controller, base: server.base, repeats: 5, sampleRead });
    const schedules = {};
    for (const schedule of ['fixed7', 'events', 'all']) {
      const v = await recordVariant({ browser, controller, base: server.base, scenario: 'none', at: 300, clean: true, repeats: 5, schedule, runTransientProbe });
      schedules[schedule] = v.trials.map((t) => ({ wallMs: t.timing.wallMs, sensorsStartMs: t.timing.sensorsStartMs, framesStartMs: t.timing.framesStartMs, framesStopMs: t.timing.framesStopMs,
        sensorsReadMs: t.timing.sensorsReadMs, samplesMs: t.timing.samplesMs, decisionsMs: t.timing.decisionsMs, windowMs: Math.round(t.window.to - t.markT), keptFrames: t.frames?.kept?.length ?? 0 }));
    }
    writeFileSync(join(OUT, 'overhead.json'), `${JSON.stringify({ schema: 'qa-gui/r1d-overhead/v1', recordedWith, page: 'canary.html?s=none', baselineMs: baseline, schedules }, null, 1)}\n`);
    console.log('overhead');
  }
} finally { await browser.close(); await server.close(); }
