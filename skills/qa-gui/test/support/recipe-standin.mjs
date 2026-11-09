// A Dragon stand-in over Playwright for the stream-detector tests, and a reference executor that follows QA GUI's
// detector recipes (scripts/lib/stream-detectors.mjs) step for step, the way the Team QA GUI executor is told to.
// Every call is recorded as {method, params, result, ok}, the shape Team QA's web collect hands to QA GUI. Tests only:
// QA GUI drives the real Dragon (HR1); Playwright stands in for it here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  EXPLORE_CALL, EXPLORE_CSS_BODY, EXPLORE_INSTALL_BODY, OVERLAY_DEFAULTS, SETTLE_MS, STREAM_HELPERS, expandDoSteps, ranHash, helperCall, helperDefinitions, helperPack, overlayTriggerOrder,
} from '../../scripts/lib/stream-detectors.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Dragon's `read`: an expression first, else a function body (background.js _evalRead).
const READ = (code) => { try { return (new Function(`return (${code})`))(); } catch { try { return (new Function(code))(); } catch (e) { return { __read_error: String(e?.message ?? e) }; } } };

export async function dragonStandIn({ browser, url, width = 1280, height = 800 }) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(url);
  const calls = [];
  const helpers = new Map();
  let size = { width, height };
  const setViewport = async (v) => {
    size = { width: v.width, height: v.height };
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor ?? 0, mobile: v.mobile === true });
    await cdp.send('Emulation.setTouchEmulationEnabled', v.mobile === true ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  };
  const step = async (s) => {
    // Dragon's helper call: a read of (<body>).apply(null, args), its result naming the code that ran.
    if (typeof s.call === 'string') {
      const body = helpers.get(s.call);
      if (!body) return { step: 'read', as: s.as ?? null, ok: false, code: 'HELPER_UNKNOWN' };
      const value = await page.evaluate(READ, `(${body}).apply(null, ${JSON.stringify(s.args ?? [])})`);
      return { step: 'read', as: s.as ?? null, value, helper: { name: s.call, sha256: sha(body) } };
    }
    if (s.read !== undefined) return { step: 'read', as: s.as ?? null, value: await page.evaluate(READ, s.read) };
    if (s.viewport) { await setViewport(s.viewport); return { step: 'viewport', ok: true }; }
    if (s.clickSelector) {
      try { await page.click(s.clickSelector, { timeout: 2000 }); return { step: 'clickSelector', ok: true, receipt: { ts: Date.now() } }; }
      catch { return { step: 'clickSelector', ok: false, code: 'CLICK_TARGET_NOT_FOUND' }; }
    }
    if (s.clickXY) { await page.mouse.click(s.clickXY[0], s.clickXY[1]); return { step: 'clickXY', ok: true }; }
    if (s.key) { await page.keyboard.press(s.key); return { step: 'key', ok: true }; }
    if (s.scroll) { await page.mouse.move(size.width / 2, size.height / 2); await page.mouse.wheel(0, s.scroll.delta ?? 400); await page.waitForTimeout(100); return { step: 'scroll', ok: true }; }
    if (s.goto) { await page.goto(s.goto); return { step: 'goto', ok: true }; }
    if (s.wait) { await page.waitForTimeout(s.wait); return { step: 'wait', ok: true, waited: s.wait }; }
    return { step: '?', ok: false, code: 'STEP_UNKNOWN' };
  };
  async function rpc(method, params = {}) {
    let result;
    if (method === 'do') {
      // Dragon expands a do's loops first; each expanded result names the step that ran and where it came from.
      const { steps, origin } = expandDoSteps(params.steps);
      const results = [];
      for (const [i, s] of steps.entries()) { const r = await step(s); results.push(origin?.[i] ? { ...r, ...(params.brief ? { ranHash: ranHash(s) } : { ran: s }), each: origin[i] } : r); }
      result = { completed: true, results };
    } else if (method === 'helpers.define') {
      // A helper pack: the file at its path, checked against its hash, as Dragon reads it.
      let given = params.helpers ?? {};
      if (params.pack) {
        const bytes = readFileSync(params.pack.path);
        if (sha(bytes) !== params.pack.sha256) { calls.push({ method, params, result: { ok: false, code: 'HELPER_PACK_HASH' }, ok: false }); return { ok: false, code: 'HELPER_PACK_HASH' }; }
        given = JSON.parse(bytes.toString('utf8')).helpers;
      }
      for (const [name, body] of Object.entries(given)) helpers.set(name, body);
      result = { ok: true, helpers: Object.keys(given).map((name) => ({ name, sha256: sha(given[name]) })) };
    }
    else if (method === 'setViewport') { await setViewport(params); result = { ok: true }; }
    else if (method === 'clearViewport') { await cdp.send('Emulation.clearDeviceMetricsOverride'); size = { width, height }; result = { ok: true, cleared: true }; }
    else if (method === 'paintSnapshot') {
      // Dragon's paint-order read, reduced to what the sweep's confirmation needs: found, shown and the hiding reasons.
      result = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) return { ok: false, code: 'PAINT_TARGET_NOT_FOUND' };
        const s = getComputedStyle(el), r = el.getBoundingClientRect(), reasons = [];
        if (s.display === 'none') reasons.push('display-none');
        if (s.visibility === 'hidden') reasons.push('visibility-hidden');
        if (Number(s.opacity) === 0) reasons.push('transparent');
        if (r.width === 0 || r.height === 0) reasons.push('zero-size');
        if (r.right > innerWidth || r.left < 0) reasons.push('outside-viewport');
        return { ok: true, elements: [{ selector, index: 0, found: true, shown: reasons.length === 0, reasons }] };
      }, params.selector);
    } else if (method === 'screenshot' || method === 'captureTab') { const png = await page.screenshot(); result = { ok: true, sha256: sha(png), bytes: png.length }; }
    else result = { ok: false, code: 'METHOD_UNKNOWN' };
    calls.push({ method, params, result, ok: result?.ok !== false });
    return result;
  }
  return { page, rpc, calls, close: () => context.close() };
}

