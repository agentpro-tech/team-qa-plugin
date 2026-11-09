// Upgrade R1d: a stand-in for Dragon in tests and fixture recording. It runs Dragon's own R1a controller
// (extension/env-controller.js of a Dragon checkout with R1a) over a Playwright CDP session, the way Dragon's
// tests/r1a-cdp-fixture.test.mjs does, and answers QA GUI's probe driver (runTransientProbe) with the RPCs it calls.
// QA GUI itself drives Dragon (HR1); Playwright only stands in for the extension's chrome.debugger in tests.
// The privacy mask provider is a stub (the canary page has no secret or PII field), as in Dragon's test.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CANARY = join(ROOT, 'test/fixtures/r1d/canary.html');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Playwright from this checkout, the module path in QA_GUI_PLAYWRIGHT_MODULE, or the Node module path.
export async function loadPlaywrightAny() {
  try { return await import('playwright'); } catch {}
  const require = createRequire(import.meta.url);
  for (const id of [process.env.QA_GUI_PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) { try { return require(id); } catch {} }
  return null;
}
// Dragon's R1a controller from DRAGON_APP_DIR (a Dragon checkout's apps/dragon-browser), or null.
export function loadDragonController(dir = process.env.DRAGON_APP_DIR) {
  if (!dir) return null;
  try { return createRequire(import.meta.url)(join(dir, 'extension/env-controller.js')); } catch { return null; }
}

export async function canaryServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/save') {
      const delay = Math.min(10000, Number(u.searchParams.get('delay')) || 0);
      req.resume();
      setTimeout(() => { res.writeHead(201, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"ok":true}'); }, delay);
      return;
    }
    if (u.pathname !== '/canary.html') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(CANARY));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const EVENTS = ['Fetch.requestPaused', 'Runtime.bindingCalled', 'Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared',
  'PerformanceTimeline.timelineEventAdded', 'Animation.animationCreated', 'Animation.animationStarted', 'Animation.animationUpdated', 'Animation.animationCanceled', 'Page.screencastFrame'];
const stubPrivacy = { install: async () => ({ privacyMasked: true }), attest: async () => ({ privacyMasked: true, renderGeometry: { boxes: [] } }), renderCheck: async () => ({ ok: true }), remove: async () => ({ removed: true }) };

// One tab: the page, its CDP session, Dragon's controller on it, and `rpc(method, params)` with Dragon's result shapes.
export async function dragonStandIn({ browser, controller, url, viewport = { width: 800, height: 600 } }) {
  const page = await browser.newPage({ viewport });
  const cdp = await page.context().newCDPSession(page);
  for (const d of ['Runtime.enable', 'Page.enable', 'DOM.enable', 'Network.enable']) await cdp.send(d);
  const ctl = controller.createEnvController({ send: (m, p) => cdp.send(m, p), privacy: stubPrivacy, hash: async (b) => createHash('sha256').update(b).digest('hex') });
  for (const ev of EVENTS) cdp.on(ev, (p) => ctl.onEvent(ev, p));
  // Dragon's network log: the response time on Dragon's clock, method, URL, status; in flight for waitForNetworkIdle.
  const meta = new Map(), net = [];
  cdp.on('Network.requestWillBeSent', (p) => { meta.set(p.requestId, { method: p.request.method, url: p.request.url.split('?')[0], type: p.type }); });
  // A response ends the request for idleness (a body the page never reads may never report loadingFinished).
  cdp.on('Network.responseReceived', (p) => { const m = meta.get(p.requestId) ?? {}; net.push({ t: Date.now(), method: m.method, url: p.response.url.split('?')[0], status: p.response.status, type: p.type }); meta.delete(p.requestId); });
  const done = (p) => meta.delete(p.requestId);
  cdp.on('Network.loadingFinished', done);
  cdp.on('Network.loadingFailed', (p) => { const m = meta.get(p.requestId) ?? {}; net.push({ t: Date.now(), failed: true, method: m.method, url: m.url, type: m.type }); done(p); });
  const inflight = () => [...meta.values()].filter((m) => m.type !== 'Document' && m.type !== 'EventSource' && m.type !== 'WebSocket').length;
  await page.goto(url);
  async function doSteps(steps) {
    const results = [], reads = {};
    for (const s of steps) {
      if (s.wait) { await sleep(s.wait); results.push({ step: 'wait', ok: true, waited: s.wait }); }
      else if (s.read != null) { const value = await page.evaluate(s.read); results.push({ step: 'read', as: s.as ?? null, value }); if (s.as) reads[s.as] = value; }
      else if (s.clickSelector) {
        const box = await page.locator(s.clickSelector).boundingBox();
        const ts = Date.now();
        // Dragon marks an open frame window at the dispatch of every trusted input.
        if (ctl.framesCapturing()) ctl.framesMark({ t: ts, label: 'clickSelector' });
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        results.push({ step: 'clickSelector', ok: true, receipt: { ts } });
      } else results.push({ step: '?', ok: false, code: 'STEP_UNKNOWN' });
    }
    return { completed: true, results, reads };
  }
  async function rpc(method, params = {}) {
    switch (method) {
      case 'sensors.start': return ctl.sensorsStart(params);
      case 'sensors.read': return ctl.sensorsRead(params);
      case 'sensors.stop': return ctl.sensorsStop();
      case 'frames.start': return ctl.framesStart(params);
      case 'frames.mark': return ctl.framesMark(params);
      case 'frames.stop': {
        const r = await ctl.framesStop(params);
        // The bridge writes kept frames to its store and returns their hashes, never the bytes.
        r.frames = (r.frames || []).map(({ data, ...f }) => { const bytes = Buffer.from(String(data || ''), 'base64'); return { ...f, file: `f-${String(f.seq).padStart(5, '0')}.jpg`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; });
        return r;
      }
      case 'env.get': return ctl.get(params);
      case 'env.reset': return ctl.reset(params);
      case 'do': return doSteps(params.steps || []);
      case 'waitForNetworkIdle': {
        const deadline = Date.now() + (params.timeoutMs ?? 1000);
        let quietSince = inflight() ? null : Date.now();
        while (Date.now() < deadline) {
          if (inflight()) quietSince = null; else if (quietSince === null) quietSince = Date.now();
          if (quietSince !== null && Date.now() - quietSince >= (params.idleMs ?? 100)) return { ok: true, waitedMs: 0 };
          await sleep(10);
        }
        return inflight() ? { ok: false, timedOut: true } : { ok: true, waitedMs: params.timeoutMs };
      }
      case 'getNetwork': return { count: net.length, requests: net.slice(-200) };
      default: throw new Error(`stand-in: ${method} is not used by the probe`);
    }
  }
  return { page, cdp, ctl, rpc, inflight, pending: () => [...meta.values()], close: () => page.close() };
}

export const SCENARIOS = ['T1', 'T2', 'T3', 'T3theme', 'T4', 'T5', 'T6focus', 'T6scroll', 'T6size', 'T7', 'T8flash', 'T8lint'];
// The rule each scenario is the canary of, and the outcome it must reach (T7 and T8 lint never go beyond a warning).
export const CANARY_RULE = { T1: ['T1', 'FAIL'], T2: ['T2', 'FAIL'], T3: ['T3', 'FAIL'], T3theme: ['T3', 'FAIL'], T4: ['T4', 'FAIL'], T5: ['T5', 'FAIL'],
  T6focus: ['T6', 'FAIL'], T6scroll: ['T6', 'FAIL'], T6size: ['T6', 'FAIL'], T7: ['T7', 'WARN'], T8flash: ['T8', 'FAIL'], T8lint: ['T8', 'WARN'] };
const ACTIONS = {
  T1: { tag: 'button', label: 'Save', inForm: true }, T2: { tag: 'button', label: 'Save', inForm: true }, T3: { tag: 'button', label: 'Load', inList: true },
  T3theme: { tag: 'button', label: 'Theme' }, T4: { tag: 'button', label: 'Show details', ariaExpanded: false }, T5: { tag: 'button', label: 'Submit', inForm: true },
  T6focus: { tag: 'button', label: 'Close', inDialog: true }, T6scroll: { tag: 'button', label: 'Refresh', inList: true }, T6size: { tag: 'button', label: 'Save', inForm: true },
  T7: { tag: 'button', label: 'Open panel', ariaExpanded: false }, T8flash: { tag: 'button', label: 'Promo', ariaHaspopup: 'dialog' },
  T8lint: { tag: 'button', label: 'More', ariaExpanded: false }, none: { tag: 'button', label: 'Save', inForm: true },
};
export const canaryAction = (scenario) => ({ method: 'click', selector: '#go', target: ACTIONS[scenario] });

async function prepare(page, scenario) {
  await page.waitForLoadState('load');
  if (scenario === 'T6scroll') { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); }
  await sleep(250);
}

// Record one scenario variant: `repeats` real-speed trials of the click on #go, each on a fresh load.
export async function recordVariant({ browser, controller, base, scenario, at, clean, repeats = 3, schedule = 'events', runTransientProbe }) {
  const url = `${base}/canary.html?s=${scenario}&at=${at}${clean ? '&clean=1' : ''}`;
  const tab = await dragonStandIn({ browser, controller, url });
  try {
    await prepare(tab.page, scenario);
    const out = await runTransientProbe({ rpc: tab.rpc, tabId: 1, step: { clickSelector: '#go', fast: false }, targetSelector: '#go', action: canaryAction(scenario), repeats, schedule,
      restore: async () => { await tab.page.goto(url); await prepare(tab.page, scenario); } });
    const reset = await tab.rpc('env.reset', {});
    return { scenario, at, clean, schedule, ...out, reset };
  } finally { await tab.close(); }
}

// The clean screen the overhead is measured on: the same click without the probe, settled (the status text appears,
// then 100 ms without change) and one settled-state read, as an executor does after every action.
export async function baselineAction({ browser, controller, base, repeats = 5, sampleRead }) {
  const url = `${base}/canary.html?s=none`;
  const tab = await dragonStandIn({ browser, controller, url });
  const ms = [];
  try {
    for (let i = 0; i < repeats; i++) {
      await tab.page.goto(url); await prepare(tab.page, 'none');
      const t0 = Date.now();
      await tab.rpc('do', { steps: [{ clickSelector: '#go', fast: false }] });
      await tab.page.waitForFunction(() => document.getElementById('status').textContent === 'Saved');
      await sleep(100);
      await tab.page.evaluate(sampleRead({ targetSelector: '#go' }));
      ms.push(Date.now() - t0);
    }
    return ms;
  } finally { await tab.close(); }
}