const readOf = (result, as) => result.results.find((r) => r.step === 'read' && r.as === as)?.value;

/** The width sweep recipe (screenCheckPromptSection), step for step, with QA GUI's helper pack and Dragon loops. */
// `chain`: the rows and the restore are left to the overlay check's first do (followOverlays `lead`), as the recipe sends them.
export async function followSweep({ rpc, url = null, min = 320, max = 1440, step = 20, height = 800, chain = false }) {
  await rpc('helpers.define', { pack: helperPack() });
  const widths = (over) => ({ forEach: { name: 'w', ...over }, steps: [{ viewport: { width: '$w', height, deviceScaleFactor: 1, mobile: false } }, { wait: SETTLE_MS }, helperCall('sweep', ['measure'], 'w:$w')] });
  const split = min + Math.ceil((max - min) / step / 2) * step;
  const one = await rpc('do', { brief: true, steps: [...(url ? [{ goto: url }] : []), helperCall('sweep', ['found'], 'w:found'), widths({ range: [min, split - step, step] })] });
  const found = readOf(one, 'w:found');
  const refine = readOf(await rpc('do', { brief: true, steps: [widths({ range: [split, max, step] }), helperCall('sweep', ['refine'], 'w:refine')] }), 'w:refine');
  for (let i = 0; i < refine.length; i += 30) await rpc('do', { brief: true, steps: [widths({ values: refine.slice(i, i + 30) })] });
  const { bands, rows } = readOf(await rpc('do', { brief: true, steps: [helperCall('sweep', ['bands'], 'w:bands')] }), 'w:bands');
  for (const band of bands) {
    await rpc('do', { brief: true, steps: [{ viewport: { width: band.from, height, deviceScaleFactor: 1, mobile: false } }, { wait: SETTLE_MS }] });
    if (band.target) await rpc('paintSnapshot', { selector: band.target });
    await rpc('screenshot', { evidence: true, toFile: `sweep-${band.from}.jpg` });
  }
  const restore = [{ forEach: { name: 'r', values: rows }, steps: [{ viewport: { width: '$r.width', height: '$r.height', deviceScaleFactor: '$r.deviceScaleFactor', mobile: '$r.mobile' } }, { wait: SETTLE_MS },
    helperCall('sweep', ['emu'], 'w:row:$r.id:emu'), helperCall('sweep', ['measure'], 'w:row:$r.id:geo')] },
  { viewport: { width: found.width, height: found.height, deviceScaleFactor: found.dpr, mobile: found.touch } }, { wait: SETTLE_MS }, helperCall('sweep', ['viewport'], 'w:restored')];
  if (!chain) await rpc('do', { brief: true, steps: restore });
  return { found, refine, bands, rows, restore };
}

/**
 * The overlay check recipe (screenCheckPromptSection), step for step: four dos per trigger, each way out clicked from
 * its own open. `lead`: steps the recipe sends first in the same do (the sweep's rows and restore).
 */
export async function followOverlays({ rpc, url, fast = false, planned = [], define = false, lead = [] }) {
  if (define) await rpc('helpers.define', { pack: helperPack() });
  const click = (selector) => ({ clickSelector: selector, fast });
  const S = (as, args = null) => helperCall('overlay', args, as);
  const tabs = (n) => ({ forEach: { name: 'i', range: [1, n] }, steps: [{ key: 'Tab' }] });
  const start = await rpc('do', { brief: true, steps: [...lead, { goto: url }, S('o:triggers', ['triggers'])] });
  const { checked } = overlayTriggerOrder(readOf(start, 'o:triggers').triggers, { planned });
  let carry = [];
  for (const [k, trigger] of checked.entries()) {
    const T = trigger.selector, o = (slot) => `o:${k}:${slot}`;
    await rpc('do', { brief: true, steps: [...carry, { goto: url }, S(o('kbd-0'), ['log']), tabs(OVERLAY_DEFAULTS.keyboardLimit)] });
    const a = await rpc('do', { brief: true, steps: [S(o('kbd'), ['keylog']), { goto: url }, S(o('before')), click(T), { wait: 300 }, S(o('first')),
      { forEach: { name: 'n', range: [1, OVERLAY_DEFAULTS.tabLimit] }, steps: [{ key: 'Tab' }, S(`o:${k}:trap-$n`)] },
      S(o('scroll-from')), { scroll: { delta: 400 } }, S(o('scroll-to')), S(o('now'))] });
    const now = readOf(a, o('now'));
    const n = (readOf(a, o('kbd'))?.samples ?? []).findIndex((x) => x?.active === T) + 1;
    const b = await rpc('do', { brief: true, steps: [
      ...(now?.innerTriggers?.length ? [click(now.innerTriggers[0].selector), { wait: 300 }, S(o('stacked-two')), { key: 'Escape' }, S(o('stacked-esc'))] : []),
      { goto: url }, click(T), { wait: 300 }, S(o('esc-open')), { key: 'Escape' }, S(o('esc-after')),
      { goto: url }, click(T), { wait: 300 }, S(o('backdrop-open'))] });
    const backdrop = readOf(b, o('backdrop-open'));
    const c = await rpc('do', { brief: true, steps: [
      ...(backdrop?.backdropPoint ? [{ clickXY: [backdrop.backdropPoint.x, backdrop.backdropPoint.y], fast }, { wait: 300 }, S(o('backdrop-after'))] : []),
      { goto: url }, click(T), { wait: 300 }, S(o('button-open'))] });
    const button = readOf(c, o('button-open'));
    carry = [...(button?.closeButton ? [click(button.closeButton), { wait: 300 }, S(o('button-after'))] : []),
      ...(n > 0 ? [{ goto: url }, tabs(n), S(o('kbd-reach')), { key: 'Enter' }, { wait: 300 }, S(o('kbd-enter'))] : [])];
  }
  await rpc('do', { brief: true, steps: [...carry, { goto: url }] });
  return { triggers: checked };
}

export { STREAM_HELPERS };
export { EXPLORE_CALL, EXPLORE_CSS_BODY, EXPLORE_INSTALL_BODY };
